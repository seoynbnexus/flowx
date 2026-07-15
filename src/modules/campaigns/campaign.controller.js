import * as service from './campaign.service.js'
import { sendSuccess, sendCreated, sendNoContent, sendPaginated } from '../../../shared/utils/response.utils.js'

export async function createCampaign(req, res, next) {
  try {
    const campaign = await service.createCampaign(req.user.id, req.body)
    return sendCreated(res, campaign, 'Campaign created')
  } catch (error) {
    next(error)
  }
}

export async function getCampaign(req, res, next) {
  try {
    const campaign = await service.getCampaign(req.user.id, req.params.id)
    return sendSuccess(res, campaign)
  } catch (error) {
    next(error)
  }
}

export async function listCampaigns(req, res, next) {
  try {
    const result = await service.listCampaigns(req.user.id, req.query)
    return sendPaginated(res, result.items, {
      page: result.page,
      limit: result.limit,
      total: result.total,
    })
  } catch (error) {
    next(error)
  }
}

export async function updateCampaign(req, res, next) {
  try {
    const campaign = await service.updateCampaign(req.user.id, req.params.id, req.body)
    return sendSuccess(res, campaign, 'Campaign updated')
  } catch (error) {
    next(error)
  }
}

export async function submitCampaign(req, res, next) {
  try {
    const campaign = await service.submitCampaign(req.user.id, req.params.id)
    return sendSuccess(res, campaign, 'Campaign submitted for review')
  } catch (error) {
    next(error)
  }
}

export async function cancelCampaign(req, res, next) {
  try {
    const campaign = await service.cancelCampaign(req.user.id, req.params.id)
    return sendSuccess(res, campaign, 'Campaign cancelled')
  } catch (error) {
    next(error)
  }
}

export async function saveCreative(req, res, next) {
  try {
    const creative = await service.saveCreative(req.user.id, req.params.id, req.body)
    return sendSuccess(res, creative, 'Creative saved')
  } catch (error) {
    next(error)
  }
}

export async function saveMetaSettings(req, res, next) {
  try {
    const settings = await service.saveMetaSettings(req.user.id, req.params.id, req.body)
    return sendSuccess(res, settings, 'Meta ad settings saved')
  } catch (error) {
    next(error)
  }
}

export async function confirmAdjustments(req, res, next) {
  try {
    const campaign = await service.confirmAdjustments(req.user.id, req.params.id)
    return sendSuccess(res, campaign, 'Adjustments confirmed, publisher requests sent')
  } catch (error) {
    next(error)
  }
}

export async function getCreative(req, res, next) {
  try {
    const creative = await service.getCampaign(req.user.id, req.params.id)
    return sendSuccess(res, creative.creative || null)
  } catch (error) {
    next(error)
  }
}

export async function getMetaSettings(req, res, next) {
  try {
    const campaign = await service.getCampaign(req.user.id, req.params.id)
    return sendSuccess(res, campaign.metaSettings || null)
  } catch (error) {
    next(error)
  }
}
