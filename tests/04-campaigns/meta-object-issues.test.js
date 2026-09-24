import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { generateUuid, uuidToBuffer } from '../../shared/utils/uuid.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import * as campaignService from '../../src/modules/campaigns/campaign.service.js'
import * as campaignRepo from '../../src/modules/campaigns/campaign.repository.js'
import * as execRepo from '../../src/modules/campaigns/campaign-execution.repository.js'
import { query } from '../../shared/database/connection.js'
import { resetRateLimitState } from '../../shared/services/meta-rate-limiter.js'
import {
  META_ISSUE_CATALOG,
  classifyIssueCode,
  normalizeIssuesInfo,
  instagramAppliesToPlacement,
  checkInstagramImageWidth,
  INSTAGRAM_MIN_IMAGE_WIDTH_PX,
} from '../../shared/services/meta-issue-catalog.js'

var metaMocks
vi.mock('../../shared/services/meta-ads.service.js', async () => {
  const actual = await vi.importActual('../../shared/services/meta-ads.service.js')
  const mocks = {
    ...actual,
    listAccountAds: vi.fn().mockResolvedValue({ rows: [], truncated: false }),
    getObjectStatus: vi.fn().mockResolvedValue({ status: 'ACTIVE', effective_status: 'ACTIVE' }),
    getCampaignStatusesBatch: vi.fn().mockResolvedValue({}),
    getAdAccount: vi.fn().mockResolvedValue({ balance: '10.00', currency: 'INR', account_status: 1, disable_reason: null }),
  }
  metaMocks = mocks
  return mocks
})

const dateTag = Date.now()
let seq = 0
function tag(prefix) {
  seq += 1
  return `${prefix}_${seq}_${generateUuid()}`
}

const ISSUE_2875006 = {
  level: 'AD',
  error_code: 2875006,
  error_summary: 'Media not wide enough',
  error_message: "Media not wide enough: Your ad won't run on Instagram because it contains media that's less than 500 pixels wide.",
  error_type: 'HARD_ERROR',
}

const ISSUE_UNKNOWN = {
  level: 'AD',
  error_code: 9990001,
  error_summary: 'Some future Meta problem',
  error_message: 'Something new happened.',
  error_type: 'HARD_ERROR',
}

describe('meta issue catalog', () => {
  it('maps 2875006 to the media-dimension category with a 500px minimum', () => {
    expect(META_ISSUE_CATALOG[2875006].category).toBe('MEDIA_DIMENSION')
    expect(META_ISSUE_CATALOG[2875006].minimumWidthPx).toBe(500)
    expect(META_ISSUE_CATALOG[2875006].severity).toBe('HARD_ERROR')
    const classified = classifyIssueCode(2875006)
    expect(classified.category).toBe('MEDIA_DIMENSION')
    expect(classified.guidance).toMatch(/500px/)
  })

  it('keeps unknown codes generic without fabricating a remediation', () => {
    const classified = classifyIssueCode(9990001)
    expect(classified.category).toBe('UNKNOWN')
    expect(classified.guidance).toBeNull()
    expect(classified.minimumWidthPx).toBeNull()
    expect(classified.errorCode).toBe('9990001')
  })

  it('normalizes issues_info entries and drops rows without a code', () => {
    const out = normalizeIssuesInfo([ISSUE_2875006, { level: 'AD', error_summary: 'nope' }, null])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ level: 'AD', errorCode: '2875006', summary: 'Media not wide enough', errorType: 'HARD_ERROR' })
    expect(normalizeIssuesInfo(null)).toEqual([])
    expect(normalizeIssuesInfo('nope')).toEqual([])
  })

  it('detects Instagram applicability from placement config', () => {
    expect(instagramAppliesToPlacement(null)).toBe(true)
    expect(instagramAppliesToPlacement({})).toBe(true)
    expect(instagramAppliesToPlacement({ publisher_platforms: ['facebook', 'instagram'] })).toBe(true)
    expect(instagramAppliesToPlacement({ publisher_platforms: ['facebook'] })).toBe(false)
  })

  it('enforces the 500px Instagram minimum with boundary behavior', () => {
    expect(INSTAGRAM_MIN_IMAGE_WIDTH_PX).toBe(500)
    expect(checkInstagramImageWidth(499).ok).toBe(false)
    expect(checkInstagramImageWidth(499).errorCode).toBe('2875006')
    expect(checkInstagramImageWidth(500).ok).toBe(true)
    expect(checkInstagramImageWidth(1200).ok).toBe(true)
    expect(checkInstagramImageWidth(null).skipped).toBe(true)
    expect(checkInstagramImageWidth(Number.NaN).skipped).toBe(true)
  })
})

