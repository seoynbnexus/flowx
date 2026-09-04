import crypto from 'node:crypto'
import { z } from 'zod'
import { query, queryOne } from '../../../shared/database/connection.js'
import * as repo from './campaign.repository.js'
import { CAMPAIGN_STATUS, META_STATUS, REVIEW_ACTIONS, CAMPAIGN_JOB_TYPES } from './campaign.model.js'
import { logMetaEvent } from '../../../shared/services/meta-logger.service.js'
import { sendAdminAlert } from '../../../shared/mailer/alert.mailer.js'

export function verifyWebhookSignature(rawBody, signature, secret) {
  if (!secret || !rawBody || !signature) return false
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
  const candidates = String(signature).split(',').map(s => s.trim().replace(/^sha256=/i, '')).filter(Boolean)
  for (const provided of candidates) {
    const a = Buffer.from(expected)
    const b = Buffer.from(provided)
    if (a.length !== b.length) continue
    if (crypto.timingSafeEqual(a, b)) return true
  }
  return false
}

export function isWebhookRetryableError(err) {
  if (!err) return true
  if (err.metaAmbiguous) return true
  if (err.metaHttpStatus === 400) return false
  if (err.statusCode >= 400 && err.statusCode < 500) return false
  return true
}

export const webhookBodySchema = z.object({
  object: z.string().min(1),
  entry: z.array(z.object({
    id: z.string().optional(),
    time: z.number().optional(),
    changes: z.array(z.object({ field: z.string().min(1), value: z.any().optional() })).max(50).optional().default([]),
  })).max(100).optional().default([]),
}).passthrough()

function stableJson(value) {
  if (value === null || value === undefined) return ''
  try {
    const keys = Object.keys(value).sort()
    const ordered = {}
    for (const k of keys) ordered[k] = value[k]
    return JSON.stringify(ordered)
  } catch {
    return String(value)
  }
}

export function buildProviderEventKey({ object, entryId, entryTime, changeIndex, field, value }) {
  const raw = `${object || ''}|${entryId || ''}|${entryTime || ''}|${changeIndex}|${field || ''}|${stableJson(value)}`
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 64)
}

function detectPlatform(object, field) {
  if (object === 'instagram') return 'instagram'
  if (object === 'page') return 'facebook'
  if (object === 'ad_account') return 'facebook_ads'
  if (field && field.startsWith('campaign')) return 'facebook_ads'
  if (field === 'feed') return 'facebook'
  if (field === 'comments' || field === 'story_insights' || field === 'mentions') return 'instagram'
  return null
}

function extractExternalIds(object, value, entryId) {
  const externalAccountId = String(entryId || value?.ad_account_id || value?.page_id || value?.ig_user_id || '')
  const externalObjectId = String(
    value?.post_id || value?.media_id || value?.comment_id || value?.story_id ||
    value?.campaign_id || value?.ad_id || value?.id || ''
  )
  return { externalAccountId: externalAccountId || null, externalObjectId: externalObjectId || null }
}

