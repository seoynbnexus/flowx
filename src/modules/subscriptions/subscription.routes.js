import { Router } from 'express'
import { authenticate, requireRole } from '../../../shared/middleware/auth.middleware.js'
import * as controller from './subscription.controller.js'

const router = Router()

router.get('/plans', controller.listPlans)
router.get('/my', authenticate, requireRole('client', 'super_admin'), controller.getSubscription)
router.get('/features/:featureKey', authenticate, requireRole('client', 'super_admin'), controller.getFeatureStatus)

export default router
