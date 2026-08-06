import { describe, it, expect, beforeAll, vi } from 'vitest'
import { generateUuid, uuidToBuffer, bufferToUuid } from '../../shared/utils/uuid.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import * as campaignService from '../../src/modules/campaigns/campaign.service.js'
import * as campaignRepo from '../../src/modules/campaigns/campaign.repository.js'
import * as subRepo from '../../src/modules/subscriptions/subscription.repository.js'
import { queryOne, query } from '../../shared/database/connection.js'
import { drainCampaignJobs } from '../../src/modules/campaigns/campaign.jobs.js'
import { sendPublisherRepublishNotification } from '../../shared/mailer/alert.mailer.js'

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
    createAdCampaign: vi.fn().mockImplementation(async () => ({ id: mocks.__nextMetaId('mock_campaign') })),
    createAdSet: vi.fn().mockImplementation(async () => ({ id: mocks.__nextMetaId('mock_adset') })),
    createAdCreative: vi.fn().mockImplementation(async () => ({ id: mocks.__nextMetaId('mock_creative') })),
    createAd: vi.fn().mockImplementation(async () => ({ id: mocks.__nextMetaId('mock_ad') })),
    updateAdStatus: vi.fn().mockResolvedValue({ success: true }),
    deleteAd: vi.fn().mockResolvedValue({}),
    deleteAdSet: vi.fn().mockResolvedValue({}),
    deleteAdCreative: vi.fn().mockResolvedValue({}),
    deleteAdCampaign: vi.fn().mockResolvedValue({}),
    searchMeta: vi.fn().mockResolvedValue([]),
    getObjectStatus: vi.fn().mockResolvedValue({ status: 'ACTIVE', effective_status: 'ACTIVE' }),
  }
  metaMocks = mocks
  return mocks
})

const dateTag = Date.now()

async function ensurePlan(userId) {
  const sub = await subRepo.findUserSubscription(userId)
  if (sub) return
  const planSlug = 'starter'
  const starterPlan = await subRepo.findPlanBySlug(planSlug)
  if (starterPlan) {
    await subRepo.upsertUserSubscription(userId, starterPlan.id, {
      status: 'active',
      billingCycle: 'monthly',
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    })
  }
}

