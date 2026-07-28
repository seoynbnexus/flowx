import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import supertest from 'supertest'

const razorpayClientMock = vi.hoisted(() => {
  const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const orders = { create: vi.fn(), fetch: vi.fn() }
  const subscriptions = { create: vi.fn(), cancel: vi.fn(), fetch: vi.fn() }
  const payments = { fetch: vi.fn() }
  const plans = { create: vi.fn() }
  const m = { orders, subscriptions, payments, plans, verifyPayment: vi.fn().mockReturnValue(true) }
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
let verifiedOrderId
let activePlanId
const testEmail = `payment-lifecycle-${Date.now()}@flowx-test.com`
const mockPaymentId = 'pay_mock_lifecycle'

beforeAll(async () => {
  const mod = await import('../../app.js')
  app = mod.default

  testUser = await createTestUser({ email: testEmail, password: 'Test@123', coins: 10000 })

  const plans = await query('SELECT * FROM subscription_plans WHERE is_active = 1')
  const paidPlan = plans.find(p => p.monthly_price > 0)
  activePlanId = bufferToUuid(paidPlan.id)
  const order = await paymentService.createSubscriptionOrder(testUser.id, activePlanId, 'monthly')
  verifiedOrderId = order.orderId
  await paymentService.verifyPayment(testUser.id, order.razorpayOrderId, mockPaymentId, 'mock_sig')
})

beforeEach(() => {
  razorpayClientMock.verifyPayment.mockReturnValue(true)
  razorpayClientMock.subscriptions.cancel.mockResolvedValue({ id: `cancel_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, status: 'cancelled' })
})

describe('cancelSubscription', () => {
  it('should cancel an active subscription schedule', async () => {
    const result = await paymentService.cancelSubscription(testUser.id)

    expect(result.success).toBe(true)
    expect(result.message).toMatch(/cancelled/i)

    const schedule = await paymentService.getActiveSchedule(testUser.id)
    expect(schedule).toBeNull()
  })

  it('should throw NotFoundError when no active schedule exists', async () => {
    await expect(
      paymentService.cancelSubscription(testUser.id)
    ).rejects.toThrow(/no active/i)
  })
})

describe('getActiveSchedule', () => {
  it('should return active schedule after fresh verification', async () => {
    const plans = await query('SELECT * FROM subscription_plans WHERE is_active = 1')
    const paidPlan = plans.find(p => p.monthly_price > 0)
    const order = await paymentService.createSubscriptionOrder(testUser.id, bufferToUuid(paidPlan.id), 'monthly')
    await paymentService.verifyPayment(testUser.id, order.razorpayOrderId, mockPaymentId, 'mock_sig')

    const schedule = await paymentService.getActiveSchedule(testUser.id)
    expect(schedule).toBeTruthy()
    expect(schedule.status).toBe('active')
    expect(schedule.billingCycle).toBe('monthly')
    expect(schedule.razorpaySubscriptionId).toBeTruthy()
  })
})

describe('getOrderHistory', () => {
  it('should return paginated order history', async () => {
    const plans = await query('SELECT * FROM subscription_plans WHERE is_active = 1')
    const paidPlan = plans.find(p => p.monthly_price > 0)
    const order = await paymentService.createSubscriptionOrder(testUser.id, bufferToUuid(paidPlan.id), 'monthly')
    await paymentService.verifyPayment(testUser.id, order.razorpayOrderId, mockPaymentId, 'mock_sig')

    const result = await paymentService.getOrderHistory(testUser.id, 1, 10)

    expect(result).toBeTruthy()
    expect(result.orders.length).toBeGreaterThan(0)
    expect(result.total).toBeGreaterThan(0)
  })
})

describe('getPaymentConfig', () => {
  it('should return payment config via API', async () => {
    const res = await supertest(app).get('/api/v1/payments/config')
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data.razorpayKey).toBe('rzp_test_mock')
    expect(res.body.data.currency).toBe('INR')
  })
})

describe('handleWebhook', () => {
  it('should handle payment.captured event', async () => {
    const plans = await query('SELECT * FROM subscription_plans WHERE is_active = 1')
    const paidPlan = plans.find(p => p.monthly_price > 0)
    const order = await paymentService.createSubscriptionOrder(testUser.id, bufferToUuid(paidPlan.id), 'monthly')

    await paymentService.handleWebhook({
      event: 'payment.captured',
      payload: { payment: { entity: { order_id: order.razorpayOrderId, id: 'pay_webhook_test' } } },
    })

    const dbOrder = await queryOne('SELECT * FROM payment_orders WHERE id = ?', [uuidToBuffer(order.orderId)])
    expect(dbOrder.razorpay_payment_id).toBe('pay_webhook_test')
  })

  it('should handle subscription.charged event', async () => {
    const plans = await query('SELECT * FROM subscription_plans WHERE is_active = 1')
    const paidPlan = plans.find(p => p.monthly_price > 0)
    const order = await paymentService.createSubscriptionOrder(testUser.id, bufferToUuid(paidPlan.id), 'monthly')
    await paymentService.verifyPayment(testUser.id, order.razorpayOrderId, mockPaymentId, 'mock_sig')

    const schedule = await paymentService.getActiveSchedule(testUser.id)
    expect(schedule).toBeTruthy()

    await paymentService.handleWebhook({
      event: 'subscription.charged',
      payload: {
        subscription: {
          entity: {
            id: schedule.razorpaySubscriptionId,
            amount: 49900,
            current_start: Math.floor(Date.now() / 1000),
            current_end: Math.floor(Date.now() / 1000) + 2592000,
          },
        },
      },
    })
  })

  it('should handle subscription.cancelled event', async () => {
    const plans = await query('SELECT * FROM subscription_plans WHERE is_active = 1')
    const paidPlan = plans.find(p => p.monthly_price > 0)
    const order = await paymentService.createSubscriptionOrder(testUser.id, bufferToUuid(paidPlan.id), 'monthly')
    await paymentService.verifyPayment(testUser.id, order.razorpayOrderId, mockPaymentId, 'mock_sig')

    const schedule = await paymentService.getActiveSchedule(testUser.id)
    expect(schedule).toBeTruthy()

    await paymentService.handleWebhook({
      event: 'subscription.cancelled',
      payload: {
        subscription: {
          entity: { id: schedule.razorpaySubscriptionId },
        },
      },
    })

    const updatedSchedule = await paymentService.getActiveSchedule(testUser.id)
    expect(updatedSchedule).toBeNull()
  })
})

describe('admin coin packages', () => {
  const slug = `test-pkg-${Date.now()}`

  it('should create a coin package', async () => {
    const pkg = await paymentService.adminCreatePackage({
      name: 'Test Package',
      slug,
      coins: 500,
      price: 499,
      currency: 'INR',
      taxRate: 18,
      isActive: true,
      displayOrder: 0,
    })

    expect(pkg).toBeTruthy()
    expect(pkg.name).toBe('Test Package')
    expect(pkg.isActive).toBe(true)
  })

  it('should list all packages including inactive', async () => {
    const packages = await paymentService.listPackages(true)
    expect(packages.length).toBeGreaterThan(0)

    const testPkg = packages.find(p => p.slug === slug)
    expect(testPkg).toBeTruthy()
  })

  it('should delete a coin package', async () => {
    const pkg = await paymentService.adminCreatePackage({
      name: 'Delete Me',
      slug: `delete-me-${Date.now()}`,
      coins: 100,
      price: 99,
      currency: 'INR',
      taxRate: 18,
      isActive: true,
      displayOrder: 0,
    })

    await paymentService.adminDeletePackage(pkg.id)

    const all = await paymentService.listPackages(true)
    const deleted = all.find(p => p.id === pkg.id)
    expect(deleted).toBeUndefined()
  })
})
