import { Router } from 'express'
import * as adminController from './admin.controller.js'
import { authenticate, requirePermission } from '../../../shared/middleware/auth.middleware.js'
import { validate } from '../../../shared/middleware/validate.middleware.js'
import { approvePostSchema, rejectPostSchema, adminPostQuerySchema } from './post.validation.js'

const router = Router()

router.get('/', authenticate, requirePermission('posts.review'), validate(adminPostQuerySchema, 'query'), adminController.listAllPosts)
router.get('/:id', authenticate, requirePermission('posts.review'), adminController.getPostDetail)
router.get('/:id/engagement', authenticate, requirePermission('posts.review'), adminController.getPostEngagement)
router.post('/:id/approve', authenticate, requirePermission('posts.review'), validate(approvePostSchema), adminController.approvePost)
router.post('/:id/reject', authenticate, requirePermission('posts.review'), validate(rejectPostSchema), adminController.rejectPost)
router.post('/:id/retry', authenticate, requirePermission('posts.review'), adminController.retryPost)
router.get('/:id/publisher-requests', authenticate, requirePermission('posts.review'), adminController.getPostPublisherRequests)
router.post('/:id/force-go-live', authenticate, requirePermission('posts.manage'), adminController.forceGoLivePost)
router.post('/:id/expire-publisher-requests', authenticate, requirePermission('posts.manage'), adminController.expirePublisherRequests)

export default router
