import { Router } from 'express'
import * as controller from './promotion.controller.js'
import { authenticate, requireRole } from '../../../shared/middleware/auth.middleware.js'

const router = Router()

router.get('/:id', authenticate, requireRole('client', 'super_admin', 'admin'), controller.getPromotion)
router.post('/:id/cancel', authenticate, requireRole('client', 'super_admin'), controller.cancelPromotion)

export default router
