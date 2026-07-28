import * as repo from './payment.repository.js'
import * as subRepo from '../subscriptions/subscription.repository.js'
import * as authRepo from '../auth/auth.repository.js'
import * as aiRepo from '../ai/ai.repository.js'
import * as razorpay from './razorpay.client.js'
import * as subService from '../subscriptions/subscription.service.js'
import { generateUuid, uuidToBuffer } from '../../../shared/utils/uuid.utils.js'
import { query, transaction } from '../../../shared/database/connection.js'
import { NotFoundError, ValidationError, ForbiddenError } from '../../../shared/errors/AppError.js'
import {
  PAYMENT_TYPES, PAYMENT_STATUS, BILLING_CYCLES, SCHEDULE_STATUS,
  INVOICE_STATUS, PLAN_STATUS, COINS_PER_RUPEE, toSubunit, formatCurrency,
} from './payment.model.js'

function calcTax(amount, taxRatePercent) {
  return Math.round(amount * taxRatePercent / 100)
}

function calcProratedRefund(currentPlan, billingCycle) {
  const now = Date.now()
  const start = new Date(currentPlan.currentPeriodStart).getTime()
  const end = new Date(currentPlan.currentPeriodEnd).getTime()
  const totalDays = (end - start) / (1000 * 60 * 60 * 24)
  const remainingDays = (end - now) / (1000 * 60 * 60 * 24)
  if (remainingDays <= 0) return 0
  const priceField = billingCycle === 'yearly' ? 'yearlyPrice' : 'monthlyPrice'
  const price = currentPlan.plan?.[priceField]
  if (!price || price <= 0) return 0
  const dailyRate = price / totalDays
  return Math.round(dailyRate * remainingDays)
}

export async function createSubscriptionOrder(userId, planId, billingCycle = BILLING_CYCLES.MONTHLY) {
  const plan = await subRepo.findPlanById(planId)
  if (!plan) throw new NotFoundError('Plan not found')
  if (!plan.isActive) throw new ValidationError('Plan is not active')

  const currency = plan.currency || 'INR'
  const price = billingCycle === BILLING_CYCLES.YEARLY ? plan.yearlyPrice : plan.monthlyPrice
  if (price <= 0) throw new ValidationError('Cannot purchase a free plan through checkout')

  const taxRate = plan.taxRate || 18
  const taxAmount = calcTax(price, taxRate)
  const totalAmount = price + taxAmount

  const user = await authRepo.findUserById(userId)
  const customerName = user ? [user.first_name, user.last_name].filter(Boolean).join(' ') || undefined : undefined

  const orderId = generateUuid()
  const receipt = `sub_${orderId.slice(0, 8)}`

  const razorpayOrder = await razorpay.createOrder({
    amount: toSubunit(totalAmount, currency),
    currency,
    receipt,
    notes: {
      userId,
      planId,
      type: PAYMENT_TYPES.SUBSCRIPTION,
      billingCycle,
      customerName: customerName || '',
      customerEmail: user?.email || '',
      customerPhone: user?.phone || '',
    },
  })

  await repo.createOrder({
    id: orderId,
    userId,
    type: PAYMENT_TYPES.SUBSCRIPTION,
    amount: toSubunit(totalAmount, currency),
    currency,
    taxAmount: toSubunit(taxAmount, currency),
    razorpayOrderId: razorpayOrder.id,
    description: `Plan: ${plan.name} (${billingCycle})`,
    metadata: { planId, billingCycle, price, taxRate, currency },
  })

  return {
    orderId,
    razorpayOrderId: razorpayOrder.id,
    amount: toSubunit(totalAmount, currency),
    currency,
    plan: { id: plan.id, name: plan.name, slug: plan.slug },
    billingCycle,
  }
}

