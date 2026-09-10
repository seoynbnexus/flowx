import { Router } from 'express'
import * as controller from './promotion.controller.js'
import { authenticate, requireRole } from '../../../shared/middleware/auth.middleware.js'
import { validate } from '../../../shared/middleware/validate.middleware.js'
import { createPromotionSchema } from './promotion.validation.js'

const router = Router()

router.post('/:postId/promotions', authenticate, requireRole('client', 'super_admin'), validate(createPromotionSchema), controller.createPromotion)
router.get('/:postId/promotions', authenticate, requireRole('client', 'super_admin'), controller.listPostPromotions)

export default router
