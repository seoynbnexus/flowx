import * as service from './identity-document-types.service.js';
import { sendSuccess, sendCreated, sendNoContent } from '../../../shared/utils/response.utils.js';

export async function list(req, res, next) {
  try {
    const includeInactive = req.query.includeInactive === 'true';
    const types = await service.list(includeInactive);
    return sendSuccess(res, types);
  } catch (error) {
    next(error);
  }
}

export async function getById(req, res, next) {
  try {
    const docType = await service.getById(req.params.id);
    return sendSuccess(res, docType);
  } catch (error) {
    next(error);
  }
}

export async function create(req, res, next) {
  try {
    const docType = await service.create(req.body);
    return sendCreated(res, docType, 'Document type created');
  } catch (error) {
    next(error);
  }
}

export async function update(req, res, next) {
  try {
    const docType = await service.update(req.params.id, req.body);
    return sendSuccess(res, docType, 'Document type updated');
  } catch (error) {
    next(error);
  }
}

export async function remove(req, res, next) {
  try {
    await service.remove(req.params.id);
    return sendNoContent(res);
  } catch (error) {
    next(error);
  }
}
