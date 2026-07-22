import { Router } from 'express'
import * as controller from './campaign.controller.js'
import * as searchController from './search.controller.js'
import { authenticate, requireRole } from '../../../shared/middleware/auth.middleware.js'
import { validate } from '../../../shared/middleware/validate.middleware.js'
import {
  createCampaignSchema,
  updateCampaignSchema,
  creativeSchema,
  metaSettingsSchema,
  campaignQuerySchema,
} from './campaign.validation.js'

const router = Router()

router.get('/meta-search', authenticate, requireRole('client', 'admin', 'super_admin'), searchController.metaSearch)
router.post('/', authenticate, requireRole('client', 'super_admin'), validate(createCampaignSchema), controller.createCampaign)
router.get('/', authenticate, requireRole('client', 'super_admin'), validate(campaignQuerySchema, 'query'), controller.listCampaigns)
router.get('/:id', authenticate, requireRole('client', 'super_admin'), controller.getCampaign)
router.patch('/:id', authenticate, requireRole('client', 'super_admin'), validate(updateCampaignSchema), controller.updateCampaign)
router.post('/:id/submit', authenticate, requireRole('client', 'super_admin'), controller.submitCampaign)
router.post('/:id/cancel', authenticate, requireRole('client', 'super_admin'), controller.cancelCampaign)
router.put('/:id/creative', authenticate, requireRole('client', 'super_admin'), validate(creativeSchema), controller.saveCreative)
router.get('/:id/creative', authenticate, requireRole('client', 'super_admin'), controller.getCreative)
router.put('/:id/meta-settings', authenticate, requireRole('client', 'super_admin'), validate(metaSettingsSchema), controller.saveMetaSettings)
router.get('/:id/meta-settings', authenticate, requireRole('client', 'super_admin'), controller.getMetaSettings)
router.post('/:id/confirm-adjustments', authenticate, requireRole('client', 'super_admin'), controller.confirmAdjustments)

export default router
