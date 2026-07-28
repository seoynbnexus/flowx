import Razorpay from 'razorpay'
import crypto from 'crypto'
import { wrapSdkCall } from '../../../shared/utils/api-logger.js'

let instance = null

function getInstance() {
  if (instance) return instance

  const keyId = process.env.RAZORPAY_KEY
  const keySecret = process.env.RAZORPAY_SECRET

  if (!keyId || !keySecret) {
    throw new Error('Razorpay is not configured. Please set RAZORPAY_KEY and RAZORPAY_SECRET.')
  }

  instance = new Razorpay({ key_id: keyId, key_secret: keySecret })
  return instance
}

export async function createOrder({ amount, currency = 'INR', receipt, notes = {} }) {
  return wrapSdkCall({ service: 'razorpay', operation: 'create_order' }, async () => {
    const rzp = getInstance()
    const options = {
      amount,
      currency,
      receipt: receipt || `rcpt_${Date.now()}`,
      notes,
    }
    return rzp.orders.create(options)
  })
}

export async function fetchOrder(orderId) {
  return wrapSdkCall({ service: 'razorpay', operation: 'fetch_order' }, async () => {
    const rzp = getInstance()
    return rzp.orders.fetch(orderId)
  })
}

export function verifyPayment({ razorpayOrderId, razorpayPaymentId, razorpaySignature }) {
  const keySecret = process.env.RAZORPAY_SECRET
  if (!keySecret) {
    throw new Error('Razorpay is not configured.')
  }
  const body = `${razorpayOrderId}|${razorpayPaymentId}`
  const expectedSignature = crypto
    .createHmac('sha256', keySecret)
    .update(body)
    .digest('hex')
  return expectedSignature === razorpaySignature
}

export async function createSubscription({ planId, totalCount, customerNotify = true, quantity = 1, notes = {} }) {
  return wrapSdkCall({ service: 'razorpay', operation: 'create_subscription' }, async () => {
    const rzp = getInstance()
    const options = {
      plan_id: planId,
      total_count: totalCount,
      customer_notify: customerNotify,
      quantity,
      notes,
    }
    return rzp.subscriptions.create(options)
  })
}

export async function cancelSubscription(subscriptionId, cancelAtCycleEnd = true) {
  return wrapSdkCall({ service: 'razorpay', operation: 'cancel_subscription' }, async () => {
    const rzp = getInstance()
    return rzp.subscriptions.cancel(subscriptionId, cancelAtCycleEnd)
  })
}

export async function fetchSubscription(subscriptionId) {
  return wrapSdkCall({ service: 'razorpay', operation: 'fetch_subscription' }, async () => {
    const rzp = getInstance()
    return rzp.subscriptions.fetch(subscriptionId)
  })
}

export async function fetchPayment(paymentId) {
  return wrapSdkCall({ service: 'razorpay', operation: 'fetch_payment' }, async () => {
    const rzp = getInstance()
    return rzp.payments.fetch(paymentId)
  })
}

export async function createRazorpayPlan({ period, interval, item, notes = {} }) {
  return wrapSdkCall({ service: 'razorpay', operation: 'create_plan' }, async () => {
    const rzp = getInstance()
    const options = {
      period,
      interval,
      item,
      notes,
    }
    return rzp.plans.create(options)
  })
}

export function verifyWebhookSignature(body, signature, secret) {
  const expected = crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('hex')
  return expected === signature
}
