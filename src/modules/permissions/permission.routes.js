import { Router } from 'express';
import * as controller from './permission.controller.js';
import { authenticate, requirePermission } from '../../../shared/middleware/auth.middleware.js';

const router = Router();

router.get('/', authenticate, requirePermission('permissions.read'), controller.list);
router.get('/modules', authenticate, requirePermission('permissions.read'), controller.listModules);

export default router;
