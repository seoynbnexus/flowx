import { describe, it, expect, beforeAll } from 'vitest'
import { generateUuid } from '../../shared/utils/uuid.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import * as coinService from '../../shared/services/coin.service.js'
import * as subRepo from '../../src/modules/subscriptions/subscription.repository.js'

let testUser, dateTag

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
  dateTag = Date.now()
  testUser = await createTestUser({
    email: `con-spend-${dateTag}@flowx-test.com`,
    password: 'Test@123',
    coins: 500,
  })
  await ensurePlan(testUser.id)
})

describe('concurrent coin spend', () => {
  it('should prevent wallet double-spend when total exceeds balance', async () => {
    await coinService.spend(testUser.id, 10000, 'test', generateUuid(), 'exhaust allowance')

    const results = await Promise.allSettled([
      coinService.spend(testUser.id, 400, 'test', generateUuid(), 'concurrent wallet 1'),
      coinService.spend(testUser.id, 200, 'test', generateUuid(), 'concurrent wallet 2'),
    ])

    const succeeded = results.filter(r => r.status === 'fulfilled').length
    const failed = results.filter(r => r.status === 'rejected').length

    expect(succeeded).toBe(1)
    expect(failed).toBe(1)

    const rejected = results.find(r => r.status === 'rejected')
    expect(rejected.reason.message).toMatch(/Insufficient|INSUFFICIENT/)
  })

  it('should allow both wallet spends when total is within balance', async () => {
    const avail = await coinService.getAvailable(testUser.id)
    const small = Math.min(Math.floor(avail.topupBalance / 3), 50)

    if (small < 1) return

    const results = await Promise.allSettled([
      coinService.spend(testUser.id, small, 'test', generateUuid(), 'concurrent small 1'),
      coinService.spend(testUser.id, small, 'test', generateUuid(), 'concurrent small 2'),
    ])

    const succeeded = results.filter(r => r.status === 'fulfilled').length
    expect(succeeded).toBe(2)
  })
})
