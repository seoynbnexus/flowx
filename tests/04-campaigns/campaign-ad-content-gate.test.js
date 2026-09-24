import { describe, it, expect, beforeAll, vi } from 'vitest'
import { generateUuid, uuidToBuffer, bufferToUuid } from '../../shared/utils/uuid.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import * as campaignService from '../../src/modules/campaigns/campaign.service.js'
import * as campaignRepo from '../../src/modules/campaigns/campaign.repository.js'
import * as subRepo from '../../src/modules/subscriptions/subscription.repository.js'
import { queryOne, query } from '../../shared/database/connection.js'
import { drainCampaignJobs } from '../../src/modules/campaigns/campaign.jobs.js'
import { ValidationError } from '../../shared/errors/AppError.js'
import { adMediaGate } from '../../shared/services/ad-content-validation.js'

// Only used by the transient-media-fetch-failure test below — every other
// test in this file relies on either no mediaUrl or a CTA failure that
// short-circuits before any network call, so leaving adMediaGate disabled
// (its test-env default) for them is unaffected by this mock's presence.
var fetchMediaMock
vi.mock('../../shared/services/media-url.js', async () => {
  const actual = await vi.importActual('../../shared/services/media-url.js')
  fetchMediaMock = vi.fn()
  return { ...actual, fetchBoundedBytes: fetchMediaMock, inspectMediaSize: vi.fn().mockResolvedValue({ status: 'UNKNOWN_SIZE', sizeBytes: null }) }
})

// Proves the front-line ad-content gate (shared/services/ad-content-validation.js,
// wired into routeOwnerChainCreation) blocks invalid ad content — using an invalid
// call-to-action stored directly via the repository (bypassing the zod schema, the
// same way stale/legacy data could already exist) — across every go-live path,
// with zero Meta object-creation calls, before this change existed only the
// optional "Validate Draft" button ever ran this check.
var metaMocks
vi.mock('../../shared/services/meta-ads.service.js', async () => {
  const actual = await vi.importActual('../../shared/services/meta-ads.service.js')
  const mocks = {
    ...actual,
    __counter: 0,
    __nextMetaId: (prefix) => {
      mocks.__counter += 1
      return `${prefix}_${mocks.__counter}`
    },
    createAdCampaign: vi.fn().mockImplementation(async () => ({ id: mocks.__nextMetaId('gatecheck_campaign') })),
    createAdSet: vi.fn().mockImplementation(async () => ({ id: mocks.__nextMetaId('gatecheck_adset') })),
    createAdCreative: vi.fn().mockImplementation(async () => ({ id: mocks.__nextMetaId('gatecheck_creative') })),
    createAd: vi.fn().mockImplementation(async () => ({ id: mocks.__nextMetaId('gatecheck_ad') })),
    updateAdStatus: vi.fn().mockResolvedValue({ success: true }),
    deleteAd: vi.fn().mockResolvedValue({}),
    deleteAdSet: vi.fn().mockResolvedValue({}),
    deleteAdCreative: vi.fn().mockResolvedValue({}),
    deleteAdCampaign: vi.fn().mockResolvedValue({}),
    getObjectStatus: vi.fn().mockResolvedValue({ status: 'ACTIVE', effective_status: 'ACTIVE' }),
    getMetaObject: vi.fn().mockImplementation(async id => ({ id })),
    listAccountCampaigns: vi.fn().mockResolvedValue({ rows: [], truncated: false }),
    listCampaignAdSets: vi.fn().mockResolvedValue({ rows: [], truncated: false }),
    listAdSetAds: vi.fn().mockResolvedValue({ rows: [], truncated: false }),
  }
  metaMocks = mocks
  return mocks
})

const dateTag = Date.now()
let counter = 0

async function ensurePlan(userId) {
  const sub = await subRepo.findUserSubscription(userId)
  if (sub) return
  const starterPlan = await subRepo.findPlanBySlug('starter')
  if (starterPlan) {
    await subRepo.upsertUserSubscription(userId, starterPlan.id, {
      status: 'active',
      billingCycle: 'monthly',
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    })
  }
}

async function createGateClient() {
  counter += 1
  const user = await createTestUser({
    email: `camp-gate-${dateTag}-${counter}@flowx-test.com`,
    password: 'Test@123',
    coins: 10000,
  })
  await ensurePlan(user.id)
  const fbPlatform = await queryOne("SELECT id FROM platforms WHERE code = 'facebook'")
  if (fbPlatform) {
    const platformId = bufferToUuid(fbPlatform.id)
    await query(
      `INSERT INTO user_platform_accounts (id, user_id, platform_id, profile_url, platform_user_id, platform_username, token_type, token_expires_at, verification_status)
       VALUES (?, ?, ?, ?, ?, ?, 'page', DATE_ADD(NOW(), INTERVAL 60 DAY), 'verified')`,
      [uuidToBuffer(generateUuid()), uuidToBuffer(user.id), uuidToBuffer(platformId), 'https://fb.com/test', `fb_gate_${dateTag}_${counter}`, 'GatePage']
    )
  }
  return user
}

