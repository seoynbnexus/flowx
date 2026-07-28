import * as repo from './user.repository.js';
import { NotFoundError, AuthError, ConflictError } from '../../../shared/errors/AppError.js';
import { ERROR_CODES } from '../../../shared/errors/errorCodes.js';
import { comparePassword, hashPassword } from '../../../shared/utils/crypto.utils.js';
import { generateUuid, uuidToBuffer } from '../../../shared/utils/uuid.utils.js';
import { query, transaction } from '../../../shared/database/connection.js';
import { USER_STATUS, PAGINATION } from '../../../shared/constants/index.js';
import { getUserPassword, updateUserPassword, createAuditLog, findUserByEmail, createUser, createUserProfile, createUserPassword, assignUserRole } from '../auth/auth.repository.js';

export async function getProfile(userId) {
  const user = await repo.findById(userId);
  if (!user || user.deleted_at) {
    throw new NotFoundError('User not found');
  }

  const profile = await repo.findProfileByUserId(userId);
  return { ...user, profile };
}

export async function updateProfile(userId, data) {
  const user = await repo.findById(userId);
  if (!user || user.deleted_at) {
    throw new NotFoundError('User not found');
  }

  const { role, ...profileData } = data;

  return await transaction(async () => {
    if (role) {
      await repo.updateUserRole(userId, role);
    }

    const updatedProfile = await repo.updateProfile(userId, profileData);
    return { ...user, profile: updatedProfile };
  });
}

export async function adminCreateUser(data) {
  const existing = await findUserByEmail(data.email);
  if (existing) {
    throw new ConflictError('Email already registered');
  }

  const userId = generateUuid();
  const passwordHash = await hashPassword(data.password);

  return await transaction(async () => {
    await createUser(userId, data.email, USER_STATUS.ACTIVE, data.phone || null);
    await query('UPDATE users SET email_verified_at = NOW() WHERE id = ?', [uuidToBuffer(userId)]);
    await createUserProfile(generateUuid(), userId, {
      firstName: data.firstName,
      lastName: data.lastName,
      countryCode: 'IN',
    });
    await createUserPassword(userId, passwordHash);
    await assignUserRole(userId, data.role);

    await createAuditLog(
      generateUuid(), userId, 'user', userId,
      'user.created_by_admin', null, { email: data.email, role: data.role }
    );

    return repo.findById(userId);
  });
}

export async function searchUsers(q, limit) {
  return repo.searchUsers(q, limit);
}

export async function listUsers(filters) {
  const page = filters.page || PAGINATION.DEFAULT_PAGE;
  const limit = Math.min(filters.limit || PAGINATION.DEFAULT_LIMIT, PAGINATION.MAX_LIMIT);

  return repo.listUsers({ ...filters, page, limit });
}

export async function updateUserStatus(userId, status) {
  const user = await repo.findById(userId);
  if (!user || user.deleted_at) {
    throw new NotFoundError('User not found');
  }

  const oldStatus = user.status;
  return await transaction(async () => {
    const updated = await repo.updateStatus(userId, status);
    await createAuditLog(
      generateUuid(), userId, 'user', userId,
      'user.status_changed', { status: oldStatus }, { status }
    );
    return updated;
  });
}

export async function deleteUser(userId) {
  const user = await repo.findById(userId);
  if (!user || user.deleted_at) {
    throw new NotFoundError('User not found');
  }

  return await transaction(async () => {
    await repo.softDelete(userId);
    await createAuditLog(
      generateUuid(), userId, 'user', userId,
      'user.deleted', { email: user.email, status: user.status }, { deleted_at: new Date() }
    );
  });
}

export async function changePassword(userId, currentPassword, newPassword) {
  const user = await repo.findById(userId);
  if (!user || user.deleted_at) throw new NotFoundError('User not found');

  const passwordRecord = await getUserPassword(userId);
  if (!passwordRecord) throw new AuthError('Password not set', ERROR_CODES.AUTH_FAILED);

  const valid = await comparePassword(currentPassword, passwordRecord.password_hash);
  if (!valid) throw new AuthError('Current password is incorrect', ERROR_CODES.AUTH_FAILED);

  const newHash = await hashPassword(newPassword);
  return await transaction(async () => {
    await updateUserPassword(userId, newHash);
    await createAuditLog(
      generateUuid(), userId, 'user', userId,
      'user.password_changed', { password_changed_at: passwordRecord.password_changed_at }, { password_changed_at: new Date() }
    );
  });
}

export async function getUserRoles(userId) {
  const user = await repo.findById(userId);
  if (!user || user.deleted_at) throw new NotFoundError('User not found');

  return repo.findUserRoles(userId);
}

export async function assignRoleToUser(userId, roleId) {
  const user = await repo.findById(userId);
  if (!user || user.deleted_at) throw new NotFoundError('User not found');

  await repo.assignRole(userId, roleId);
}

export async function removeRoleFromUser(userId, roleId) {
  const user = await repo.findById(userId);
  if (!user || user.deleted_at) throw new NotFoundError('User not found');

  await repo.removeRole(userId, roleId);
}
