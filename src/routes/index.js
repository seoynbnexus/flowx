import { Router } from 'express';
import authRoutes from '../modules/auth/auth.routes.js';
import userRoutes from '../modules/users/user.routes.js';
import roleRoutes from '../modules/roles/role.routes.js';
import permissionRoutes from '../modules/permissions/permission.routes.js';
import publisherRoutes from '../modules/publisher-platforms/publisher.routes.js';
import adminPlatformRoutes from '../modules/publisher-platforms/admin.routes.js';
import adCategoryRoutes from '../modules/ad-categories/ad-category.routes.js';
import identityRoutes from '../modules/identity-documents/identity.routes.js';
import adminIdentityRoutes from '../modules/identity-documents/admin.routes.js';
import swaggerMiddleware from '../docs/swagger.js';

const router = Router();

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/roles', roleRoutes);
router.use('/permissions', permissionRoutes);
router.use('/publisher/accounts', publisherRoutes);
router.use('/admin/platform-accounts', adminPlatformRoutes);
router.use('/ad-categories', adCategoryRoutes);
router.use('/identity/documents', identityRoutes);
router.use('/admin/identity-documents', adminIdentityRoutes);
router.use('/docs', swaggerMiddleware);

router.get('/health', (_req, res) => {
  res.json({ success: true, message: 'OK', timestamp: new Date().toISOString() });
});

export default router;
