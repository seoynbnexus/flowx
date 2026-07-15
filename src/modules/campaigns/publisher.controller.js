import * as service from './campaign.service.js'
import { sendSuccess, sendPaginated } from '../../../shared/utils/response.utils.js'

export async function listRequests(req, res, next) {
  try {
    const result = await service.listPublisherRequests(req.user.id, req.query)
    return sendPaginated(res, result.items, {
      page: result.page,
      limit: result.limit,
      total: result.total,
    })
  } catch (error) {
    next(error)
  }
}

export async function acceptRequest(req, res, next) {
  try {
    const request = await service.acceptPublisherRequest(req.user.id, req.params.requestId)
    return sendSuccess(res, request, 'Request accepted')
  } catch (error) {
    next(error)
  }
}

export async function rejectRequest(req, res, next) {
  try {
    const request = await service.rejectPublisherRequest(req.user.id, req.params.requestId)
    return sendSuccess(res, request, 'Request rejected')
  } catch (error) {
    next(error)
  }
}

export async function getMyCategories(req, res, next) {
  try {
    const categories = await service.getPublisherCategories(req.user.id)
    return sendSuccess(res, categories)
  } catch (error) {
    next(error)
  }
}

export async function setMyCategories(req, res, next) {
  try {
    const categories = await service.setPublisherCategories(req.user.id, req.body.categoryIds)
    return sendSuccess(res, categories, 'Categories updated')
  } catch (error) {
    next(error)
  }
}
