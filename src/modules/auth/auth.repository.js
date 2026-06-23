import { query, queryOne } from '../../../shared/database/connection.js';
import { uuidToBuffer, bufferToUuid, generateUuid } from '../../../shared/utils/uuid.utils.js';

const rowToUser = (row) => {
  if (!row) return null;
  return {
    ...row,
    id: bufferToUuid(row.id),
    email_verified_at: row.email_verified_at || null,
    last_login_at: row.last_login_at || null,
    deleted_at: row.deleted_at || null,
  };
};

const rowToSession = (row) => {
  if (!row) return null;
  return { ...row, id: bufferToUuid(row.id), user_id: bufferToUuid(row.user_id) };
};

export async function findUserByEmail(email) {
  const row = await queryOne(
    `SELECT u.*, up.first_name, up.last_name, up.avatar_url, up.country_code, up.state, up.city
     FROM users u
     LEFT JOIN user_profiles up ON up.user_id = u.id
     WHERE u.email = ?`,
    [email]
  );
  return rowToUser(row);
}

export async function findUserById(id) {
  const row = await queryOne(
    `SELECT u.*, up.first_name, up.last_name, up.avatar_url, up.country_code, up.state, up.city
     FROM users u
     LEFT JOIN user_profiles up ON up.user_id = u.id
     WHERE u.id = ?`,
    [uuidToBuffer(id)]
  );
  return rowToUser(row);
}

export async function createUser(id, email, status = 'pending', phone = null) {
  await query(
    'INSERT INTO users (id, email, phone, status) VALUES (?, ?, ?, ?)',
    [uuidToBuffer(id), email, phone, status]
  );
  return findUserById(id);
}

export async function createUserProfile(id, userId, data) {
  await query(
    `INSERT INTO user_profiles (id, user_id, first_name, last_name, country_code, state)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      uuidToBuffer(id),
      uuidToBuffer(userId),
      data.firstName || null,
      data.lastName || null,
      data.countryCode || 'IN',
      data.state || null,
    ]
  );
}

export async function createUserPassword(userId, passwordHash) {
  await query(
    'INSERT INTO user_passwords (user_id, password_hash) VALUES (?, ?)',
    [uuidToBuffer(userId), passwordHash]
  );
}

export async function getUserPassword(userId) {
  return queryOne(
    'SELECT * FROM user_passwords WHERE user_id = ?',
    [uuidToBuffer(userId)]
  );
}

export async function updateUserPassword(userId, passwordHash) {
  await query(
    'UPDATE user_passwords SET password_hash = ?, password_changed_at = NOW(), failed_attempts = 0 WHERE user_id = ?',
    [passwordHash, uuidToBuffer(userId)]
  );
}

export async function incrementFailedAttempts(userId) {
  await query(
    'UPDATE user_passwords SET failed_attempts = failed_attempts + 1 WHERE user_id = ?',
    [uuidToBuffer(userId)]
  );
}

export async function lockUserAccount(userId, lockedUntil) {
  await query(
    'UPDATE user_passwords SET locked_until = ? WHERE user_id = ?',
    [lockedUntil, uuidToBuffer(userId)]
  );
}

export async function updateUserLogin(userId) {
  await query(
    'UPDATE users SET last_login_at = NOW() WHERE id = ?',
    [uuidToBuffer(userId)]
  );
}

export async function updateUserStatus(userId, status) {
  await query(
    'UPDATE users SET status = ? WHERE id = ?',
    [status, uuidToBuffer(userId)]
  );
}

export async function createSession(id, userId, refreshTokenHash, expiresAt, deviceName, ipAddress) {
  await query(
    `INSERT INTO user_sessions (id, user_id, refresh_token_hash, expires_at, device_name, ip_address)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [uuidToBuffer(id), uuidToBuffer(userId), refreshTokenHash, expiresAt, deviceName || null, ipAddress || null]
  );
  return findSessionById(id);
}

export async function findSessionById(id) {
  const row = await queryOne(
    'SELECT * FROM user_sessions WHERE id = ?',
    [uuidToBuffer(id)]
  );
  return rowToSession(row);
}

export async function findSessionByRefreshToken(tokenHash) {
  const row = await queryOne(
    'SELECT * FROM user_sessions WHERE refresh_token_hash = ?',
    [tokenHash]
  );
  return rowToSession(row);
}

