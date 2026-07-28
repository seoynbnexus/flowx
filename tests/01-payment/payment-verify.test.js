import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'

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
import * as subRepo from '../../src/modules/subscriptions/subscription.repository.js'

let testUser
const testEmail = `payment-verify-${Date.now()}@flowx-test.com`
const mockPaymentId = 'pay_mock_verify_123'
const mockSignature = 'mock_signature_123'

beforeAll(async () => {
  testUser = await createTestUser({ email: testEmail, password: 'Test@123', coins: 10000 })
})

beforeEach(() => {
  razorpayClientMock.verifyPayment.mockReturnValue(true)
  razorpayClientMock.subscriptions.cancel.mockResolvedValue({ id: `cancel_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, status: 'cancelled' })
})

describe('verifyPayment', () => {
  it('should verify a subscription payment successfully', async () => {
    const plans = await query('SELECT * FROM subscription_plans WHERE is_active = 1')
    const paidPlan = plans.find(p => p.monthly_price > 0)
    const order = await paymentService.createSubscriptionOrder(testUser.id, bufferToUuid(paidPlan.id), 'monthly')

    const result = await paymentService.verifyPayment(testUser.id, order.razorpayOrderId, mockPaymentId, mockSignature)

    expect(result.success).toBe(true)
    expect(result.type).toBe('subscription')

    const dbOrder = await queryOne('SELECT * FROM payment_orders WHERE id = ?', [uuidToBuffer(order.orderId)])
    expect(dbOrder.status).toBe('paid')
    expect(dbOrder.razorpay_payment_id).toBe(mockPaymentId)

    const dbInvoice = await queryOne('SELECT * FROM subscription_invoices WHERE order_id = ?', [uuidToBuffer(order.orderId)])
    expect(dbInvoice).toBeTruthy()
    expect(dbInvoice.status).toBe('paid')

    const dbTx = await queryOne('SELECT * FROM payment_transactions WHERE order_id = ?', [uuidToBuffer(order.orderId)])
    expect(dbTx).toBeTruthy()
    expect(dbTx.gateway_txn_id).toBe(mockPaymentId)

    const sub = await subRepo.findUserSubscription(testUser.id)
    expect(sub).toBeTruthy()
    expect(sub.status).toBe('active')
  })

  it('should verify a topup payment successfully', async () => {
    const packages = await query('SELECT * FROM coin_topup_packages WHERE is_active = 1')
    const pkg = packages[0]
    const order = await paymentService.createTopupOrder(testUser.id, bufferToUuid(pkg.id))

    const beforeWallet = await queryOne('SELECT coins FROM user_wallets WHERE user_id = ?', [uuidToBuffer(testUser.id)])
    const beforeCoins = beforeWallet?.coins || 0

    const result = await paymentService.verifyPayment(testUser.id, order.razorpayOrderId, mockPaymentId, mockSignature)

    expect(result.success).toBe(true)
    expect(result.type).toBe('topup')
    expect(result.coinsAdded).toBe(pkg.coins)

    const afterWallet = await queryOne('SELECT coins FROM user_wallets WHERE user_id = ?', [uuidToBuffer(testUser.id)])
    expect(Number(afterWallet.coins)).toBe(Number(beforeCoins) + Number(pkg.coins))

    const dbOrder = await queryOne('SELECT * FROM payment_orders WHERE id = ?', [uuidToBuffer(order.orderId)])
    expect(dbOrder.status).toBe('paid')
  })

  it('should throw ValidationError for invalid signature', async () => {
    razorpayClientMock.verifyPayment.mockReturnValue(false)

    const plans = await query('SELECT * FROM subscription_plans WHERE is_active = 1')
    const paidPlan = plans.find(p => p.monthly_price > 0)
    const order = await paymentService.createSubscriptionOrder(testUser.id, bufferToUuid(paidPlan.id), 'monthly')

    await expect(
      paymentService.verifyPayment(testUser.id, order.razorpayOrderId, mockPaymentId, 'bad_signature')
    ).rejects.toThrow(/invalid signature/i)
  })

  it('should throw NotFoundError for non-existent order', async () => {
    await expect(
      paymentService.verifyPayment(testUser.id, 'nonexistent_razorpay_order', mockPaymentId, mockSignature)
    ).rejects.toThrow(/not found/i)
  })

  it('should throw ForbiddenError for order belonging to another user', async () => {
    const otherUser = await createTestUser({ email: `other-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const plans = await query('SELECT * FROM subscription_plans WHERE is_active = 1')
    const paidPlan = plans.find(p => p.monthly_price > 0)
    const order = await paymentService.createSubscriptionOrder(testUser.id, bufferToUuid(paidPlan.id), 'monthly')

    await expect(
      paymentService.verifyPayment(otherUser.id, order.razorpayOrderId, mockPaymentId, mockSignature)
    ).rejects.toThrow(/not belong/i)
  })

  it('should throw ValidationError for already processed order', async () => {
    const plans = await query('SELECT * FROM subscription_plans WHERE is_active = 1')
    const paidPlan = plans.find(p => p.monthly_price > 0)
    const order = await paymentService.createSubscriptionOrder(testUser.id, bufferToUuid(paidPlan.id), 'monthly')

    await paymentService.verifyPayment(testUser.id, order.razorpayOrderId, mockPaymentId, mockSignature)

    await expect(
      paymentService.verifyPayment(testUser.id, order.razorpayOrderId, mockPaymentId, mockSignature)
    ).rejects.toThrow(/already processed/i)
  })

  it('should rollback transaction when processSubscriptionPayment fails mid-way', async () => {
    razorpayClientMock.verifyPayment.mockReturnValue(true)
    razorpayClientMock.subscriptions.create.mockRejectedValueOnce(new Error('Schedule creation failed'))

    const plans = await query('SELECT * FROM subscription_plans WHERE is_active = 1')
    const paidPlan = plans.find(p => p.monthly_price > 0)
    const order = await paymentService.createSubscriptionOrder(testUser.id, bufferToUuid(paidPlan.id), 'monthly')

    await paymentService.verifyPayment(testUser.id, order.razorpayOrderId, mockPaymentId, mockSignature)

    const dbOrder = await queryOne('SELECT * FROM payment_orders WHERE id = ?', [uuidToBuffer(order.orderId)])
    expect(dbOrder.status).toBe('paid')

    const dbInvoice = await queryOne('SELECT * FROM subscription_invoices WHERE order_id = ?', [uuidToBuffer(order.orderId)])
    expect(dbInvoice).toBeTruthy()
  })
})
