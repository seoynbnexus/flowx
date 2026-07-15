import * as service from './subscription.service.js'
import { sendSuccess } from '../../../shared/utils/response.utils.js'

export async function getSubscription(req, res, next) {
  try {
    const entitlements = await service.getUserEntitlements(req.user.id)
    const usage = await service.getAllUsage(req.user.id)
    return sendSuccess(res, { ...entitlements, usage })
  } catch (error) {
    next(error)
  }
}

export async function getFeatureStatus(req, res, next) {
  try {
    const { featureKey } = req.params
    const allowed = await service.hasFeature(req.user.id, featureKey)
    const usage = await service.getUsage(req.user.id, featureKey)
    return sendSuccess(res, { featureKey, allowed, ...usage })
  } catch (error) {
    next(error)
  }
}

export async function listPlans(req, res, next) {
  try {
    const repo = await import('./subscription.repository.js')
    const plans = await repo.findAllPlans()
    const result = []
    for (const plan of plans) {
      const features = await repo.findPlanFeatures(plan.id)
      result.push({ ...plan, features })
    }
    return sendSuccess(res, result)
  } catch (error) {
    next(error)
  }
}
