import { describe, it, expect, beforeAll } from 'vitest'
import { query, queryOne } from '../../shared/database/connection.js'
import { generateUuid, uuidToBuffer } from '../../shared/utils/uuid.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import * as campaignService from '../../src/modules/campaigns/campaign.service.js'
import * as campaignRepo from '../../src/modules/campaigns/campaign.repository.js'
import * as subRepo from '../../src/modules/subscriptions/subscription.repository.js'
import { CAMPAIGN_STATUS } from '../../src/modules/campaigns/campaign.model.js'

let testUser = { id: null, email: null }
let adminUser = { id: null, email: null }
let testCampaignId
const dateTag = Date.now()

async function ensureCampaignPlan(userId) {
  const sub = await subRepo.findUserSubscription(userId)
  if (sub) return sub
  const freePlan = await subRepo.findPlanBySlug('free')
  if (freePlan) {
    return subRepo.upsertUserSubscription(userId, freePlan.id, {
      status: 'active',
      billingCycle: 'monthly',
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    })
  }
}

beforeAll(async () => {
  testUser = await createTestUser({
    email: `campaign-client-${dateTag}@flowx-test.com`,
    password: 'Test@123',
    coins: 10000,
  })
  adminUser = await createTestUser({
    email: `campaign-admin-${dateTag}@flowx-test.com`,
    password: 'Test@123',
    role: 'admin',
  })

  await ensureCampaignPlan(testUser.id)

  testCampaignId = generateUuid()
  await campaignRepo.createCampaign(testCampaignId, testUser.id, {
    name: `Test Campaign ${dateTag}`,
    type: 'post',
    publisherCount: 3,
    coinsPerPublisher: 100,
  })

  const creativeId = generateUuid()
  await campaignRepo.createCreative(creativeId, testCampaignId, {
    caption: 'Test caption for campaign',
    mediaUrl: 'https://example.com/image.jpg',
  })
})

describe('submitCampaign', () => {
  it('should transition draft campaign to pending_review with review log', async () => {
    const updated = await campaignService.submitCampaign(testUser.id, testCampaignId)
    expect(updated.status).toBe(CAMPAIGN_STATUS.PENDING_REVIEW)

    const reviewLogs = await campaignRepo.findReviewLogsByCampaignId(testCampaignId)
    expect(reviewLogs.some(r => r.action === 'submitted')).toBe(true)
  })

  it('should throw when campaign has no creative', async () => {
    const noCreativeId = generateUuid()
    await campaignRepo.createCampaign(noCreativeId, testUser.id, {
      name: 'No Creative Campaign',
      type: 'post',
    })

    await expect(
      campaignService.submitCampaign(testUser.id, noCreativeId)
    ).rejects.toThrow('must have at least a caption or media')
  })

  it('should throw for non-owner trying to submit', async () => {
    await expect(
      campaignService.submitCampaign(adminUser.id, testCampaignId)
    ).rejects.toThrow('Not your campaign')
  })
})

describe('cancelCampaign', () => {
  const cancelEmail = `cancel-test-${dateTag}@flowx-test.com`
  let cancelUser, cancelCampaignId

  beforeAll(async () => {
    cancelUser = await createTestUser({ email: cancelEmail, password: 'Test@123' })
    await ensureCampaignPlan(cancelUser.id)
    cancelCampaignId = generateUuid()
    await campaignRepo.createCampaign(cancelCampaignId, cancelUser.id, {
      name: 'Cancel Test Campaign',
      type: 'post',
    })
    const cId = generateUuid()
    await campaignRepo.createCreative(cId, cancelCampaignId, { caption: 'Cancel test' })
  })

  it('should cancel a draft campaign', async () => {
    const updated = await campaignService.cancelCampaign(cancelUser.id, cancelCampaignId)
    expect(updated.status).toBe(CAMPAIGN_STATUS.CANCELLED)

    const reviewLogs = await campaignRepo.findReviewLogsByCampaignId(cancelCampaignId)
    expect(reviewLogs.some(r => r.action === 'cancelled')).toBe(true)
  })

  it('should throw when cancelling another users campaign', async () => {
    await expect(
      campaignService.cancelCampaign(adminUser.id, testCampaignId)
    ).rejects.toThrow('Not your campaign')
  })
})

describe('rejectCampaign', () => {
  let rejectCampaignId

  beforeAll(async () => {
    const userEmail = `reject-client-${dateTag}@flowx-test.com`
    const user = await createTestUser({ email: userEmail, password: 'Test@123' })
    await ensureCampaignPlan(user.id)

    rejectCampaignId = generateUuid()
    await campaignRepo.createCampaign(rejectCampaignId, user.id, {
      name: 'Reject Test Campaign',
      type: 'post',
    })
    const cId = generateUuid()
    await campaignRepo.createCreative(cId, rejectCampaignId, { caption: 'Reject test' })
    await campaignService.submitCampaign(user.id, rejectCampaignId)
  })

  it('should reject a pending_review campaign', async () => {
    const updated = await campaignService.rejectCampaign(adminUser.id, rejectCampaignId, {
      notes: 'Does not meet guidelines',
    })
    expect(updated.status).toBe(CAMPAIGN_STATUS.REJECTED)
    expect(updated.reviewNotes).toBe('Does not meet guidelines')

    const reviewLogs = await campaignRepo.findReviewLogsByCampaignId(rejectCampaignId)
    expect(reviewLogs.some(r => r.action === 'rejected')).toBe(true)
  })

  it('should throw when campaign is not in pending_review', async () => {
    await expect(
      campaignService.rejectCampaign(adminUser.id, rejectCampaignId, { notes: 'x' })
    ).rejects.toThrow('must be in pending review status')
  })
})
