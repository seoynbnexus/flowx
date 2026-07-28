import { describe, it, expect, beforeAll, vi } from 'vitest'
import { generateUuid } from '../../shared/utils/uuid.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import * as paymentService from '../../src/modules/payments/payment.service.js'
import * as subRepo from '../../src/modules/subscriptions/subscription.repository.js'

const razorpayClientMock = vi.hoisted(() => {
  const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const m = {
    verifyPayment: vi.fn().mockReturnValue(true),
    createOrder: vi.fn().mockImplementation(async () => ({ id: `order_${uid()}`, amount: 0, currency: 'INR', status: 'created' })),
    createRazorpayPlan: vi.fn().mockImplementation(async () => ({ id: `plan_${uid()}`, period: 'monthly', interval: 1 })),
    createSubscription: vi.fn().mockImplementation(async () => ({ id: `sub_${uid()}`, status: 'created' })),
    cancelSubscription: vi.fn().mockResolvedValue({}),
  }
  return m
})

vi.mock('../../src/modules/payments/razorpay.client.js', () => razorpayClientMock)

let testUser = { id: null, email: null }
let testPlan = null
let order = null
let razorpayOrderId
const dateTag = Date.now()

beforeAll(async () => {
  testUser = await createTestUser({
    email: `con-pay-${dateTag}@flowx-test.com`,
    password: 'Test@123',
  })

  const plans = await subRepo.findAllPlans()
  testPlan = plans.find(p => p.isActive && p.monthlyPrice > 0)
  if (!testPlan) {
    const planId = generateUuid()
    await subRepo.createPlan({
      id: planId,
      name: 'Test Concurrency Plan',
      slug: `con-test-${dateTag}`,
      description: 'For concurrency testing',
      monthlyPrice: 100,
      yearlyPrice: 1000,
      currency: 'INR',
      isActive: true,
    })
    testPlan = await subRepo.findPlanById(planId)
  }

  order = await paymentService.createSubscriptionOrder(testUser.id, testPlan.id, 'monthly')
  razorpayOrderId = order.razorpayOrderId
})

describe('concurrent payment verify', () => {
  it('should only verify payment once for the same order', async () => {
    const razorpayPaymentId = `pay_${dateTag}`
    const razorpaySignature = 'test_signature'

    const results = await Promise.allSettled([
      paymentService.verifyPayment(testUser.id, razorpayOrderId, razorpayPaymentId, razorpaySignature),
      paymentService.verifyPayment(testUser.id, razorpayOrderId, razorpayPaymentId, razorpaySignature),
    ])

    const succeeded = results.filter(r => r.status === 'fulfilled').length
    const failed = results.filter(r => r.status === 'rejected').length

    expect(succeeded).toBe(1)
    expect(failed).toBe(1)

    const failedReason = results.find(r => r.status === 'rejected').reason
    expect(failedReason.message).toMatch(/already processed/i)
  })
})
