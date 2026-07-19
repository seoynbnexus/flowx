import { Router } from 'express'
import express from 'express'
import { authenticate } from '../../../shared/middleware/auth.middleware.js'
import { validate } from '../../../shared/middleware/validate.middleware.js'
import {
  createSubscriptionOrderSchema,
  createTopupOrderSchema,
  verifyPaymentSchema,
} from './payment.validation.js'
import * as controller from './payment.controller.js'

const router = Router()

router.get('/config', controller.getPaymentConfig)
router.post('/orders/subscription', authenticate, validate(createSubscriptionOrderSchema), controller.createSubscriptionOrder)
router.post('/orders/topup', authenticate, validate(createTopupOrderSchema), controller.createTopupOrder)
router.post('/verify', authenticate, validate(verifyPaymentSchema), controller.verifyPayment)
router.get('/packages', controller.listPackages)
router.get('/plans', authenticate, controller.getPlans)
router.get('/orders', authenticate, controller.getOrderHistory)
router.get('/invoices', authenticate, controller.getInvoices)
router.post('/subscription/cancel', authenticate, controller.cancelSubscription)
router.get('/subscription/schedule', authenticate, controller.getActiveSchedule)
router.post('/webhook', express.raw({ type: 'application/json' }), controller.webhook)

export default router
