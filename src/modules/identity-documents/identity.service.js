import * as repo from './identity.repository.js';
import { generateUuid } from '../../../shared/utils/uuid.utils.js';
import { NotFoundError, ConflictError } from '../../../shared/errors/AppError.js';

export async function upload(userId, documentType, file) {
  if (!file) {
    throw new NotFoundError('File not provided');
  }

  const documentUrl = `/uploads/identity/${file.filename}`;

  const existing = await repo.findByUserId(userId);
  if (existing) {
    if (existing.status === 'verified') {
      throw new ConflictError('Identity is already verified and cannot be changed');
    }
    return repo.update(existing.id, documentType, documentUrl);
  }

  return repo.create(generateUuid(), userId, documentType, documentUrl);
}

export async function getMyDocument(userId) {
  const doc = await repo.findByUserId(userId);
  if (!doc) {
    throw new NotFoundError('Identity document not found');
  }
  return doc;
}

export async function listAll(filters) {
  return repo.listAll(filters);
}

export async function verify(documentId, status, adminId, rejectedReason = null) {
  const doc = await repo.findById(documentId);
  if (!doc) {
    throw new NotFoundError('Identity document not found');
  }

  if (doc.status === 'verified') {
    throw new ConflictError('Identity is already verified');
  }

  return repo.verify(documentId, status, adminId, rejectedReason);
}
