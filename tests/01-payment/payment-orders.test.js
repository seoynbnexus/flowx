import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import supertest from 'supertest'

// Setup razorpay client mock - hoisted by vitest before imports
const razorpayClientMock = vi.hoisted(() => {
  const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const orders = { create: vi.fn(), fetch: vi.fn() }
  const subscriptions = { create: vi.fn(), cancel: vi.fn(), fetch: vi.fn() }
  const payments = { fetch: vi.fn() }
  const plans = { create: vi.fn() }
  const m = {
    orders, subscriptions, payments, plans,
    verifyPayment: vi.fn().mockReturnValue(true),
  }
  orders.create.mockImplementation(async () => {
    return { id: `order_${uid()}`, amount: 0, currency: 'INR', receipt: `rcpt_${uid()}`, status: 'created' }
  })
  orders.fetch.mockResolvedValue({ id: `order_${uid()}`, amount: 0, currency: 'INR', status: 'paid' })
  subscriptions.create.mockImplementation(async () => {
    return { id: `sub_${uid()}`, plan_id: `plan_${uid()}`, status: 'created', current_start: Math.floor(Date.now() / 1000), current_end: Math.floor(Date.now() / 1000) + 2592000 }
  })
  subscriptions.cancel.mockResolvedValue({ id: `sub_${uid()}`, status: 'cancelled' })
  subscriptions.fetch.mockResolvedValue({ id: `sub_${uid()}`, status: 'active' })
  payments.fetch.mockResolvedValue({ id: `pay_${uid()}`, status: 'captured', amount: 0 })
  plans.create.mockImplementation(async () => {
    return { id: `plan_${uid()}`, period: 'monthly', interval: 1, item: { name: 'Mock Plan', amount: 0 } }
  })
  return m
})

vi.mock('../../src/modules/payments/razorpay.client.js', () => ({
  createOrder: razorpayClientMock.orders.create,
  fetchOrder: razorpayClientMock.orders.fetch,
  createSubscription: razorpayClientMock.subscriptions.create,
  cancelSubscription: razorpayClientMock.subscriptions.cancel,
  fetchSubscription: razorpayClientMock.subscriptions.fetch,
  fetchPayment: razorpayClientMock.payments.fetch,
  createRazorpayPlan: razorpayClientMock.plans.create,
  verifyPayment: razorpayClientMock.verifyPayment,
  verifyWebhookSignature: vi.fn().mockReturnValue(true),
}))

import { createTestUser } from '../helpers/create-user.js'
import { query, queryOne } from '../../shared/database/connection.js'
import { uuidToBuffer, bufferToUuid } from '../../shared/utils/uuid.utils.js'
import * as paymentService from '../../src/modules/payments/payment.service.js'

let app
let testUser
const testEmail = `payment-orders-${Date.now()}@flowx-test.com`

beforeAll(async () => {
  const mod = await import('../../app.js')
  app = mod.default
  testUser = await createTestUser({ email: testEmail, password: 'Test@123', coins: 10000 })
})

beforeEach(() => {
  razorpayClientMock.orders.create.mockResolvedValue({ id: 'order_mock_123', amount: 0, currency: 'INR', receipt: 'rcpt_mock', status: 'created' })
  razorpayClientMock.orders.fetch.mockResolvedValue({ id: 'order_mock_123', amount: 0, currency: 'INR', status: 'paid' })
  razorpayClientMock.subscriptions.create.mockResolvedValue({ id: 'sub_mock_123', plan_id: 'plan_mock_123', status: 'created', current_start: Math.floor(Date.now() / 1000), current_end: Math.floor(Date.now() / 1000) + 2592000 })
  razorpayClientMock.payments.fetch.mockResolvedValue({ id: 'pay_mock_123', status: 'captured', amount: 0 })
})

