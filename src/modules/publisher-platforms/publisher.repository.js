import { query, queryOne } from '../../../shared/database/connection.js';
import { uuidToBuffer, bufferToUuid, generateUuid } from '../../../shared/utils/uuid.utils.js';

import { decrypt } from '../../../shared/utils/crypto.utils.js';

function mapAccountRow(row) {
  if (!row) return null;
  return {
    id: bufferToUuid(row.id),
    userId: bufferToUuid(row.user_id),
    platformId: bufferToUuid(row.platform_id),
    profileUrl: row.profile_url,
    platformUsername: row.platform_username,
    platformDisplayName: row.platform_display_name,
    avatarUrl: row.avatar_url,
    followersCount: row.followers_count,
    platformUserId: row.platform_user_id,
    instagramAccountType: row.instagram_account_type,
    instagramBusinessAccountId: row.instagram_business_account_id,
    accessToken: row.access_token ? decrypt(row.access_token) : null,
    refreshToken: row.refresh_token ? decrypt(row.refresh_token) : null,
    tokenExpiresAt: row.token_expires_at,
    tokenStatus: row.token_status,
    tokenType: row.token_type || 'user',
    tokenIssuedAt: row.token_issued_at,
    oauthProvider: row.oauth_provider,
    verificationStatus: row.verification_status,
    verifiedAt: row.verified_at,
    verifiedBy: row.verified_by ? bufferToUuid(row.verified_by) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAccountRowPublic(row) {
  const full = mapAccountRow(row);
  if (!full) return null;
  const { accessToken, refreshToken, tokenExpiresAt, tokenIssuedAt, ...rest } = full;
  return { ...rest, tokenStatus: full.tokenStatus };
}

export async function findPlatformByCode(code) {
  const row = await queryOne('SELECT * FROM platforms WHERE code = ?', [code]);
  if (!row) return null;
  return { ...row, id: bufferToUuid(row.id) };
}

export async function findAccountByUserAndPlatform(userId, platformId) {
  const row = await queryOne(
    'SELECT * FROM user_platform_accounts WHERE user_id = ? AND platform_id = ?',
    [uuidToBuffer(userId), uuidToBuffer(platformId)]
  );
  return mapAccountRow(row);
}

export async function findAccountById(id) {
  const row = await queryOne(
    'SELECT * FROM user_platform_accounts WHERE id = ?',
    [uuidToBuffer(id)]
  );
  return mapAccountRow(row);
}

export async function createAccount(id, userId, platformId, profileUrl, username) {
  await query(
    `INSERT INTO user_platform_accounts (id, user_id, platform_id, profile_url, platform_username)
     VALUES (?, ?, ?, ?, ?)`,
    [uuidToBuffer(id), uuidToBuffer(userId), uuidToBuffer(platformId), profileUrl, username]
  );
  return findAccountById(id);
}

export async function hardDeleteAccount(id) {
  await query(
    'DELETE FROM user_platform_accounts WHERE id = ?',
    [uuidToBuffer(id)]
  );
}

export async function verifyAccount(id, status, adminId) {
  await query(
    `UPDATE user_platform_accounts
     SET verification_status = ?, verified_at = NOW(), verified_by = ?,
         updated_at = NOW()
     WHERE id = ?`,
    [status, uuidToBuffer(adminId), uuidToBuffer(id)]
  );
  return findAccountById(id);
}

export async function listAccountsByUser(userId) {
  const rows = await query(
    `SELECT a.*, p.code as platform_code, p.name as platform_name
     FROM user_platform_accounts a
     JOIN platforms p ON p.id = a.platform_id
      WHERE a.user_id = ?
     ORDER BY a.created_at DESC`,
    [uuidToBuffer(userId)]
  );
  return rows.map(r => ({
    ...mapAccountRowPublic(r),
    platformCode: r.platform_code,
    platformName: r.platform_name,
  }));
}

export async function listAllAccounts({ status, page, limit }) {
  const offset = (page - 1) * limit;
  const where = ['a.token_type != ?'];
  const params = ['user'];

  if (status) {
    where.push('a.verification_status = ?');
    params.push(status);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const countRow = await queryOne(
    `SELECT COUNT(*) as total FROM user_platform_accounts a ${whereClause}`,
    params
  );

  const rows = await query(
    `SELECT a.*, p.code as platform_code, p.name as platform_name,
            u.email as user_email
     FROM user_platform_accounts a
     JOIN platforms p ON p.id = a.platform_id
     JOIN users u ON u.id = a.user_id
     ${whereClause}${where.length > 0 ? ' AND' : ' WHERE'} u.deleted_at IS NULL
     ORDER BY a.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, String(limit), String(offset)]
  );

  return {
    accounts: rows.map(r => ({
      ...mapAccountRowPublic(r),
      platformCode: r.platform_code,
      platformName: r.platform_name,
      userEmail: r.user_email,
    })),
    total: countRow.total,
    page,
    limit,
  };
}

export async function findAllPlatforms() {
  const rows = await query('SELECT * FROM platforms WHERE is_active = 1 ORDER BY code');
  return rows.map(r => ({ ...r, id: bufferToUuid(r.id) }));
}

export async function findPlatformById(id) {
  const row = await queryOne('SELECT * FROM platforms WHERE id = ?', [uuidToBuffer(id)]);
  if (!row) return null;
  return { ...row, id: bufferToUuid(row.id) };
}
