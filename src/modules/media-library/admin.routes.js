import { Router } from 'express'
import { authenticate, requirePermission } from '../../../shared/middleware/auth.middleware.js'
import { validate } from '../../../shared/middleware/validate.middleware.js'
import { z } from 'zod'
import * as adminController from './admin.controller.js'

const router = Router()

router.use(authenticate, requirePermission('campaigns.review'))

const updateConfigSchema = z.object({
  quotaBytes: z.number().int().positive().optional(),
  maxFileBytes: z.number().int().positive().optional(),
})

router.get('/config', adminController.getMediaConfig)
router.put('/config', validate(updateConfigSchema), adminController.updateMediaConfig)

export default router