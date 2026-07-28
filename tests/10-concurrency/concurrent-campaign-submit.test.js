import { describe, it, expect, beforeAll } from 'vitest'
import { generateUuid } from '../../shared/utils/uuid.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import * as campaignService from '../../src/modules/campaigns/campaign.service.js'
import * as campaignRepo from '../../src/modules/campaigns/campaign.repository.js'
import * as subRepo from '../../src/modules/subscriptions/subscription.repository.js'
import { CAMPAIGN_STATUS } from '../../src/modules/campaigns/campaign.model.js'

let testUser = { id: null, email: null }
let testCampaignId
const dateTag = Date.now()

async function ensurePlan(userId) {
  const sub = await subRepo.findUserSubscription(userId)
  if (sub) return
  const freePlan = await subRepo.findPlanBySlug('free')
  if (freePlan) {
    await subRepo.upsertUserSubscription(userId, freePlan.id, {
      status: 'active',
      billingCycle: 'monthly',
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    })
  }
}

beforeAll(async () => {
  testUser = await createTestUser({
    email: `con-camp-${dateTag}@flowx-test.com`,
    password: 'Test@123',
    coins: 10000,
  })
  await ensurePlan(testUser.id)

  testCampaignId = generateUuid()
  await campaignRepo.createCampaign(testCampaignId, testUser.id, {
    name: `Concurrent Campaign ${dateTag}`,
    type: 'post',
    publisherCount: 3,
    coinsPerPublisher: 100,
  })

  const creativeId = generateUuid()
  await campaignRepo.createCreative(creativeId, testCampaignId, {
    caption: 'Concurrent test caption',
    mediaUrl: 'https://example.com/image.jpg',
  })
})

describe('concurrent campaign submit', () => {
  it('should only submit campaign once', async () => {
    const results = await Promise.allSettled([
      campaignService.submitCampaign(testUser.id, testCampaignId),
      campaignService.submitCampaign(testUser.id, testCampaignId),
    ])

    const succeeded = results.filter(r => r.status === 'fulfilled').length
    const failed = results.filter(r => r.status === 'rejected').length

    expect(succeeded).toBe(1)
    expect(failed).toBe(1)

    const campaign = await campaignRepo.findCampaignById(testCampaignId)
    expect(campaign.status).toBe(CAMPAIGN_STATUS.PENDING_REVIEW)
  })
})