export function normalizeWebhookEvents(body) {
  if (!body || typeof body !== 'object') return []
  const parsed = (() => {
    try { return webhookBodySchema.parse(body) } catch { return body }
  })()
  const entryList = Array.isArray(parsed?.entry) ? parsed.entry : (Array.isArray(body?.entry) ? body.entry : [])
  if (!entryList.length) return []
  const events = []
  let changeCount = 0
  for (const entry of entryList) {
    const entryId = entry.id ? String(entry.id) : null
    const entryTime = entry.time || null
    const changes = Array.isArray(entry.changes) ? entry.changes : []
    for (let index = 0; index < changes.length; index += 1) {
      if (changeCount >= 100) break
      const change = changes[index]
      if (!change || typeof change.field !== 'string' || !change.field) continue
      const value = change?.value && typeof change.value === 'object' ? change.value : {}
      const field = change.field
      const object = parsed?.object || body.object || null
      const platform = detectPlatform(object, field)
      const { externalAccountId, externalObjectId } = extractExternalIds(object, value, entryId)
      const providerEventKey = buildProviderEventKey({
        object, entryId, entryTime, changeIndex: index, field, value,
      })
      events.push({
        id: `${entryId || 'unknown'}:${index}:${providerEventKey.slice(0, 8)}`,
        providerEventKey,
        object: object || null,
        objectType: object || null,
        field,
        value,
        time: entryTime,
        eventTime: entryTime,
        sourceId: entryId,
        platform,
        externalAccountId,
        externalObjectId,
        accountId: value.ad_account_id || externalAccountId || null,
      })
      changeCount += 1
    }
    if (changeCount >= 100) break
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

async function shouldProcessEvent(target, eventTime) {
  if (!target || !eventTime) return true
  if (target.metaDeletedAt) return false
  const stored = target.lastMetaEventAt ? new Date(target.lastMetaEventAt).getTime() : 0
  const incoming = new Date(eventTime * 1000).getTime()
  if (Number.isFinite(stored) && Number.isFinite(incoming) && incoming < stored - 1000) {
    return false
  }
  return true
}

async function handleFacebookPageFeed(event) {
  const value = event.value || {}
  const verb = String(value.verb || '').toLowerCase()
  const item = String(value.item || '').toLowerCase()
  const postId = value.post_id || value.postId || null
  const parentId = value.parent_id || value.parentId || null
  const commentId = value.comment_id || null
  const targetExternalId = postId || parentId || value.id || event.externalObjectId
  if (!targetExternalId) return { ignored: true, reason: 'no_external_id' }

  const { findPostTargetByExternalId } = await import('./campaign.repository.js')
  const targetRow = await findPostTargetByExternalId(targetExternalId, 'facebook')
  if (!targetRow) {
    const pageId = event.sourceId || event.externalAccountId
    if (pageId) {
      const { queryOne } = await import('../../../shared/database/connection.js')
      const pageExists = await queryOne('SELECT id FROM user_platform_accounts WHERE platform_user_id = ? LIMIT 1', [String(pageId)])
      if (!pageExists) return { ignored: true, reason: 'unknown_page' }
    }
    return { ignored: true, reason: 'unknown_target' }
  }

  // fixup: video/reel posts may have stored a video id — the feed webhook carries the real post id
  if (postId && String(postId).includes('_')) {
    const storedId = targetRow.meta_object_id ? String(targetRow.meta_object_id) : ''
    const storedIsVideoShaped = storedId && !storedId.includes('_')
    const needsFixup = !storedId || storedIsVideoShaped || (storedId !== String(postId) && !storedId.startsWith(`${String(postId).split('_')[0]}_`))
    if (needsFixup && !targetRow.meta_deleted_at) {
      const { query } = await import('../../../shared/database/connection.js')
      const { uuidToBuffer } = await import('../../../shared/utils/uuid.utils.js')
      await query('UPDATE post_targets SET meta_object_id = ? WHERE id = ?', [String(postId), uuidToBuffer(targetRow.id)])
      targetRow.meta_object_id = String(postId)
      try {
        const postService = await import('../posts/post.service.js')
        const post = await postService.getPostBoostFlags(targetRow.post_id)
        if (post?.boostEnabled) {
          await postService.capturePostPromotabilityForWebhook(targetRow, String(postId))
        }
      } catch {}
    }
  }

  if ((item === 'status' || item === 'post' || item === 'photo' || item === 'video' || item === 'share' || item === 'album' || item === 'link' || item === 'story' || item === 'event') && (verb === 'remove' || verb === 'delete' || verb === 'hide' || verb === 'hidden' || value.deleted_time || value.is_hidden || value.hidden || value.post?.is_published === false)) {
    const { query } = await import('../../../shared/database/connection.js')
    const { uuidToBuffer } = await import('../../../shared/utils/uuid.utils.js')
    const eventTime = event.time ? new Date(event.time * 1000).toISOString().slice(0, 19).replace('T', ' ') : new Date().toISOString().slice(0, 19).replace('T', ' ')
    const should = await shouldProcessEvent(targetRow, event.time)
    if (!should) return { ignored: true, reason: 'stale_event' }
    await query('UPDATE post_targets SET meta_remote_status = ?, meta_deleted_at = ?, last_meta_event_at = ? WHERE id = ?', ['deleted', eventTime, eventTime, uuidToBuffer(targetRow.id)])
    return { applied: true, deleted: true, targetId: targetRow.id, postId: targetRow.post_id }
  }

  if (item === 'comment' || item === 'like' || item === 'reaction' || commentId || value.reaction_type || verb === 'add' || verb === 'edited' || verb === 'remove' || verb === 'delete') {
    const should = await shouldProcessEvent(targetRow, event.time)
    if (!should) return { ignored: true, reason: 'stale_event' }
    const { requeueAutoJob } = await import('./campaign.repository.js')
    const { POST_JOB_TYPES } = await import('../posts/post.model.js')
    const runKey = `eng-target:${targetRow.id}`
    await requeueAutoJob(targetRow.post_id, POST_JOB_TYPES.SYNC_ENGAGEMENT_TARGET, { targetId: targetRow.id }, {
      runKey,
      entityType: 'post',
      runAfterSeconds: 15,
    })
    const { query } = await import('../../../shared/database/connection.js')
    const { uuidToBuffer } = await import('../../../shared/utils/uuid.utils.js')
    const evtTime = event.time ? new Date(event.time * 1000).toISOString().slice(0, 19).replace('T', ' ') : new Date().toISOString().slice(0, 19).replace('T', ' ')
    await query('UPDATE post_targets SET last_engagement_event_at = ?, last_meta_event_at = ? WHERE id = ?', [evtTime, evtTime, uuidToBuffer(targetRow.id)])
    return { applied: true, engagementRefreshQueued: true, targetId: targetRow.id }
  }

  const should = await shouldProcessEvent(targetRow, event.time)
  if (!should) return { ignored: true, reason: 'stale_event' }
  const { requeueAutoJob } = await import('./campaign.repository.js')
  const { POST_JOB_TYPES } = await import('../posts/post.model.js')
  await requeueAutoJob(targetRow.post_id, POST_JOB_TYPES.SYNC_ENGAGEMENT_TARGET, { targetId: targetRow.id }, {
    runKey: `eng-target:${targetRow.id}`,
    entityType: 'post',
    runAfterSeconds: 15,
  })
  const { query } = await import('../../../shared/database/connection.js')
  const { uuidToBuffer } = await import('../../../shared/utils/uuid.utils.js')
  const evtTime2 = event.time ? new Date(event.time * 1000).toISOString().slice(0, 19).replace('T', ' ') : new Date().toISOString().slice(0, 19).replace('T', ' ')
  await query('UPDATE post_targets SET last_engagement_event_at = ?, last_meta_event_at = ? WHERE id = ?', [evtTime2, evtTime2, uuidToBuffer(targetRow.id)])
  return { applied: true, engagementRefreshQueued: true, targetId: targetRow.id }
}

async function handleInstagramComments(event) {
  const value = event.value || {}
  const mediaId = value.media_id || value.mediaId || value.id || event.externalObjectId
  if (!mediaId) return { ignored: true, reason: 'no_media_id' }
  const { findPostTargetByExternalId } = await import('./campaign.repository.js')
  const targetRow = await findPostTargetByExternalId(mediaId, 'instagram')
  if (!targetRow) return { ignored: true, reason: 'unknown_target' }
  const should = await shouldProcessEvent(targetRow, event.time)
  if (!should) return { ignored: true, reason: 'stale_event' }
  const { requeueAutoJob } = await import('./campaign.repository.js')
  const { POST_JOB_TYPES } = await import('../posts/post.model.js')
  await requeueAutoJob(targetRow.post_id, POST_JOB_TYPES.SYNC_ENGAGEMENT_TARGET, { targetId: targetRow.id }, {
    runKey: `eng-target:${targetRow.id}`,
    entityType: 'post',
    runAfterSeconds: 10,
  })
  const { query } = await import('../../../shared/database/connection.js')
  const { uuidToBuffer } = await import('../../../shared/utils/uuid.utils.js')
  const evtTime = event.time ? new Date(event.time * 1000).toISOString().slice(0, 19).replace('T', ' ') : new Date().toISOString().slice(0, 19).replace('T', ' ')
  await query('UPDATE post_targets SET last_engagement_event_at = ?, last_meta_event_at = ? WHERE id = ?', [evtTime, evtTime, uuidToBuffer(targetRow.id)])
  return { applied: true, engagementRefreshQueued: true, targetId: targetRow.id }
}

async function handleInstagramStoryInsights(event) {
  const value = event.value || {}
  const mediaId = value.media_id || value.id || event.externalObjectId
  if (!mediaId) return { ignored: true, reason: 'no_media_id' }
  const { findPostTargetByExternalId } = await import('./campaign.repository.js')
  const targetRow = await findPostTargetByExternalId(mediaId, 'instagram')
  if (!targetRow) return { ignored: true, reason: 'unknown_target' }
  const payload = {
    impressions: value.impressions,
    reach: value.reach,
    views: value.views,
    taps_forward: value.taps_forward,
    taps_back: value.taps_back,
    exits: value.exits,
    replies: value.replies,
  }
  const hasMetrics = Object.values(payload).some(v => v != null)
  if (!hasMetrics) return { ignored: true, reason: 'no_metrics' }
  const statDate = new Date((event.time || Date.now()/1000) * 1000).toISOString().slice(0, 10)
  const { query } = await import('../../../shared/database/connection.js')
  const { bufferToUuid } = await import('../../../shared/utils/uuid.utils.js')
  const { generateUuid, uuidToBuffer } = await import('../../../shared/utils/uuid.utils.js')
  const impressions = Number(payload.impressions) || 0
  const reach = Number(payload.reach) || 0
  const views = Number(payload.views) || 0
  const tapsForward = Number(payload.taps_forward) || 0
  const tapsBack = Number(payload.taps_back) || 0
  const exits = Number(payload.exits) || 0
  const replies = Number(payload.replies) || 0
  const id = generateUuid()
  await query(
    `INSERT INTO post_engagement_daily
      (id, post_id, target_id, stat_date, media_type, permalink, likes, comments, saved, shares, views, reach, interactions, impressions, taps_forward, taps_back, exits, replies, raw, comments_json, error)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 0, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, NULL)
     ON DUPLICATE KEY UPDATE
       views = VALUES(views), reach = VALUES(reach), impressions = VALUES(impressions),
       taps_forward = VALUES(taps_forward), taps_back = VALUES(taps_back), exits = VALUES(exits), replies = VALUES(replies),
       raw = VALUES(raw), updated_at = NOW()`,
    [
      uuidToBuffer(id), uuidToBuffer(targetRow.post_id), uuidToBuffer(targetRow.id), statDate, targetRow.publish_state || null, null,
      views, reach, impressions, tapsForward, tapsBack, exits, replies,
      JSON.stringify({ source: 'webhook', story_insights: payload, eventTime: event.time }),
      JSON.stringify([]),
    ]
  )
  const evtTime = event.time ? new Date(event.time * 1000).toISOString().slice(0, 19).replace('T', ' ') : new Date().toISOString().slice(0, 19).replace('T', ' ')
  await query('UPDATE post_targets SET last_engagement_event_at = ?, last_meta_event_at = ?, last_engagement_sync_at = NOW() WHERE id = ?', [evtTime, evtTime, uuidToBuffer(targetRow.id)])
  return { applied: true, storyInsightsStored: true, targetId: targetRow.id }
}

export async function resubscribeAllWebhooks() {
  const { query } = await import('../../../shared/database/connection.js')
  const { decrypt } = await import('../../../shared/utils/crypto.utils.js')
  const { bufferToUuid } = await import('../../../shared/utils/uuid.utils.js')
  const { subscribePage } = await import('../../../shared/services/meta-graph.service.js')
  const rows = await query(`
    SELECT upa.*, p.code as platform_code FROM user_platform_accounts upa
    JOIN platforms p ON p.id = upa.platform_id
    WHERE upa.token_type = 'page' AND upa.verification_status = 'verified'
      AND p.code = 'facebook'
      AND upa.platform_user_id NOT LIKE 'dbg\\_%'
  `)
  const results = []
  for (const row of rows) {
    const platform = row.platform_code
    const uuid = (() => { try { return bufferToUuid(row.id) } catch { return String(row.id) } })()
    const token = row.access_token ? decrypt(row.access_token) : null
    if (!token) {
      results.push({ id: uuid, platform, status: 'failed', error: 'no token' })
      continue
    }
    const hasLinkedIg = !!row.instagram_business_account_id
    const expected = hasLinkedIg ? ['feed', 'comments', 'story_insights', 'mentions'] : ['feed']
    try {
      await subscribePage(row.platform_user_id, token, expected)
      const fields = JSON.stringify(expected)
      await query("UPDATE user_platform_accounts SET webhook_status = 'active', webhook_fields = ?, webhook_subscribed_at = NOW(), webhook_last_checked_at = NOW(), webhook_last_error = NULL WHERE id = ?", [fields, row.id])
      results.push({ id: uuid, platform, status: 'active' })
    } catch (e) {
      await query("UPDATE user_platform_accounts SET webhook_status = 'failed', webhook_last_error = ?, webhook_last_checked_at = NOW() WHERE id = ?", [String(e.message).slice(0, 1000), row.id])
      results.push({ id: uuid, platform, status: 'failed', error: String(e.message).slice(0, 500) })
    }
  }
  return {
    total: rows.length,
    active: results.filter(r => r.status === 'active').length,
    failed: results.filter(r => r.status === 'failed').length,
    results,
  }
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
    case 'feed':
      return handleFacebookPageFeed(event)
    case 'comments':
      return handleInstagramComments(event)
    case 'story_insights':
      return handleInstagramStoryInsights(event)
    case 'mentions':
      return { ignored: true, reason: 'mentions_not_handled' }
    default:
      return { ignored: true, reason: 'unsupported_field' }
  }
}

const CAMPAIGN_FIELDS = new Set(['campaign.status_update', 'campaign_daily_spend', 'campaign_spend', 'ad.delivery_signals'])
const ORGANIC_FIELDS = new Set(['feed', 'comments', 'story_insights', 'mentions'])

export async function processMetaWebhookEvents(body) {
  const events = normalizeWebhookEvents(body)
  if (!events.length) return { success: false, reason: 'no_events' }

  const results = []
  for (const event of events) {
    const providerKey = event.providerEventKey || event.id
    const existingByProvider = await queryOne('SELECT id FROM meta_webhook_events WHERE provider_event_key = ?', [providerKey])
    if (existingByProvider) {
      results.push({ id: event.id, providerEventKey: providerKey, field: event.field, status: 'duplicate' })
      continue
    }
    const existingById = await queryOne('SELECT id FROM meta_webhook_events WHERE id = ?', [event.id])
    if (existingById) {
      results.push({ id: event.id, field: event.field, status: 'duplicate' })
      continue
    }
    const isCampaignEvent = CAMPAIGN_FIELDS.has(event.field)
    const isOrganicEvent = ORGANIC_FIELDS.has(event.field)
    if (isCampaignEvent || !isOrganicEvent) {
      try {
        const outcome = await handleMetaWebhookEvent(event)
        await repo.insertWebhookEventAtomic({
          id: event.id,
          providerEventKey: providerKey,
          objectType: event.objectType || event.object,
          sourceId: event.sourceId,
          platform: event.platform,
          accountId: event.accountId,
          externalAccountId: event.externalAccountId,
          externalObjectId: event.externalObjectId,
          eventType: event.field || 'unknown',
          eventTime: event.time,
          payload: { object: event.object, field: event.field, value: event.value, time: event.time },
        })
        await query("UPDATE meta_webhook_events SET processing_status = ?, processed_at = NOW() WHERE id = ?", [outcome && outcome.ignored ? 'ignored' : 'processed', event.id])
        results.push({ id: event.id, providerEventKey: providerKey, field: event.field, status: 'processed', outcome })
      } catch (err) {
        await logMetaEvent({ action: 'webhook', field: event.field, error: err.message })
        try {
          await repo.insertWebhookEventAtomic({
            id: event.id,
            providerEventKey: providerKey,
            objectType: event.objectType || event.object,
            sourceId: event.sourceId,
            platform: event.platform,
            accountId: event.accountId,
            externalAccountId: event.externalAccountId,
            externalObjectId: event.externalObjectId,
            eventType: event.field || 'unknown',
            eventTime: event.time,
            payload: { object: event.object, field: event.field, value: event.value, time: event.time },
          })
          await query("UPDATE meta_webhook_events SET processing_status = ?, last_error = ? WHERE id = ?", ['dead', String(err.message).slice(0, 2000), event.id])
        } catch {}
        results.push({ id: event.id, field: event.field, status: 'error', error: err.message })
      }
      continue
    }
    try {
      const inserted = await repo.insertWebhookEventAtomic({
        id: event.id,
        providerEventKey: providerKey,
        objectType: event.objectType || event.object,
        sourceId: event.sourceId,
        platform: event.platform,
        accountId: event.accountId,
        externalAccountId: event.externalAccountId,
        externalObjectId: event.externalObjectId,
        eventType: event.field || 'unknown',
        eventTime: event.time,
        payload: { object: event.object, field: event.field, value: event.value, time: event.time },
      })
      if (inserted.duplicate) {
        results.push({ id: event.id, providerEventKey: providerKey, field: event.field, status: 'duplicate' })
        continue
      }
      const { requeueAutoJob } = await import('./campaign.repository.js')
      await requeueAutoJob(null, CAMPAIGN_JOB_TYPES.META_WEBHOOK, { eventId: event.id, providerEventKey: providerKey }, {
        runKey: `webhook:${providerKey.slice(0, 32)}`,
        entityType: 'system',
        maxAttempts: 5,
      })
      results.push({ id: event.id, providerEventKey: providerKey, field: event.field, status: 'queued' })
    } catch (err) {
      await logMetaEvent({ action: 'webhook_ingress', field: event.field, error: err.message })
      results.push({ id: event.id, field: event.field, status: 'error', error: err.message })
    }
  }

  const processed = results.filter(r => r.status === 'processed').length
  const queued = results.filter(r => r.status === 'queued').length
  const dups = results.filter(r => r.status === 'duplicate').length
  return {
    success: true,
    total: results.length,
    processed: processed + queued,
    queued,
    duplicates: dups,
    errors: results.filter(r => r.status === 'error').length,
    results,
  }
}

export async function processWebhookEventById(eventId) {
  const eventRow = await queryOne('SELECT * FROM meta_webhook_events WHERE id = ?', [eventId])
  if (!eventRow) return { ignored: true, reason: 'event_not_found' }
  if (eventRow.processing_status === 'processed' || eventRow.processing_status === 'ignored') {
    return { ignored: true, reason: 'already_processed' }
  }
  await query('UPDATE meta_webhook_events SET processing_status = ?, processing_started_at = NOW(), attempts = attempts + 1 WHERE id = ?', ['processing', eventId])
  try {
    const payload = typeof eventRow.payload === 'string' ? JSON.parse(eventRow.payload) : eventRow.payload
    const normalized = {
      id: eventRow.id,
      providerEventKey: eventRow.provider_event_key,
      object: eventRow.object_type || payload?.object,
      field: eventRow.event_type,
      value: payload?.value || payload,
      time: eventRow.event_time ? Math.floor(new Date(eventRow.event_time).getTime() / 1000) : null,
      platform: eventRow.platform,
      externalAccountId: eventRow.external_account_id,
      externalObjectId: eventRow.external_object_id,
      accountId: eventRow.account_id,
    }
    const outcome = await handleMetaWebhookEvent(normalized)
    const isIgnored = outcome && outcome.ignored
    await query('UPDATE meta_webhook_events SET processing_status = ?, processed_at = NOW(), last_error = NULL WHERE id = ?', [isIgnored ? 'ignored' : 'processed', eventId])
    return outcome
  } catch (err) {
    const isRetryable = isWebhookRetryableError(err)
    const nextAttempt = isRetryable ? new Date(Date.now() + Math.min(2 ** (eventRow.attempts || 0) * 30000, 3600000)).toISOString().slice(0, 19).replace('T', ' ') : null
    await query('UPDATE meta_webhook_events SET processing_status = ?, last_error = ?, next_attempt_at = ? WHERE id = ?', [
      isRetryable ? 'retryable' : 'dead', String(err.message).slice(0, 2000), nextAttempt, eventId,
    ])
    if (!isRetryable) {
      try { await sendAdminAlert('Meta webhook event dead', `Event ${eventId} (${eventRow.event_type}) moved to dead: ${String(err.message).slice(0, 500)}`) } catch {}
    }
    await logMetaEvent({ action: 'webhook_process', eventId, error: err.message })
    throw err
  }
}
