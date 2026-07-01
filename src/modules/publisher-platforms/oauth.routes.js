import { Router } from 'express';
import * as controller from './oauth.controller.js';
import { authenticate } from '../../../shared/middleware/auth.middleware.js';

const router = Router();

router.get('/url', authenticate, controller.getOAuthUrl);
router.get('/callback', controller.handleCallback);
router.get('/status', authenticate, controller.getConnectionStatus);

export default router;
