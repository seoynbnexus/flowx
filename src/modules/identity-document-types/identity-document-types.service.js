import * as repo from './identity-document-types.repository.js';
import { generateUuid } from '../../../shared/utils/uuid.utils.js';
import { NotFoundError, ConflictError } from '../../../shared/errors/AppError.js';

export async function list(includeInactive = false) {
  return repo.findAll(includeInactive);
}

export async function getById(id) {
  const docType = await repo.findById(id);
  if (!docType) throw new NotFoundError('Document type not found');
  return docType;
}

export async function create(data) {
  const existing = await repo.findByCode(data.code);
  if (existing) {
    throw new ConflictError('Document type with this code already exists');
  }
  return repo.create(generateUuid(), data);
}

export async function update(id, data) {
  const docType = await repo.findById(id);
  if (!docType) throw new NotFoundError('Document type not found');
  return repo.update(id, data);
}

export async function remove(id) {
  const docType = await repo.findById(id);
  if (!docType) throw new NotFoundError('Document type not found');
  await repo.softDelete(id);
}
