import { describe, it, expect, beforeAll, vi } from 'vitest'
import { generateUuid, uuidToBuffer, bufferToUuid } from '../../shared/utils/uuid.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import * as campaignService from '../../src/modules/campaigns/campaign.service.js'
import * as campaignRepo from '../../src/modules/campaigns/campaign.repository.js'
import * as subRepo from '../../src/modules/subscriptions/subscription.repository.js'
import { queryOne, query } from '../../shared/database/connection.js'

var metaMocks
vi.mock('../../shared/services/meta-ads.service.js', () => {
  const mocks = {
    createAdCampaign: vi.fn().mockResolvedValue({ id: 'mock_campaign' }),
    createAdSet: vi.fn().mockResolvedValue({ id: 'mock_adset' }),
    createAdCreative: vi.fn().mockResolvedValue({ id: 'mock_creative' }),
    createAd: vi.fn().mockResolvedValue({ id: 'mock_ad' }),
    updateAdStatus: vi.fn().mockResolvedValue({ success: true }),
    deleteAd: vi.fn().mockResolvedValue({}),
    deleteAdSet: vi.fn().mockResolvedValue({}),
    deleteAdCreative: vi.fn().mockResolvedValue({}),
    deleteAdCampaign: vi.fn().mockResolvedValue({}),
    searchMeta: vi.fn().mockResolvedValue([]),
    getObjectStatus: vi.fn().mockResolvedValue({ status: 'ACTIVE', effective_status: 'ACTIVE' }),
    getCampaignSpend: vi.fn().mockResolvedValue({ spend: '0.00' }),
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
    }

    await expect(
      campaignService.updateCampaign(client.id, tempCampaign.id, { name: 'Blocked' })
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

    metaMocks.getObjectStatus.mockResolvedValue({ status: 'PAUSED', effective_status: 'PAUSED' })

    const result = await campaignService.syncCampaignMetaStatus(campaign.id)
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

    metaMocks.getObjectStatus.mockResolvedValue({ status: 'PAUSED', effective_status: 'PAUSED' })
    metaMocks.getCampaignSpend.mockResolvedValue({ spend: '0.00' })
    await campaignService.syncCampaignMetaStatus(campaign.id)

    const paused = await campaignRepo.findCampaignById(campaign.id)
    expect(paused.status).toBe('paused')

    metaMocks.getObjectStatus.mockResolvedValue({ status: 'ACTIVE', effective_status: 'ACTIVE' })
    metaMocks.getCampaignSpend.mockResolvedValue({ spend: '15.50' })

    const result = await campaignService.syncCampaignMetaStatus(campaign.id)
    expect(result.success).toBe(true)
    expect(result.result.statusAfter).toBe('running')
    expect(result.result.statusChanged).toBe(true)

    const updated = await campaignRepo.findCampaignById(campaign.id)
    expect(updated.status).toBe('running')
  })
})
