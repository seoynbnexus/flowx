import * as repo from './identity.repository.js';
import { generateUuid } from '../../../shared/utils/uuid.utils.js';
import { NotFoundError, ConflictError, ValidationError } from '../../../shared/errors/AppError.js';
import { query, queryOne } from '../../../shared/database/connection.js';

export async function upload(userId, documentType, file) {
  if (!file) {
    throw new NotFoundError('File not provided');
  }

  const docType = await queryOne(
    'SELECT * FROM identity_document_types WHERE code = ? AND is_active = 1',
    [documentType]
  );
  if (!docType) {
    throw new ValidationError(`Invalid document type: ${documentType}`);
  }

  const documentUrl = `/uploads/identity/${file.filename}`;

  const existing = await repo.findByUserIdAndType(userId, documentType);
  if (existing) {
    if (existing.status === 'verified') {
      throw new ConflictError('This document type is already verified and cannot be changed');
    }
    return repo.update(existing.id, documentType, documentUrl);
  }

  return repo.create(generateUuid(), userId, documentType, documentUrl);
}

export async function getMyDocuments(userId) {
  return repo.findByUserId(userId);
}

export async function getMyDocumentByType(userId, documentType) {
  const doc = await repo.findByUserIdAndType(userId, documentType);
  if (!doc) {
    throw new NotFoundError('Identity document not found');
  }
  return doc;
}

export async function getMissingMandatory(userId) {
  const mandatory = await query(
    'SELECT code, name FROM identity_document_types WHERE is_mandatory = 1 AND is_active = 1'
  );
  if (mandatory.length === 0) return [];

  const userDocs = await repo.findByUserId(userId);
  const uploadedTypes = new Set(userDocs.map(d => d.documentType))

  return mandatory.filter(t => !uploadedTypes.has(t.code));
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