export async function createTopupOrder(userId, packageId) {
  const pkg = await repo.findPackageById(packageId)
  if (!pkg) throw new NotFoundError('Coin package not found')
  if (!pkg.isActive) throw new ValidationError('Coin package is not active')

  const currency = pkg.currency || 'INR'
  const taxAmount = calcTax(pkg.price, pkg.taxRate)
  const totalAmount = pkg.price + taxAmount

  const user = await authRepo.findUserById(userId)
  const customerName = user ? [user.first_name, user.last_name].filter(Boolean).join(' ') || undefined : undefined

  const orderId = generateUuid()
  const receipt = `top_${orderId.slice(0, 8)}`

  const razorpayOrder = await razorpay.createOrder({
    amount: toSubunit(totalAmount, currency),
    currency,
    receipt,
    notes: {
      userId,
      packageId,
      type: PAYMENT_TYPES.TOPUP,
      customerName: customerName || '',
      customerEmail: user?.email || '',
      customerPhone: user?.phone || '',
    },
  })

  await repo.createOrder({
    id: orderId,
    userId,
    type: PAYMENT_TYPES.TOPUP,
    amount: toSubunit(totalAmount, currency),
    currency,
    taxAmount: toSubunit(taxAmount, currency),
    razorpayOrderId: razorpayOrder.id,
    description: `Top-up: ${pkg.name} (${pkg.coins} coins)`,
    metadata: { packageId, coins: pkg.coins, price: pkg.price, taxRate: pkg.taxRate, currency },
  })

  return {
    orderId,
    razorpayOrderId: razorpayOrder.id,
    amount: toSubunit(totalAmount, currency),
    currency,
    package: { id: pkg.id, name: pkg.name, coins: pkg.coins },
  }
}

export async function verifyPayment(userId, razorpayOrderId, razorpayPaymentId, razorpaySignature) {
  const valid = razorpay.verifyPayment({ razorpayOrderId, razorpayPaymentId, razorpaySignature })
  if (!valid) throw new ValidationError('Payment verification failed. Invalid signature.')

  return await transaction(async () => {
    const order = await repo.findOrderByRazorpayIdForUpdate(razorpayOrderId)
    if (!order) throw new NotFoundError('Order not found')
    if (order.userId !== userId) throw new ForbiddenError('Order does not belong to this user')
    if (order.status !== PAYMENT_STATUS.PENDING) throw new ValidationError('Order already processed')

    let result
    if (order.type === PAYMENT_TYPES.SUBSCRIPTION) {
      result = await processSubscriptionPayment(order, razorpayPaymentId)
    } else if (order.type === PAYMENT_TYPES.TOPUP) {
      result = await processTopupPayment(order, razorpayPaymentId)
    } else {
      throw new ValidationError('Unknown order type')
    }

    return result
  })
}

