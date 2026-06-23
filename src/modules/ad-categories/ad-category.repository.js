import { query, queryOne } from '../../../shared/database/connection.js';
import { uuidToBuffer, bufferToUuid, generateUuid } from '../../../shared/utils/uuid.utils.js';

function mapCategoryRow(row) {
  if (!row) return null;
  return {
    id: bufferToUuid(row.id),
    name: row.name,
    code: row.code,
    description: row.description,
    icon: row.icon,
    isActive: !!row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createCategory(id, data) {
  await query(
    'INSERT INTO ad_categories (id, code, name, description, icon) VALUES (?, ?, ?, ?, ?)',
    [uuidToBuffer(id), data.code, data.name, data.description || null, data.icon || null]
  );
  return findCategoryById(id);
}

export async function findCategoryById(id) {
  const row = await queryOne('SELECT * FROM ad_categories WHERE id = ?', [uuidToBuffer(id)]);
  return mapCategoryRow(row);
}

export async function findCategoryByCode(code) {
  const row = await queryOne('SELECT * FROM ad_categories WHERE code = ?', [code]);
  return mapCategoryRow(row);
}

export async function findAllCategories(includeInactive = false) {
  const where = includeInactive ? '' : 'WHERE is_active = 1';
  const rows = await query(`SELECT * FROM ad_categories ${where} ORDER BY name`);
  return rows.map(mapCategoryRow);
}

export async function updateCategory(id, data) {
  const fields = [];
  const values = [];

  if (data.name !== undefined) { fields.push('name = ?'); values.push(data.name); }
  if (data.description !== undefined) { fields.push('description = ?'); values.push(data.description); }
  if (data.icon !== undefined) { fields.push('icon = ?'); values.push(data.icon); }
  if (data.isActive !== undefined) { fields.push('is_active = ?'); values.push(data.isActive ? 1 : 0); }

  if (fields.length === 0) return findCategoryById(id);

  values.push(uuidToBuffer(id));
  await query(
    `UPDATE ad_categories SET ${fields.join(', ')} WHERE id = ?`,
    values
  );
  return findCategoryById(id);
}

export async function softDeleteCategory(id) {
  await query('UPDATE ad_categories SET is_active = 0 WHERE id = ?', [uuidToBuffer(id)]);
}

export async function setUserCategories(userId, categoryIds) {
  await query('DELETE FROM user_categories WHERE user_id = ?', [uuidToBuffer(userId)]);

  if (categoryIds.length === 0) return [];

  const values = categoryIds.map(catId => [
    uuidToBuffer(generateUuid()),
    uuidToBuffer(userId),
    uuidToBuffer(catId),
  ]);

  const placeholders = values.map(() => '(?, ?, ?)').join(', ');
  const flatValues = values.flat();

  await query(
    `INSERT INTO user_categories (id, user_id, category_id) VALUES ${placeholders}`,
    flatValues
  );

  return findUserCategories(userId);
}

export async function findUserCategories(userId) {
  const rows = await query(
    `SELECT c.* FROM ad_categories c
     JOIN user_categories uc ON uc.category_id = c.id
     WHERE uc.user_id = ?
     ORDER BY c.name`,
    [uuidToBuffer(userId)]
  );
  return rows.map(mapCategoryRow);
}
