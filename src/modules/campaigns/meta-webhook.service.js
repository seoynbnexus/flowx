import crypto from 'node:crypto'
import { query, queryOne } from '../../../shared/database/connection.js'
import * as repo from './campaign.repository.js'
import { CAMPAIGN_STATUS, META_STATUS, REVIEW_ACTIONS, CAMPAIGN_JOB_TYPES } from './campaign.model.js'
import { logMetaEvent } from '../../../shared/services/meta-logger.service.js'
import { sendAdminAlert } from '../../../shared/mailer/alert.mailer.js'

export function verifyWebhookSignature(rawBody, signature, secret) {
  if (!secret || !rawBody || !signature) return false
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
  const provided = String(signature).replace(/^sha256=/, '')
  const a = Buffer.from(expected)
  const b = Buffer.from(provided)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

export function normalizeWebhookEvents(body) {
  const events = []
  for (const entry of body?.entry || []) {
    for (let index = 0; index < (entry.changes || []).length; index += 1) {
      const change = entry.changes[index]
      const value = change?.value || {}
      events.push({
        id: `${entry.id}:${index}`,
        object: body.object || null,
        field: change?.field || null,
        value,
        time: entry.time || null,
        accountId: value.ad_account_id || null,
      })
    }
  }
  return events
}

async function findCampaignByFbCampaignId(fbCampaignId) {
  if (!fbCampaignId) return null
  const idMap = await repo.findCampaignIdsByFbObjectIds([fbCampaignId])
  const campaignId = idMap.get(fbCampaignId)
  if (!campaignId) return null
  return repo.findCampaignById(campaignId)
}

async function handleStatusUpdate(event) {
  const status = String(event.value.status || '').toUpperCase()
  const campaign = await findCampaignByFbCampaignId(event.value.campaign_id)
  if (!campaign) return { ignored: true, reason: 'unknown_campaign' }

  const transition = await applyMetaStatusTransitionLocal(campaign, status)
  return {
    applied: true,
    status,
    ...transition,
    ...(transition.metaStatusAfter === META_STATUS.ARCHIVED ? { archived: true } : {}),
  }
}

async function handleSpendEvent(event) {
  const amount = parseFloat(event.value.amount)
  if (!Number.isFinite(amount) || amount <= 0) return { ignored: true, reason: 'no_amount' }
  const campaign = await findCampaignByFbCampaignId(event.value.campaign_id)
  if (!campaign) return { ignored: true, reason: 'unknown_campaign' }

  const spendPaise = Math.round(amount * 100)
  const statDate = event.value.date || new Date().toISOString().slice(0, 10)
  await repo.upsertSpendOnly(campaign.id, statDate, spendPaise)

  const totalPaise = await repo.sumDailyStatsSpend(campaign.id)
  if (totalPaise > (campaign.metaSpentPaise || 0)) {
    await repo.saveMetaSpend(campaign.id, totalPaise)
  }
  return { applied: true, spendPaise, totalPaise, statDate }
}

async function handleDeliverySignals(event) {
  const value = event.value || {}
  const campaign = await findCampaignByFbCampaignId(value.campaign_id)
  if (!campaign) return { ignored: true, reason: 'unknown_campaign' }

  const outcomes = []
  if (value.ad_id && value.status) {
    await repo.saveMetaObjectStatus(value.ad_id, String(value.status).toUpperCase())
    const transition = await applyMetaStatusTransitionLocal(campaign, String(value.status).toUpperCase())
    outcomes.push({ adId: value.ad_id, status: String(value.status).toUpperCase(), ...transition })
  } else {
    outcomes.push({ adId: value.ad_id || null, status: null, applied: false })
  }
  return { applied: true, outcomes }
}

async function applyMetaStatusTransitionLocal(campaign, metaAdStatus) {
  const status = String(metaAdStatus || '').toUpperCase()
  let statusChanged = false
  let metaStatusChanged = false
  let newStatus = campaign.status
  let newMetaStatus = campaign.metaStatus

  if (['DISAPPROVED', 'REJECTED'].includes(status)
    && [CAMPAIGN_STATUS.RUNNING, CAMPAIGN_STATUS.PAUSED].includes(campaign.status)) {
    await repo.updateCampaignWithStatusGuard(campaign.id, {
      status: CAMPAIGN_STATUS.FAILED,
      metaStatus: META_STATUS.FAILED,
      metaError: 'Ad disapproved by Meta',
    }, campaign.status)
    await repo.createReviewLog(campaign.id, null, REVIEW_ACTIONS.SUBMITTED, campaign.status,
      'Ad disapproved by Meta')
    newStatus = CAMPAIGN_STATUS.FAILED
    newMetaStatus = META_STATUS.FAILED
    statusChanged = true
    metaStatusChanged = true
  } else if (status === 'ARCHIVED' || status === 'DELETED') {
    await repo.updateCampaign(campaign.id, { metaStatus: META_STATUS.ARCHIVED, metaError: `Meta webhook: campaign ${status}` })
    await repo.createReviewLog(campaign.id, null, REVIEW_ACTIONS.SUBMITTED, campaign.status,
      `Meta campaign ${status.toLowerCase()} via webhook — manual review required`)
    await repo.requeueAutoJob(campaign.id, CAMPAIGN_JOB_TYPES.SETTLE_CAMPAIGN)
    await sendAdminAlert('Meta campaign archived via webhook',
      `Campaign ${campaign.name} (${campaign.id}) was ${status.toLowerCase()} on Meta. Review and settle manually.`)
    newMetaStatus = META_STATUS.ARCHIVED
    metaStatusChanged = true
  } else if (status === 'PAUSED' && campaign.status === CAMPAIGN_STATUS.RUNNING) {
    await repo.updateCampaignStatus(campaign.id, CAMPAIGN_STATUS.PAUSED)
    await repo.updateCampaign(campaign.id, { metaStatus: META_STATUS.PAUSED })
    await repo.createReviewLog(campaign.id, null, REVIEW_ACTIONS.SUBMITTED, CAMPAIGN_STATUS.RUNNING, 'Campaign paused from Meta webhook')
    newStatus = CAMPAIGN_STATUS.PAUSED
    newMetaStatus = META_STATUS.PAUSED
    statusChanged = true
    metaStatusChanged = true
  } else if (status === 'ACTIVE' && campaign.status === CAMPAIGN_STATUS.PAUSED) {
    await repo.updateCampaignStatus(campaign.id, CAMPAIGN_STATUS.RUNNING)
    await repo.updateCampaign(campaign.id, { metaStatus: META_STATUS.ACTIVE })
    await repo.createReviewLog(campaign.id, null, REVIEW_ACTIONS.SUBMITTED, CAMPAIGN_STATUS.PAUSED, 'Campaign resumed from Meta webhook')
    newStatus = CAMPAIGN_STATUS.RUNNING
    newMetaStatus = META_STATUS.ACTIVE
    statusChanged = true
    metaStatusChanged = true
  } else if (status === 'ACTIVE') {
    await repo.updateCampaign(campaign.id, { metaStatus: META_STATUS.ACTIVE })
    newMetaStatus = META_STATUS.ACTIVE
    metaStatusChanged = true
  } else if (status === 'PAUSED') {
    await repo.updateCampaign(campaign.id, { metaStatus: META_STATUS.PAUSED })
    newMetaStatus = META_STATUS.PAUSED
    metaStatusChanged = true
  } else if (status === 'PENDING_REVIEW') {
    await repo.updateCampaign(campaign.id, { metaStatus: META_STATUS.PENDING_REVIEW })
    newMetaStatus = META_STATUS.PENDING_REVIEW
    metaStatusChanged = true
  } else if (status === 'PENDING_BILLING_INFO') {
    await repo.updateCampaign(campaign.id, { metaStatus: META_STATUS.PENDING_BILLING_INFO })
    await sendAdminAlert('Meta campaign billing info required',
      `Campaign ${campaign.name} (${campaign.id}) requires billing info on Meta.`)
    newMetaStatus = META_STATUS.PENDING_BILLING_INFO
    metaStatusChanged = true
  } else if (status === 'WITH_ISSUES') {
    await repo.updateCampaign(campaign.id, { metaStatus: META_STATUS.WITH_ISSUES })
    await sendAdminAlert('Meta campaign has issues',
      `Campaign ${campaign.name} (${campaign.id}) has policy issues on Meta.`)
    newMetaStatus = META_STATUS.WITH_ISSUES
    metaStatusChanged = true
  } else if (status === 'PREAPPROVED') {
    await repo.updateCampaign(campaign.id, { metaStatus: META_STATUS.PREAPPROVED })
    newMetaStatus = META_STATUS.PREAPPROVED
    metaStatusChanged = true
  }

  return { statusAfter: newStatus, metaStatusAfter: newMetaStatus, statusChanged, metaStatusChanged }
}

async function handleMetaWebhookEvent(event) {
  switch (event.field) {
    case 'campaign.status_update':
      return handleStatusUpdate(event)
    case 'campaign_daily_spend':
    case 'campaign_spend':
      return handleSpendEvent(event)
    case 'ad.delivery_signals':
      return handleDeliverySignals(event)
    default:
      return { ignored: true, reason: 'unsupported_field' }
  }
}

export async function processMetaWebhookEvents(body) {
  const events = normalizeWebhookEvents(body)
  if (!events.length) return { success: false, reason: 'no_events' }

  const results = []
  for (const event of events) {
    const existing = await queryOne('SELECT id FROM meta_webhook_events WHERE id = ?', [event.id])
    if (existing) {
      results.push({ id: event.id, field: event.field, status: 'duplicate' })
      continue
    }
    try {
      const outcome = await handleMetaWebhookEvent(event)
      await query(
        `INSERT INTO meta_webhook_events (id, account_id, event_type, payload, processed_at)
         VALUES (?, ?, ?, ?, NOW())`,
        [event.id, event.accountId, event.field || 'unknown',
          JSON.stringify({ object: event.object, field: event.field, value: event.value, time: event.time })]
      )
      results.push({ id: event.id, field: event.field, status: 'processed', outcome })
    } catch (err) {
      await logMetaEvent({ action: 'webhook', field: event.field, error: err.message })
      results.push({ id: event.id, field: event.field, status: 'error', error: err.message })
    }
  }

  return {
    success: true,
    total: results.length,
    processed: results.filter(r => r.status === 'processed').length,
    duplicates: results.filter(r => r.status === 'duplicate').length,
    errors: results.filter(r => r.status === 'error').length,
    results,
  }
}
