import { Router } from 'express'
import { authenticate, requirePermission } from '../../../shared/middleware/auth.middleware.js'
import { validate } from '../../../shared/middleware/validate.middleware.js'
import * as controller from './admin.controller.js'
import {
  createPlanSchema, updatePlanSchema, createFeatureSchema, updateFeatureSchema,
  bulkSetEntitlementsSchema, assignPlanSchema, reorderPlansSchema,
  adminAdjustUsageSchema, adminForceRefundSchema,
} from './subscription.validation.js'

const router = Router()

router.get('/plans', authenticate, requirePermission('subscriptions.admin'), controller.listPlans)
router.get('/plans/:id', authenticate, requirePermission('subscriptions.admin'), controller.getPlan)
router.post('/plans', authenticate, requirePermission('subscriptions.admin'), validate(createPlanSchema), controller.createPlan)
router.patch('/plans/:id', authenticate, requirePermission('subscriptions.admin'), validate(updatePlanSchema), controller.updatePlan)
router.delete('/plans/:id', authenticate, requirePermission('subscriptions.admin'), controller.deletePlan)
router.post('/plans/reorder', authenticate, requirePermission('subscriptions.admin'), validate(reorderPlansSchema), controller.reorderPlans)

router.get('/features', authenticate, requirePermission('subscriptions.admin'), controller.listFeatures)
router.get('/features/:id', authenticate, requirePermission('subscriptions.admin'), controller.getFeature)
router.post('/features', authenticate, requirePermission('subscriptions.admin'), validate(createFeatureSchema), controller.createFeature)
router.patch('/features/:id', authenticate, requirePermission('subscriptions.admin'), validate(updateFeatureSchema), controller.updateFeature)
router.delete('/features/:id', authenticate, requirePermission('subscriptions.admin'), controller.deleteFeature)

router.get('/plans/:id/features', authenticate, requirePermission('subscriptions.admin'), controller.getPlanFeatures)
router.put('/plans/:id/features', authenticate, requirePermission('subscriptions.admin'), validate(bulkSetEntitlementsSchema), controller.bulkSetEntitlements)

router.get('/users', authenticate, requirePermission('subscriptions.admin'), controller.listUsers)
router.patch('/users/:userId/assign', authenticate, requirePermission('subscriptions.admin'), validate(assignPlanSchema), controller.assignPlan)

router.get('/usage/:userId', authenticate, requirePermission('subscriptions.admin'), controller.getUserUsageHistory)
router.get('/usage/:userId/overview', authenticate, requirePermission('subscriptions.admin'), controller.getUserUsageOverview)
router.get('/usage/:userId/:featureKey', authenticate, requirePermission('subscriptions.admin'), controller.getFeatureUsageDetail)
router.post('/usage/adjust', authenticate, requirePermission('subscriptions.admin'), validate(adminAdjustUsageSchema), controller.adminAdjustUsage)
router.post('/usage/refund', authenticate, requirePermission('subscriptions.admin'), validate(adminForceRefundSchema), controller.adminForceRefund)

export default router
