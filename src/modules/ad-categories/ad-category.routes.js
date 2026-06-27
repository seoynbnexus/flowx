import { Router } from 'express';
import * as controller from './ad-category.controller.js';
import { authenticate, requirePermission } from '../../../shared/middleware/auth.middleware.js';
import { validate } from '../../../shared/middleware/validate.middleware.js';
import { createCategorySchema, updateCategorySchema, setUserCategoriesSchema } from './ad-category.validation.js';

const router = Router();

router.post('/', authenticate, requirePermission('ad_categories.create'), validate(createCategorySchema), controller.createCategory);
router.get('/', authenticate, requirePermission('ad_categories.read'), controller.listCategories);
router.get('/active', authenticate, controller.listActiveCategories);
router.get('/:id', authenticate, requirePermission('ad_categories.read'), controller.getCategory);
router.patch('/:id', authenticate, requirePermission('ad_categories.update'), validate(updateCategorySchema), controller.updateCategory);
router.delete('/:id', authenticate, requirePermission('ad_categories.delete'), controller.deleteCategory);

export default router;