describe('campaign lifecycle', () => {
  let client, admin, campaignId

  beforeAll(async () => {
    client = await createTestUser({
      email: `camp-client-${dateTag}@flowx-test.com`,
      password: 'Test@123',
      coins: 10000,
    })
    await ensurePlan(client.id)

    const fbPlatform = await queryOne("SELECT id FROM platforms WHERE code = 'facebook'")
    if (fbPlatform) {
      const platformId = bufferToUuid(fbPlatform.id)
      await query(
        `INSERT INTO user_platform_accounts (id, user_id, platform_id, profile_url, platform_user_id, platform_username, token_type, token_expires_at, verification_status)
         VALUES (?, ?, ?, ?, ?, ?, 'page', DATE_ADD(NOW(), INTERVAL 60 DAY), 'verified')`,
        [uuidToBuffer(generateUuid()), uuidToBuffer(client.id), uuidToBuffer(platformId), 'https://fb.com/test', 'test_fb_page_123', 'TestPage']
      )
    }

    const adminRow = await queryOne("SELECT id FROM users WHERE email = 'admin@flowx.com'")
    admin = { id: adminRow ? bufferToUuid(adminRow.id) : null }
  })

  it('should create a campaign in draft status', async () => {
    const campaign = await campaignService.createCampaign(client.id, {
      name: `Lifecycle Test ${dateTag}`,
      type: 'post',
      publisherCount: 2,
      coinsPerPublisher: 100,
    })
    expect(campaign.status).toBe('draft')
    expect(campaign.clientId).toBe(client.id)
    campaignId = campaign.id
  })

  it('should get campaign details', async () => {
    const campaign = await campaignService.getCampaign(client.id, campaignId)
    expect(campaign.name).toContain('Lifecycle Test')
    expect(campaign.creative).toBeNull()
    expect(Array.isArray(campaign.reviewLog)).toBe(true)
  })

  it('should reject access to other user\'s campaign', async () => {
    const otherUser = await createTestUser({
      email: `camp-other-${dateTag}@flowx-test.com`,
      password: 'Test@123',
    })
    await expect(
      campaignService.getCampaign(otherUser.id, campaignId)
    ).rejects.toThrow(/access/i)
  })

  it('should list client campaigns', async () => {
    const result = await campaignService.listCampaigns(client.id, {})
    expect(Array.isArray(result.items)).toBe(true)
  })

  it('should update draft campaign', async () => {
    const updated = await campaignService.updateCampaign(client.id, campaignId, { name: 'Updated Lifecycle' })
    expect(updated.name).toBe('Updated Lifecycle')
  })

  it('should reject updating non-existent campaign', async () => {
    await expect(
      campaignService.updateCampaign(client.id, generateUuid(), { name: 'Nope' })
    ).rejects.toThrow(/not found/i)
  })

  it('should save creative', async () => {
    await campaignService.saveCreative(client.id, campaignId, {
      caption: 'Test caption for lifecycle',
      mediaUrl: 'https://example.com/img.jpg',
    })
    const campaign = await campaignService.getCampaign(client.id, campaignId)
    expect(campaign.creative.caption).toBe('Test caption for lifecycle')
  })

  it('should reject submit without creative', async () => {
    const newCampaign = await campaignService.createCampaign(client.id, {
      name: `No Creative ${dateTag}`,
      type: 'post',
    })
    await expect(
      campaignService.submitCampaign(client.id, newCampaign.id)
    ).rejects.toThrow(/caption|media/i)
  })

  it('should submit campaign for review', async () => {
    const result = await campaignService.submitCampaign(client.id, campaignId)
    expect(result.status).toBe('pending_review')
  })

  it('should allow editing pending_review campaign and reset to draft', async () => {
    const updated = await campaignService.updateCampaign(client.id, campaignId, { name: 'Edited After Submit' })
    expect(updated.name).toBe('Edited After Submit')
    expect(updated.status).toBe('draft')
  })

  it('should reject duplicate submit', async () => {
    await campaignService.submitCampaign(client.id, campaignId)
    await expect(
      campaignService.submitCampaign(client.id, campaignId)
    ).rejects.toThrow(/transition/i)
  })

  it('should reject campaign by admin', async () => {
    if (!admin.id) return
    const result = await campaignService.rejectCampaign(admin.id, campaignId, { notes: 'Test rejection' })
    expect(result.status).toBe('rejected')
  })

  it('should allow editing rejected campaign and reset to draft', async () => {
    const updated = await campaignService.updateCampaign(client.id, campaignId, { name: 'Edited After Reject' })
    expect(updated.name).toBe('Edited After Reject')
    expect(updated.status).toBe('draft')
  })

  it('should reject editing approved campaign', async () => {
    const tempCampaign = await campaignService.createCampaign(client.id, {
      name: `Approved Block ${dateTag}`,
      type: 'post',
    })
    const creativeId = generateUuid()
    await campaignRepo.createCreative(creativeId, tempCampaign.id, { caption: 'Approve test', mediaUrl: 'https://example.com/img.jpg' })
    await campaignService.submitCampaign(client.id, tempCampaign.id)

    if (admin.id) {
      await campaignService.approveCampaign(admin.id, tempCampaign.id, {})
      await drainCampaignJobs()
    }

    await expect(
      campaignService.updateCampaign(client.id, tempCampaign.id, { name: 'Blocked' })
    ).rejects.toThrow(/current status/i)
  })

  it('should allow editing failed campaign, reset to draft, and propagate to publishers', async () => {
    const failedUser = await createTestUser({
      email: `camp-failed-${dateTag}@flowx-test.com`,
      password: 'Test@123',
      coins: 5000,
    })
    await ensurePlan(failedUser.id)

    const failedCampaign = await campaignService.createCampaign(failedUser.id, {
      name: `Failed Edit ${dateTag}`,
      type: 'post',
    })
    await campaignRepo.createCreative(generateUuid(), failedCampaign.id, { caption: 'Failed caption', mediaUrl: 'https://example.com/f.jpg' })

    const publisher = await createTestUser({
      email: `camp-failed-pub-${dateTag}@flowx-test.com`,
      password: 'Test@123',
      coins: 100,
    })

    await campaignRepo.createPublisherRequests(failedCampaign.id, [publisher.id], 100)
    const requests = await campaignRepo.findPublisherRequestsByCampaignId(failedCampaign.id)
    const requestId = requests[0].id
    await campaignRepo.updatePublisherRequestStatus(requestId, 'accepted', new Date())
    await campaignRepo.updatePublisherRequestPublished(requestId)

    await campaignRepo.updateCampaign(failedCampaign.id, { status: 'failed' })
    await campaignRepo.updateCampaign(failedCampaign.id, { metaStatus: 'failed' })

    const updated = await campaignService.updateCampaign(failedUser.id, failedCampaign.id, { name: 'Failed Edited' })
    expect(updated.name).toBe('Failed Edited')
    expect(updated.status).toBe('draft')

    const afterRequests = await campaignRepo.findPublisherRequestsByCampaignId(failedCampaign.id)
    expect(afterRequests[0].status).toBe('pending_republish')
    expect(afterRequests[0].creativeSnapshot).toBeTruthy()
    expect(sendPublisherRepublishNotification).toHaveBeenCalledWith(publisher.id, failedCampaign.id, expect.any(String))
  })

  it('should reject editing archived campaign', async () => {
    const archivedUser = await createTestUser({
      email: `camp-archived-${dateTag}@flowx-test.com`,
      password: 'Test@123',
      coins: 5000,
    })
    await ensurePlan(archivedUser.id)
    const archivedCampaign = await campaignService.createCampaign(archivedUser.id, {
      name: `Archived Block ${dateTag}`,
      type: 'post',
    })
    await campaignRepo.updateCampaign(archivedCampaign.id, { status: 'archived' })
    await expect(
      campaignService.updateCampaign(archivedUser.id, archivedCampaign.id, { name: 'Blocked' })
    ).rejects.toThrow(/current status/i)
  })

  it('should cancel a campaign', async () => {
    const cancelUser = await createTestUser({
      email: `camp-cancel-${dateTag}@flowx-test.com`,
      password: 'Test@123',
      coins: 5000,
    })
    await ensurePlan(cancelUser.id)

    const newCampaign = await campaignService.createCampaign(cancelUser.id, {
      name: `Cancel Test ${dateTag}`,
      type: 'post',
    })
    const creativeId = generateUuid()
    await campaignRepo.createCreative(creativeId, newCampaign.id, { caption: 'Cancel test', mediaUrl: 'https://example.com/img.jpg' })

    await campaignService.submitCampaign(cancelUser.id, newCampaign.id)
    await campaignService.rejectCampaign(admin?.id || cancelUser.id, newCampaign.id, { notes: 'Rejected for cancel test' })

    const result = await campaignService.cancelCampaign(cancelUser.id, newCampaign.id)
    expect(result.status).toBe('cancelled')
  })

  it('should reject cancel from wrong user', async () => {
    const wrongUser = await createTestUser({
      email: `camp-wrong-cancel-${dateTag}@flowx-test.com`,
      password: 'Test@123',
    })
    await expect(
      campaignService.cancelCampaign(wrongUser.id, campaignId)
    ).rejects.toThrow(/your campaign/i)
  })

  it('should sync Meta paused status and update campaign', async () => {
    const campaign = await campaignService.createCampaign(client.id, {
      name: `Sync Pause Test ${dateTag}`,
      type: 'post',
    })
    const creativeId = generateUuid()
    await campaignRepo.createCreative(creativeId, campaign.id, { caption: 'Sync pause test', mediaUrl: 'https://example.com/img.jpg' })

    await campaignService.submitCampaign(client.id, campaign.id)
    await campaignService.approveCampaign(admin?.id || client.id, campaign.id, {})
    await drainCampaignJobs()

    metaMocks.getObjectStatus.mockResolvedValue({ status: 'PAUSED', effective_status: 'PAUSED' })

    const result = await campaignService.syncCampaignStatusJob(campaign.id)
    expect(result.success).toBe(true)
    expect(result.result.statusAfter).toBe('paused')
    expect(result.result.statusChanged).toBe(true)

    const updated = await campaignRepo.findCampaignById(campaign.id)
    expect(updated.status).toBe('paused')
  })

  it('should sync Meta active status and resume campaign with spend', async () => {
    const campaign = await campaignService.createCampaign(client.id, {
      name: `Sync Resume Test ${dateTag}`,
      type: 'post',
    })
    const creativeId = generateUuid()
    await campaignRepo.createCreative(creativeId, campaign.id, { caption: 'Sync resume test', mediaUrl: 'https://example.com/img.jpg' })

    await campaignService.submitCampaign(client.id, campaign.id)
    await campaignService.approveCampaign(admin?.id || client.id, campaign.id, {})
    await drainCampaignJobs()

    metaMocks.getObjectStatus.mockResolvedValue({ status: 'PAUSED', effective_status: 'PAUSED' })
    await campaignService.syncCampaignStatusJob(campaign.id)

    const paused = await campaignRepo.findCampaignById(campaign.id)
    expect(paused.status).toBe('paused')

    metaMocks.getObjectStatus.mockResolvedValue({ status: 'ACTIVE', effective_status: 'ACTIVE' })

    const result = await campaignService.syncCampaignStatusJob(campaign.id)
    expect(result.success).toBe(true)
    expect(result.result.statusAfter).toBe('running')
    expect(result.result.statusChanged).toBe(true)

    const updated = await campaignRepo.findCampaignById(campaign.id)
    expect(updated.status).toBe('running')
  })

  describe('meta validate_only pre-flight', () => {
    const resetCreateMocks = () => {
      metaMocks.createAdCampaign.mockReset().mockResolvedValue({ id: 'mock_campaign' })
      metaMocks.createAdSet.mockReset().mockResolvedValue({ id: 'mock_adset' })
      metaMocks.createAdCreative.mockReset().mockResolvedValue({ id: 'mock_creative' })
      metaMocks.createAd.mockReset().mockResolvedValue({ id: 'mock_ad' })
      metaMocks.deleteAd.mockClear()
      metaMocks.deleteAdSet.mockClear()
      metaMocks.deleteAdCreative.mockClear()
      metaMocks.deleteAdCampaign.mockClear()
    }

    const failValidate = (fnName, userMsg) => {
      metaMocks[fnName].mockImplementation((...args) => {
        if (args[args.length - 1] === true) {
          return Promise.reject(new Error(`Graph API POST act_1/${fnName} failed: ${JSON.stringify({ error: { error_user_msg: userMsg, error_subcode: 100 } })}`))
        }
        return Promise.resolve({ id: 'mock_object' })
      })
    }

    let valUserCounter = 0

    const createCampaignClient = async () => {
      valUserCounter += 1
      const user = await createTestUser({
        email: `camp-val-${dateTag}-${valUserCounter}@flowx-test.com`,
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
          [uuidToBuffer(generateUuid()), uuidToBuffer(user.id), uuidToBuffer(platformId), 'https://fb.com/test', `fb_page_${dateTag}_${valUserCounter}`, 'ValPage']
        )
      }
      return user
    }

    const createReadyCampaign = async () => {
      const testClient = await createCampaignClient()
      const campaign = await campaignService.createCampaign(testClient.id, {
        name: `Validate ${generateUuid().substring(0, 8)}`,
        type: 'post',
        publisherCount: 2,
        coinsPerPublisher: 100,
      })
      await campaignRepo.createCreative(generateUuid(), campaign.id, { caption: 'Validate caption', mediaUrl: 'https://example.com/img.jpg' })
      await campaignService.submitCampaign(testClient.id, campaign.id)
      return { campaign, clientId: testClient.id }
    }

    beforeEach(resetCreateMocks)

    it('should surface creative validation failure before creating anything', async () => {
      failValidate('createAdCreative', 'The Page ID specified in object story spec is invalid')
      const { campaign, clientId } = await createReadyCampaign()

      const approved = await campaignService.approveCampaign(admin?.id || clientId, campaign.id, {})
      expect(approved.queued).toBe(true)
      await drainCampaignJobs()

      expect(metaMocks.createAdCampaign).not.toHaveBeenCalled()
      expect(metaMocks.createAdSet).not.toHaveBeenCalled()
      expect(metaMocks.createAd).not.toHaveBeenCalled()
      expect(await campaignRepo.findMetaObjectsByCampaignId(campaign.id)).toEqual([])

      const updated = await campaignRepo.findCampaignById(campaign.id)
      expect(updated.status).toBe('pending_review')
      expect(updated.metaStatus).toBe('failed')
      expect(updated.metaError).toContain('The Page ID specified in object story spec is invalid')
    })

    it('should surface campaign validation failure before creating anything', async () => {
      failValidate('createAdCampaign', 'The campaign spending limit must be at least ₹5,000.00 for this currency')
      const { campaign, clientId } = await createReadyCampaign()

      const approved = await campaignService.approveCampaign(admin?.id || clientId, campaign.id, {})
      expect(approved.queued).toBe(true)
      await drainCampaignJobs()

      expect(metaMocks.createAdSet).not.toHaveBeenCalled()
      expect(metaMocks.createAdCreative).toHaveBeenCalledTimes(1)
      expect(metaMocks.createAd).not.toHaveBeenCalled()
      expect(await campaignRepo.findMetaObjectsByCampaignId(campaign.id)).toEqual([])

      const updated = await campaignRepo.findCampaignById(campaign.id)
      expect(updated.status).toBe('pending_review')
      expect(updated.metaStatus).toBe('failed')
      expect(updated.metaError).toContain('₹5,000')
    })

    it('should roll back the campaign when ad set validation fails', async () => {
      failValidate('createAdSet', 'Some locations conflict with each other')
      const { campaign, clientId } = await createReadyCampaign()

      const approved = await campaignService.approveCampaign(admin?.id || clientId, campaign.id, {})
      expect(approved.queued).toBe(true)
      await drainCampaignJobs()

      expect(metaMocks.createAdCampaign).toHaveBeenCalledTimes(2)
      expect(metaMocks.createAdSet).toHaveBeenCalledTimes(1)
      expect(metaMocks.createAdCreative).toHaveBeenCalledTimes(1)
      expect(metaMocks.createAd).not.toHaveBeenCalled()

      expect(metaMocks.deleteAdCampaign).toHaveBeenCalledWith('mock_campaign', expect.anything())
      expect(await campaignRepo.findMetaObjectsByCampaignId(campaign.id)).toEqual([])

      const updated = await campaignRepo.findCampaignById(campaign.id)
      expect(updated.status).toBe('pending_review')
      expect(updated.metaStatus).toBe('failed')
      expect(updated.metaError).toContain('Some locations conflict with each other')
    })

    it('should roll back creative, ad set and campaign when ad validation fails', async () => {
      failValidate('createAd', 'No payment method')
      const { campaign, clientId } = await createReadyCampaign()

      const approved = await campaignService.approveCampaign(admin?.id || clientId, campaign.id, {})
      expect(approved.queued).toBe(true)
      await drainCampaignJobs()

      expect(metaMocks.createAdCampaign).toHaveBeenCalledTimes(2)
      expect(metaMocks.createAdSet).toHaveBeenCalledTimes(2)
      expect(metaMocks.createAdCreative).toHaveBeenCalledTimes(2)
      expect(metaMocks.createAd).toHaveBeenCalledTimes(1)

      expect(metaMocks.deleteAdCreative).toHaveBeenCalledWith('mock_creative', expect.anything())
      expect(metaMocks.deleteAdSet).toHaveBeenCalledWith('mock_adset', expect.anything())
      expect(metaMocks.deleteAdCampaign).toHaveBeenCalledWith('mock_campaign', expect.anything())
      expect(await campaignRepo.findMetaObjectsByCampaignId(campaign.id)).toEqual([])

      const updated = await campaignRepo.findCampaignById(campaign.id)
      expect(updated.status).toBe('pending_review')
      expect(updated.metaStatus).toBe('failed')
      expect(updated.metaError).toContain('No payment method')
    })

    it('should run validate_only before real creation and publish successfully', async () => {
      const { campaign, clientId } = await createReadyCampaign()

      const approved = await campaignService.approveCampaign(admin?.id || clientId, campaign.id, {})
      expect(approved.queued).toBe(true)
      await drainCampaignJobs()

      for (const fnName of ['createAdCampaign', 'createAdSet', 'createAdCreative', 'createAd']) {
        const calls = metaMocks[fnName].mock.calls
        expect(calls).toHaveLength(2)
        expect(calls[0][calls[0].length - 1]).toBe(true)
        expect(calls[1][calls[1].length - 1]).not.toBe(true)
      }

      const objects = await campaignRepo.findMetaObjectsByCampaignId(campaign.id)
      expect(objects).toHaveLength(4)

      const updated = await campaignRepo.findCampaignById(campaign.id)
      expect(updated.status).toBe('running')
    })
  })

  describe('meta pre-validate (validateCampaignDraft)', () => {
    let preValCounter = 0

    const resetValidateMocks = () => {
      metaMocks.createAdCampaign.mockReset().mockResolvedValue({ id: 'mock_campaign' })
      metaMocks.createAdCreative.mockReset().mockResolvedValue({ id: 'mock_creative' })
      metaMocks.createAdSet.mockClear()
      metaMocks.createAd.mockClear()
      metaMocks.deleteAd.mockClear()
      metaMocks.deleteAdSet.mockClear()
      metaMocks.deleteAdCreative.mockClear()
      metaMocks.deleteAdCampaign.mockClear()
    }

    const failValidateFn = (fnName, userMsg) => {
      metaMocks[fnName].mockImplementation((...args) => {
        if (args[args.length - 1] === true) {
          return Promise.reject(new Error(`Graph API POST act_1/${fnName} failed: ${JSON.stringify({ error: { error_user_msg: userMsg, error_subcode: 100 } })}`))
        }
        return Promise.resolve({ id: 'mock_object' })
      })
    }

    const createPreValidateClient = async () => {
      preValCounter += 1
      const user = await createTestUser({
        email: `camp-preval-${dateTag}-${preValCounter}@flowx-test.com`,
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
          [uuidToBuffer(generateUuid()), uuidToBuffer(user.id), uuidToBuffer(platformId), 'https://fb.com/test', `fb_preval_${dateTag}_${preValCounter}`, 'PreValPage']
        )
      }
      return user
    }

    const createDraftWithSettings = async (settingsOverrides = {}) => {
      const testClient = await createPreValidateClient()
      const campaign = await campaignService.createCampaign(testClient.id, {
        name: `PreValidate ${generateUuid().substring(0, 8)}`,
        type: 'post',
      })
      await campaignRepo.createCreative(generateUuid(), campaign.id, { caption: 'Pre-validate caption', mediaUrl: 'https://example.com/img.jpg' })
      await campaignService.saveMetaSettings(testClient.id, campaign.id, {
        objective: 'OUTCOME_TRAFFIC',
        budgetAmount: 10000,
        targeting: { geo_locations: { countries: ['IN'] } },
        platformPlacement: { publisher_platforms: ['facebook', 'instagram'] },
        ...settingsOverrides,
      })
      return { campaign, clientId: testClient.id }
    }

    beforeEach(resetValidateMocks)

    it('should validate a draft campaign without creating Meta objects', async () => {
      const { campaign, clientId } = await createDraftWithSettings()

      const result = await campaignService.validateCampaignDraft(clientId, campaign.id)

      expect(result.valid).toBe(true)
      expect(result.error).toBeNull()
      expect(result.checks).toEqual([
        { object: 'creative', ok: true },
        { object: 'campaign', ok: true },
      ])

      for (const fnName of ['createAdCreative', 'createAdCampaign']) {
        const calls = metaMocks[fnName].mock.calls
        expect(calls).toHaveLength(1)
        expect(calls[0][calls[0].length - 1]).toBe(true)
      }
      expect(metaMocks.createAdSet).not.toHaveBeenCalled()
      expect(metaMocks.createAd).not.toHaveBeenCalled()

      expect(await campaignRepo.findMetaObjectsByCampaignId(campaign.id)).toEqual([])
      const updated = await campaignRepo.findCampaignById(campaign.id)
      expect(updated.status).toBe('draft')
      expect(updated.metaStatus).toBe('pending')
    })

    it('should surface a creative validation failure without creating anything', async () => {
      failValidateFn('createAdCreative', 'The Page ID specified in object story spec is invalid')
      const { campaign, clientId } = await createDraftWithSettings()

      const result = await campaignService.validateCampaignDraft(clientId, campaign.id)

      expect(result.valid).toBe(false)
      expect(result.error).toContain('The Page ID specified in object story spec is invalid')
      expect(result.checks[0]).toEqual({ object: 'creative', ok: false, error: 'The Page ID specified in object story spec is invalid' })
      expect(metaMocks.createAdCampaign).toHaveBeenCalledTimes(1)
      expect(metaMocks.createAdSet).not.toHaveBeenCalled()
      expect(metaMocks.createAd).not.toHaveBeenCalled()
      expect(await campaignRepo.findMetaObjectsByCampaignId(campaign.id)).toEqual([])
    })

    it('should surface a campaign validation failure and keep the creative check green', async () => {
      failValidateFn('createAdCampaign', 'The campaign spending limit must be at least ₹5,000.00 for this currency')
      const { campaign, clientId } = await createDraftWithSettings()

      const result = await campaignService.validateCampaignDraft(clientId, campaign.id)

      expect(result.valid).toBe(false)
      expect(result.checks[0]).toEqual({ object: 'creative', ok: true })
      expect(result.checks[1]).toEqual({ object: 'campaign', ok: false, error: 'The campaign spending limit must be at least ₹5,000.00 for this currency' })
      expect(result.error).toContain('₹5,000')
      expect(metaMocks.createAdSet).not.toHaveBeenCalled()
      expect(metaMocks.createAd).not.toHaveBeenCalled()
      expect(await campaignRepo.findMetaObjectsByCampaignId(campaign.id)).toEqual([])
    })

    it('should reject a budget below the ₹100 minimum before calling Meta', async () => {
      const { campaign, clientId } = await createDraftWithSettings({ budgetAmount: 1 })

      const result = await campaignService.validateCampaignDraft(clientId, campaign.id)

      expect(result.valid).toBe(false)
      expect(result.error).toContain('Minimum daily budget is ₹100')
      expect(metaMocks.createAdCreative).not.toHaveBeenCalled()
      expect(metaMocks.createAdCampaign).not.toHaveBeenCalled()
    })

    it('should reject a past end time before calling Meta', async () => {
      const { campaign, clientId } = await createDraftWithSettings({
        endTime: new Date(Date.now() - 3600000).toISOString(),
      })

      const result = await campaignService.validateCampaignDraft(clientId, campaign.id)

      expect(result.valid).toBe(false)
      expect(result.error).toContain('end time must be in the future')
      expect(metaMocks.createAdCreative).not.toHaveBeenCalled()
      expect(metaMocks.createAdCampaign).not.toHaveBeenCalled()
    })

    it('should reject a past start time before calling Meta', async () => {
      const testClient = await createPreValidateClient()
      const campaign = await campaignService.createCampaign(testClient.id, {
        name: `PreValidate ${generateUuid().substring(0, 8)}`,
        type: 'post',
        scheduledAt: new Date(Date.now() - 3600000).toISOString().slice(0, 19).replace('T', ' '),
      })
      await campaignRepo.createCreative(generateUuid(), campaign.id, { caption: 'Pre-validate caption', mediaUrl: 'https://example.com/img.jpg' })
      await campaignService.saveMetaSettings(testClient.id, campaign.id, {
        objective: 'OUTCOME_TRAFFIC',
        budgetAmount: 10000,
        targeting: { geo_locations: { countries: ['IN'] } },
        platformPlacement: { publisher_platforms: ['facebook', 'instagram'] },
      })

      const result = await campaignService.validateCampaignDraft(testClient.id, campaign.id)

      expect(result.valid).toBe(false)
      expect(result.error).toContain('start time must be in the future')
      expect(metaMocks.createAdCreative).not.toHaveBeenCalled()
      expect(metaMocks.createAdCampaign).not.toHaveBeenCalled()
    })

    it('should reject an end time before the start time', async () => {
      const testClient = await createPreValidateClient()
      const campaign = await campaignService.createCampaign(testClient.id, {
        name: `PreValidate ${generateUuid().substring(0, 8)}`,
        type: 'post',
        scheduledAt: new Date(Date.now() + 48 * 3600000).toISOString().slice(0, 19).replace('T', ' '),
      })
      await campaignRepo.createCreative(generateUuid(), campaign.id, { caption: 'Pre-validate caption', mediaUrl: 'https://example.com/img.jpg' })
      await campaignService.saveMetaSettings(testClient.id, campaign.id, {
        objective: 'OUTCOME_TRAFFIC',
        budgetAmount: 10000,
        targeting: { geo_locations: { countries: ['IN'] } },
        platformPlacement: { publisher_platforms: ['facebook', 'instagram'] },
        endTime: new Date(Date.now() + 24 * 3600000).toISOString(),
      })

      const result = await campaignService.validateCampaignDraft(testClient.id, campaign.id)

      expect(result.valid).toBe(false)
      expect(result.error).toContain('end time must be after start time')
      expect(metaMocks.createAdCreative).not.toHaveBeenCalled()
      expect(metaMocks.createAdCampaign).not.toHaveBeenCalled()
    })

    it('should require an end time for lifetime budgets', async () => {
      const { campaign, clientId } = await createDraftWithSettings({ budgetType: 'lifetime' })

      const result = await campaignService.validateCampaignDraft(clientId, campaign.id)

      expect(result.valid).toBe(false)
      expect(result.error).toContain('End time is required for lifetime budget')
      expect(metaMocks.createAdCreative).not.toHaveBeenCalled()
      expect(metaMocks.createAdCampaign).not.toHaveBeenCalled()
    })

    it('should reject a daily budget with an end time within 24 hours', async () => {
      const { campaign, clientId } = await createDraftWithSettings({
        endTime: new Date(Date.now() + 2 * 3600000).toISOString(),
      })

      const result = await campaignService.validateCampaignDraft(clientId, campaign.id)

      expect(result.valid).toBe(false)
      expect(result.error).toContain('longer than 24 hours')
      expect(metaMocks.createAdCreative).not.toHaveBeenCalled()
      expect(metaMocks.createAdCampaign).not.toHaveBeenCalled()
    })

    it('should allow a daily budget with a far-future end time', async () => {
      const { campaign, clientId } = await createDraftWithSettings({
        endTime: new Date(Date.now() + 10 * 24 * 3600000).toISOString(),
      })

      const result = await campaignService.validateCampaignDraft(clientId, campaign.id)

      expect(result.valid).toBe(true)
      expect(result.error).toBeNull()
      expect(result.checks).toHaveLength(2)
      expect(metaMocks.createAdCreative).toHaveBeenCalledTimes(1)
      expect(metaMocks.createAdCampaign).toHaveBeenCalledTimes(1)
    })

    it('should fail fast when the client has no verified Facebook page', async () => {
      const noPageUser = await createTestUser({
        email: `camp-nopage-${dateTag}@flowx-test.com`,
        password: 'Test@123',
      })
      const campaign = await campaignService.createCampaign(noPageUser.id, {
        name: `No Page ${dateTag}`,
        type: 'post',
      })

      const result = await campaignService.validateCampaignDraft(noPageUser.id, campaign.id)

      expect(result.valid).toBe(false)
      expect(result.error).toContain('verified Facebook page')
      expect(metaMocks.createAdCreative).not.toHaveBeenCalled()
      expect(metaMocks.createAdCampaign).not.toHaveBeenCalled()
    })

    it('should reject validation of another user\'s campaign', async () => {
      const { campaign } = await createDraftWithSettings()
      const otherUser = await createTestUser({
        email: `camp-preval-other-${dateTag}@flowx-test.com`,
        password: 'Test@123',
      })

      await expect(
        campaignService.validateCampaignDraft(otherUser.id, campaign.id)
      ).rejects.toThrow(/your campaign/i)
    })

    it('should reject validation when the campaign is not editable', async () => {
      const { campaign, clientId } = await createDraftWithSettings()
      await campaignService.cancelCampaign(clientId, campaign.id)

      await expect(
        campaignService.validateCampaignDraft(clientId, campaign.id)
      ).rejects.toThrow(/cannot be validated/i)
    })
  })

  describe('publisher go-live activation', () => {
    let pubFlowCounter = 0

    const createPubFlowUser = async () => {
      pubFlowCounter += 1
      const user = await createTestUser({
        email: `camp-pubflow-${dateTag}-${pubFlowCounter}@flowx-test.com`,
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
          [uuidToBuffer(generateUuid()), uuidToBuffer(user.id), uuidToBuffer(platformId), 'https://fb.com/test', `fb_pubflow_${dateTag}_${pubFlowCounter}`, 'PubFlowPage']
        )
      }
      return user
    }

    const createAwaitingCampaign = async (publisherCount = 1) => {
      const client = await createPubFlowUser()
      const publishers = []
      for (let i = 0; i < publisherCount; i++) {
        publishers.push(await createPubFlowUser())
      }
      const campaign = await campaignService.createCampaign(client.id, {
        name: `PubFlow ${generateUuid().substring(0, 8)}`,
        type: 'post',
        publisherCount,
        coinsPerPublisher: 100,
      })
      await campaignRepo.createCreative(generateUuid(), campaign.id, { caption: 'PubFlow caption', mediaUrl: 'https://example.com/img.jpg' })
      await campaignRepo.updateCampaign(campaign.id, { status: 'awaiting_publishers' })
      await campaignRepo.createPublisherRequests(campaign.id, publishers.map(p => p.id), 100)
      const requests = await campaignRepo.findPublisherRequestsByCampaignId(campaign.id)
      return { campaign, clientId: client.id, publishers, requestIds: requests.map(r => r.id) }
    }

    beforeEach(() => {
      metaMocks.createAdCampaign.mockReset().mockImplementation(async () => ({ id: metaMocks.__nextMetaId('mock_campaign') }))
      metaMocks.createAdSet.mockReset().mockImplementation(async () => ({ id: metaMocks.__nextMetaId('mock_adset') }))
      metaMocks.createAdCreative.mockReset().mockImplementation(async () => ({ id: metaMocks.__nextMetaId('mock_creative') }))
      metaMocks.createAd.mockReset().mockImplementation(async () => ({ id: metaMocks.__nextMetaId('mock_ad') }))
      metaMocks.updateAdStatus.mockReset().mockResolvedValue({ success: true })
      metaMocks.deleteAd.mockClear()
      metaMocks.deleteAdSet.mockClear()
      metaMocks.deleteAdCreative.mockClear()
      metaMocks.deleteAdCampaign.mockClear()
    })

    it('should go live when all publisher slots are filled and activation succeeds', async () => {
      const { campaign, publishers, requestIds } = await createAwaitingCampaign()

      await campaignService.acceptPublisherRequest(publishers[0].id, requestIds[0])
      await drainCampaignJobs()

      const updated = await campaignRepo.findCampaignById(campaign.id)
      expect(updated.status).toBe('running')
      expect(updated.metaStatus).toBe('created')
      expect(metaMocks.updateAdStatus).toHaveBeenCalled()
    })

    it('should stay awaiting publishers when activation fails', async () => {
      metaMocks.updateAdStatus.mockRejectedValue(new Error('Object cannot be activated'))
      const { campaign, publishers, requestIds } = await createAwaitingCampaign()

      await campaignService.acceptPublisherRequest(publishers[0].id, requestIds[0])
      await drainCampaignJobs()

      const updated = await campaignRepo.findCampaignById(campaign.id)
      expect(updated.status).toBe('awaiting_publishers')
      expect(updated.metaStatus).toBe('failed')
      expect(updated.metaError).toContain('Object cannot be activated')

      const reviewLogs = await query('SELECT * FROM campaign_review_log WHERE campaign_id = ?', [uuidToBuffer(campaign.id)])
      expect(reviewLogs.some(r => r.notes.includes('activation failed'))).toBe(true)
    })

    it('force go-live activates client and accepted publisher with per-user ownership', async () => {
      const { campaign, clientId, publishers, requestIds } = await createAwaitingCampaign(2)

      const accepted = await campaignService.acceptPublisherRequest(publishers[0].id, requestIds[0])
      expect(accepted.status).toBe('accepted')

      const updated = await campaignService.forceGoLiveCampaign(admin?.id ?? null, campaign.id)
      expect(updated.status).toBe('running')

      const rows = await query('SELECT * FROM campaign_meta_objects WHERE campaign_id = ?', [uuidToBuffer(campaign.id)])
      expect(rows).toHaveLength(8)
      expect(rows.filter(r => bufferToUuid(r.created_for_user_id) === clientId)).toHaveLength(4)
      expect(rows.filter(r => bufferToUuid(r.created_for_user_id) === publishers[0].id)).toHaveLength(4)
      expect(metaMocks.updateAdStatus).toHaveBeenCalledTimes(6)
    })

    it('auto go-live on last accept creates and activates every user with ownership', async () => {
      const { campaign, clientId, publishers, requestIds } = await createAwaitingCampaign(2)

      await campaignService.acceptPublisherRequest(publishers[0].id, requestIds[0])
      await campaignService.acceptPublisherRequest(publishers[1].id, requestIds[1])
      await drainCampaignJobs()

      const updated = await campaignRepo.findCampaignById(campaign.id)
      expect(updated.status).toBe('running')

      const rows = await query('SELECT * FROM campaign_meta_objects WHERE campaign_id = ?', [uuidToBuffer(campaign.id)])
      expect(rows).toHaveLength(12)
      const owners = new Set(rows.map(r => bufferToUuid(r.created_for_user_id)))
      expect(owners.has(clientId)).toBe(true)
      expect(owners.has(publishers[0].id)).toBe(true)
      expect(owners.has(publishers[1].id)).toBe(true)
      expect(metaMocks.updateAdStatus).toHaveBeenCalledTimes(9)
    })

    it('re-running force go-live after activation failure deletes prior Meta objects instead of duplicating', async () => {
      const { campaign, publishers, requestIds } = await createAwaitingCampaign(2)
      await campaignService.acceptPublisherRequest(publishers[0].id, requestIds[0])

      metaMocks.updateAdStatus.mockRejectedValue(new Error('Object cannot be activated'))
      let updated = await campaignService.forceGoLiveCampaign(admin?.id ?? null, campaign.id)
      expect(updated.status).toBe('awaiting_publishers')
      expect(updated.metaStatus).toBe('failed')

      const firstRunRows = await query('SELECT * FROM campaign_meta_objects WHERE campaign_id = ?', [uuidToBuffer(campaign.id)])
      const firstRunCampaignIds = firstRunRows.filter(r => r.object_type === 'facebook_campaign').map(r => r.object_id).sort()
      const firstRunAdIds = firstRunRows.filter(r => r.object_type === 'ad').map(r => r.object_id).sort()

      metaMocks.deleteAdCampaign.mockClear()
      metaMocks.deleteAdSet.mockClear()
      metaMocks.deleteAdCreative.mockClear()
      metaMocks.deleteAd.mockClear()
      metaMocks.updateAdStatus.mockReset().mockResolvedValue({ success: true })

      updated = await campaignService.forceGoLiveCampaign(admin?.id ?? null, campaign.id)

      expect(updated.status).toBe('running')
      expect(metaMocks.deleteAdCampaign.mock.calls.map(c => c[0]).sort()).toEqual(firstRunCampaignIds)
      expect(metaMocks.deleteAd.mock.calls.map(c => c[0]).sort()).toEqual(firstRunAdIds)

      const rows = await query('SELECT * FROM campaign_meta_objects WHERE campaign_id = ?', [uuidToBuffer(campaign.id)])
      expect(rows).toHaveLength(8)
    })

    it('aborts rebuild when cleanup delete fails with a rate limit — no duplicate objects are created', async () => {
      const { campaign, publishers, requestIds } = await createAwaitingCampaign(2)
      await campaignService.acceptPublisherRequest(publishers[0].id, requestIds[0])

      metaMocks.updateAdStatus.mockRejectedValue(new Error('Object cannot be activated'))
      let updated = await campaignService.forceGoLiveCampaign(admin?.id ?? null, campaign.id)
      expect(updated.status).toBe('awaiting_publishers')
      expect(updated.metaStatus).toBe('failed')

      const beforeRows = await query('SELECT * FROM campaign_meta_objects WHERE campaign_id = ?', [uuidToBuffer(campaign.id)])
      const beforeCampaignIds = beforeRows.filter(r => r.object_type === 'facebook_campaign').map(r => r.object_id).sort()

      metaMocks.updateAdStatus.mockReset().mockResolvedValue({ success: true })
      metaMocks.deleteAdCampaign.mockRejectedValue(
        new Error('Graph API DELETE 120249122041740055 failed: {"error":{"message":"too many calls","code":80004,"type":"OAuthException","error_subcode":2446079}}')
      )

      await expect(campaignService.forceGoLiveCampaign(admin?.id ?? null, campaign.id))
        .rejects.toThrow(/not cleaned up/)

      const afterRows = await query('SELECT * FROM campaign_meta_objects WHERE campaign_id = ?', [uuidToBuffer(campaign.id)])
      expect(afterRows.filter(r => r.object_type === 'facebook_campaign').map(r => r.object_id).sort()).toEqual(beforeCampaignIds)
      expect(afterRows).toHaveLength(beforeRows.length)

      metaMocks.deleteAdCampaign.mockReset().mockResolvedValue({})
    })

    it('partial publisher failure rolls back only that publisher while the client still goes live', async () => {
      const { campaign, clientId, publishers, requestIds } = await createAwaitingCampaign(2)
      await campaignService.acceptPublisherRequest(publishers[0].id, requestIds[0])

      metaMocks.createAd
        .mockResolvedValueOnce({ id: metaMocks.__nextMetaId('mock_ad') })
        .mockResolvedValueOnce({ id: metaMocks.__nextMetaId('mock_ad') })
        .mockRejectedValueOnce(new Error('Ad creation failed'))

      const updated = await campaignService.forceGoLiveCampaign(admin?.id ?? null, campaign.id)
      expect(updated.status).toBe('running')

      const rows = await query('SELECT * FROM campaign_meta_objects WHERE campaign_id = ?', [uuidToBuffer(campaign.id)])
      expect(rows).toHaveLength(4)
      expect(rows.every(r => bufferToUuid(r.created_for_user_id) === clientId)).toBe(true)

      const pubRequests = await campaignRepo.findPublisherRequestsByCampaignId(campaign.id)
      expect(pubRequests.find(r => r.publisherId === publishers[0].id).status).toBe('failed')
      expect(metaMocks.updateAdStatus).toHaveBeenCalledTimes(3)
    })

    it('concurrent accepts of the last two slots produce exactly one go-live with no duplicates', async () => {
      const { campaign, publishers, requestIds } = await createAwaitingCampaign(2)

      const results = await Promise.allSettled([
        campaignService.acceptPublisherRequest(publishers[0].id, requestIds[0]),
        campaignService.acceptPublisherRequest(publishers[1].id, requestIds[1]),
      ])

      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(2)

      await drainCampaignJobs()

      const updated = await campaignRepo.findCampaignById(campaign.id)
      expect(updated.status).toBe('running')

      const rows = await query('SELECT * FROM campaign_meta_objects WHERE campaign_id = ?', [uuidToBuffer(campaign.id)])
      expect(rows).toHaveLength(12)
      expect(metaMocks.createAdCampaign).toHaveBeenCalledTimes(6)
      expect(metaMocks.updateAdStatus).toHaveBeenCalledTimes(9)
    })

    it('retry-meta rebuilds client and accepted publisher objects after full cleanup', async () => {
      const { campaign, publishers, requestIds } = await createAwaitingCampaign(2)
      await campaignService.acceptPublisherRequest(publishers[0].id, requestIds[0])
      await campaignService.forceGoLiveCampaign(admin?.id ?? null, campaign.id)

      const before = await query('SELECT * FROM campaign_meta_objects WHERE campaign_id = ?', [uuidToBuffer(campaign.id)])
      expect(before).toHaveLength(8)

      metaMocks.deleteAdCampaign.mockClear()
      metaMocks.deleteAdSet.mockClear()
      metaMocks.deleteAdCreative.mockClear()
      metaMocks.deleteAd.mockClear()

      const result = await campaignService.retryCampaignMeta(campaign.id)

      expect(result.success).toBe(true)
      expect(metaMocks.deleteAdCampaign).toHaveBeenCalledTimes(2)

      const rows = await query('SELECT * FROM campaign_meta_objects WHERE campaign_id = ?', [uuidToBuffer(campaign.id)])
      expect(rows).toHaveLength(8)

      const pubRequests = await campaignRepo.findPublisherRequestsByCampaignId(campaign.id)
      expect(pubRequests.find(r => r.publisherId === publishers[0].id).status).toBe('published')
    })
  })
})
