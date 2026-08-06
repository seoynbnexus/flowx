import { Router } from 'express'
import * as adminController from './admin.controller.js'
import { authenticate, requirePermission } from '../../../shared/middleware/auth.middleware.js'
import { validate } from '../../../shared/middleware/validate.middleware.js'
import { approveCampaignSchema, rejectCampaignSchema, adminCampaignQuerySchema, coinConversionRateSchema, metaAdAccountSchema, metaAdAccountUpdateSchema } from './campaign.validation.js'

const router = Router()

router.get('/meta/sync-health', authenticate, requirePermission('campaigns.review'), adminController.getMetaSyncHealth)
router.get('/meta/accounts', authenticate, requirePermission('campaigns.review'), adminController.listMetaAccounts)
router.post('/meta/accounts', authenticate, requirePermission('campaigns.review'), validate(metaAdAccountSchema), adminController.createMetaAccount)
router.put('/meta/accounts/:id', authenticate, requirePermission('campaigns.review'), validate(metaAdAccountUpdateSchema), adminController.updateMetaAccount)
router.delete('/meta/accounts/:id', authenticate, requirePermission('campaigns.review'), adminController.deleteMetaAccount)
router.get('/', authenticate, requirePermission('campaigns.review'), validate(adminCampaignQuerySchema, 'query'), adminController.listAllCampaigns)
router.get('/:id', authenticate, requirePermission('campaigns.review'), adminController.getCampaignDetail)
router.post('/:id/sync', authenticate, requirePermission('campaigns.review'), adminController.syncCampaign)
router.post('/:id/settle', authenticate, requirePermission('campaigns.review'), adminController.settleCampaign)
router.post('/:id/approve', authenticate, requirePermission('campaigns.review'), validate(approveCampaignSchema), adminController.approveCampaign)
router.post('/:id/reject', authenticate, requirePermission('campaigns.review'), validate(rejectCampaignSchema), adminController.rejectCampaign)
router.post('/:id/retry-meta', authenticate, requirePermission('campaigns.review'), adminController.retryCampaignMeta)
router.post('/:id/force-go-live', authenticate, requirePermission('campaigns.force-manage'), adminController.forceGoLive)
router.post('/:id/force-cancel', authenticate, requirePermission('campaigns.force-manage'), adminController.forceCancel)
router.put('/conversion-rate', authenticate, requirePermission('campaigns.review'), validate(coinConversionRateSchema), adminController.updateConversionRate)

export default router
