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
  duplicateCampaignSchema,
} from './campaign.validation.js'

const router = Router()

router.get('/meta-search', authenticate, requireRole('client', 'admin', 'super_admin'), searchController.metaSearch)
router.post('/', authenticate, requireRole('client', 'super_admin'), validate(createCampaignSchema), controller.createCampaign)
router.get('/', authenticate, requireRole('client', 'super_admin'), validate(campaignQuerySchema, 'query'), controller.listCampaigns)
router.get('/:id', authenticate, requireRole('client', 'super_admin'), controller.getCampaign)
router.patch('/:id', authenticate, requireRole('client', 'super_admin'), validate(updateCampaignSchema), controller.updateCampaign)
router.post('/:id/submit', authenticate, requireRole('client', 'super_admin'), controller.submitCampaign)
router.post('/:id/cancel', authenticate, requireRole('client', 'super_admin'), controller.cancelCampaign)
router.post('/:id/validate', authenticate, requireRole('client', 'super_admin'), controller.validateCampaign)
router.put('/:id/creative', authenticate, requireRole('client', 'super_admin'), validate(creativeSchema), controller.saveCreative)
router.get('/:id/creative', authenticate, requireRole('client', 'super_admin'), controller.getCreative)
router.put('/:id/meta-settings', authenticate, requireRole('client', 'super_admin'), validate(metaSettingsSchema), controller.saveMetaSettings)
router.get('/:id/meta-settings', authenticate, requireRole('client', 'super_admin'), controller.getMetaSettings)
router.post('/:id/confirm-adjustments', authenticate, requireRole('client', 'super_admin'), controller.confirmAdjustments)
router.get('/:id/publishers', authenticate, requireRole('client', 'super_admin'), controller.getPublisherProgress)
router.post('/:id/duplicate', authenticate, requireRole('client', 'super_admin'), validate(duplicateCampaignSchema), controller.duplicateCampaign)
router.get('/:id/insights', authenticate, requireRole('client', 'super_admin'), controller.getCampaignInsights)

export default router
