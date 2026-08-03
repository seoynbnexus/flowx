import { describe, it, expect, beforeAll } from 'vitest'
import { query } from '../../shared/database/connection.js'
import { generateUuid, uuidToBuffer, bufferToUuid } from '../../shared/utils/uuid.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import * as campaignService from '../../src/modules/campaigns/campaign.service.js'
import * as campaignRepo from '../../src/modules/campaigns/campaign.repository.js'
import * as subRepo from '../../src/modules/subscriptions/subscription.repository.js'

let publisherId, campaignId
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
  const client = await createTestUser({
    email: `con-pub-client-${dateTag}@flowx-test.com`,
    password: 'Test@123',
    coins: 10000,
  })
  await ensurePlan(client.id)

  const pub = await createTestUser({
    email: `con-publisher-${dateTag}@flowx-test.com`,
    password: 'Test@123',
    role: 'publisher',
  })
  publisherId = pub.id

  campaignId = generateUuid()
  await campaignRepo.createCampaign(campaignId, client.id, {
    name: `Pub Accept Test ${dateTag}`,
    type: 'post',
    publisherCount: 3,
    coinsPerPublisher: 100,
  })

  const creativeId = generateUuid()
  await campaignRepo.createCreative(creativeId, campaignId, { caption: 'Pub accept test', mediaUrl: 'https://example.com/img.jpg' })

  await campaignService.submitCampaign(client.id, campaignId)
})

async function createRequest() {
  const requestId = generateUuid()
  await query(
    `INSERT INTO campaign_publisher_requests (id, campaign_id, publisher_id, coins_offered, status)
     VALUES (?, ?, ?, ?, 'pending')`,
    [uuidToBuffer(requestId), uuidToBuffer(campaignId), uuidToBuffer(publisherId), 100]
  )
  return requestId
}

describe('concurrent publisher accept', () => {
  it('should work sequentially', async () => {
    const requestId = await createRequest()
    const result = await campaignService.acceptPublisherRequest(publisherId, requestId)
    expect(result.status).toBe('accepted')
  })

  it('should only accept the same request once', async () => {
    const requestId = await createRequest()

    const results = await Promise.allSettled([
      campaignService.acceptPublisherRequest(publisherId, requestId),
      campaignService.acceptPublisherRequest(publisherId, requestId),
    ])

    const succeeded = results.filter(r => r.status === 'fulfilled').length
    const failed = results.filter(r => r.status === 'rejected').length

    expect(succeeded).toBe(1)
    expect(failed).toBe(1)
  })
})
