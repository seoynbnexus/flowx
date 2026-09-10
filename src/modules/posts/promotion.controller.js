import * as service from './promotion.service.js'
import { sendSuccess, sendCreated, sendAccepted } from '../../../shared/utils/response.utils.js'

export async function createPromotion(req, res, next) {
  try {
    const result = await service.createPromotionForPublishedPost(req.user.id, req.params.postId, req.body)
    return sendAccepted(res, { promotionId: result.promotion.id, status: result.promotion.status, promotionTargetIds: result.promotionTargetIds }, 'Promotion created — execution queued')
  } catch (error) {
    next(error)
  }
}

export async function listPostPromotions(req, res, next) {
  try {
    const result = await service.listPromotionsForPost(req.user.id, req.params.postId)
    return sendSuccess(res, result)
  } catch (error) {
    next(error)
  }
}

export async function getPromotion(req, res, next) {
  try {
    const result = await service.getPromotionForClient(req.user.id, req.params.id)
    return sendSuccess(res, result)
  } catch (error) {
    next(error)
  }
}

export async function cancelPromotion(req, res, next) {
  try {
    const promotion = await service.cancelPromotion(req.user.id, req.params.id)
    return sendSuccess(res, promotion, 'Promotion cancelled')
  } catch (error) {
    next(error)
  }
}

export async function adminGetPromotion(req, res, next) {
  try {
    const result = await service.adminGetPromotion(req.params.id)
    return sendSuccess(res, result)
  } catch (error) {
    next(error)
  }
}
