import { Router } from 'express'
import * as controller from './notifications.controller.js'
import { authenticate } from '../../../shared/middleware/auth.middleware.js'

const router = Router()

router.get('/unread-count', authenticate, controller.getUnreadCount)
router.get('/', authenticate, controller.listNotifications)
router.post('/read', authenticate, controller.markRead)

export default router
