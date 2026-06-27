import * as service from './identity.service.js';
import { sendSuccess, sendCreated, sendPaginated } from '../../../shared/utils/response.utils.js';

export async function uploadDocument(req, res, next) {
  try {
    const { documentType } = req.body;
    const doc = await service.upload(req.user.id, documentType, req.file);
    return sendCreated(res, doc, 'Identity document submitted for verification');
  } catch (error) {
    next(error);
  }
}

export async function getMyDocument(req, res, next) {
  try {
    const doc = await service.getMyDocument(req.user.id);
    return sendSuccess(res, doc);
  } catch (error) {
    next(error);
  }
}

export async function listAllDocuments(req, res, next) {
  try {
    const result = await service.listAll({
      status: req.query.status,
      page: parseInt(req.query.page, 10) || 1,
      limit: Math.min(parseInt(req.query.limit, 10) || 20, 100),
    });
    return sendPaginated(res, result.documents, { page: result.page, limit: result.limit, total: result.total });
  } catch (error) {
    next(error);
  }
}

export async function verifyDocument(req, res, next) {
  try {
    const { status, rejectedReason } = req.body;
    const doc = await service.verify(req.params.id, status, req.user.id, rejectedReason);
    return sendSuccess(res, doc, `Document ${status}`);
  } catch (error) {
    next(error);
  }
}
