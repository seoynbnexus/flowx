import { Router } from 'express'
import { authenticate, requireRole, requirePermission } from '../../../shared/middleware/auth.middleware.js'
import * as controller from './dashboard.controller.js'

const router = Router()

router.get('/client', authenticate, requireRole('client', 'super_admin'), controller.getClientDashboard)
router.get('/publisher', authenticate, requireRole('publisher', 'super_admin'), controller.getPublisherDashboard)
router.get('/admin', authenticate, requirePermission('ai.admin'), controller.getAdminDashboard)

export default router
