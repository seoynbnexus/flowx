import { Router } from 'express'
import * as controller from './post.controller.js'
import { authenticate, requireRole } from '../../../shared/middleware/auth.middleware.js'
import { validate } from '../../../shared/middleware/validate.middleware.js'
import {
  createPostSchema,
  updatePostSchema,
  postQuerySchema,
  duplicatePostSchema,
  postTargetsSchema,
} from './post.validation.js'

const router = Router()

router.get('/accounts/available', authenticate, requireRole('client', 'super_admin'), controller.getAvailableAccounts)
router.post('/', authenticate, requireRole('client', 'super_admin'), validate(createPostSchema), controller.createPost)
router.get('/', authenticate, requireRole('client', 'super_admin'), validate(postQuerySchema, 'query'), controller.listPosts)
router.get('/:id', authenticate, requireRole('client', 'super_admin'), controller.getPost)
router.patch('/:id', authenticate, requireRole('client', 'super_admin'), validate(updatePostSchema), controller.updatePost)
router.post('/:id/submit', authenticate, requireRole('client', 'super_admin'), controller.submitPost)
router.post('/:id/cancel', authenticate, requireRole('client', 'super_admin'), controller.cancelPost)
router.post('/:id/duplicate', authenticate, requireRole('client', 'super_admin'), validate(duplicatePostSchema), controller.duplicatePost)
router.put('/:id/targets', authenticate, requireRole('client', 'super_admin'), validate(postTargetsSchema), controller.setPostTargets)
router.get('/:id/targets', authenticate, requireRole('client', 'super_admin'), controller.getPostTargets)
router.get('/:id/engagement', authenticate, requireRole('client', 'super_admin'), controller.getPostEngagement)
router.post('/:id/retry', authenticate, requireRole('client', 'super_admin'), controller.retryPost)
router.get('/:id/publisher-progress', authenticate, requireRole('client', 'super_admin'), controller.getPostPublisherProgress)

export default router