export async function deleteSession(id) {
  await query('DELETE FROM user_sessions WHERE id = ?', [uuidToBuffer(id)]);
}

export async function deleteUserSessions(userId) {
  await query('DELETE FROM user_sessions WHERE user_id = ?', [uuidToBuffer(userId)]);
}

export async function createEmailVerification(id, userId, tokenHash, expiresAt) {
  await query(
    'INSERT INTO email_verifications (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)',
    [uuidToBuffer(id), uuidToBuffer(userId), tokenHash, expiresAt]
  );
}

export async function findEmailVerification(tokenHash) {
  const row = await queryOne(
    'SELECT * FROM email_verifications WHERE token_hash = ? AND verified_at IS NULL',
    [tokenHash]
  );
  if (!row) return null;
  return { ...row, id: bufferToUuid(row.id), user_id: bufferToUuid(row.user_id) };
}

export async function verifyEmail(userId) {
  await query(
    'UPDATE email_verifications SET verified_at = NOW() WHERE user_id = ? AND verified_at IS NULL',
    [uuidToBuffer(userId)]
  );
  await query('UPDATE users SET email_verified_at = NOW() WHERE id = ?', [uuidToBuffer(userId)]);
}

export async function resetFailedAttempts(userId) {
  await query(
    'UPDATE user_passwords SET failed_attempts = 0, locked_until = NULL WHERE user_id = ?',
    [uuidToBuffer(userId)]
  );
}

export async function createPasswordReset(id, userId, tokenHash, expiresAt) {
  await query(
    'INSERT INTO password_resets (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)',
    [uuidToBuffer(id), uuidToBuffer(userId), tokenHash, expiresAt]
  );
}

export async function findPasswordReset(tokenHash) {
  const row = await queryOne(
    'SELECT * FROM password_resets WHERE token_hash = ? AND used_at IS NULL',
    [tokenHash]
  );
  if (!row) return null;
  return { ...row, id: bufferToUuid(row.id), user_id: bufferToUuid(row.user_id) };
}

export async function usePasswordReset(tokenHash) {
  await query(
    'UPDATE password_resets SET used_at = NOW() WHERE token_hash = ?',
    [tokenHash]
  );
}

export async function createPhoneOtp(id, userId, phone, otpHash, purpose, expiresAt) {
  await query(
    'INSERT INTO phone_otps (id, user_id, phone, otp_hash, purpose, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    [uuidToBuffer(id), userId ? uuidToBuffer(userId) : null, phone, otpHash, purpose, expiresAt]
  );
}

export async function findPhoneOtp(phone, purpose) {
  const row = await queryOne(
    'SELECT * FROM phone_otps WHERE phone = ? AND purpose = ? AND used_at IS NULL ORDER BY created_at DESC LIMIT 1',
    [phone, purpose]
  );
  if (!row) return null;
  return { ...row, id: bufferToUuid(row.id), user_id: row.user_id ? bufferToUuid(row.user_id) : null };
}

export async function usePhoneOtp(id) {
  await query('UPDATE phone_otps SET used_at = NOW() WHERE id = ?', [uuidToBuffer(id)]);
}

export async function incrementOtpAttempts(id) {
  await query('UPDATE phone_otps SET attempts = attempts + 1 WHERE id = ?', [uuidToBuffer(id)]);
}

export async function createEmailOtp(id, email, otpHash, purpose, expiresAt) {
  await query(
    'INSERT INTO email_otps (id, email, otp_hash, purpose, expires_at) VALUES (?, ?, ?, ?, ?)',
    [uuidToBuffer(id), email, otpHash, purpose, expiresAt]
  );
}

export async function findEmailOtp(email, purpose) {
  const row = await queryOne(
    'SELECT * FROM email_otps WHERE email = ? AND purpose = ? AND used_at IS NULL ORDER BY created_at DESC LIMIT 1',
    [email, purpose]
  );
  if (!row) return null;
  return { ...row, id: bufferToUuid(row.id) };
}

export async function useEmailOtp(id) {
  await query('UPDATE email_otps SET used_at = NOW() WHERE id = ?', [uuidToBuffer(id)]);
}

