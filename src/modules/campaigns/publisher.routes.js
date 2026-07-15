import { Router } from 'express'
import * as publisherController from './publisher.controller.js'
import { authenticate, requireRole } from '../../../shared/middleware/auth.middleware.js'
import { validate } from '../../../shared/middleware/validate.middleware.js'
import { campaignQuerySchema } from './campaign.validation.js'

const router = Router()

router.get('/requests', authenticate, requireRole('publisher', 'super_admin'), validate(campaignQuerySchema, 'query'), publisherController.listRequests)
router.post('/requests/:requestId/accept', authenticate, requireRole('publisher', 'super_admin'), publisherController.acceptRequest)
router.post('/requests/:requestId/reject', authenticate, requireRole('publisher', 'super_admin'), publisherController.rejectRequest)
router.get('/categories', authenticate, requireRole('publisher', 'super_admin'), publisherController.getMyCategories)
router.put('/categories', authenticate, requireRole('publisher', 'super_admin'), publisherController.setMyCategories)

export default router
