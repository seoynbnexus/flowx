import * as service from './campaign.service.js'
import { sendSuccess, sendPaginated } from '../../../shared/utils/response.utils.js'

export async function listAllCampaigns(req, res, next) {
  try {
    const result = await service.listAllCampaigns(req.query)
    return sendPaginated(res, result.items, {
      page: result.page,
      limit: result.limit,
      total: result.total,
    })
  } catch (error) {
    next(error)
  }
}

export async function getCampaignDetail(req, res, next) {
  try {
    const campaign = await service.getCampaignDetail(req.params.id)
    return sendSuccess(res, campaign)
  } catch (error) {
    next(error)
  }
}

export async function approveCampaign(req, res, next) {
  try {
    const campaign = await service.approveCampaign(req.user.id, req.params.id, req.body)
    return sendSuccess(res, campaign, 'Campaign approved')
  } catch (error) {
    next(error)
  }
}

export async function rejectCampaign(req, res, next) {
  try {
    const campaign = await service.rejectCampaign(req.user.id, req.params.id, req.body)
    return sendSuccess(res, campaign, 'Campaign rejected')
  } catch (error) {
    next(error)
  }
}
