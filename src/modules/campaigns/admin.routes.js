import { Router } from 'express'
import * as adminController from './admin.controller.js'
import { authenticate, requirePermission } from '../../../shared/middleware/auth.middleware.js'
import { validate } from '../../../shared/middleware/validate.middleware.js'
import { approveCampaignSchema, rejectCampaignSchema, adminCampaignQuerySchema } from './campaign.validation.js'

const router = Router()

router.get('/', authenticate, requirePermission('campaigns.review'), validate(adminCampaignQuerySchema, 'query'), adminController.listAllCampaigns)
router.get('/:id', authenticate, requirePermission('campaigns.review'), adminController.getCampaignDetail)
router.post('/:id/approve', authenticate, requirePermission('campaigns.review'), validate(approveCampaignSchema), adminController.approveCampaign)
router.post('/:id/reject', authenticate, requirePermission('campaigns.review'), validate(rejectCampaignSchema), adminController.rejectCampaign)
router.post('/:id/retry-meta', authenticate, requirePermission('campaigns.review'), adminController.retryCampaignMeta)

export default router
