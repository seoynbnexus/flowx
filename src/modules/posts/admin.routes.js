import { Router } from 'express'
import * as adminController from './admin.controller.js'
import { authenticate, requirePermission } from '../../../shared/middleware/auth.middleware.js'
import { validate } from '../../../shared/middleware/validate.middleware.js'
import { approvePostSchema, rejectPostSchema, adminPostQuerySchema, violationReviewSchema } from './post.validation.js'

const router = Router()

router.get('/', authenticate, requirePermission('posts.review'), validate(adminPostQuerySchema, 'query'), adminController.listAllPosts)
router.get('/flagged', authenticate, requirePermission('posts.review'), adminController.getFlaggedPosts)
router.get('/:id', authenticate, requirePermission('posts.review'), adminController.getPostDetail)
router.get('/:id/engagement', authenticate, requirePermission('posts.review'), adminController.getPostEngagement)
router.get('/:id/boost-performance', authenticate, requirePermission('posts.review'), adminController.getBoostPerformance)
router.post('/:id/approve', authenticate, requirePermission('posts.review'), validate(approvePostSchema), adminController.approvePost)
router.post('/:id/reject', authenticate, requirePermission('posts.review'), validate(rejectPostSchema), adminController.rejectPost)
router.post('/:id/retry', authenticate, requirePermission('posts.review'), adminController.retryPost)
router.get('/:id/publisher-requests', authenticate, requirePermission('posts.review'), adminController.getPostPublisherRequests)
router.get('/:id/publisher-requests/:requestId/publisher-accounts', authenticate, requirePermission('posts.review'), adminController.getPublisherRequestAccounts)
router.post('/:id/publisher-requests/:requestId/accept', authenticate, requirePermission('posts.review'), adminController.adminAcceptPublisherRequest)
router.post('/:id/force-go-live', authenticate, requirePermission('posts.manage'), adminController.forceGoLivePost)
router.post('/:id/expire-publisher-requests', authenticate, requirePermission('posts.manage'), adminController.expirePublisherRequests)
router.get('/:id/violations', authenticate, requirePermission('posts.review'), adminController.getPostViolations)
router.post('/:id/violations/:targetId/review', authenticate, requirePermission('posts.review'), validate(violationReviewSchema), adminController.reviewPostViolation)

router.get('/publishers/:publisherId/violations', authenticate, requirePermission('posts.review'), adminController.getPublisherViolations)
router.post('/publishers/:publisherId/suspend', authenticate, requirePermission('posts.review'), adminController.suspendPublisher)
router.post('/publishers/:publisherId/unsuspend', authenticate, requirePermission('posts.review'), adminController.unsuspendPublisher)
router.post('/publishers/:publisherId/warn', authenticate, requirePermission('posts.review'), adminController.warnPublisher)

export default router
