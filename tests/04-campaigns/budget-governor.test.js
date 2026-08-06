import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import * as repo from '../../src/modules/campaigns/campaign.repository.js'
import * as service from '../../src/modules/campaigns/campaign.service.js'
import * as limiter from '../../shared/services/meta-rate-limiter.js'
import { sendAdminAlert } from '../../shared/mailer/alert.mailer.js'
import { query } from '../../shared/database/connection.js'
import { generateUuid, uuidToBuffer } from '../../shared/utils/uuid.utils.js'
import { createTestUser } from '../helpers/create-user.js'

var metaMocks

vi.mock('../../shared/services/meta-ads.service.js', async () => {
  const actual = await vi.importActual('../../shared/services/meta-ads.service.js')
  const mocks = {
    updateAdStatus: vi.fn().mockResolvedValue({ success: true }),
    listAccountAds: vi.fn().mockResolvedValue({ rows: [], truncated: false }),
    getObjectStatus: vi.fn().mockResolvedValue({ status: 'ACTIVE', effective_status: 'ACTIVE' }),
    getAdAccount: vi.fn().mockResolvedValue({ balance: '10.00', currency: 'INR', account_status: 1, disable_reason: null }),
    createInsightsReport: vi.fn().mockResolvedValue({ report_run_id: 'run_bg_1' }),
    getInsightsReport: vi.fn().mockResolvedValue({ async_status: 'Job Running' }),
    getInsightsReportData: vi.fn().mockResolvedValue([]),
    extractMetaError: vi.fn().mockReturnValue(null),
  }
  metaMocks = mocks
  return { ...actual, ...mocks }
})

const dateTag = Date.now()

async function cleanup() {
  await query('SET FOREIGN_KEY_CHECKS = 0')
  await query('DELETE FROM meta_sync_state')
  await query('DELETE FROM campaign_meta_objects')
  await query('DELETE FROM campaign_jobs')
  await query('DELETE FROM campaigns')
  await query('DELETE FROM meta_ad_accounts')
  await query('SET FOREIGN_KEY_CHECKS = 1')
}

async function seedCampaignWithCharge(userId, accountId, chargedPaise) {
  const campaign = await repo.createCampaign(generateUuid(), userId, {
    name: `BG ${generateUuid().substring(0, 8)}`,
    type: 'post',
    adAccountId: accountId,
  })
  const adId = `ad_bg_${generateUuid()}`
  await repo.createMetaObject(campaign.id, 'facebook_campaign', `fb_bg_${generateUuid()}`, null, 'ACTIVE', userId)
  await repo.createMetaObject(campaign.id, 'ad', adId, null, 'ACTIVE', userId)
  await repo.updateCampaignStatus(campaign.id, 'running')
  await repo.updateCampaign(campaign.id, { chargedAdBudgetPaise: chargedPaise })
  return { campaign, adId }
}

beforeAll(async () => {
  process.env.META_SYSTEM_USER_TOKEN = 'test_system_user_token'
  process.env.META_AD_ACCOUNT_ID = 'act_env_fallback'
  await cleanup()
})

beforeEach(async () => {
  await cleanup()
  limiter.resetRateLimitState()
  vi.clearAllMocks()
})

afterAll(async () => {
  await cleanup()
})

describe('budget governor — pause at cap', () => {
  it('pauses running campaigns when the account exceeds its monthly cap', async () => {
    const user = await createTestUser({ email: `bg1-${dateTag}@flowx-test.com`, password: 'Test@123', coins: 1000 })
    const account = await repo.createMetaAdAccount({ metaAccountId: `bgA_${dateTag}`, token: 't', monthlyCapPaise: 100000 })
    const { campaign: c1, adId: ad1 } = await seedCampaignWithCharge(user.id, account.id, 60000)
    const { campaign: c2, adId: ad2 } = await seedCampaignWithCharge(user.id, account.id, 60000)

    metaMocks.listAccountAds.mockResolvedValue({
      rows: [
        { id: ad1, status: 'PAUSED', effective_status: 'PAUSED' },
        { id: ad2, status: 'PAUSED', effective_status: 'PAUSED' },
      ],
      truncated: false,
    })

    const result = await service.syncAccountStatusJob(`bgA_${dateTag}`)
    expect(result.budget.atCap).toBe(true)
    expect(result.budget.paused).toHaveLength(2)

    const after1 = await repo.findCampaignById(c1.id)
    const after2 = await repo.findCampaignById(c2.id)
    expect(after1.status).toBe('paused')
    expect(after1.metaStatus).toBe('paused')
    expect(after2.status).toBe('paused')
    expect(after2.metaStatus).toBe('paused')

    expect(metaMocks.updateAdStatus).toHaveBeenCalledWith(ad1, 'PAUSED', 't')
    expect(metaMocks.updateAdStatus).toHaveBeenCalledWith(ad2, 'PAUSED', 't')

    const logs = await query(
      'SELECT COUNT(*) AS n FROM campaign_review_log WHERE campaign_id IN (?, ?) AND notes LIKE ?',
      [uuidToBuffer(c1.id), uuidToBuffer(c2.id), '%budget cap%']
    )
    expect(Number(logs[0].n)).toBe(2)
  })

  it('does not re-pause already paused campaigns on the next sync', async () => {
    const user = await createTestUser({ email: `bg2-${dateTag}@flowx-test.com`, password: 'Test@123', coins: 1000 })
    const account = await repo.createMetaAdAccount({ metaAccountId: `bgB_${dateTag}`, token: 't', monthlyCapPaise: 100000 })
    const { adId } = await seedCampaignWithCharge(user.id, account.id, 120000)

    metaMocks.listAccountAds.mockResolvedValue({
      rows: [{ id: adId, status: 'PAUSED', effective_status: 'PAUSED' }],
      truncated: false,
    })

    const first = await service.syncAccountStatusJob(`bgB_${dateTag}`)
    expect(first.budget.paused).toHaveLength(1)

    metaMocks.updateAdStatus.mockClear()
    const second = await service.syncAccountStatusJob(`bgB_${dateTag}`)
    expect(second.budget.paused).toHaveLength(0)
    expect(metaMocks.updateAdStatus).not.toHaveBeenCalled()
  })
})