async function processSubscriptionPayment(order, razorpayPaymentId) {
  const metadata = order.metadata || {}
  const { planId, billingCycle = BILLING_CYCLES.MONTHLY } = metadata
  const uid = order.userId

  const plan = await subRepo.findPlanById(planId)
  if (!plan) throw new NotFoundError('Plan not found')

  return transaction(async () => {
    const now = new Date()
    let periodStart = now
    let periodEnd

    if (billingCycle === BILLING_CYCLES.YEARLY) {
      periodEnd = new Date(now.getFullYear() + 1, now.getMonth(), now.getDate())
    } else {
      periodEnd = new Date(now)
      periodEnd.setMonth(periodEnd.getMonth() + 1)
    }

    const currentSub = await subRepo.findUserSubscription(uid)
    let proratedRefundCoins = 0

    if (currentSub && currentSub.planId !== planId && currentSub.status === PLAN_STATUS.ACTIVE) {
      const refundRupees = calcProratedRefund(currentSub, currentSub.billingCycle)
      if (refundRupees > 0) {
        proratedRefundCoins = refundRupees * COINS_PER_RUPEE
      }
    }

    const sub = await subRepo.upsertUserSubscription(uid, planId, {
      status: PLAN_STATUS.ACTIVE,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      billingCycle,
    })

    const invoiceId = generateUuid()
    await repo.createInvoice({
      id: invoiceId,
      userId: uid,
      userSubscriptionId: sub.id,
      orderId: order.id,
      periodStart,
      periodEnd,
      amount: order.amount,
      currency: order.currency,
      taxAmount: order.taxAmount,
      status: INVOICE_STATUS.PAID,
    })
    await repo.updateInvoice(invoiceId, { paidAt: now })

    await repo.updateOrder(order.id, {
      status: PAYMENT_STATUS.PAID,
      razorpayPaymentId,
    })

    const txnId = generateUuid()
    await repo.createTransaction({
      id: txnId,
      orderId: order.id,
      gateway: 'razorpay',
      gatewayTxnId: razorpayPaymentId,
      gatewayStatus: 'captured',
      amount: order.amount,
      currency: order.currency,
    })

    if (proratedRefundCoins > 0) {
      await ensureWallet(uid)
      await aiRepo.addCoins(uid, proratedRefundCoins)
      await aiRepo.createTransaction(
        generateUuid(),
        uid,
        'Prorated refund from plan upgrade',
        proratedRefundCoins,
        'credit',
        'plan_upgrade',
        order.id
      )
      const updatedMeta = { ...(order.metadata || {}), proratedRefundCoins }
      await repo.updateOrder(order.id, { metadata: JSON.stringify(updatedMeta) })
    }

    const oldSchedule = await repo.findActiveSchedule(uid)
    if (oldSchedule) {
      try {
        await razorpay.cancelSubscription(oldSchedule.razorpaySubscriptionId, true)
      } catch (err) {
        console.warn('Failed to cancel old Razorpay subscription on upgrade:', err.message)
      }
      await repo.updateSchedule(oldSchedule.id, { status: SCHEDULE_STATUS.CANCELLED })
    }

    try {
      const rzpPlan = await razorpay.createRazorpayPlan({
        period: billingCycle === BILLING_CYCLES.YEARLY ? 'yearly' : 'monthly',
        interval: 1,
        item: {
          name: plan.name,
          amount: order.amount,
          currency: order.currency,
        },
      })

      const rzpSubscription = await razorpay.createSubscription({
        planId: rzpPlan.id,
        totalCount: 12,
        notes: { userId: uid, planId, userSubscriptionId: sub.id },
      })

      await repo.createSchedule({
        id: generateUuid(),
        userId: uid,
        userSubscriptionId: sub.id,
        planId,
        razorpaySubscriptionId: rzpSubscription.id,
        billingCycle,
        status: SCHEDULE_STATUS.ACTIVE,
        currentStart: periodStart,
        currentEnd: periodEnd,
      })

      await repo.updateOrder(order.id, { razorpaySubscriptionId: rzpSubscription.id })
    } catch (err) {
      console.warn('Failed to create auto-renewal schedule:', err.message)
    }

    subService.clearCache(uid)

    return {
      success: true,
      type: PAYMENT_TYPES.SUBSCRIPTION,
      subscription: sub,
      proratedRefundCoins,
    }
  })
}

async function processTopupPayment(order, razorpayPaymentId) {
  const metadata = order.metadata || {}
  const { coins } = metadata

  if (!coins) throw new ValidationError('Invalid topup package metadata')

  const uid = order.userId

  return transaction(async () => {
    await ensureWallet(uid)
    await aiRepo.addCoins(uid, coins)
    await query(
      'UPDATE user_wallets SET total_purchased_coins = total_purchased_coins + ? WHERE user_id = ?',
      [coins, uuidToBuffer(uid)]
    )

    await aiRepo.createTransaction(
      generateUuid(),
      uid,
      order.description || 'Coin top-up',
      coins,
      'credit',
      'topup',
      order.id
    )

    await repo.updateOrder(order.id, {
      status: PAYMENT_STATUS.PAID,
      razorpayPaymentId,
    })

    const txnId = generateUuid()
    await repo.createTransaction({
      id: txnId,
      orderId: order.id,
      gateway: 'razorpay',
      gatewayTxnId: razorpayPaymentId,
      gatewayStatus: 'captured',
      amount: order.amount,
      currency: order.currency,
    })

    return {
      success: true,
      type: PAYMENT_TYPES.TOPUP,
      coinsAdded: coins,
    }
  })
}

async function ensureWallet(userId) {
  await query(
    'INSERT IGNORE INTO user_wallets (user_id, coins, total_purchased_coins) VALUES (?, 0, 0)',
    [uuidToBuffer(userId)]
  )
}

export async function listPackages(includeInactive = false) {
  if (includeInactive) {
    return repo.findAllPackages()
  }
  return repo.findActivePackages()
}

export async function getOrderHistory(userId, page = 1, limit = 20) {
  const offset = (page - 1) * limit
  const orders = await repo.findOrdersByUserId(userId, limit, offset)
  const total = await repo.countOrdersByUserId(userId)
  return { orders, total, page, limit }
}

export async function getInvoices(userId, page = 1, limit = 20) {
  const offset = (page - 1) * limit
  const invoices = await repo.findInvoicesByUserId(userId, limit, offset)
  return { invoices, total: invoices.length, page, limit }
}

