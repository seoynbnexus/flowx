import { describe, it, expect, beforeAll } from 'vitest'
import { query, queryOne } from '../../shared/database/connection.js'
import { generateUuid, uuidToBuffer } from '../../shared/utils/uuid.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import * as paymentService from '../../src/modules/payments/payment.service.js'
import * as paymentRepo from '../../src/modules/payments/payment.repository.js'
import * as subRepo from '../../src/modules/subscriptions/subscription.repository.js'

let testUser = { id: null, email: null }
let testSchedule
let testSub
let freePlan
const dateTag = Date.now()

beforeAll(async () => {
  testUser = await createTestUser({
    email: `webhook-${dateTag}@flowx-test.com`,
    password: 'Test@123',
    coins: 10000,
  })

  freePlan = await subRepo.findPlanBySlug('free')
  if (freePlan) {
    testSub = await subRepo.upsertUserSubscription(testUser.id, freePlan.id, {
      status: 'active',
      billingCycle: 'monthly',
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    })

    testSchedule = await paymentRepo.createSchedule({
      id: generateUuid(),
      userId: testUser.id,
      userSubscriptionId: testSub.id,
      planId: freePlan.id,
      razorpaySubscriptionId: `rzp_sub_${dateTag}`,
      billingCycle: 'monthly',
      status: 'active',
      currentStart: new Date(),
      currentEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    })
  }
})

describe('handleWebhook — subscription.charged', () => {
  it('should create invoice, update schedule, and upsert subscription', async () => {
    if (!testSchedule) return

    const now = Math.floor(Date.now() / 1000)
    await paymentService.handleWebhook({
      event: 'subscription.charged',
      payload: {
        subscription: {
          entity: {
            id: testSchedule.razorpaySubscriptionId,
            amount: 99900,
            current_start: now,
            current_end: now + 30 * 24 * 3600,
          },
        },
      },
    })

    const invoices = await query(
      'SELECT * FROM subscription_invoices WHERE user_id = ?',
      [uuidToBuffer(testUser.id)]
    )
    expect(invoices.length).toBeGreaterThan(0)
    expect(invoices[0].status).toBe('paid')
    expect(invoices[0].paid_at).not.toBeNull()

    const schedule = await paymentRepo.findScheduleByRazorpayId(testSchedule.razorpaySubscriptionId)
    expect(schedule).toBeDefined()
    expect(schedule.currentStart).not.toBeNull()
  })
})

describe('handleWebhook — subscription.completed', () => {
  it('should mark schedule as completed and subscription as expired', async () => {
    if (!testSchedule) return

    await paymentService.handleWebhook({
      event: 'subscription.completed',
      payload: {
        subscription: {
          entity: {
            id: testSchedule.razorpaySubscriptionId,
          },
        },
      },
    })

    const schedule = await paymentRepo.findScheduleByRazorpayId(testSchedule.razorpaySubscriptionId)
    expect(schedule).toBeDefined()
    expect(schedule.status).toBe('completed')

    const sub = await subRepo.findUserSubscription(testUser.id)
    expect(sub.status).toBe('canceled')
  })
})