describe('budget governor — cap alerts', () => {
  it('sends an admin alert once per 24h when charged budget reaches 95%', async () => {
    const user = await createTestUser({ email: `bg3-${dateTag}@flowx-test.com`, password: 'Test@123', coins: 1000 })
    const account = await repo.createMetaAdAccount({ metaAccountId: `bgC_${dateTag}`, token: 't', monthlyCapPaise: 100000 })
    const { campaign, adId } = await seedCampaignWithCharge(user.id, account.id, 96000)
    metaMocks.listAccountAds.mockResolvedValue({
      rows: [{ id: adId, status: 'ACTIVE', effective_status: 'ACTIVE' }],
      truncated: false,
    })

    await service.syncAccountStatusJob(`bgC_${dateTag}`)
    expect(sendAdminAlert).toHaveBeenCalledTimes(1)

    await service.syncAccountStatusJob(`bgC_${dateTag}`)
    expect(sendAdminAlert).toHaveBeenCalledTimes(1)
  })

  it('does not alert below 95% of the cap', async () => {
    const user = await createTestUser({ email: `bg4-${dateTag}@flowx-test.com`, password: 'Test@123', coins: 1000 })
    const account = await repo.createMetaAdAccount({ metaAccountId: `bgD_${dateTag}`, token: 't', monthlyCapPaise: 100000 })
    const { campaign, adId } = await seedCampaignWithCharge(user.id, account.id, 50000)
    metaMocks.listAccountAds.mockResolvedValue({
      rows: [{ id: adId, status: 'ACTIVE', effective_status: 'ACTIVE' }],
      truncated: false,
    })

    await service.syncAccountStatusJob(`bgD_${dateTag}`)
    expect(sendAdminAlert).not.toHaveBeenCalled()
  })

  it('leaves uncapped accounts untouched', async () => {
    const user = await createTestUser({ email: `bg5-${dateTag}@flowx-test.com`, password: 'Test@123', coins: 1000 })
    const account = await repo.createMetaAdAccount({ metaAccountId: `bgE_${dateTag}`, token: 't', monthlyCapPaise: 0 })
    const { campaign } = await seedCampaignWithCharge(user.id, account.id, 999999999)

    const result = await service.syncAccountStatusJob(`bgE_${dateTag}`)
    expect(result.budget.checked).toBe(false)

    const after = await repo.findCampaignById(campaign.id)
    expect(after.status).toBe('running')
  })
})

describe('budget governor — priority shedding', () => {
  it('sheds low-priority accounts when soft throttled and many accounts exist', async () => {
    for (let i = 0; i < 4; i += 1) {
      await repo.createMetaAdAccount({ metaAccountId: `shed_${i}_${dateTag}`, token: 't' })
    }
    limiter.recordUsage({ 'x-app-usage': { used: { call_count: 0.6, total_cputime: 0.6 } } })
    expect(limiter.isSoftThrottled()).toBe(true)

    const result = await service.scheduleCampaignSyncs()
    expect(result.skipped).toBeUndefined()
    expect(result.accounts).toBe(3)
    expect(result.shed).toHaveLength(1)
  })

  it('still skips entirely when soft throttled and at or below the shed limit', async () => {
    await repo.createMetaAdAccount({ metaAccountId: `shed1_${dateTag}`, token: 't' })
    await repo.createMetaAdAccount({ metaAccountId: `shed2_${dateTag}`, token: 't' })
    limiter.recordUsage({ 'x-app-usage': { used: { call_count: 0.6, total_cputime: 0.6 } } })

    const result = await service.scheduleCampaignSyncs()
    expect(result.skipped).toBe(true)
    expect(result.reason).toBe('soft_throttled')
  })

  it('enqueues all accounts when not throttled', async () => {
    for (let i = 0; i < 4; i += 1) {
      await repo.createMetaAdAccount({ metaAccountId: `full_${i}_${dateTag}`, token: 't' })
    }
    const result = await service.scheduleCampaignSyncs()
    expect(result.skipped).toBeUndefined()
    expect(result.accounts).toBe(4)
    expect(result.shed).toBeUndefined()
  })
})
