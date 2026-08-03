import { Router } from 'express';
import authRoutes from '../modules/auth/auth.routes.js';
import userRoutes from '../modules/users/user.routes.js';
import roleRoutes from '../modules/roles/role.routes.js';
import permissionRoutes from '../modules/permissions/permission.routes.js';
import publisherRoutes from '../modules/publisher-platforms/publisher.routes.js';
import adminPlatformRoutes from '../modules/publisher-platforms/admin.routes.js';
import oauthRoutes from '../modules/publisher-platforms/oauth.routes.js';
import adCategoryRoutes from '../modules/ad-categories/ad-category.routes.js';
import identityRoutes from '../modules/identity-documents/identity.routes.js';
import adminIdentityRoutes from '../modules/identity-documents/admin.routes.js';
import identityDocumentTypeRoutes from '../modules/identity-document-types/identity-document-types.routes.js';
import swaggerMiddleware from '../docs/swagger.js';
import configRoutes from '../modules/config/config.routes.js';
import aiRoutes from '../modules/ai/ai.routes.js';
import adminAiRoutes from '../modules/ai/admin.routes.js';
import adminAnalyticsRoutes from '../modules/analytics/admin.routes.js';
import campaignRoutes from '../modules/campaigns/campaign.routes.js';
import adminCampaignRoutes from '../modules/campaigns/admin.routes.js';
import publisherCampaignRoutes from '../modules/campaigns/publisher.routes.js';
import subscriptionRoutes from '../modules/subscriptions/subscription.routes.js';
import adminSubscriptionRoutes from '../modules/subscriptions/admin.routes.js';
import paymentRoutes from '../modules/payments/payment.routes.js';
import adminPaymentRoutes from '../modules/payments/admin.routes.js';
import notificationRoutes from '../modules/notifications/notifications.routes.js';

const router = Router();

router.use('/config', configRoutes);
router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/roles', roleRoutes);
router.use('/permissions', permissionRoutes);
router.use('/publisher/accounts', publisherRoutes);
router.use('/publisher/accounts/oauth', oauthRoutes);
router.use('/admin/platform-accounts', adminPlatformRoutes);
router.use('/ad-categories', adCategoryRoutes);
router.use('/identity/documents', identityRoutes);
router.use('/admin/identity-documents', adminIdentityRoutes);
router.use('/admin/identity-document-types', identityDocumentTypeRoutes);
router.use('/ai', aiRoutes);
router.use('/admin/ai', adminAiRoutes);
router.use('/admin/analytics', adminAnalyticsRoutes);
router.use('/campaigns', campaignRoutes);
router.use('/admin/campaigns', adminCampaignRoutes);
router.use('/publisher', publisherCampaignRoutes);
router.use('/subscriptions', subscriptionRoutes);
router.use('/admin/subscriptions', adminSubscriptionRoutes);
router.use('/payments', paymentRoutes);
router.use('/admin/payments', adminPaymentRoutes);
router.use('/notifications', notificationRoutes);
router.use('/docs', swaggerMiddleware);

router.get('/health', (_req, res) => {
  res.json({ success: true, message: 'OK', timestamp: new Date().toISOString() });
});

export default router;
