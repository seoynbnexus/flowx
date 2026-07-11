import { Router } from 'express';
import { authenticate, requireRole } from '../../../shared/middleware/auth.middleware.js';
import { validate } from '../../../shared/middleware/validate.middleware.js';
import { generateSchema, saveSchema, historyQuerySchema, generateImageSchema, saveImageSchema, imageQuerySchema } from './ai.model.js';
import * as aiController from './ai.controller.js';
import rateLimit from 'express-rate-limit';
import { AI_LIMITS } from './ai.config.js';

const router = Router();

const genLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: AI_LIMITS.rateLimitRpm || 30,
  message: { success: false, message: 'Too many AI generation requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const CLIENT_ROLES = ['client', 'super_admin'];

router.post('/generate', authenticate, requireRole(...CLIENT_ROLES), genLimiter, validate(generateSchema), aiController.generate);

router.post('/save', authenticate, requireRole(...CLIENT_ROLES), validate(saveSchema), aiController.save);

router.get('/history', authenticate, requireRole(...CLIENT_ROLES), validate(historyQuerySchema, 'query'), aiController.history);

router.delete('/history/:id', authenticate, requireRole(...CLIENT_ROLES), aiController.remove);

router.get('/wallet', authenticate, requireRole(...CLIENT_ROLES), aiController.wallet);

router.post('/generate-image', authenticate, requireRole(...CLIENT_ROLES), genLimiter, validate(generateImageSchema), aiController.generateImage);

router.post('/save-image', authenticate, requireRole(...CLIENT_ROLES), validate(saveImageSchema), aiController.saveImage);

router.get('/images', authenticate, requireRole(...CLIENT_ROLES), validate(imageQuerySchema, 'query'), aiController.listImages);

router.delete('/images/:id', authenticate, requireRole(...CLIENT_ROLES), aiController.removeImage);

export default router;
