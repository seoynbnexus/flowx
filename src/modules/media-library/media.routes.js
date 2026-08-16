import { Router } from 'express'
import * as controller from './media.controller.js'
import { authenticate, requireRole } from '../../../shared/middleware/auth.middleware.js'
import { uploadPostMedia } from '../../../shared/utils/post-media-upload.js'
import { z } from 'zod'
import { validate } from '../../../shared/middleware/validate.middleware.js'

const listQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  kind: z.enum(['image', 'video']).optional(),
})

const uploadSchema = z.object({
  name: z.string().max(255).optional().nullable(),
})

const router = Router()

router.post('/', authenticate, requireRole('client', 'super_admin'), uploadPostMedia, validate(uploadSchema), controller.uploadMedia)
router.get('/', authenticate, requireRole('client', 'super_admin'), validate(listQuerySchema, 'query'), controller.listMedia)
router.delete('/:id', authenticate, requireRole('client', 'super_admin'), controller.deleteMedia)

export default router