describe('createSubscriptionOrder', () => {
  it('should create a subscription order successfully', async () => {
    const plans = await query('SELECT * FROM subscription_plans WHERE is_active = 1')
    const starterPlan = plans.find(p => p.monthly_price > 0)
    expect(starterPlan).toBeTruthy()

    const order = await paymentService.createSubscriptionOrder(
      testUser.id,
      bufferToUuid(starterPlan.id),
      'monthly'
    )

    expect(order).toBeDefined()
    expect(order.orderId).toBeTruthy()
    expect(order.razorpayOrderId).toBe('order_mock_123')
    expect(order.amount).toBeGreaterThan(0)

    const dbOrder = await queryOne(
      'SELECT * FROM payment_orders WHERE id = ?',
      [uuidToBuffer(order.orderId)]
    )
    expect(dbOrder).toBeTruthy()
    expect(dbOrder.status).toBe('pending')
    expect(dbOrder.type).toBe('subscription')
  })

  it('should throw NotFoundError for non-existent plan', async () => {
    await expect(
      paymentService.createSubscriptionOrder(testUser.id, '00000000-0000-0000-0000-000000000000', 'monthly')
    ).rejects.toThrow(/not found/i)
  })

  it('should throw ValidationError for inactive plan', async () => {
    await query('UPDATE subscription_plans SET is_active = 0 WHERE name = ?', ['Starter'])
    try {
      const plans = await query('SELECT * FROM subscription_plans WHERE name = ?', ['Starter'])
      await expect(
        paymentService.createSubscriptionOrder(testUser.id, bufferToUuid(plans[0].id), 'monthly')
      ).rejects.toThrow(/not active/i)
    } finally {
      await query('UPDATE subscription_plans SET is_active = 1 WHERE name = ?', ['Starter'])
    }
  })

  it('should throw ValidationError for free plan', async () => {
    const plans = await query('SELECT * FROM subscription_plans WHERE monthly_price = 0 OR monthly_price IS NULL')
    expect(plans.length).toBeGreaterThan(0)
    await expect(
      paymentService.createSubscriptionOrder(testUser.id, bufferToUuid(plans[0].id), 'monthly')
    ).rejects.toThrow(/free plan/i)
  })

  it('should not create DB order if Razorpay fails', async () => {
    razorpayClientMock.orders.create.mockRejectedValueOnce(new Error('Razorpay timeout'))

    const plans = await query('SELECT * FROM subscription_plans WHERE is_active = 1')
    const paidPlan = plans.find(p => p.monthly_price > 0)

    await expect(
      paymentService.createSubscriptionOrder(testUser.id, bufferToUuid(paidPlan.id), 'monthly')
    ).rejects.toThrow('Razorpay timeout')

    const allOrders = await query(
      'SELECT * FROM payment_orders WHERE user_id = ?',
      [uuidToBuffer(testUser.id)]
    )
  })

  it('should leave dangling Razorpay order if DB insert fails after Razorpay success', async () => {
    const razorpayCallCount = razorpayClientMock.orders.create.mock.calls.length

    const plans = await query('SELECT * FROM subscription_plans WHERE is_active = 1')
    const paidPlan = plans.find(p => p.monthly_price > 0)

    const createOrderSpy = vi.spyOn(
      await import('../../src/modules/payments/payment.repository.js'),
      'createOrder'
    )
    createOrderSpy.mockRejectedValueOnce(new Error('DB insert failed'))

    await expect(
      paymentService.createSubscriptionOrder(testUser.id, bufferToUuid(paidPlan.id), 'monthly')
    ).rejects.toThrow('DB insert failed')

    expect(razorpayClientMock.orders.create.mock.calls.length).toBe(razorpayCallCount + 1)
  })

  it('should reject unauthenticated request', async () => {
    const res = await supertest(app)
      .post('/api/v1/payments/orders/subscription')
      .send({ planId: 'any', billingCycle: 'monthly' })
    expect(res.status).toBe(401)
  })
})

describe('createTopupOrder', () => {
  it('should create a topup order successfully', async () => {
    const packages = await query('SELECT * FROM coin_topup_packages WHERE is_active = 1')
    expect(packages.length).toBeGreaterThan(0)

    const order = await paymentService.createTopupOrder(testUser.id, bufferToUuid(packages[0].id))

    expect(order).toBeDefined()
    expect(order.orderId).toBeTruthy()
    expect(order.razorpayOrderId).toBeTruthy()

    const dbOrder = await queryOne(
      'SELECT * FROM payment_orders WHERE id = ?',
      [uuidToBuffer(order.orderId)]
    )
    expect(dbOrder).toBeTruthy()
  })

  it('should throw for non-existent package', async () => {
    await expect(
      paymentService.createTopupOrder(testUser.id, '00000000-0000-0000-0000-000000000000')
    ).rejects.toThrow(/not found/i)
  })

  it('should not create DB order if Razorpay fails', async () => {
    razorpayClientMock.orders.create.mockRejectedValueOnce(new Error('Razorpay timeout'))

    const packages = await query('SELECT * FROM coin_topup_packages WHERE is_active = 1')

    await expect(
      paymentService.createTopupOrder(testUser.id, bufferToUuid(packages[0].id))
    ).rejects.toThrow('Razorpay timeout')
  })
})
