import { describe, it, expect, beforeAll } from 'vitest'
import { generateUuid } from '../../shared/utils/uuid.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import * as subService from '../../src/modules/subscriptions/subscription.service.js'
import * as subRepo from '../../src/modules/subscriptions/subscription.repository.js'

let testUser = { id: null, email: null }
let limitUser = { id: null, email: null }
const dateTag = Date.now()

async function ensurePlanForUser(userId) {
  let sub = await subRepo.findUserSubscription(userId)
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
    email: `sub-test-${dateTag}@flowx-test.com`,
    password: 'Test@123',
  })
  limitUser = await createTestUser({
    email: `sub-limit-${dateTag}@flowx-test.com`,
    password: 'Test@123',
  })
  await ensurePlanForUser(testUser.id)
  await ensurePlanForUser(limitUser.id)
})

describe('consumeUsage', () => {
  it('should consume usage from ledger', async () => {
    const before = await subService.getUsage(testUser.id, 'campaigns')

    await subService.consumeUsage(testUser.id, 'campaigns', 'campaign', generateUuid(), 'test consume', 1)

    const after = await subService.getUsage(testUser.id, 'campaigns')
    expect(after.used).toBe(before.used + 1)
  })

  it('should refund usage correctly', async () => {
    const usage = await subService.getUsage(testUser.id, 'campaigns')
    const limit = await subService.getLimit(testUser.id, 'campaigns')
    if (limit !== null && usage.used >= limit && usage.topupAvailable === 0) return

    const resourceId = generateUuid()
    const before = await subService.getUsage(testUser.id, 'campaigns')

    await subService.consumeUsage(testUser.id, 'campaigns', 'campaign', resourceId, 'test refund consume', 1)
    await subService.refundUsage(testUser.id, 'campaigns', 'campaign', resourceId, 'test refund', 1)

    const after = await subService.getUsage(testUser.id, 'campaigns')
    expect(after.used).toBeLessThanOrEqual(before.used)
  })

  it('should throw ForbiddenError when limit is reached for a user', async () => {
    const featureKey = 'campaigns'
    const limit = await subService.getLimit(limitUser.id, featureKey)
    if (limit === null) return

    while (true) {
      const usage = await subService.getUsage(limitUser.id, featureKey)
      const remaining = limit - usage.used + usage.topupAvailable
      if (remaining <= 0) break
      await subService.consumeUsage(limitUser.id, featureKey, 'campaign', generateUuid())
    }

    await expect(
      subService.consumeUsage(limitUser.id, featureKey, 'campaign', generateUuid())
    ).rejects.toThrow("You've reached your monthly limit")
  })
})

describe('refundUsage', () => {
  it('should refund without error even when nothing is consumed', async () => {
    await subService.refundUsage(testUser.id, 'campaigns', 'campaign', generateUuid(), 'test empty refund')
  })
})
