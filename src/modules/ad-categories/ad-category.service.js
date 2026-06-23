import * as repo from './ad-category.repository.js';
import { generateUuid } from '../../../shared/utils/uuid.utils.js';
import { NotFoundError, ConflictError } from '../../../shared/errors/AppError.js';

export async function createCategory(data) {
  const existing = await repo.findCategoryByCode(data.code);
  if (existing) {
    throw new ConflictError('Category with this code already exists');
  }
  return repo.createCategory(generateUuid(), data);
}

export async function listCategories(includeInactive = false) {
  return repo.findAllCategories(includeInactive);
}

export async function getCategory(id) {
  const category = await repo.findCategoryById(id);
  if (!category) throw new NotFoundError('Category not found');
  return category;
}

export async function updateCategory(id, data) {
  const category = await repo.findCategoryById(id);
  if (!category) throw new NotFoundError('Category not found');
  return repo.updateCategory(id, data);
}

export async function deleteCategory(id) {
  const category = await repo.findCategoryById(id);
  if (!category) throw new NotFoundError('Category not found');
  await repo.softDeleteCategory(id);
}

export async function setMyCategories(userId, categoryIds) {
  return repo.setUserCategories(userId, categoryIds);
}

export async function getMyCategories(userId) {
  return repo.findUserCategories(userId);
}
