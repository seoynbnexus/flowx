import * as service from './payment.service.js'
import { sendSuccess, sendCreated, sendPaginated, sendError, sendNoContent } from '../../../shared/utils/response.utils.js'

export async function createSubscriptionOrder(req, res, next) {
  try {
    const { planId, billingCycle } = req.body
    const result = await service.createSubscriptionOrder(req.user.id, planId, billingCycle)
    return sendCreated(res, result)
  } catch (error) {
    next(error)
  }
}

export async function createTopupOrder(req, res, next) {
  try {
    const { packageId } = req.body
    const result = await service.createTopupOrder(req.user.id, packageId)
    return sendCreated(res, result)
  } catch (error) {
    next(error)
  }
}

export async function verifyPayment(req, res, next) {
  try {
    const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body
    const result = await service.verifyPayment(req.user.id, razorpayOrderId, razorpayPaymentId, razorpaySignature)
    return sendSuccess(res, result)
  } catch (error) {
    next(error)
  }
}

export async function listPackages(req, res, next) {
  try {
    const packages = await service.listPackages()
    return sendSuccess(res, packages)
  } catch (error) {
    next(error)
  }
}

export async function getOrderHistory(req, res, next) {
  try {
    const page = parseInt(req.query.page) || 1
    const limit = Math.min(parseInt(req.query.limit) || 20, 100)
    const result = await service.getOrderHistory(req.user.id, page, limit)
    return sendPaginated(res, result.orders, { page, limit, total: result.total })
  } catch (error) {
    next(error)
  }
}

export async function getInvoices(req, res, next) {
  try {
    const page = parseInt(req.query.page) || 1
    const limit = Math.min(parseInt(req.query.limit) || 20, 100)
    const result = await service.getInvoices(req.user.id, page, limit)
    return sendPaginated(res, result.invoices, { page, limit, total: result.total })
  } catch (error) {
    next(error)
  }
}

export async function cancelSubscription(req, res, next) {
  try {
    const result = await service.cancelSubscription(req.user.id)
    return sendSuccess(res, result)
  } catch (error) {
    next(error)
  }
}

export async function getActiveSchedule(req, res, next) {
  try {
    const schedule = await service.getActiveSchedule(req.user.id)
    return sendSuccess(res, schedule)
  } catch (error) {
    next(error)
  }
}

export async function webhook(req, res, next) {
  try {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET
    if (secret && req.body instanceof Buffer) {
      const signature = req.headers['x-razorpay-signature']
      const { verifyWebhookSignature } = await import('./razorpay.client.js')
      const rawBody = req.body.toString('utf8')
      const valid = verifyWebhookSignature(rawBody, signature, secret)
      if (!valid) {
        return sendError(res, 401, 'Invalid webhook signature')
      }
      req.body = JSON.parse(rawBody)
    }
    const result = await service.handleWebhook(req.body)
    return sendSuccess(res, result)
  } catch (error) {
    next(error)
  }
}

export async function getPaymentConfig(req, res, next) {
  try {
    return sendSuccess(res, {
      razorpayKey: process.env.RAZORPAY_KEY || null,
      currency: 'INR',
    })
  } catch (error) {
    next(error)
  }
}

export async function getPlans(req, res, next) {
  try {
    const subRepo = await import('../subscriptions/subscription.repository.js')
    const plans = await subRepo.findAllPlans()
    const result = []
    for (const plan of plans) {
      const features = await subRepo.findPlanFeatures(plan.id)
      result.push({ ...plan, features })
    }
    return sendSuccess(res, result)
  } catch (error) {
    next(error)
  }
}

export async function adminCreatePackage(req, res, next) {
  try {
    const pkg = await service.adminCreatePackage(req.body)
    return sendCreated(res, pkg)
  } catch (error) {
    next(error)
  }
}

export async function adminUpdatePackage(req, res, next) {
  try {
    const { id } = req.params
    const pkg = await service.adminUpdatePackage(id, req.body)
    return sendSuccess(res, pkg)
  } catch (error) {
    next(error)
  }
}

export async function adminDeletePackage(req, res, next) {
  try {
    const { id } = req.params
    await service.adminDeletePackage(id)
    return sendNoContent(res)
  } catch (error) {
    next(error)
  }
}

export async function adminListPackages(req, res, next) {
  try {
    const packages = await service.listPackages(true)
    return sendSuccess(res, packages)
  } catch (error) {
    next(error)
  }
}
