import { Router } from 'express';
import * as controller from './publisher.controller.js';
import { authenticate, requireRole } from '../../../shared/middleware/auth.middleware.js';
import { validate } from '../../../shared/middleware/validate.middleware.js';
import { submitAccountSchema, deleteAccountSchema } from './publisher.validation.js';

const router = Router();

router.post('/', authenticate, requireRole('publisher'), validate(submitAccountSchema), controller.submitAccount);
router.get('/', authenticate, requireRole('publisher'), controller.listMyAccounts);
router.delete('/:id', authenticate, requireRole('publisher'), controller.removeAccount);

export default router;
