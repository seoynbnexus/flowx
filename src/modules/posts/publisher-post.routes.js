import { Router } from 'express'
import * as publisherController from './publisher-post.controller.js'
import { authenticate, requireRole } from '../../../shared/middleware/auth.middleware.js'
import { validate } from '../../../shared/middleware/validate.middleware.js'
import { z } from 'zod'

const requestQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  status: z.string().optional(),
})

const acceptSchema = z.object({
  platformAccountId: z.string().uuid('Invalid account ID'),
})

const router = Router()

router.get('/posts/requests', authenticate, requireRole('publisher', 'super_admin'), validate(requestQuerySchema, 'query'), publisherController.listRequests)
router.get('/posts/requests/:requestId', authenticate, requireRole('publisher', 'super_admin'), publisherController.getRequest)
router.post('/posts/requests/:requestId/accept', authenticate, requireRole('publisher', 'super_admin'), validate(acceptSchema), publisherController.acceptRequest)
router.post('/posts/requests/:requestId/reject', authenticate, requireRole('publisher', 'super_admin'), publisherController.rejectRequest)
router.post('/posts/requests/:requestId/complete', authenticate, requireRole('publisher', 'super_admin'), publisherController.completeRequest)

export default router