describe('meta object issue ingestion', () => {
  let client
  let partner
  const campaignIds = []

  async function seedCampaignWithExecution(ownerId, suffix, kind = 'client') {
    const campaign = await campaignService.createCampaign(ownerId, {
      name: `MetaIssueIngest ${suffix}`,
      type: 'post',
    })
    campaignIds.push(campaign.id)
    await campaignRepo.createCreative(generateUuid(), campaign.id, { caption: 'ingest', mediaUrl: 'https://example.com/i.jpg' })
    const fbId = `fb_iss_${suffix}`
    const adsetId = `adset_iss_${suffix}`
    const creativeId = `creative_iss_${suffix}`
    const adId = `ad_iss_${suffix}`
    await campaignRepo.createMetaObject(campaign.id, 'facebook_campaign', fbId, null, 'ACTIVE', ownerId)
    await campaignRepo.createMetaObject(campaign.id, 'ad_set', adsetId, null, 'ACTIVE', ownerId)
    await campaignRepo.createMetaObject(campaign.id, 'ad_creative', creativeId, null, null, ownerId)
    await campaignRepo.createMetaObject(campaign.id, 'ad', adId, null, 'ACTIVE', ownerId)
    const executionId = await execRepo.createExecution({
      campaignId: campaign.id,
      ownerUserId: ownerId,
      kind,
      status: 'creating',
      platformCampaignId: fbId,
      platformAdsetId: adsetId,
      platformCreativeId: creativeId,
      platformAdId: adId,
    })
    await campaignRepo.updateCampaignStatus(campaign.id, 'running')
    return { campaignId: campaign.id, fbId, adsetId, creativeId, adId, executionId }
  }

  async function issueRows(campaignId) {
    return campaignRepo.findMetaObjectIssuesByCampaignId(campaignId)
  }

  beforeAll(async () => {
    process.env.META_SYSTEM_USER_TOKEN = 'test_system_user_token'
    process.env.META_AD_ACCOUNT_ID = 'act_test_account'
    resetRateLimitState()
    client = await createTestUser({ email: `meta-iss-${dateTag}@flowx-test.com`, password: 'Test@123', coins: 10000 })
    partner = await createTestUser({ email: `meta-iss-partner-${dateTag}@flowx-test.com`, password: 'Test@123', coins: 10000 })
  })

  afterAll(async () => {
    for (const id of campaignIds) {
      await query('DELETE FROM campaigns WHERE id = ?', [uuidToBuffer(id)]).catch(() => {})
    }
  })

  it('persists issues_info per execution with the execution creative id', async () => {
    const seed = await seedCampaignWithExecution(client.id, tag('s'))
    metaMocks.listAccountAds.mockResolvedValue({
      rows: [{ id: seed.adId, status: 'PAUSED', effective_status: 'WITH_ISSUES', issues_info: [ISSUE_2875006, ISSUE_UNKNOWN] }],
      truncated: false,
    })
    await campaignService.syncAccountStatusJob('act_test_account')

    const rows = await issueRows(seed.campaignId)
    expect(rows).toHaveLength(2)
    const dim = rows.find(r => r.errorCode === '2875006')
    expect(dim).toMatchObject({
      executionId: seed.executionId,
      objectId: seed.adId,
      creativeId: seed.creativeId,
      level: 'AD',
      summary: 'Media not wide enough',
      errorType: 'HARD_ERROR',
      active: true,
    })
    expect(dim.message).toMatch(/500 pixels/)
    expect(dim.observedAt).toBeTruthy()
    expect(dim.clearedAt).toBeNull()
    expect(dim.executionKind).toBe('client')
    expect(dim.ownerUserId).toBe(client.id)

    const campaign = await campaignRepo.findCampaignById(seed.campaignId)
    expect(campaign.metaStatus).toBe('with_issues')
    expect(campaign.metaError).toMatch(/Media not wide enough/)
  })

  it('does not duplicate the same issue on repeat syncs and preserves observed_at', async () => {
    const seed = await seedCampaignWithExecution(client.id, tag('s'))
    const list = {
      rows: [{ id: seed.adId, status: 'PAUSED', effective_status: 'WITH_ISSUES', issues_info: [ISSUE_2875006] }],
      truncated: false,
    }
    metaMocks.listAccountAds.mockResolvedValue(list)
    await campaignService.syncAccountStatusJob('act_test_account')
    const first = await issueRows(seed.campaignId)
    expect(first).toHaveLength(1)

    await campaignService.syncAccountStatusJob('act_test_account')
    const second = await issueRows(seed.campaignId)
    expect(second).toHaveLength(1)
    expect(String(second[0].observedAt)).toBe(String(first[0].observedAt))
    expect(second[0].active).toBe(true)
  })

  it('clears issues that disappear and reactivates them without losing history', async () => {
    const seed = await seedCampaignWithExecution(client.id, tag('s'))
    metaMocks.listAccountAds.mockResolvedValue({
      rows: [{ id: seed.adId, status: 'PAUSED', effective_status: 'WITH_ISSUES', issues_info: [ISSUE_2875006] }],
      truncated: false,
    })
    await campaignService.syncAccountStatusJob('act_test_account')
    const before = (await issueRows(seed.campaignId))[0]
    expect(before.active).toBe(true)

    metaMocks.listAccountAds.mockResolvedValue({
      rows: [{ id: seed.adId, status: 'ACTIVE', effective_status: 'ACTIVE' }],
      truncated: false,
    })
    await campaignService.syncAccountStatusJob('act_test_account')
    const cleared = (await issueRows(seed.campaignId))[0]
    expect(cleared.active).toBe(false)
    expect(cleared.clearedAt).toBeTruthy()

    metaMocks.listAccountAds.mockResolvedValue({
      rows: [{ id: seed.adId, status: 'PAUSED', effective_status: 'WITH_ISSUES', issues_info: [ISSUE_2875006] }],
      truncated: false,
    })
    await campaignService.syncAccountStatusJob('act_test_account')
    const revived = (await issueRows(seed.campaignId))[0]
    expect(revived.active).toBe(true)
    expect(revived.clearedAt).toBeNull()
    expect(String(revived.observedAt)).toBe(String(before.observedAt))
    expect(await issueRows(seed.campaignId).then(r => r.length)).toBe(1)
  })

  it('keeps client and publisher issues independent on one campaign', async () => {
    const campaign = await campaignService.createCampaign(client.id, { name: `MetaIssueBoth ${tag('s')}`, type: 'post' })
    campaignIds.push(campaign.id)
    await campaignRepo.createCreative(generateUuid(), campaign.id, { caption: 'both', mediaUrl: 'https://example.com/b.jpg' })

    const mkChain = async (ownerId, suffix, kind) => {
      const fbId = `fb_both_${suffix}`
      const adId = `ad_both_${suffix}`
      const creativeId = `creative_both_${suffix}`
      await campaignRepo.createMetaObject(campaign.id, 'facebook_campaign', fbId, null, 'ACTIVE', ownerId)
      await campaignRepo.createMetaObject(campaign.id, 'ad_set', `adset_both_${suffix}`, null, 'ACTIVE', ownerId)
      await campaignRepo.createMetaObject(campaign.id, 'ad_creative', creativeId, null, null, ownerId)
      await campaignRepo.createMetaObject(campaign.id, 'ad', adId, null, 'ACTIVE', ownerId)
      const executionId = await execRepo.createExecution({
        campaignId: campaign.id, ownerUserId: ownerId, kind, status: 'creating',
        platformCampaignId: fbId, platformAdsetId: `adset_both_${suffix}`,
        platformCreativeId: creativeId, platformAdId: adId,
      })
      return { adId, executionId }
    }
    const c = await mkChain(client.id, tag('s'), 'client')
    const p = await mkChain(partner.id, tag('s'), 'publisher')
    await campaignRepo.updateCampaignStatus(campaign.id, 'running')

    metaMocks.listAccountAds.mockResolvedValue({
      rows: [
        { id: c.adId, status: 'PAUSED', effective_status: 'WITH_ISSUES', issues_info: [ISSUE_2875006] },
        { id: p.adId, status: 'PAUSED', effective_status: 'WITH_ISSUES', issues_info: [ISSUE_2875006] },
      ],
      truncated: false,
    })
    await campaignService.syncAccountStatusJob('act_test_account')

    const rows = await issueRows(campaign.id)
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map(r => r.executionId))).toEqual(new Set([c.executionId, p.executionId]))
    expect(new Set(rows.map(r => r.executionKind))).toEqual(new Set(['client', 'publisher']))
    expect(new Set(rows.map(r => r.ownerUserId))).toEqual(new Set([client.id, partner.id]))

    const detail = await campaignService.getCampaign(client.id, campaign.id)
    expect(Array.isArray(detail.metaIssues)).toBe(true)
    expect(detail.metaIssues).toHaveLength(2)
    expect(detail.metaIssues[0]).toMatchObject({ category: 'MEDIA_DIMENSION' })
    expect(detail.metaIssues[0].guidance).toMatch(/500px/)
    expect(detail.metaStatus).toBe('with_issues')
  })

  it('ingests issues through the per-campaign force-sync path', async () => {
    const seed = await seedCampaignWithExecution(client.id, tag('s'))
    metaMocks.getObjectStatus.mockResolvedValue({
      status: 'PAUSED', effective_status: 'WITH_ISSUES', issues_info: [ISSUE_2875006],
    })
    await campaignService.syncCampaignStatusJob(seed.campaignId)
    const rows = await issueRows(seed.campaignId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ errorCode: '2875006', executionId: seed.executionId, active: true })
    metaMocks.getObjectStatus.mockResolvedValue({ status: 'ACTIVE', effective_status: 'ACTIVE' })
  })

  it('skips persistence when no execution owns the ad', async () => {
    const seed = await seedCampaignWithExecution(client.id, tag('s'))
    await query('DELETE FROM campaign_executions WHERE id = ?', [uuidToBuffer(seed.executionId)])
    metaMocks.listAccountAds.mockResolvedValue({
      rows: [{ id: seed.adId, status: 'PAUSED', effective_status: 'WITH_ISSUES', issues_info: [ISSUE_2875006] }],
      truncated: false,
    })
    await campaignService.syncAccountStatusJob('act_test_account')
    expect(await issueRows(seed.campaignId)).toHaveLength(0)
    const campaign = await campaignRepo.findCampaignById(seed.campaignId)
    expect(campaign.metaStatus).toBe('with_issues')
  })

  it('returns an empty issue list for campaigns without issues', async () => {
    const campaign = await campaignService.createCampaign(client.id, { name: `MetaIssueEmpty ${tag('s')}`, type: 'post' })
    campaignIds.push(campaign.id)
    const detail = await campaignService.getCampaign(client.id, campaign.id)
    expect(detail.metaIssues).toEqual([])
  })
})
