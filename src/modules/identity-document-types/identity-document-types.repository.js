import { query, queryOne } from '../../../shared/database/connection.js';
import { uuidToBuffer, bufferToUuid } from '../../../shared/utils/uuid.utils.js';

function mapRow(row) {
  if (!row) return null;
  return {
    id: bufferToUuid(row.id),
    code: row.code,
    name: row.name,
    description: row.description,
    isMandatory: !!row.is_mandatory,
    isActive: !!row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function findAll(includeInactive = false) {
  const where = includeInactive ? '' : 'WHERE is_active = 1';
  const rows = await query(`SELECT * FROM identity_document_types ${where} ORDER BY code`);
  return rows.map(mapRow);
}

export async function findById(id) {
  const row = await queryOne('SELECT * FROM identity_document_types WHERE id = ?', [uuidToBuffer(id)]);
  return mapRow(row);
}

export async function findByCode(code) {
  const row = await queryOne('SELECT * FROM identity_document_types WHERE code = ?', [code]);
  return mapRow(row);
}

export async function create(id, data) {
  await query(
    'INSERT INTO identity_document_types (id, code, name, description, is_mandatory) VALUES (?, ?, ?, ?, ?)',
    [uuidToBuffer(id), data.code, data.name, data.description || null, data.isMandatory ? 1 : 0]
  );
  return findById(id);
}

export async function update(id, data) {
  const fields = [];
  const values = [];

  if (data.name !== undefined) { fields.push('name = ?'); values.push(data.name); }
  if (data.description !== undefined) { fields.push('description = ?'); values.push(data.description); }
  if (data.isMandatory !== undefined) { fields.push('is_mandatory = ?'); values.push(data.isMandatory ? 1 : 0); }
  if (data.isActive !== undefined) { fields.push('is_active = ?'); values.push(data.isActive ? 1 : 0); }

  if (fields.length === 0) return findById(id);

  values.push(uuidToBuffer(id));
  await query(
    `UPDATE identity_document_types SET ${fields.join(', ')} WHERE id = ?`,
    values
  );
  return findById(id);
}

export async function softDelete(id) {
  await query('UPDATE identity_document_types SET is_active = 0 WHERE id = ?', [uuidToBuffer(id)]);
}
