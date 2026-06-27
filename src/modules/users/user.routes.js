import { Router } from 'express';
import * as controller from './user.controller.js';
import * as categoryController from '../ad-categories/ad-category.controller.js';
import { authenticate, requirePermission } from '../../../shared/middleware/auth.middleware.js';
import { validate } from '../../../shared/middleware/validate.middleware.js';
import {
  updateProfileSchema,
  updateStatusSchema,
  changePasswordSchema,
  listUsersSchema,
  createUserSchema,
} from './user.validation.js';
import { setUserCategoriesSchema } from '../ad-categories/ad-category.validation.js';

const router = Router();

router.get('/me', authenticate, requirePermission('own.profile.read'), controller.getProfile);
router.patch('/me', authenticate, requirePermission('own.profile.update'), validate(updateProfileSchema), controller.updateProfile);
router.post('/me/change-password', authenticate, validate(changePasswordSchema), controller.changePassword);
router.get('/me/categories', authenticate, categoryController.getMyCategories);
router.put('/me/categories', authenticate, validate(setUserCategoriesSchema), categoryController.setMyCategories);

router.post('/', authenticate, requirePermission('users.create'), validate(createUserSchema), controller.createUser);
router.get('/', authenticate, requirePermission('users.read'), validate(listUsersSchema, 'query'), controller.listUsers);
router.get('/:id', authenticate, requirePermission('users.read'), controller.getProfile);
router.patch('/:id/status', authenticate, requirePermission('users.update'), validate(updateStatusSchema), controller.updateStatus);
router.delete('/:id', authenticate, requirePermission('users.delete'), controller.deleteUser);

router.get('/:id/roles', authenticate, requirePermission('users.read'), controller.getUserRoles);
router.post('/:id/roles', authenticate, requirePermission('users.update'), controller.assignRole);
router.delete('/:id/roles/:roleId', authenticate, requirePermission('users.update'), controller.removeRole);

export default router;
