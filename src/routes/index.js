import { Router } from 'express';
import authRoutes from '../modules/auth/auth.routes.js';
import userRoutes from '../modules/users/user.routes.js';
import roleRoutes from '../modules/roles/role.routes.js';
import permissionRoutes from '../modules/permissions/permission.routes.js';

const router = Router();

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/roles', roleRoutes);
router.use('/permissions', permissionRoutes);

router.get('/health', (_req, res) => {
  res.json({ success: true, message: 'OK', timestamp: new Date().toISOString() });
});

export default router;
