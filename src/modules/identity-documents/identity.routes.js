import { Router } from 'express';
import * as controller from './identity.controller.js';
import { authenticate, requireRole } from '../../../shared/middleware/auth.middleware.js';
import { uploadIdentity } from '../../../shared/utils/upload.utils.js';
import { z } from 'zod';
import { validate } from '../../../shared/middleware/validate.middleware.js';

const uploadSchema = z.object({
  documentType: z.string().min(1, 'Document type is required'),
});

const router = Router();

router.post('/', authenticate, requireRole('publisher', 'client'), uploadIdentity, validate(uploadSchema), controller.uploadDocument);
router.get('/', authenticate, requireRole('publisher', 'client'), controller.getMyDocuments);
router.get('/missing-mandatory', authenticate, requireRole('publisher', 'client'), controller.getMissingMandatory);

export default router;
