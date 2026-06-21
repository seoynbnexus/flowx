import { query, queryOne } from '../../../shared/database/connection.js';
import { uuidToBuffer, bufferToUuid, generateUuid } from '../../../shared/utils/uuid.utils.js';

function mapRow(row) {
  if (!row) return null;
  return {
    ...row,
    id: bufferToUuid(row.id),
  };
}

export async function findAll() {
  const rows = await query('SELECT * FROM roles ORDER BY created_at ASC');
  return rows.map(mapRow);
}

export async function findById(id) {
  const row = await queryOne('SELECT * FROM roles WHERE id = ?', [uuidToBuffer(id)]);
  return mapRow(row);
}

export async function findByCode(code) {
  const row = await queryOne('SELECT * FROM roles WHERE code = ?', [code]);
  return mapRow(row);
}

export async function create(data) {
  const id = generateUuid();
  await query(
    `INSERT INTO roles (id, code, name, description, is_system, is_super_admin)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [uuidToBuffer(id), data.code, data.name, data.description || null, 0, data.isSuperAdmin ? 1 : 0]
  );
  return findById(id);
}

export async function update(id, data) {
  const fields = [];
  const values = [];
  if (data.name !== undefined) { fields.push('name = ?'); values.push(data.name); }
  if (data.description !== undefined) { fields.push('description = ?'); values.push(data.description); }

  if (fields.length === 0) return findById(id);

  values.push(uuidToBuffer(id));
  await query(`UPDATE roles SET ${fields.join(', ')} WHERE id = ?`, values);
  return findById(id);
}

export async function remove(id) {
  await query('DELETE FROM role_permissions WHERE role_id = ?', [uuidToBuffer(id)]);
  await query('DELETE FROM user_roles WHERE role_id = ?', [uuidToBuffer(id)]);
  await query('DELETE FROM roles WHERE id = ?', [uuidToBuffer(id)]);
}

export async function getPermissions(roleId) {
  const rows = await query(
    `SELECT p.* FROM permissions p
     JOIN role_permissions rp ON rp.permission_id = p.id
     WHERE rp.role_id = ?`,
    [uuidToBuffer(roleId)]
  );
  return rows.map(r => ({ ...r, id: bufferToUuid(r.id) }));
}

export async function setPermissions(roleId, permissionIds) {
  const roleBuffer = uuidToBuffer(roleId);
  await query('DELETE FROM role_permissions WHERE role_id = ?', [roleBuffer]);

  if (permissionIds.length > 0) {
    const placeholders = permissionIds.map(() => '(?, ?)').join(', ');
    const values = [];
    for (const pid of permissionIds) {
      values.push(roleBuffer, uuidToBuffer(pid));
    }
    await query(
      `INSERT INTO role_permissions (role_id, permission_id) VALUES ${placeholders}`,
      values
    );
  }
}
