import { Router } from 'express';
import * as controller from './oauth.controller.js';
import { authenticate } from '../../../shared/middleware/auth.middleware.js';

const router = Router();

router.get('/url', authenticate, controller.getOAuthUrl);
router.get('/callback', controller.handleCallback);
router.get('/status', authenticate, controller.getConnectionStatus);
router.get('/available-pages', authenticate, controller.getAvailablePages);
router.post('/pages', authenticate, controller.addPage);
router.get('/available-instagram', authenticate, controller.getAvailableInstagram);
router.post('/instagram', authenticate, controller.addInstagram);
router.get('/discovered-assets', authenticate, controller.getDiscoveredAssets);
router.post('/connect-selected', authenticate, controller.connectSelectedAssets);

export default router;
