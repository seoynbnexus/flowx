import * as service from './post.service.js'
import { sendSuccess, sendCreated, sendPaginated, sendAccepted } from '../../../shared/utils/response.utils.js'

export async function createPost(req, res, next) {
  try {
    const post = await service.createPost(req.user.id, req.body)
    return sendCreated(res, post, 'Post created')
  } catch (error) {
    next(error)
  }
}

export async function getPost(req, res, next) {
  try {
    const post = await service.getPost(req.user.id, req.params.id)
    return sendSuccess(res, post)
  } catch (error) {
    next(error)
  }
}

export async function listPosts(req, res, next) {
  try {
    const result = await service.listPosts(req.user.id, req.query)
    return sendPaginated(res, result.items, {
      page: result.page,
      limit: result.limit,
      total: result.total,
    })
  } catch (error) {
    next(error)
  }
}

export async function updatePost(req, res, next) {
  try {
    const post = await service.updatePost(req.user.id, req.params.id, req.body)
    return sendSuccess(res, post, 'Post updated')
  } catch (error) {
    next(error)
  }
}

export async function submitPost(req, res, next) {
  try {
    const post = await service.submitPost(req.user.id, req.params.id)
    return sendSuccess(res, post, 'Post submitted for review')
  } catch (error) {
    next(error)
  }
}

export async function cancelPost(req, res, next) {
  try {
    const post = await service.cancelPost(req.user.id, req.params.id)
    return sendSuccess(res, post, 'Post cancelled')
  } catch (error) {
    next(error)
  }
}

export async function duplicatePost(req, res, next) {
  try {
    const post = await service.duplicatePost(req.user.id, req.params.id, req.body)
    return sendCreated(res, post, 'Post duplicated')
  } catch (error) {
    next(error)
  }
}

export async function setPostTargets(req, res, next) {
  try {
    const targetAccountIds = Array.isArray(req.body) ? req.body : req.body?.targetAccountIds
    const targets = await service.setPostTargets(req.user.id, req.params.id, targetAccountIds)
    return sendSuccess(res, targets, 'Targets updated')
  } catch (error) {
    next(error)
  }
}

export async function getPostTargets(req, res, next) {
  try {
    const post = await service.getPost(req.user.id, req.params.id)
    return sendSuccess(res, post.targets || [])
  } catch (error) {
    next(error)
  }
}

export async function getAvailableAccounts(req, res, next) {
  try {
    const accounts = await service.getAvailablePostAccounts(req.user.id)
    return sendSuccess(res, accounts)
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
    const result = await service.getPostEngagement(req.user.id, req.params.id, req.query)
    return sendSuccess(res, result)
  } catch (error) {
    next(error)
  }
}

export async function getPostPublisherProgress(req, res, next) {
  try {
    const result = await service.getPostPublisherProgress(req.user.id, req.params.id)
    return sendSuccess(res, result)
  } catch (error) {
    next(error)
  }
}
