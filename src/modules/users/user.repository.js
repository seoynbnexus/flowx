import { query, queryOne } from '../../../shared/database/connection.js';
import { uuidToBuffer, bufferToUuid, generateUuid } from '../../../shared/utils/uuid.utils.js';

function mapUserRow(row) {
  if (!row) return null;
  return {
    ...row,
    id: bufferToUuid(row.id),
    email_verified_at: row.email_verified_at || null,
    last_login_at: row.last_login_at || null,
    deleted_at: row.deleted_at || null,
  };
}

function mapProfileRow(row) {
  if (!row) return null;
  return {
    ...row,
    id: bufferToUuid(row.id),
    user_id: bufferToUuid(row.user_id),
    metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
  };
}

export async function findById(id) {
  const row = await queryOne('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL', [uuidToBuffer(id)]);
  return mapUserRow(row);
}

export async function findProfileByUserId(userId) {
  const row = await queryOne(
    'SELECT * FROM user_profiles WHERE user_id = ?',
    [uuidToBuffer(userId)]
  );
  return mapProfileRow(row);
}

export async function updateProfile(userId, data) {
  const fields = [];
  const values = [];

  if (data.firstName !== undefined) { fields.push('first_name = ?'); values.push(data.firstName); }
  if (data.lastName !== undefined) { fields.push('last_name = ?'); values.push(data.lastName); }
  if (data.avatarUrl !== undefined) { fields.push('avatar_url = ?'); values.push(data.avatarUrl); }
  if (data.countryCode !== undefined) { fields.push('country_code = ?'); values.push(data.countryCode); }
  if (data.state !== undefined) { fields.push('state = ?'); values.push(data.state); }
  if (data.city !== undefined) { fields.push('city = ?'); values.push(data.city); }
  if (data.pincode !== undefined) { fields.push('pincode = ?'); values.push(data.pincode); }
  if (data.timezone !== undefined) { fields.push('timezone = ?'); values.push(data.timezone); }
  if (data.metadata !== undefined) { fields.push('metadata = ?'); values.push(JSON.stringify(data.metadata)); }

  if (fields.length === 0) return null;

  values.push(uuidToBuffer(userId));
  await query(
    `UPDATE user_profiles SET ${fields.join(', ')} WHERE user_id = ?`,
    values
  );
  return findProfileByUserId(userId);
}

export async function listUsers({ page, limit, status, search }) {
  const offset = (page - 1) * limit;
  const where = ['deleted_at IS NULL'];
  const params = [];

  if (status) {
    where.push('status = ?');
    params.push(status);
  }

  if (search) {
    where.push('(email LIKE ? OR id IN (SELECT user_id FROM user_profiles WHERE first_name LIKE ? OR last_name LIKE ?))');
    const pattern = `%${search}%`;
    params.push(pattern, pattern, pattern);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const countRow = await queryOne(
    `SELECT COUNT(*) as total FROM users ${whereClause}`,
    params
  );

  const rows = await query(
    `SELECT u.*, up.first_name, up.last_name, up.avatar_url
     FROM users u
     LEFT JOIN user_profiles up ON up.user_id = u.id
     ${whereClause}
     ORDER BY u.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, String(limit), String(offset)]
  );

  return {
    users: rows.map(r => ({
      id: bufferToUuid(r.id),
      email: r.email,
      phone: r.phone,
      status: r.status,
      email_verified_at: r.email_verified_at || null,
      last_login_at: r.last_login_at || null,
      created_at: r.created_at,
      updated_at: r.updated_at,
      profile: {
        first_name: r.first_name,
        last_name: r.last_name,
        avatar_url: r.avatar_url,
      },
    })),
    total: countRow.total,
    page,
    limit,
  };
}

export async function updateStatus(userId, status) {
  await query('UPDATE users SET status = ? WHERE id = ?', [status, uuidToBuffer(userId)]);
  return findById(userId);
}

export async function softDelete(userId) {
  await query(
    'UPDATE users SET deleted_at = NOW(), status = ? WHERE id = ?',
    ['inactive', uuidToBuffer(userId)]
  );
}

export async function findUserRoles(userId) {
  const rows = await query(
    `SELECT r.id, r.code, r.name FROM roles r
     JOIN user_roles ur ON ur.role_id = r.id
     WHERE ur.user_id = ?`,
    [uuidToBuffer(userId)]
  );
  return rows.map(r => ({ ...r, id: bufferToUuid(r.id) }));
}

export async function assignRole(userId, roleId) {
  await query(
    'INSERT IGNORE INTO user_roles (id, user_id, role_id) VALUES (?, ?, ?)',
    [uuidToBuffer(generateUuid()), uuidToBuffer(userId), uuidToBuffer(roleId)]
  );
}

export async function removeRole(userId, roleId) {
  await query(
    'DELETE FROM user_roles WHERE user_id = ? AND role_id = ?',
    [uuidToBuffer(userId), uuidToBuffer(roleId)]
  );
}
