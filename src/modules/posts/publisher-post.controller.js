import * as service from './post.service.js'
import { sendSuccess, sendPaginated } from '../../../shared/utils/response.utils.js'

export async function listRequests(req, res, next) {
  try {
    const result = await service.listPostPublisherRequests(req.user.id, req.query)
    return sendPaginated(res, result.items, {
      page: req.query.page || 1,
      limit: req.query.limit || 20,
      total: result.total,
    })
  } catch (error) {
    next(error)
  }
}

export async function getRequest(req, res, next) {
  try {
    const request = await service.getPostPublisherRequestDetail(req.user.id, req.params.requestId)
    return sendSuccess(res, request)
  } catch (error) {
    next(error)
  }
}

export async function acceptRequest(req, res, next) {
  try {
    const request = await service.acceptPostPublisherRequest(req.user.id, req.params.requestId, req.body)
    return sendSuccess(res, request, 'Post request accepted')
  } catch (error) {
    next(error)
  }
}

export async function rejectRequest(req, res, next) {
  try {
    const request = await service.rejectPostPublisherRequest(req.user.id, req.params.requestId)
    return sendSuccess(res, request, 'Post request rejected')
  } catch (error) {
    next(error)
  }
}

export async function completeRequest(req, res, next) {
  try {
    const request = await service.completePostPublisherRequest(req.user.id, req.params.requestId)
    return sendSuccess(res, request, 'Post request completed')
  } catch (error) {
    next(error)
  }
}
