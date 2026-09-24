import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { generateUuid, uuidToBuffer, bufferToUuid } from '../../shared/utils/uuid.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import * as campaignService from '../../src/modules/campaigns/campaign.service.js'
import * as campaignRepo from '../../src/modules/campaigns/campaign.repository.js'
import * as execRepo from '../../src/modules/campaigns/campaign-execution.repository.js'
import * as subRepo from '../../src/modules/subscriptions/subscription.repository.js'
import * as coinService from '../../shared/services/coin.service.js'
import { queryOne, query } from '../../shared/database/connection.js'
import { drainCampaignJobs } from '../../src/modules/campaigns/campaign.jobs.js'

var metaMocks
vi.mock('../../shared/services/meta-ads.service.js', async () => {
  const actual = await vi.importActual('../../shared/services/meta-ads.service.js')
  const mocks = {
    ...actual,
    __counter: 0,
    __nextMetaId: prefix => {
      mocks.__counter += 1
      return `finchar_${prefix}_${mocks.__counter}`
    },
    createAdCampaign: vi.fn().mockImplementation(async () => ({ id: mocks.__nextMetaId('mock_campaign') })),
    createAdSet: vi.fn().mockImplementation(async () => ({ id: mocks.__nextMetaId('mock_adset') })),
    createAdCreative: vi.fn().mockImplementation(async () => ({ id: mocks.__nextMetaId('mock_creative') })),
    createAd: vi.fn().mockImplementation(async () => ({ id: mocks.__nextMetaId('mock_ad') })),
    updateAdStatus: vi.fn().mockResolvedValue({ success: true }),
    deleteAd: vi.fn().mockResolvedValue({}),
    deleteAdSet: vi.fn().mockResolvedValue({}),
    deleteAdCreative: vi.fn().mockResolvedValue({}),
    deleteAdCampaign: vi.fn().mockResolvedValue({}),
    getObjectStatus: vi.fn().mockResolvedValue({ status: 'ACTIVE', effective_status: 'ACTIVE' }),
  }
  metaMocks = mocks
  return mocks
})

const dateTag = Date.now()

async function ensurePlan(userId) {
  const sub = await subRepo.findUserSubscription(userId)
  if (sub) return
  const starter = await subRepo.findPlanBySlug('starter')
  if (starter) {
    await subRepo.upsertUserSubscription(userId, starter.id, {
      status: 'active',
      billingCycle: 'monthly',
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    })
  }
}

async function addVerifiedPage(userId, platformUserId) {
  const fbPlatform = await queryOne("SELECT id FROM platforms WHERE code = 'facebook'")
  if (!fbPlatform) return
  await query(
    `INSERT INTO user_platform_accounts (id, user_id, platform_id, profile_url, platform_user_id, platform_username, token_type, token_expires_at, verification_status)
     VALUES (?, ?, ?, ?, ?, ?, 'page', DATE_ADD(NOW(), INTERVAL 60 DAY), 'verified')`,
    [uuidToBuffer(generateUuid()), uuidToBuffer(userId), fbPlatform.id, 'https://fb.com/test', platformUserId, 'TestPage']
  )
}

async function createClientReadyCampaign(clientId, name) {
  const campaign = await campaignService.createCampaign(clientId, { name, type: 'post' })
  await campaignRepo.createCreative(generateUuid(), campaign.id, { caption: 'spend-last', mediaUrl: 'https://example.com/img.jpg' })
  await campaignRepo.createMetaSettings(generateUuid(), campaign.id, {
    objective: 'OUTCOME_TRAFFIC',
    budgetType: 'lifetime',
    budgetAmount: 500,
    endTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  })
  await campaignService.submitCampaign(clientId, campaign.id)
  return campaign.id
}

function failValidateOnly(fnName, userMsg) {
  metaMocks[fnName].mockImplementation((...args) => {
    if (args[args.length - 1] === true) {
      return Promise.reject(new Error(`Graph API failed: ${JSON.stringify({ error: { error_user_msg: userMsg, error_subcode: 100 } })}`))
    }
    return Promise.resolve({ id: metaMocks.__nextMetaId('mock_object') })
  })
}

