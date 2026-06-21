import { Router } from 'express';
import * as controller from './role.controller.js';
import { authenticate, requirePermission } from '../../../shared/middleware/auth.middleware.js';
import { validate } from '../../../shared/middleware/validate.middleware.js';
import { createRoleSchema, updateRoleSchema } from './role.validation.js';

const router = Router();

router.get('/', authenticate, requirePermission('roles.read'), controller.list);
router.get('/:id', authenticate, requirePermission('roles.read'), controller.getById);
router.post('/', authenticate, requirePermission('roles.create'), validate(createRoleSchema), controller.create);
router.patch('/:id', authenticate, requirePermission('roles.update'), validate(updateRoleSchema), controller.update);
router.delete('/:id', authenticate, requirePermission('roles.delete'), controller.remove);

router.get('/:id/permissions', authenticate, requirePermission('roles.read'), controller.getPermissions);
router.post('/:id/permissions', authenticate, requirePermission('roles.update'), controller.assignPermissions);

export default router;
