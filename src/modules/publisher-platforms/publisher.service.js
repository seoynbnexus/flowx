import * as repo from './publisher.repository.js';
import { generateUuid } from '../../../shared/utils/uuid.utils.js';
import { NotFoundError, ConflictError, ValidationError } from '../../../shared/errors/AppError.js';
import { ERROR_CODES } from '../../../shared/errors/errorCodes.js';

function extractUsername(platformCode, profileUrl) {
  const url = new URL(profileUrl.startsWith('http') ? profileUrl : `https://${profileUrl}`);
  const path = url.pathname.replace(/\/$/, '');
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] || null;
}

export async function submitAccount(userId, platformCode, profileUrl) {
  const platform = await repo.findPlatformByCode(platformCode);
  if (!platform) {
    throw new NotFoundError('Platform not found');
  }

  const username = extractUsername(platformCode, profileUrl);

  try {
    const response = await fetch(profileUrl, { method: 'HEAD' });
    if (!response.ok) {
      throw new ValidationError('Profile URL is not reachable');
    }
  } catch {
    throw new ValidationError('Profile URL is not reachable');
  }

  const existing = await repo.findAccountByUserAndPlatform(userId, platform.id);
  if (existing) {
    if (existing.isActive) {
      throw new ConflictError('You already have an account linked for this platform');
    }
    return repo.reactivateAccount(existing.id, profileUrl, username);
  }

  return repo.createAccount(generateUuid(), userId, platform.id, profileUrl, username);
}

export async function listMyAccounts(userId) {
  return repo.listAccountsByUser(userId);
}

export async function removeAccount(userId, accountId) {
  const account = await repo.findAccountById(accountId);
  if (!account || account.userId !== userId) {
    throw new NotFoundError('Account not found');
  }
  await repo.softDeleteAccount(accountId);
}

export async function listAllAccounts(filters) {
  return repo.listAllAccounts(filters);
}

export async function verifyAccount(accountId, status, adminId) {
  const account = await repo.findAccountById(accountId);
  if (!account) {
    throw new NotFoundError('Account not found');
  }
  return repo.verifyAccount(accountId, status, adminId);
}
