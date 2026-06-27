import { Router } from 'express';
import * as controller from './publisher.controller.js';
import { authenticate, requirePermission } from '../../../shared/middleware/auth.middleware.js';
import { validate } from '../../../shared/middleware/validate.middleware.js';
import { verifyAccountSchema, listAccountsQuerySchema } from './publisher.validation.js';

const router = Router();

router.get('/', authenticate, requirePermission('platform_accounts.read'), validate(listAccountsQuerySchema, 'query'), controller.listAllAccounts);
router.patch('/:id/verify', authenticate, requirePermission('platform_accounts.verify'), validate(verifyAccountSchema), controller.verifyAccount);

export default router;
