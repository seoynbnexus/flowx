import { Router } from 'express'
import { authenticate, requireRole } from '../../../shared/middleware/auth.middleware.js'
import { validate } from '../../../shared/middleware/validate.middleware.js'
import { z } from 'zod'
import * as featureController from './feature.controller.js'

const router = Router()

router.use(authenticate, requireRole('super_admin'))

const updateFeatureSchema = z.object({
  key: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]{1,63}$/),
  visible: z.boolean(),
})

const updatePublisherMaxSchema = z.object({
  max: z.number().int().min(1).max(10),
})

router.get('/features', featureController.getFeatureVisibility)
router.put('/features', validate(updateFeatureSchema), featureController.updateFeatureVisibility)
router.get('/publisher-max-accounts', featureController.getPublisherMaxAccounts)
router.put('/publisher-max-accounts', validate(updatePublisherMaxSchema), featureController.updatePublisherMaxAccounts)
router.get('/publisher-deadline', featureController.getPublisherDeadline)
router.put('/publisher-deadline', validate(z.object({ hours: z.number().int().min(1).max(720) })), featureController.updatePublisherDeadline)

export default router