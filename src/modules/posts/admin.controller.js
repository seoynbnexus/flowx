import * as service from './post.service.js'
import * as boostPerfService from './boost-performance.service.js'
import * as deletionService from './deletion-monitoring.service.js'
import { findViolationTargetsByPostId, findRequestViolationInfo } from './deletion-monitoring.repository.js'
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

export async function getBoostPerformance(req, res, next) {
  try {
    const result = await boostPerfService.getBoostPerformance(null, req.params.id, req.query, { skipOwnership: true, includeDebug: true })
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

export async function adminAcceptPublisherRequest(req, res, next) {
  try {
    const result = await service.adminAcceptPostPublisherRequest(
      req.user.id, req.params.id, req.params.requestId, req.body
    )
    return sendSuccess(res, result, 'Publisher request accepted on behalf')
  } catch (error) {
    next(error)
  }
}

export async function getPublisherRequestAccounts(req, res, next) {
  try {
    const requests = await service.adminListPostPublisherRequests(req.params.id)
    const target = requests.requests.find(r => r.id === req.params.requestId)
    if (!target) return res.status(404).json({ success: false, message: 'Request not found' })
    const { findVerifiedPublisherAccounts } = await import('./post.repository.js')
    const accounts = await findVerifiedPublisherAccounts(target.publisherId)
    return sendSuccess(res, accounts.map(a => ({
      id: a.id,
      platformCode: a.platformCode,
      platformDisplayName: a.platformDisplayName,
      platformUsername: a.platformUsername,
    })))
  } catch (error) {
    next(error)
  }
}

export async function getPostViolations(req, res, next) {
  try {
    const targets = await findViolationTargetsByPostId(req.params.id)
    const requestIds = [...new Set(targets.map(t => t.publisherRequestId).filter(Boolean))]
    const requests = {}
    for (const requestId of requestIds) {
      requests[requestId] = await findRequestViolationInfo(requestId)
    }
    return sendSuccess(res, { targets, requests })
  } catch (error) {
    next(error)
  }
}

export async function reviewPostViolation(req, res, next) {
  try {
    const result = await deletionService.reviewDeletionViolation(req.params.targetId, req.user.id, req.body?.action)
    return sendSuccess(res, result, req.body?.action === 'clawback' ? 'Clawback processed' : 'Violation dismissed')
  } catch (error) {
    next(error)
  }
}
