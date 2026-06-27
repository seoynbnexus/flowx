import { Router } from 'express';
import * as controller from './identity-document-types.controller.js';
import { authenticate, requirePermission } from '../../../shared/middleware/auth.middleware.js';
import { validate } from '../../../shared/middleware/validate.middleware.js';
import { createDocumentTypeSchema, updateDocumentTypeSchema } from './identity-document-types.validation.js';

const router = Router();

router.get('/', authenticate, requirePermission('identity_document_types.read'), controller.list);
router.get('/:id', authenticate, requirePermission('identity_document_types.read'), controller.getById);
router.post('/', authenticate, requirePermission('identity_document_types.create'), validate(createDocumentTypeSchema), controller.create);
router.patch('/:id', authenticate, requirePermission('identity_document_types.update'), validate(updateDocumentTypeSchema), controller.update);
router.delete('/:id', authenticate, requirePermission('identity_document_types.delete'), controller.remove);

export default router;
