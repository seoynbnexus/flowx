import { query, queryOne } from '../../../shared/database/connection.js';
import { uuidToBuffer, bufferToUuid, generateUuid } from '../../../shared/utils/uuid.utils.js';
import { encrypt, decrypt } from '../../../shared/utils/crypto.utils.js';

function mapOAuthAccountRow(row) {
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
    tokenIssuedAt: row.token_issued_at,
    oauthProvider: row.oauth_provider,
    verificationStatus: row.verification_status,
    verifiedAt: row.verified_at,
    verifiedBy: row.verified_by ? bufferToUuid(row.verified_by) : null,
    isActive: !!row.is_active,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPlatformRow(row) {
  if (!row) return null;
  return { ...row, id: bufferToUuid(row.id) };
}

export async function findPlatformByCode(code) {
  const row = await queryOne('SELECT * FROM platforms WHERE code = ?', [code]);
  return mapPlatformRow(row);
}

export async function findExistingByUserAndPlatform(userId, platformId) {
  const row = await queryOne(
    'SELECT * FROM user_platform_accounts WHERE user_id = ? AND platform_id = ?',
    [uuidToBuffer(userId), uuidToBuffer(platformId)]
  );
  return mapOAuthAccountRow(row);
}

export async function findById(id) {
  const row = await queryOne('SELECT * FROM user_platform_accounts WHERE id = ?', [uuidToBuffer(id)]);
  return mapOAuthAccountRow(row);
}

export async function createOAuthAccount({ id, userId, platformId, profileUrl, username, displayName, avatarUrl, followersCount, platformUserId, igAccountType, igBusinessAccountId, accessToken, refreshToken, tokenExpiresAt, tokenIssuedAt, oauthProvider }) {
  await query(
    `INSERT INTO user_platform_accounts
     (id, user_id, platform_id, profile_url, platform_username, platform_display_name,
      avatar_url, followers_count, platform_user_id, instagram_account_type,
      instagram_business_account_id, access_token, refresh_token, token_expires_at,
      token_issued_at, oauth_provider, verification_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    [
      uuidToBuffer(id),
      uuidToBuffer(userId),
      uuidToBuffer(platformId),
      profileUrl || '',
      username || null,
      displayName || null,
      avatarUrl || null,
      followersCount || 0,
      platformUserId || null,
      igAccountType || null,
      igBusinessAccountId || null,
      accessToken ? encrypt(accessToken) : null,
      refreshToken ? encrypt(refreshToken) : null,
      tokenExpiresAt,
      tokenIssuedAt,
      oauthProvider || 'meta',
    ]
  );
  return findById(id);
}

export async function updateOAuthAccount(id, updates) {
  const fields = [];
  const params = [];

  if (updates.profileUrl !== undefined) { fields.push('profile_url = ?'); params.push(updates.profileUrl); }
  if (updates.username !== undefined) { fields.push('platform_username = ?'); params.push(updates.username); }
  if (updates.displayName !== undefined) { fields.push('platform_display_name = ?'); params.push(updates.displayName); }
  if (updates.avatarUrl !== undefined) { fields.push('avatar_url = ?'); params.push(updates.avatarUrl); }
  if (updates.followersCount !== undefined) { fields.push('followers_count = ?'); params.push(updates.followersCount); }
  if (updates.platformUserId !== undefined) { fields.push('platform_user_id = ?'); params.push(updates.platformUserId); }
  if (updates.igAccountType !== undefined) { fields.push('instagram_account_type = ?'); params.push(updates.igAccountType); }
  if (updates.igBusinessAccountId !== undefined) { fields.push('instagram_business_account_id = ?'); params.push(updates.igBusinessAccountId); }
  if (updates.accessToken !== undefined) { fields.push('access_token = ?'); params.push(encrypt(updates.accessToken)); }
  if (updates.refreshToken !== undefined) { fields.push('refresh_token = ?'); params.push(encrypt(updates.refreshToken)); }
  if (updates.tokenExpiresAt !== undefined) { fields.push('token_expires_at = ?'); params.push(updates.tokenExpiresAt); }
  if (updates.tokenIssuedAt !== undefined) { fields.push('token_issued_at = ?'); params.push(updates.tokenIssuedAt); }
  if (updates.tokenStatus !== undefined) { fields.push('token_status = ?'); params.push(updates.tokenStatus); }
  if (updates.verificationStatus !== undefined) { fields.push('verification_status = ?'); params.push(updates.verificationStatus); }

  if (fields.length === 0) return findById(id);

  fields.push('updated_at = NOW()');
  params.push(uuidToBuffer(id));

  await query(
    `UPDATE user_platform_accounts SET ${fields.join(', ')} WHERE id = ?`,
    params
  );
  return findById(id);
}
