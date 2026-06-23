import * as service from './ad-category.service.js';
import { sendSuccess, sendCreated, sendNoContent } from '../../../shared/utils/response.utils.js';

export async function createCategory(req, res, next) {
  try {
    const category = await service.createCategory(req.body);
    return sendCreated(res, category, 'Category created');
  } catch (error) {
    next(error);
  }
}

export async function listCategories(req, res, next) {
  try {
    const categories = await service.listCategories(true);
    return sendSuccess(res, categories);
  } catch (error) {
    next(error);
  }
}

export async function listActiveCategories(req, res, next) {
  try {
    const categories = await service.listCategories(false);
    return sendSuccess(res, categories);
  } catch (error) {
    next(error);
  }
}

export async function getCategory(req, res, next) {
  try {
    const category = await service.getCategory(req.params.id);
    return sendSuccess(res, category);
  } catch (error) {
    next(error);
  }
}

export async function updateCategory(req, res, next) {
  try {
    const category = await service.updateCategory(req.params.id, req.body);
    return sendSuccess(res, category, 'Category updated');
  } catch (error) {
    next(error);
  }
}

export async function deleteCategory(req, res, next) {
  try {
    await service.deleteCategory(req.params.id);
    return sendNoContent(res);
  } catch (error) {
    next(error);
  }
}

export async function setMyCategories(req, res, next) {
  try {
    const categories = await service.setMyCategories(req.user.id, req.body.categoryIds);
    return sendSuccess(res, categories, 'Categories updated');
  } catch (error) {
    next(error);
  }
}

export async function getMyCategories(req, res, next) {
  try {
    const categories = await service.getMyCategories(req.user.id);
    return sendSuccess(res, categories);
  } catch (error) {
    next(error);
  }
}