export async function incrementEmailOtpAttempts(id) {
  await query('UPDATE email_otps SET attempts = attempts + 1 WHERE id = ?', [uuidToBuffer(id)]);
}

export async function createLoginHistory(id, userId, method, ipAddress, userAgent, success, providerId) {
  await query(
    `INSERT INTO auth_login_history (id, user_id, provider_id, login_method, ip_address, user_agent, success)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      uuidToBuffer(id),
      userId ? uuidToBuffer(userId) : null,
      providerId ? uuidToBuffer(providerId) : null,
      method,
      ipAddress || null,
      userAgent || null,
      success ? 1 : 0,
    ]
  );
}

export async function findUserByPhone(phone) {
  const row = await queryOne(
    `SELECT u.*, up.first_name, up.last_name, up.avatar_url, up.country_code, up.state, up.city
     FROM users u
     LEFT JOIN user_profiles up ON up.user_id = u.id
     WHERE u.phone = ?`,
    [phone]
  );
  return rowToUser(row);
}

export async function findOauthProviderByCode(code) {
  const row = await queryOne('SELECT * FROM oauth_providers WHERE code = ?', [code]);
  if (!row) return null;
  return { ...row, id: bufferToUuid(row.id) };
}

export async function findOauthAccount(providerId, providerUserId) {
  const row = await queryOne(
    'SELECT * FROM oauth_accounts WHERE provider_id = ? AND provider_user_id = ?',
    [uuidToBuffer(providerId), providerUserId]
  );
  if (!row) return null;
  return { ...row, id: bufferToUuid(row.id), user_id: bufferToUuid(row.user_id), provider_id: bufferToUuid(row.provider_id) };
}

export async function findOauthAccountsByUserId(userId) {
  const rows = await query(
    'SELECT oa.*, op.code AS provider_code, op.name AS provider_name FROM oauth_accounts oa JOIN oauth_providers op ON op.id = oa.provider_id WHERE oa.user_id = ?',
    [uuidToBuffer(userId)]
  );
  return rows.map(r => ({
    ...r,
    id: bufferToUuid(r.id),
    user_id: bufferToUuid(r.user_id),
    provider_id: bufferToUuid(r.provider_id),
  }));
}

export async function createOauthAccount(id, userId, providerId, providerUserId, providerEmail, providerUsername) {
  await query(
    `INSERT INTO oauth_accounts (id, user_id, provider_id, provider_user_id, provider_email, provider_username)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [uuidToBuffer(id), uuidToBuffer(userId), uuidToBuffer(providerId), providerUserId, providerEmail || null, providerUsername || null]
  );
}

export async function assignUserRole(userId, roleCode) {
  const role = await queryOne('SELECT id FROM roles WHERE code = ?', [roleCode]);
  if (role) {
    await query(
      'INSERT IGNORE INTO user_roles (id, user_id, role_id) VALUES (?, ?, ?)',
      [uuidToBuffer(generateUuid()), uuidToBuffer(userId), role.id]
    );
  }
}

export async function createAuditLog(id, actorId, entityType, entityId, action, oldValues, newValues) {
  await query(
    `INSERT INTO audit_logs (id, actor_id, entity_type, entity_id, action, old_values, new_values)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      uuidToBuffer(id),
      actorId ? uuidToBuffer(actorId) : null,
      entityType || null,
      entityId ? uuidToBuffer(entityId) : null,
      action,
      oldValues ? JSON.stringify(oldValues) : null,
      newValues ? JSON.stringify(newValues) : null,
    ]
  );
}

export async function findUserRoles(userId) {
  const rows = await query(
    `SELECT r.code, r.name FROM roles r
     JOIN user_roles ur ON ur.role_id = r.id
     WHERE ur.user_id = ?`,
    [uuidToBuffer(userId)]
  );
  return rows.map(r => r.code);
}

export async function findUserPermissions(userId) {
  const rows = await query(
    `SELECT DISTINCT p.code FROM permissions p
     JOIN role_permissions rp ON rp.permission_id = p.id
     JOIN user_roles ur ON ur.role_id = rp.role_id
     WHERE ur.user_id = ?`,
    [uuidToBuffer(userId)]
  );
  return rows.map(r => r.code);
}
