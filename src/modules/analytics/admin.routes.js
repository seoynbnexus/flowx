import { Router } from 'express';
import { authenticate, requirePermission } from '../../../shared/middleware/auth.middleware.js';
import * as adminController from './admin.controller.js';

const router = Router();

router.use(authenticate, requirePermission('ai.admin'));

router.get('/overview', adminController.getOverview);
router.get('/users', adminController.getUsers);
router.get('/logins', adminController.getLogins);
router.get('/ai-usage', adminController.getAiUsage);
router.get('/economy', adminController.getEconomy);

export default router;
