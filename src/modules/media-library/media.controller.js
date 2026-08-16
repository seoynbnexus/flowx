import * as service from './media.service.js'
import { sendSuccess, sendCreated, sendPaginated } from '../../../shared/utils/response.utils.js'

export async function uploadMedia(req, res, next) {
  try {
    const media = await service.uploadMedia(req.user.id, req.file, { name: req.body?.name })
    return sendCreated(res, media, 'Media uploaded')
  } catch (error) {
    next(error)
  }
}

export async function listMedia(req, res, next) {
  try {
    const result = await service.listMedia(req.user.id, {
      page: parseInt(req.query.page, 10) || 1,
      limit: Math.min(parseInt(req.query.limit, 10) || 20, 100),
      kind: req.query.kind,
    })
    return sendPaginated(res, result.items, {
      page: result.page,
      limit: result.limit,
      total: result.total,
      totalBytes: result.totalBytes,
      quotaBytes: result.quotaBytes,
    })
  } catch (error) {
    next(error)
  }
}

export async function deleteMedia(req, res, next) {
  try {
    const result = await service.deleteMedia(req.user.id, req.params.id)
    return sendSuccess(res, result, 'Media deleted')
  } catch (error) {
    next(error)
  }
}