function resetMetaMocks() {
  metaMocks.createAdCampaign.mockClear()
  metaMocks.createAdSet.mockClear()
  metaMocks.createAdCreative.mockClear()
  metaMocks.createAd.mockClear()
  metaMocks.updateAdStatus.mockClear()
}

describe('campaign ad-content gate (routeOwnerChainCreation single choke point)', () => {
  let admin

  beforeAll(async () => {
    process.env.META_SYSTEM_USER_TOKEN = process.env.META_SYSTEM_USER_TOKEN || 'test_system_user_token'
    process.env.META_AD_ACCOUNT_ID = process.env.META_AD_ACCOUNT_ID || 'act_test_account'
    const adminRow = await queryOne("SELECT id FROM users WHERE email = 'admin@flowx.com'")
    admin = { id: adminRow ? bufferToUuid(adminRow.id) : null }
  })

  it('approveAndGoLive blocks an invalid call-to-action before any Meta object is created', async () => {
    resetMetaMocks()
    const client = await createGateClient()
    const campaign = await campaignService.createCampaign(client.id, {
      name: `Gate Bad CTA ${generateUuid().substring(0, 8)}`,
      type: 'post',
    })
    await campaignRepo.createCreative(generateUuid(), campaign.id, {
      caption: 'gate test',
      mediaUrl: 'https://example.com/img.jpg',
      callToAction: 'NOT_A_REAL_CTA',
    })
    await campaignService.submitCampaign(client.id, campaign.id)

    const approved = await campaignService.approveCampaign(admin?.id || client.id, campaign.id, {})
    expect(approved.queued).toBe(true)
    await drainCampaignJobs()

    expect(metaMocks.createAdCreative).not.toHaveBeenCalled()
    expect(metaMocks.createAdCampaign).not.toHaveBeenCalled()
    expect(metaMocks.createAdSet).not.toHaveBeenCalled()
    expect(metaMocks.createAd).not.toHaveBeenCalled()
    expect(await campaignRepo.findMetaObjectsByCampaignId(campaign.id)).toEqual([])

    const updated = await campaignRepo.findCampaignById(campaign.id)
    expect(updated.status).toBe('pending_review')
    expect(updated.metaStatus).toBe('failed')
    expect(updated.metaError).toMatch(/not a supported call-to-action/)
  })

  it('approveAndGoLive still succeeds end-to-end with valid content (regression)', async () => {
    resetMetaMocks()
    const client = await createGateClient()
    const campaign = await campaignService.createCampaign(client.id, {
      name: `Gate Ok ${generateUuid().substring(0, 8)}`,
      type: 'post',
    })
    await campaignRepo.createCreative(generateUuid(), campaign.id, {
      caption: 'gate test',
      // No mediaUrl: keeps this a pure wiring/choke-point regression test
      // (media content probing itself is covered by ad-content-validation.test.js
      // and media-dimensions.test.js) — checkAdMediaForMeta short-circuits to a
      // pass with no network call when there is no media URL at all.
      callToAction: 'LEARN_MORE',
    })
    await campaignRepo.createMetaSettings(generateUuid(), campaign.id, {
      objective: 'OUTCOME_TRAFFIC',
      budgetAmount: 500,
      endTime: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString(),
    })
    await campaignService.submitCampaign(client.id, campaign.id)

    const approved = await campaignService.approveCampaign(admin?.id || client.id, campaign.id, {})
    expect(approved.queued).toBe(true)
    await drainCampaignJobs()

    expect(metaMocks.createAdCreative).toHaveBeenCalled()
    expect(metaMocks.createAdCampaign).toHaveBeenCalled()

    const updated = await campaignRepo.findCampaignById(campaign.id)
    expect(updated.status).toBe('running')
    expect(updated.metaStatus).toBe('created')
  })

  // Regression for a live production bug: a transient network/timeout hiccup
  // fetching the ad's media during the pre-flight verification gate (Meta
  // was never even contacted yet) was classified identically to "this file
  // is genuinely broken" — permanent, job dies, requiring manual admin
  // intervention for what was really just a momentary blip. The gate's own
  // error message literally says "please retry"; this proves the classifier
  // actually honors that now.
  it('a transient media-fetch failure throws a retryable Error (job backoff), not a permanent ValidationError (dead job)', async () => {
    resetMetaMocks()
    const client = await createGateClient()
    const campaign = await campaignService.createCampaign(client.id, {
      name: `Gate Transient ${generateUuid().substring(0, 8)}`,
      type: 'post',
    })
    await campaignRepo.createCreative(generateUuid(), campaign.id, {
      caption: 'gate test',
      mediaUrl: 'https://example.com/flaky.jpg',
      callToAction: 'LEARN_MORE',
    })
    await campaignRepo.createMetaSettings(generateUuid(), campaign.id, {
      objective: 'OUTCOME_TRAFFIC',
      budgetAmount: 500,
      endTime: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString(),
    })
    await campaignService.submitCampaign(client.id, campaign.id)

    fetchMediaMock.mockReset().mockRejectedValue(new Error('ETIMEDOUT'))
    const originalEnabled = adMediaGate.enabled
    adMediaGate.enabled = true
    let caught = null
    try {
      await campaignService.approveAndGoLive(campaign.id, admin?.id || client.id, {})
    } catch (err) {
      caught = err
    } finally {
      adMediaGate.enabled = originalEnabled
    }

    expect(caught).toBeTruthy()
    expect(caught).not.toBeInstanceOf(ValidationError)
    expect(caught.message).toMatch(/Could not verify media/)
    expect(metaMocks.createAdCampaign).not.toHaveBeenCalled()
  })

  it('forceGoLiveCampaign blocks an invalid call-to-action for the client leg (stays awaiting_publishers)', async () => {
    resetMetaMocks()
    const client = await createGateClient()
    const campaign = await campaignService.createCampaign(client.id, {
      name: `Gate Force Bad ${generateUuid().substring(0, 8)}`,
      type: 'post',
      publisherCount: 1,
      coinsPerPublisher: 100,
    })
    await campaignRepo.createCreative(generateUuid(), campaign.id, {
      caption: 'gate test',
      mediaUrl: 'https://example.com/img.jpg',
      callToAction: 'STILL_NOT_REAL',
    })
    await campaignRepo.createMetaSettings(generateUuid(), campaign.id, {
      objective: 'OUTCOME_TRAFFIC',
      budgetType: 'lifetime',
      budgetAmount: 500,
      endTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    })
    await campaignRepo.updateCampaign(campaign.id, { status: 'awaiting_publishers' })

    await expect(
      campaignService.forceGoLiveCampaign(admin?.id ?? null, campaign.id)
    ).rejects.toThrow(/not a supported call-to-action/)

    expect(metaMocks.createAdCreative).not.toHaveBeenCalled()
    expect(metaMocks.createAdCampaign).not.toHaveBeenCalled()

    const updated = await campaignRepo.findCampaignById(campaign.id)
    expect(updated.status).toBe('awaiting_publishers')
  })

  it('retryCampaignMeta throws (job-queue-visible failure) without calling Meta when content is invalid and nothing else was fixed', async () => {
    resetMetaMocks()
    const client = await createGateClient()
    const campaign = await campaignService.createCampaign(client.id, {
      name: `Gate Retry Bad ${generateUuid().substring(0, 8)}`,
      type: 'post',
    })
    await campaignRepo.createCreative(generateUuid(), campaign.id, {
      caption: 'gate test',
      mediaUrl: 'https://example.com/img.jpg',
      callToAction: 'BOGUS',
    })

    await expect(campaignService.retryCampaignMeta(campaign.id)).rejects.toThrow(/not a supported call-to-action/)
    expect(metaMocks.createAdCreative).not.toHaveBeenCalled()
    expect(metaMocks.createAdCampaign).not.toHaveBeenCalled()
  })

  it('publisher-flow approve rejects an invalid call-to-action before staging any execution or job', async () => {
    resetMetaMocks()
    const cat = await queryOne("SELECT id FROM ad_categories WHERE code = 'technology'")
    expect(cat).toBeTruthy()
    const client = await createGateClient()
    const campaign = await campaignService.createCampaign(client.id, {
      name: `Gate Pub Bad ${generateUuid().substring(0, 8)}`,
      type: 'post',
      categoryId: bufferToUuid(cat.id),
      publisherCount: 1,
      coinsPerPublisher: 50,
    })
    await campaignRepo.createCreative(generateUuid(), campaign.id, {
      caption: 'gate test',
      mediaUrl: 'https://example.com/img.jpg',
      callToAction: 'INVALID_CTA_VALUE',
    })
    await campaignRepo.createMetaSettings(generateUuid(), campaign.id, {
      objective: 'OUTCOME_TRAFFIC',
      budgetType: 'lifetime',
      budgetAmount: 500,
      endTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    })
    await campaignService.submitCampaign(client.id, campaign.id)

    await expect(
      campaignService.approveCampaign(admin?.id || client.id, campaign.id, {})
    ).rejects.toThrow(/not a supported call-to-action/)

    expect(metaMocks.createAd).not.toHaveBeenCalled()
    expect(metaMocks.createAdSet).not.toHaveBeenCalled()

    const jobs = await query(
      "SELECT * FROM campaign_jobs WHERE campaign_id = ? AND job_type = 'approve_publisher'",
      [uuidToBuffer(campaign.id)]
    )
    expect(jobs).toHaveLength(0)
  })
})
