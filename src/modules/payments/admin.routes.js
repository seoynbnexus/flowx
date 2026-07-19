import { Router } from 'express'
import { authenticate, requirePermission } from '../../../shared/middleware/auth.middleware.js'
import { validate } from '../../../shared/middleware/validate.middleware.js'
import { createPackageSchema, updatePackageSchema } from './payment.validation.js'
import * as controller from './payment.controller.js'

const router = Router()

router.get('/packages', authenticate, requirePermission('subscriptions.admin'), controller.adminListPackages)
router.post('/packages', authenticate, requirePermission('subscriptions.admin'), validate(createPackageSchema), controller.adminCreatePackage)
router.put('/packages/:id', authenticate, requirePermission('subscriptions.admin'), validate(updatePackageSchema), controller.adminUpdatePackage)
router.delete('/packages/:id', authenticate, requirePermission('subscriptions.admin'), controller.adminDeletePackage)

export default router
