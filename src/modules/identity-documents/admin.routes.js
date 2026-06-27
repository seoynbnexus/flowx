import { Router } from 'express';
import * as controller from './identity.controller.js';
import { authenticate, requirePermission } from '../../../shared/middleware/auth.middleware.js';
import { validate } from '../../../shared/middleware/validate.middleware.js';
import { verifyDocumentSchema, listDocumentsQuerySchema } from './identity.validation.js';

const router = Router();

router.get('/', authenticate, requirePermission('identity_documents.read'), validate(listDocumentsQuerySchema, 'query'), controller.listAllDocuments);
router.patch('/:id/verify', authenticate, requirePermission('identity_documents.verify'), validate(verifyDocumentSchema), controller.verifyDocument);

export default router;