describe('campaign finance characterization (Phase 0 — locks current behavior)', () => {
  let client, adminId

  beforeAll(async () => {
    await query(
      `INSERT INTO app_config (id, config_key, config_value, is_public, description, version)
       VALUES (?, 'campaign_execution_runtime_enabled', 'false', 0, 'test', 1)
       ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
      [uuidToBuffer(generateUuid())]
    )
    client = await createTestUser({
      email: `camp-finchar-${dateTag}@flowx-test.com`,
      password: 'Test@123',
      coins: 10000,
    })
    await ensurePlan(client.id)
    await addVerifiedPage(client.id, `finchar_page_${dateTag}`)
    const adminRow = await queryOne("SELECT id FROM users WHERE email = 'admin@flowx.com'")
    adminId = adminRow ? bufferToUuid(adminRow.id) : client.id
  })

  beforeEach(() => {
    metaMocks.createAdCampaign.mockReset().mockImplementation(async () => ({ id: metaMocks.__nextMetaId('mock_campaign') }))
    metaMocks.createAdSet.mockReset().mockImplementation(async () => ({ id: metaMocks.__nextMetaId('mock_adset') }))
    metaMocks.createAdCreative.mockReset().mockImplementation(async () => ({ id: metaMocks.__nextMetaId('mock_creative') }))
    metaMocks.createAd.mockReset().mockImplementation(async () => ({ id: metaMocks.__nextMetaId('mock_ad') }))
  })

  it('spend-last: Meta publish failure moves zero coins and writes zero charge rows', async () => {
    failValidateOnly('createAdCreative', 'The Page ID specified in object story spec is invalid')
    const campaignId = await createClientReadyCampaign(client.id, `FinChar Fail ${generateUuid().substring(0, 8)}`)
    const before = await coinService.getAvailable(client.id)

    const approved = await campaignService.approveCampaign(adminId, campaignId, {})
    expect(approved.queued).toBe(true)
    await drainCampaignJobs()

    const updated = await campaignRepo.findCampaignById(campaignId)
    expect(updated.status).toBe('pending_review')
    expect(updated.metaStatus).toBe('failed')
    expect(Number(updated.chargedAdBudgetPaise)).toBe(0)

    const entries = await campaignRepo.findBillingEntries(campaignId)
    expect(entries.filter(e => e.kind === 'charge')).toHaveLength(0)

    const after = await coinService.getAvailable(client.id)
    expect(after.total).toBe(before.total)
  })

  it('spend-last: success charges exactly once with a single charge row', async () => {
    const campaignId = await createClientReadyCampaign(client.id, `FinChar Ok ${generateUuid().substring(0, 8)}`)
    const before = await coinService.getAvailable(client.id)

    const approved = await campaignService.approveCampaign(adminId, campaignId, {})
    expect(approved.queued).toBe(true)
    await drainCampaignJobs()

    const updated = await campaignRepo.findCampaignById(campaignId)
    expect(['running', 'scheduled']).toContain(updated.status)
    expect(Number(updated.chargedAdBudgetPaise)).toBe(50000)

    const entries = await campaignRepo.findBillingEntries(campaignId)
    const charges = entries.filter(e => e.kind === 'charge')
    expect(charges).toHaveLength(1)
    expect(Number(charges[0].paise)).toBe(50000)

    const after = await coinService.getAvailable(client.id)
    expect(after.total).toBe(before.total - 500)
  })

  it('publisher-flow approve is async: 202 stages, worker spends, escrow stays invisible to settlement', async () => {
    const cat = await queryOne("SELECT id FROM ad_categories WHERE code = 'technology'")
    expect(cat).toBeTruthy()
    const campaign = await campaignService.createCampaign(client.id, {
      name: `FinChar Pub ${generateUuid().substring(0, 8)}`,
      type: 'post',
      categoryId: bufferToUuid(cat.id),
      publisherCount: 1,
      coinsPerPublisher: 50,
    })
    await campaignRepo.createCreative(generateUuid(), campaign.id, { caption: 'pub escrow', mediaUrl: 'https://example.com/img.jpg' })
    await campaignRepo.createMetaSettings(generateUuid(), campaign.id, {
      objective: 'OUTCOME_TRAFFIC',
      budgetType: 'lifetime',
      budgetAmount: 500,
      endTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    })
    await campaignService.submitCampaign(client.id, campaign.id)

    const before = await coinService.getAvailable(client.id)
    const result = await campaignService.approveCampaign(adminId, campaign.id, {})
    expect(result.queued).toBe(true)
    expect(result.jobId).toBeTruthy()
    expect(result.executionId).toBeTruthy()

    let updated = await campaignRepo.findCampaignById(campaign.id)
    expect(updated.status).toBe('pending_review')
    expect((await coinService.getAvailable(client.id)).total).toBe(before.total)
    expect(await campaignRepo.findPublisherRequestsByCampaignId(campaign.id)).toHaveLength(0)
    const staged = await execRepo.findExecutionByOwner(campaign.id, client.id, 'client')
    expect(staged.status).toBe('pending')

    await drainCampaignJobs()

    updated = await campaignRepo.findCampaignById(campaign.id)
    expect(updated.status).toBe('awaiting_publishers')
    expect(Number(updated.chargedAdBudgetPaise)).toBe(0)
    expect((await coinService.getAvailable(client.id)).total).toBe(before.total - 1055)

    const settled = await campaignService.settleCampaignJob(campaign.id)
    expect(settled.nothingCharged).toBe(true)
  })

  it('sequential double settle executes a single refund (early-return locked)', async () => {
    const campaignId = await createClientReadyCampaign(client.id, `FinChar Dbl ${generateUuid().substring(0, 8)}`)
    await campaignRepo.updateCampaignStatus(campaignId, 'running')
    await campaignRepo.updateCampaign(campaignId, { chargedAdBudgetPaise: 10000 })
    await campaignRepo.insertBillingEntry(campaignId, {
      kind: 'charge',
      paise: 10000,
      coins: 100,
      rate: 1,
      paidFromMonthly: 0,
      paidFromWallet: 100,
      reason: 'phase 0 double-settle lock',
    })
    await campaignRepo.upsertDailyStat(campaignId, {
      statDate: '2026-07-01',
      impressions: 100,
      reach: 90,
      clicks: 5,
      ctr: 0.05,
      cpc: 1,
      cpm: 10,
      spendPaise: 4000,
      actions: {},
      costPerActionType: {},
    })

    const first = await campaignService.settleCampaignJob(campaignId)
    expect(first.success).toBe(true)
    expect(first.refundCoins).toBe(60)

    const second = await campaignService.settleCampaignJob(campaignId)
    expect(second.alreadySettled).toBe(true)

    const entries = await campaignRepo.findBillingEntries(campaignId)
    expect(entries.filter(e => e.kind === 'refund')).toHaveLength(1)
  })
})
