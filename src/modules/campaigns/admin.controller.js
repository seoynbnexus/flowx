import * as service from './campaign.service.js'
import { sendSuccess, sendPaginated, sendError, sendAccepted } from '../../../shared/utils/response.utils.js'
import { HTTP_STATUS } from '../../../shared/constants/httpStatus.js'
import { query, queryOne } from '../../../shared/database/connection.js'
import { generateUuid, uuidToBuffer } from '../../../shared/utils/uuid.utils.js'

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
    const result = await service.approveCampaign(req.user.id, req.params.id, req.body)
    if (result?.queued) {
      return sendAccepted(res, { jobId: result.jobId }, 'Campaign approved — activation queued')
    }
    return sendSuccess(res, result, 'Campaign approved')
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

export async function retryCampaignMeta(req, res, next) {
  try {
    const job = await service.queueRetryMeta(req.params.id)
    return sendAccepted(res, { jobId: job.jobId }, 'Meta ad creation queued')
  } catch (error) {
    next(error)
  }
}

export async function forceGoLive(req, res, next) {
  try {
    const job = await service.queueForceGoLive(req.user.id, req.params.id)
    return sendAccepted(res, { jobId: job.jobId }, 'Force go-live queued')
  } catch (error) {
    next(error)
  }
}

export async function forceCancel(req, res, next) {
  try {
    const campaign = await service.forceCancelCampaign(req.user.id, req.params.id)
    return sendSuccess(res, campaign, 'Campaign cancelled')
  } catch (error) {
    next(error)
  }
}

export async function updateConversionRate(req, res, next) {
  try {
    const { rate } = req.body

    const existing = await queryOne(
      "SELECT id FROM app_config WHERE config_key = 'coin_conversion_rate'"
    )

    if (existing) {
      await query(
        "UPDATE app_config SET config_value = ?, updated_by = ?, version = version + 1 WHERE config_key = 'coin_conversion_rate'",
        [JSON.stringify(rate), uuidToBuffer(req.user.id)]
      )
    } else {
      await query(
        `INSERT INTO app_config (id, config_key, config_value, is_public, description, version, updated_by)
         VALUES (?, 'coin_conversion_rate', ?, 1, 'Conversion rate: 1 coin = X INR when calculating Meta ad budget from coin budget', 1, ?)`,
        [uuidToBuffer(generateUuid()), JSON.stringify(rate), uuidToBuffer(req.user.id)]
      )
    }

    service.invalidateCoinRateCache()

    return sendSuccess(res, { rate }, 'Coin conversion rate updated')
  } catch (error) {
    next(error)
  }
}
