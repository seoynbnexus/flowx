import * as service from './post.service.js'
import { sendSuccess, sendPaginated, sendAccepted } from '../../../shared/utils/response.utils.js'

export async function listAllPosts(req, res, next) {
  try {
    const result = await service.listAllPosts(req.query)
    return sendPaginated(res, result.items, {
      page: result.page,
      limit: result.limit,
      total: result.total,
    })
  } catch (error) {
    next(error)
  }
}

export async function getPostDetail(req, res, next) {
  try {
    const post = await service.getPostDetail(req.params.id)
    return sendSuccess(res, post)
  } catch (error) {
    next(error)
  }
}

export async function approvePost(req, res, next) {
  try {
    const result = await service.approvePost(req.user.id, req.params.id, req.body)
    return sendAccepted(res, { jobId: result.jobId }, 'Post approved — publish queued')
  } catch (error) {
    next(error)
  }
}

export async function rejectPost(req, res, next) {
  try {
    const post = await service.rejectPost(req.user.id, req.params.id, req.body)
    return sendSuccess(res, post, 'Post rejected')
  } catch (error) {
    next(error)
  }
}

export async function retryPost(req, res, next) {
  try {
    const result = await service.retryPostPublish(req.params.id)
    return sendAccepted(res, { jobId: result.jobId }, 'Publish retry queued')
  } catch (error) {
    next(error)
  }
}

export async function getPostEngagement(req, res, next) {
  try {
    const result = await service.getPostEngagement(null, req.params.id, req.query, { skipOwnership: true })
    return sendSuccess(res, result)
  } catch (error) {
    next(error)
  }
}

export async function getPostPublisherRequests(req, res, next) {
  try {
    const requests = await service.adminListPostPublisherRequests(req.params.id)
    return sendSuccess(res, requests)
  } catch (error) {
    next(error)
  }
}

export async function forceGoLivePost(req, res, next) {
  try {
    const result = await service.adminForceGoLivePost(req.params.id)
    return sendAccepted(res, result, 'Post force go-live queued')
  } catch (error) {
    next(error)
  }
}

export async function expirePublisherRequests(req, res, next) {
  try {
    const result = await service.adminExpirePostPublisherRequests(req.params.id)
    return sendAccepted(res, result, 'Post publisher requests expired')
  } catch (error) {
    next(error)
  }
}
