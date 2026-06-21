import * as repo from './user.repository.js';
import { NotFoundError, AuthError } from '../../../shared/errors/AppError.js';
import { ERROR_CODES } from '../../../shared/errors/errorCodes.js';
import { comparePassword, hashPassword } from '../../../shared/utils/crypto.utils.js';
import { generateUuid } from '../../../shared/utils/uuid.utils.js';
import { PAGINATION } from '../../../shared/constants/index.js';
import { getUserPassword, updateUserPassword, createAuditLog } from '../auth/auth.repository.js';

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

  const updatedProfile = await repo.updateProfile(userId, data);
  return { ...user, profile: updatedProfile };
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
  const updated = await repo.updateStatus(userId, status);
  await createAuditLog(
    generateUuid(), userId, 'user', userId,
    'user.status_changed', { status: oldStatus }, { status }
  );
  return updated;
}

export async function deleteUser(userId) {
  const user = await repo.findById(userId);
  if (!user || user.deleted_at) {
    throw new NotFoundError('User not found');
  }

  await repo.softDelete(userId);
  await createAuditLog(
    generateUuid(), userId, 'user', userId,
    'user.deleted', { email: user.email, status: user.status }, { deleted_at: new Date() }
  );
}

export async function changePassword(userId, currentPassword, newPassword) {
  const user = await repo.findById(userId);
  if (!user) throw new NotFoundError('User not found');

  const passwordRecord = await getUserPassword(userId);
  if (!passwordRecord) throw new AuthError('Password not set', ERROR_CODES.AUTH_FAILED);

  const valid = await comparePassword(currentPassword, passwordRecord.password_hash);
  if (!valid) throw new AuthError('Current password is incorrect', ERROR_CODES.AUTH_FAILED);

  const newHash = await hashPassword(newPassword);
  await updateUserPassword(userId, newHash);
  await createAuditLog(
    generateUuid(), userId, 'user', userId,
    'user.password_changed', { password_changed_at: passwordRecord.password_changed_at }, { password_changed_at: new Date() }
  );
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
  await repo.removeRole(userId, roleId);
}
