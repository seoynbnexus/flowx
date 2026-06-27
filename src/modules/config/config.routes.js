import { Router } from 'express';
import { optionalAuth } from '../../../shared/middleware/auth.middleware.js';
import { getConfig } from './config.controller.js';

const router = Router();

router.get('/', optionalAuth, getConfig);

export default router;
