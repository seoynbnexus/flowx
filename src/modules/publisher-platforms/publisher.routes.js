import { Router } from 'express';
import * as controller from './publisher.controller.js';
import { authenticate, requireRole } from '../../../shared/middleware/auth.middleware.js';
import { validate } from '../../../shared/middleware/validate.middleware.js';
import { submitAccountSchema, deleteAccountSchema } from './publisher.validation.js';

const router = Router();

router.post('/', authenticate, requireRole('publisher', 'client'), validate(submitAccountSchema), controller.submitAccount);
router.post('/disconnect', authenticate, requireRole('publisher', 'client'), controller.disconnectAll);
router.get('/', authenticate, requireRole('publisher', 'client'), controller.listMyAccounts);
router.delete('/:id', authenticate, requireRole('publisher', 'client'), controller.removeAccount);

export default router;