export async function handleWebhook(event) {
  const { event: eventName, payload } = event

  switch (eventName) {
    case 'payment.captured': {
      const payment = payload.payment.entity
      const order = await repo.findOrderByRazorpayId(payment.order_id)
      if (order) {
        await repo.updateOrder(order.id, { razorpayPaymentId: payment.id })
      }
      break
    }

    case 'subscription.charged': {
      const sub = payload.subscription.entity
      const schedule = await repo.findScheduleByRazorpayId(sub.id)
      if (schedule) {
        await transaction(async () => {
          const invoiceId = generateUuid()
          const now = new Date()
          await repo.createInvoice({
            id: invoiceId,
            userId: schedule.userId,
            userSubscriptionId: schedule.userSubscriptionId,
            orderId: null,
            periodStart: sub.current_start ? new Date(sub.current_start * 1000) : null,
            periodEnd: sub.current_end ? new Date(sub.current_end * 1000) : null,
            amount: sub.amount || 0,
            currency: 'INR',
            taxAmount: 0,
            status: INVOICE_STATUS.PAID,
          })
          await repo.updateInvoice(invoiceId, { paidAt: now })

          await repo.updateSchedule(schedule.id, {
            currentStart: sub.current_start ? new Date(sub.current_start * 1000) : null,
            currentEnd: sub.current_end ? new Date(sub.current_end * 1000) : null,
          })

          await subRepo.upsertUserSubscription(schedule.userId, schedule.planId, {
            currentPeriodStart: sub.current_start ? new Date(sub.current_start * 1000) : new Date(),
            currentPeriodEnd: sub.current_end ? new Date(sub.current_end * 1000) : null,
          })

          subService.clearCache(schedule.userId)
        })
      }
      break
    }

    case 'subscription.cancelled': {
      const cancelledSub = payload.subscription.entity
      const schedule = await repo.findScheduleByRazorpayId(cancelledSub.id)
      if (schedule) {
        await repo.updateSchedule(schedule.id, { status: SCHEDULE_STATUS.CANCELLED })
      }
      break
    }

    case 'subscription.completed': {
      const completedSub = payload.subscription.entity
      const schedule = await repo.findScheduleByRazorpayId(completedSub.id)
      if (schedule) {
        await transaction(async () => {
          await repo.updateSchedule(schedule.id, { status: SCHEDULE_STATUS.COMPLETED })
          await subRepo.upsertUserSubscription(schedule.userId, schedule.planId, { status: 'canceled' })
          subService.clearCache(schedule.userId)
        })
      }
      break
    }

    default:
      break
  }

  return { received: true }
}

export async function cancelSubscription(userId) {
  const schedule = await repo.findActiveSchedule(userId)
  if (!schedule) throw new NotFoundError('No active subscription schedule found')

  try {
    await razorpay.cancelSubscription(schedule.razorpaySubscriptionId)
  } catch (err) {
    console.warn('Razorpay cancel failed:', err.message)
  }

  await repo.updateSchedule(schedule.id, { status: SCHEDULE_STATUS.CANCELLED })

  subService.clearCache(userId)

  return { success: true, message: 'Auto-renewal cancelled. Current period remains active until end.' }
}

export async function getActiveSchedule(userId) {
  const schedule = await repo.findActiveSchedule(userId)
  return schedule || null
}

export async function changePlan(userId, newPlanId, billingCycle = BILLING_CYCLES.MONTHLY) {
  return createSubscriptionOrder(userId, newPlanId, billingCycle)
}

export async function adminCreatePackage(data) {
  const existing = await repo.findPackageBySlug(data.slug)
  if (existing) throw new ValidationError('A package with this slug already exists')

  const id = generateUuid()
  await repo.createPackage({ id, ...data })
  return repo.findPackageById(id)
}

export async function adminUpdatePackage(id, data) {
  const pkg = await repo.findPackageById(id)
  if (!pkg) throw new NotFoundError('Package not found')

  if (data.slug && data.slug !== pkg.slug) {
    const existing = await repo.findPackageBySlug(data.slug)
    if (existing) throw new ValidationError('A package with this slug already exists')
  }

  await repo.updatePackage(id, data)
  return repo.findPackageById(id)
}

export async function adminDeletePackage(id) {
  const pkg = await repo.findPackageById(id)
  if (!pkg) throw new NotFoundError('Package not found')
  await repo.deletePackage(id)
}
