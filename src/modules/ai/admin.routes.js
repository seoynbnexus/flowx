import { Router } from 'express';
import { authenticate, requirePermission } from '../../../shared/middleware/auth.middleware.js';
import { validate } from '../../../shared/middleware/validate.middleware.js';
import { z } from 'zod';
import * as adminController from './admin.controller.js';

const router = Router();

router.use(authenticate, requirePermission('ai.admin'));

const addCoinsSchema = z.object({
  userId: z.string().uuid(),
  amount: z.number().int().positive(),
  reason: z.string().max(255).optional(),
});

const deductCoinsSchema = z.object({
  userId: z.string().uuid(),
  amount: z.number().int().positive(),
  reason: z.string().max(255).optional(),
});

const updateConfigSchema = z.object({
  markupCoins: z.number().int().min(0).optional(),
  imageBaseCost: z.number().int().min(0).optional(),
});

router.get('/config', adminController.getConfig);
router.put('/config', validate(updateConfigSchema), adminController.updateConfig);

router.get('/usage', adminController.usageStats);
router.get('/usage/:userId', adminController.usageByUser);

router.get('/wallet/:userId', adminController.getWallet);
router.post('/wallet/add', validate(addCoinsSchema), adminController.addCoins);
router.post('/wallet/deduct', validate(deductCoinsSchema), adminController.deductCoins);

export default router;
