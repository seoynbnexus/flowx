import { Router } from 'express';
import * as controller from './ad-category.controller.js';
import { authenticate, requirePermission } from '../../../shared/middleware/auth.middleware.js';
import { validate } from '../../../shared/middleware/validate.middleware.js';
import { createCategorySchema, updateCategorySchema, setUserCategoriesSchema } from './ad-category.validation.js';

const router = Router();

router.post('/', authenticate, requirePermission('users.update'), validate(createCategorySchema), controller.createCategory);
router.get('/', authenticate, requirePermission('users.update'), controller.listCategories);
router.get('/active', authenticate, controller.listActiveCategories);
router.get('/:id', authenticate, requirePermission('users.update'), controller.getCategory);
router.patch('/:id', authenticate, requirePermission('users.update'), validate(updateCategorySchema), controller.updateCategory);
router.delete('/:id', authenticate, requirePermission('users.update'), controller.deleteCategory);

export default router;
