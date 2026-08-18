import { META_CONFIG } from './meta-oauth.config.js'
import { apiFetch } from '../utils/api-logger.js'
import { recordUsage } from './meta-rate-limiter.js'
import { fetchBoundedBytes } from './media-url.js'

const RATE_LIMIT_CODES = new Set([80004, 613, 4, 17])
const RATE_LIMIT_SUBCODE = 2446079
const HOSTED_UPLOAD_MAX_BYTES = 512 * 1024 * 1024

function accountKeyFromPath(path) {
  const match = String(path).match(/^act_[A-Za-z0-9]+/)
  return match ? match[0] : undefined
}

export function isRateLimitError(error) {
  const meta = extractMetaError(error)
  if (meta?.code != null && RATE_LIMIT_CODES.has(Number(meta.code))) return true
  if (meta?.subcode != null && Number(meta.subcode) === RATE_LIMIT_SUBCODE) return true
  return false
}

export function retryAfterSecondsFromError(error) {
  const retryAfter = error?.response?.headers?.get?.('retry-after')
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds, 3600)
  }
  const meta = extractMetaError(error)
  if (meta?.code != null && RATE_LIMIT_CODES.has(Number(meta.code))) return 120
  return null
}

function tagGraphError(error, { path, method }) {
  const meta = extractMetaError(error)
  if (meta) {
    error.metaHttpStatus = error?.statusCode ?? 400
    error.metaErrorCode = meta.code
    error.metaErrorSubcode = meta.subcode
    error.metaAmbiguous = false
    return error
  }
  error.metaHttpStatus = error?.statusCode ?? null
  error.metaAmbiguous = true
  return error
}

async function maybeEnterCooldown(res, errorText, accountId) {
  if (res.status === 429) {
    const { setCooldown } = await import('./meta-rate-limiter.js')
    setCooldown(120, accountId)
    return
  }
  let parsed = null
  try {
    parsed = JSON.parse(errorText)
  } catch {
    return
  }
  const err = parsed?.error
  if (err && (RATE_LIMIT_CODES.has(Number(err.code)) || Number(err.error_subcode) === RATE_LIMIT_SUBCODE)) {
    const { setCooldown } = await import('./meta-rate-limiter.js')
    setCooldown(120, accountId)
  }
}

async function graphPost(path, params = {}) {
  const query = new URLSearchParams({ access_token: params.access_token })
  const url = `${META_CONFIG.graphUrl}/${path}?${query.toString()}`

  const body = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (key !== 'access_token') {
      body.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value))
    }
  }

  const accountId = accountKeyFromPath(path)
  const res = await apiFetch(url, { method: 'POST', body: body.toString() }, { service: 'meta_ads', operation: `POST ${path}` })
  recordUsage(res.headers, accountId)
  if (!res.ok) {
    const error = await res.text()
    await maybeEnterCooldown(res, error, accountId)
    const err = new Error(`Graph API POST ${path} failed: ${error}`)
    err.statusCode = res.status
    throw tagGraphError(err, { path, method: 'POST' })
  }
  return res.json()
}

async function graphDelete(path, accessToken) {
  const url = `${META_CONFIG.graphUrl}/${path}?access_token=${accessToken}`
  const accountId = accountKeyFromPath(path)
  const res = await apiFetch(url, { method: 'DELETE' }, { service: 'meta_ads', operation: `DELETE ${path}` })
  recordUsage(res.headers, accountId)
  if (!res.ok) {
    const error = await res.text()
    await maybeEnterCooldown(res, error, accountId)
    const err = new Error(`Graph API DELETE ${path} failed: ${error}`)
    err.statusCode = res.status
    throw tagGraphError(err, { path, method: 'DELETE' })
  }
  return res.json()
}

async function graphGet(path, params = {}) {
  const qs = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (key !== 'access_token') {
      qs.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value))
    }
  }
  qs.append('access_token', params.access_token)
  const url = `${META_CONFIG.graphUrl}/${path}?${qs.toString()}`
  const accountId = accountKeyFromPath(path)
  const res = await apiFetch(url, {}, { service: 'meta_ads', operation: `GET ${path}` })
  recordUsage(res.headers, accountId)
  if (!res.ok) {
    const error = await res.text()
    await maybeEnterCooldown(res, error, accountId)
    const err = new Error(`Graph API GET ${path} failed: ${error}`)
    err.statusCode = res.status
    throw tagGraphError(err, { path, method: 'GET' })
  }
  return res.json()
}

export function extractMetaError(error) {
  const message = error?.message || String(error)
  const match = message.match(/failed: (\{.*\})/s)
  if (!match) return null
  try {
    const parsed = JSON.parse(match[1])
    return {
      userMsg: parsed.error?.error_user_msg || null,
      userTitle: parsed.error?.error_user_title || null,
      code: parsed.error?.code || null,
      subcode: parsed.error?.error_subcode || null,
      raw: message,
    }
  } catch {
    return null
  }
}

export async function createAdCampaign(adAccountId, name, objective, status = 'PAUSED', accessToken, extra = {}, validateOnly = false) {
  const params = {
    access_token: accessToken,
    name,
    objective,
    status,
    special_ad_categories: [],
    is_adset_budget_sharing_enabled: false,
  }
  if (extra.spendCap) params.spend_cap = extra.spendCap
  if (validateOnly) params.execution_options = ['validate_only']
  const data = await graphPost(`act_${adAccountId}/campaigns`, params)
  return data
}

const GOAL_BILLING_MAP = {
  REACH: 'IMPRESSIONS',
  IMPRESSIONS: 'IMPRESSIONS',
  LINK_CLICKS: 'LINK_CLICKS',
  LANDING_PAGE_VIEWS: 'LINK_CLICKS',
  OUTBOUND_CLICKS: 'LINK_CLICKS',
  POST_ENGAGEMENT: 'POST_ENGAGEMENT',
  PAGE_LIKES: 'PAGE_LIKES',
  CONVERSIONS: 'OFFSITE_CONVERSIONS',
  LEAD_GENERATION: 'LEAD_GENERATION',
  VALUE: 'OFFSITE_CONVERSIONS',
}

export async function createAdSet(adAccountId, campaignId, targeting, budget, schedule, placement, accessToken, validateOnly = false) {
  const optimizationGoal = budget.optimizationGoal || 'REACH'
  const params = {
    access_token: accessToken,
    name: `Ad Set ${campaignId.substring(0, 8)}`,
    campaign_id: campaignId,
    bid_strategy: budget.bidStrategy || 'LOWEST_COST_WITHOUT_CAP',
    optimization_goal: optimizationGoal,
    billing_event: GOAL_BILLING_MAP[optimizationGoal] || budget.billingEvent || 'IMPRESSIONS',
    targeting: { ...targeting, targeting_automation: { advantage_audience: 0 } },
    status: 'PAUSED',
  }

  if (budget.budgetType === 'daily') {
    params.daily_budget = Math.round(budget.budgetAmount * 100)
  } else {
    params.lifetime_budget = Math.round(budget.budgetAmount * 100)
  }

  if (schedule.startTime) params.start_time = schedule.startTime
  if (schedule.endTime) params.end_time = schedule.endTime

  if (placement) {
    params.publisher_platforms = placement.publisherPlatforms || ['facebook', 'instagram']
    if (placement.feedPositions) params.feed_positions = placement.feedPositions
    if (placement.instagramPositions) params.instagram_positions = placement.instagramPositions
  }

  if (budget.promotedPageId) params.promoted_object = { page_id: budget.promotedPageId }

  if (placement?.adSchedule) params.ad_schedule = placement.adSchedule
  if (placement?.frequencyControl) params.frequency_control_specs = placement.frequencyControl

  if (validateOnly) params.execution_options = ['validate_only']

  const data = await graphPost(`act_${adAccountId}/adsets`, params)
  return data
}

export async function createAdCreative(adAccountId, pageId, message, mediaUrl, callToAction, accessToken, extra = {}, validateOnly = false) {
  const objectStorySpec = {
    page_id: pageId,
  }

  if (mediaUrl) {
    const linkData = {
      link: mediaUrl,
      message: message || '',
    }
    if (callToAction) linkData.call_to_action = { type: callToAction }
    if (extra.headline) linkData.name = extra.headline
    if (extra.description) linkData.description = extra.description
    if (extra.imageHash) linkData.image_hash = extra.imageHash
    objectStorySpec.link_data = linkData
  }

  const params = {
    access_token: accessToken,
    name: `Creative ${Date.now()}`,
    object_story_spec: objectStorySpec,
  }

  if (validateOnly) params.execution_options = ['validate_only']

  const data = await graphPost(`act_${adAccountId}/adcreatives`, params)
  return data
}

export async function createUnpublishedPagePost(pageId, message, mediaUrl, accessToken) {
  const params = {
    access_token: accessToken,
    message: message || '',
    published: false,
  }

  if (mediaUrl) {
    params.link = mediaUrl
  }

  const data = await graphPost(`${pageId}/feed`, params)
  return data
}

export async function createAdCreativeFromPost(adAccountId, objectStoryId, name, accessToken) {
  const data = await graphPost(`act_${adAccountId}/adcreatives`, {
    access_token: accessToken,
    name: name || `Creative ${Date.now()}`,
    object_story_id: objectStoryId,
  })
  return data
}

export async function createAd(adAccountId, adSetId, creativeId, name, accessToken, status = 'PAUSED', extra = {}, validateOnly = false) {
  const params = {
    access_token: accessToken,
    name: name || `Ad ${Date.now()}`,
    adset_id: adSetId,
    creative: { creative_id: creativeId },
    status,
  }
  if (extra.urlTags) params.url_tags = extra.urlTags
  if (validateOnly) params.execution_options = ['validate_only']
  const data = await graphPost(`act_${adAccountId}/ads`, params)
  return data
}

export async function createPagePhotoPost(pageId, accessToken, { url, message, scheduledAt, published } = {}) {
  const params = {
    access_token: accessToken,
    url,
  }

  if (message) params.caption = message

  if (scheduledAt) {
    params.published = false
    params.scheduled_publish_time = Math.floor(new Date(scheduledAt).getTime() / 1000)
  }

  if (published !== undefined) params.published = published

  const data = await graphPost(`${pageId}/photos`, params)
  return data
}

export async function createPageVideoPost(pageId, accessToken, { url, message } = {}) {
  const params = {
    access_token: accessToken,
    file_url: url,
  }

  if (message) params.description = message

  const data = await graphPost(`${pageId}/videos`, params)
  return data
}

async function uploadHostedVideo(uploadUrl, fileUrl, accessToken) {
  const hosted = await apiFetch(uploadUrl, {
    method: 'POST',
    headers: { Authorization: `OAuth ${accessToken}`, 'file_url': fileUrl },
  }, { service: 'meta_ads', operation: 'POST rupload (hosted)' })
  if (hosted.ok) return hosted.json()
  const hostedBody = await hosted.text().catch(() => '(empty)')
  let fallbackBody = null
  try {
    const { bytes, truncated } = await fetchBoundedBytes(fileUrl, { maxBytes: HOSTED_UPLOAD_MAX_BYTES })
    if (truncated || !bytes || !bytes.length) throw new Error('could not download full media (truncated or empty)')
    const res = await apiFetch(uploadUrl, {
      method: 'POST',
      headers: {
        Authorization: `OAuth ${accessToken}`,
        'Content-Type': 'application/octet-stream',
        offset: '0',
        file_size: String(bytes.length),
      },
      body: bytes,
    }, { service: 'meta_ads', operation: 'POST rupload (binary)' })
    if (res.ok) return res.json()
    fallbackBody = await res.text().catch(() => '(empty)')
  } catch (downloadErr) {
    fallbackBody = downloadErr?.message || 'download failed'
  }
  const fallbackDetail = fallbackBody && !/[\{\}]/.test(fallbackBody) ? ` (fallback: ${fallbackBody})` : ''
  const err = new Error(`Graph API hosted video upload failed: ${hostedBody}${fallbackDetail}`)
  err.statusCode = hosted.status
  throw tagGraphError(err, { path: 'rupload', method: 'POST' })
}

async function createPageVideoContainer(pageId, accessToken, endpoint, uploadPhase, params) {
  const body = {
    access_token: accessToken,
    upload_phase: uploadPhase,
    ...params,
  }
  const data = await graphPost(`${pageId}/${endpoint}`, body)
  return data
}

export const fbVideoPoll = { intervalMs: 5000, timeoutMs: 180000, publishTimeoutMs: 600000 }

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function listPageReels(pageId, accessToken) {
  const data = await graphGet(`${pageId}/video_reels`, {
    access_token: accessToken,
    fields: 'id,description,updated_time',
    limit: 10,
  })
  return Array.isArray(data?.data) ? data.data : []
}

export async function resolvePageReelPostId(pageId, accessToken, { message, since } = {}) {
  const reels = await listPageReels(pageId, accessToken)
  const matches = reels.filter(reel => {
    if (!reel?.id) return false
    if (since) {
      const updated = reel.updated_time ? Date.parse(reel.updated_time) : NaN
      if (!Number.isNaN(updated) && updated < since) return false
    }
    if (message && typeof reel.description === 'string') {
      return reel.description === message
    }
    return true
  })
  if (matches.length === 1) return { postId: matches[0].id, ambiguous: false }
  if (matches.length > 1) return { postId: null, ambiguous: true }
  return { postId: null, ambiguous: false }
}

async function listPageStories(pageId, accessToken) {
  const data = await graphGet(`${pageId}/stories`, {
    access_token: accessToken,
    fields: 'post_id,status,creation_time,media_type',
    limit: 10,
  })
  return Array.isArray(data?.data) ? data.data : []
}

async function resolveStoryPostId(pageId, accessToken, since) {
  const stories = await listPageStories(pageId, accessToken)
  const matches = stories.filter(story => {
    if (!story?.post_id || story?.status !== 'PUBLISHED') return false
    if (since) {
      const created = story.creation_time ? story.creation_time * 1000 : NaN
      if (!Number.isNaN(created) && created < since) return false
    }
    return true
  })
  if (matches.length === 1) return matches[0].post_id
  if (matches.length > 1) {
    const sorted = [...matches].sort((a, b) => (b.creation_time || 0) - (a.creation_time || 0))
    if (sorted[0].creation_time !== sorted[1].creation_time) return sorted[0].post_id
  }
  if (matches.length > 0) return matches[0].post_id
  return null
}

async function waitForStoryPublished(pageId, videoId, accessToken) {
  const startedAt = Date.now()
  const deadline = startedAt + fbVideoPoll.publishTimeoutMs
  while (Date.now() < deadline) {
    const data = await getVideoUploadStatus(videoId, accessToken)
    const status = data?.status
    if (status?.video_status === 'error') {
      const detail = Array.isArray(status.status_errors)
        ? status.status_errors.map(e => e?.message || e).join('; ')
        : status.status_errors?.message || status.status_errors || 'video publishing failed'
      const err = new Error(`Facebook video story publishing failed: ${detail}`)
      err.metaAmbiguous = false
      throw err
    }
    if (status?.publishing_phase?.publish_status === 'published') {
      const postId = await resolveStoryPostId(pageId, accessToken, startedAt)
      if (postId) return { id: postId, videoId }
    }
    await sleep(fbVideoPoll.intervalMs)
  }
  const err = new Error('Timed out waiting for Facebook video story to finish publishing')
  err.metaAmbiguous = false
  throw err
}

export async function startPageReel(pageId, accessToken) {
  const started = await createPageVideoContainer(pageId, accessToken, 'video_reels', 'start', {})
  if (started instanceof Error) throw started
  if (!started?.upload_url || !started?.video_id) {
    const err = new Error('Graph API failed to allocate a Reels upload session (missing upload_url)')
    err.metaAmbiguous = false
    err.metaHttpStatus = 500
    throw err
  }
  return started
}

export async function uploadPageReelMedia(uploadUrl, fileUrl, accessToken) {
  return uploadHostedVideo(uploadUrl, fileUrl, accessToken)
}

export async function getPageReelStatus(videoId, accessToken) {
  const data = await graphGet(videoId, {
    access_token: accessToken,
    fields: 'status',
  })
  if (data instanceof Error) throw data
  return data?.status ?? data
}

export async function finishPageReel(pageId, accessToken, { videoId, description } = {}) {
  const finished = await createPageVideoContainer(pageId, accessToken, 'video_reels', 'finish', {
    video_id: videoId,
    video_state: 'PUBLISHED',
    description: description || '',
  })
  if (finished instanceof Error) throw finished
  if (finished?.error) {
    const detail = finished.error?.message || finished.error?.error_user_msg || JSON.stringify(finished.error)
    const err = new Error(`Graph API failed to finish the Reels upload: ${detail}`)
    err.metaAmbiguous = false
    err.metaHttpStatus = 400
    throw err
  }
  return finished
}

export async function createPageVideoStory(pageId, accessToken, { url }) {
  const started = await createPageVideoContainer(pageId, accessToken, 'video_stories', 'start', { file_url: url })
  if (!started?.upload_url || !started?.video_id) {
    const err = new Error('Graph API failed to allocate a video story upload session (missing upload_url)')
    err.metaAmbiguous = false
    throw err
  }
  await uploadHostedVideo(started.upload_url, url, accessToken)
  const finished = await createPageVideoContainer(pageId, accessToken, 'video_stories', 'finish', {
    video_id: started.video_id,
    video_state: 'PUBLISHED',
  })
  if (finished instanceof Error) throw finished
  if (finished?.post_id) return { id: finished.post_id, videoId: started.video_id }
  if (finished?.error) {
    const detail = finished.error?.message || finished.error?.error_user_msg || JSON.stringify(finished.error)
    const err = new Error(`Graph API failed to finish the video story upload: ${detail}`)
    err.metaAmbiguous = false
    throw err
  }
  return waitForStoryPublished(pageId, started.video_id, accessToken)
}

export async function createPagePhotoStory(pageId, accessToken, { url }) {
  const photo = await createPagePhotoPost(pageId, accessToken, { url, published: false })
  if (!photo?.id) {
    const err = new Error('Graph API failed to stage story photo (missing photo id)')
    err.metaAmbiguous = false
    throw err
  }
  const story = await graphPost(`${pageId}/photo_stories`, {
    access_token: accessToken,
    photo_id: photo.id,
  })
  return { id: story?.id || photo.id, photoId: photo.id }
}

export async function getVideoUploadStatus(videoId, accessToken) {
  const data = await graphGet(videoId, {
    access_token: accessToken,
    fields: 'status',
  })
  return data
}

export async function createFeedPost(pageId, message, link, scheduledPublishTime, accessToken) {
  const params = {
    access_token: accessToken,
    message: message || '',
  }

  if (link) {
    params.link = link
  }

  if (scheduledPublishTime) {
    params.scheduled_publish_time = Math.floor(new Date(scheduledPublishTime).getTime() / 1000)
    params.published = false
  }

  const data = await graphPost(`${pageId}/feed`, params)
  return data
}

export async function createInstagramMedia(igBusinessAccountId, mediaUrl, caption, accessToken, options = {}) {
  const params = {
    access_token: accessToken,
    caption: caption || '',
  }

  const mediaType = options.mediaType || 'IMAGE'
  if (mediaType !== 'IMAGE') params.media_type = mediaType

  if (options.videoUrl || (mediaType !== 'IMAGE' && /\.(mp4|mov)$/i.test(mediaUrl || ''))) {
    params.video_url = options.videoUrl || mediaUrl
  } else {
    params.image_url = mediaUrl
  }

  const data = await graphPost(`${igBusinessAccountId}/media`, params)
  return data
}

export async function publishInstagramMedia(igBusinessAccountId, mediaContainerId, accessToken) {
  const data = await graphPost(`${igBusinessAccountId}/media_publish`, {
    access_token: accessToken,
    creation_id: mediaContainerId,
  })
  return data
}

export async function getContainerStatus(mediaContainerId, accessToken) {
  const data = await graphGet(`${mediaContainerId}`, {
    access_token: accessToken,
    fields: 'status_code,status',
  })
  return data
}

const ENGAGEMENT_INSIGHT_METRICS = 'reach,likes,comments,saved,shares,views,total_interactions'

const FB_VIDEO_FIELDS = 'id,permalink_url,length,created_time,likes.summary(true).limit(0),comments.summary(true).limit(0)'
const FB_PHOTO_FIELDS = 'id,link,created_time,likes.summary(true).limit(0),comments.summary(true).limit(0)'
const FB_POST_FIELDS = 'id,permalink_url,message,created_time,likes.summary(true).limit(0),comments.summary(true).limit(0),shares{count}'

function isPermissionError(error) {
  return /"code"\s*:\s*(10|200|210|282)/.test(String(error?.message || error))
}

function systemToken() {
  return process.env.META_SYSTEM_USER_TOKEN || null
}

export async function getMediaEngagement(mediaId, accessToken, { mediaKind = 'post', platform = 'instagram' } = {}) {
  if (platform === 'facebook') return getFacebookMediaEngagement(mediaId, accessToken)

  const basic = await graphGet(`${mediaId}`, {
    access_token: accessToken,
    fields: mediaKind === 'story' ? 'media_type,timestamp,permalink' : 'media_type,media_product_type,permalink,timestamp,like_count,comments_count',
  })

  const result = {
    mediaId,
    mediaType: basic.media_type || null,
    mediaProductType: basic.media_product_type || null,
    permalink: basic.permalink || null,
    timestamp: basic.timestamp || null,
    likeCount: basic.like_count != null ? Number(basic.like_count) : null,
    commentsCount: basic.comments_count != null ? Number(basic.comments_count) : null,
    insights: {},
    comments: [],
  }

  if (mediaKind === 'story') return result

  const insights = await graphGet(`${mediaId}/insights`, {
    access_token: accessToken,
    metric: ENGAGEMENT_INSIGHT_METRICS,
  })
  for (const entry of insights.data || []) {
    result.insights[entry.name] = Number(entry.values?.[0]?.value) || 0
  }

  const comments = await graphGet(`${mediaId}/comments`, {
    access_token: accessToken,
    fields: 'text,username,timestamp',
  })
  result.comments = (comments.data || []).map(c => ({
    id: c.id,
    text: c.text,
    username: c.username,
    timestamp: c.timestamp,
  }))

  return result
}

async function getFacebookMediaEngagement(mediaId, accessToken) {
  const result = {
    mediaId,
    mediaType: null,
    mediaProductType: null,
    permalink: null,
    timestamp: null,
    likeCount: null,
    commentsCount: null,
    insights: {},
    comments: [],
  }

  let kind = null
  let basic = null
  for (const [candidateKind, fields] of [
    ['video', FB_VIDEO_FIELDS],
    ['photo', FB_PHOTO_FIELDS],
    ['post', FB_POST_FIELDS],
  ]) {
    try {
      basic = await graphGet(`${mediaId}`, { access_token: accessToken, fields })
      kind = candidateKind
      break
    } catch {
      // try next field set — Meta rejects inapplicable fields
    }
  }
  if (!kind) throw new Error(`Graph API GET ${mediaId} failed: unsupported Facebook object`)

  result.mediaType = kind === 'post' ? (basic.link ? 'link' : 'post') : kind
  result.permalink = basic.permalink_url || basic.link || null
  result.timestamp = basic.created_time || null
  result.likeCount = basic.likes?.summary?.total_count != null ? Number(basic.likes.summary.total_count) : null
  result.commentsCount = basic.comments?.summary?.total_count != null ? Number(basic.comments.summary.total_count) : null

  let insights
  try {
    if (kind === 'video') {
      insights = await graphGet(`${mediaId}/video_insights`, {
        access_token: accessToken,
        metric: 'total_video_views',
      })
      for (const entry of insights.data || []) {
        result.insights[entry.name] = Number(entry.values?.[0]?.value) || 0
      }
      result.insights.views = result.insights.total_video_views || 0
    } else if (kind === 'post') {
      insights = await graphGet(`${mediaId}/insights`, {
        access_token: accessToken,
        metric: 'post_impressions,post_engaged_users',
      })
      for (const entry of insights.data || []) {
        result.insights[entry.name] = Number(entry.values?.[0]?.value) || 0
      }
      result.insights.reach = result.insights.post_impressions || 0
      result.insights.interactions = result.insights.post_engaged_users || 0
      result.insights.shares = basic.shares?.count != null ? Number(basic.shares.count) : 0
    }
  } catch (err) {
    const sys = systemToken()
    if (sys && isPermissionError(err)) {
      const fallback = await graphGet(`${mediaId}${kind === 'video' ? '/video_insights' : '/insights'}`, {
        access_token: sys,
        metric: kind === 'video' ? 'total_video_views' : 'post_impressions,post_engaged_users',
      })
      for (const entry of fallback.data || []) {
        result.insights[entry.name] = Number(entry.values?.[0]?.value) || 0
      }
      if (kind === 'video') {
        result.insights.views = result.insights.total_video_views || 0
      } else {
        result.insights.reach = result.insights.post_impressions || 0
        result.insights.interactions = result.insights.post_engaged_users || 0
        result.insights.shares = basic.shares?.count != null ? Number(basic.shares.count) : 0
      }
    }
  }

  try {
    const comments = await graphGet(`${mediaId}/comments`, {
      access_token: accessToken,
      fields: 'message,from{name},created_time',
    })
    result.comments = (comments.data || []).map(c => ({
      id: c.id,
      text: c.message,
      username: c.from?.name || null,
      timestamp: c.created_time,
    }))
  } catch {
    // comments are best-effort
  }

  return result
}

export async function deleteInstagramContainer(mediaContainerId, accessToken) {
  const data = await graphDelete(`${mediaContainerId}`, accessToken)
  return data
}

export async function createInstagramStory(igBusinessAccountId, mediaUrl, accessToken, options = {}) {
  const params = {
    access_token: accessToken,
    media_type: 'STORIES',
  }

  if (options.videoUrl || mediaUrl.match(/\.(mp4|mov)$/i)) {
    params.video_url = options.videoUrl || mediaUrl
  } else {
    params.image_url = mediaUrl
  }

  const data = await graphPost(`${igBusinessAccountId}/media`, params)
  return data
}

export async function getAdAccount(adAccountId, accessToken) {
  const data = await graphGet(`act_${adAccountId}`, {
    access_token: accessToken,
    fields: 'id,name,account_status,currency,balance,disable_reason',
  })
  return data
}

export async function getCampaignInsights(campaignId, accessToken, datePreset = 'last_7d') {
  const data = await graphGet(`${campaignId}/insights`, {
    access_token: accessToken,
    fields: 'impressions,reach,spend,clicks,ctr,cpc,cpm,actions',
    date_preset: datePreset,
  })
  return data.data || []
}

export const INSIGHTS_FIELDS = 'impressions,reach,frequency,clicks,unique_clicks,ctr,cpc,cpm,spend,actions,cost_per_action_type'

export async function createInsightsReport(adAccountId, { accessToken, level = 'campaign', timeIncrement = 1, since, until, fields = INSIGHTS_FIELDS, filtering } = {}) {
  const params = {
    access_token: accessToken,
    level,
    time_increment: timeIncrement,
    fields,
    limit: 1000,
  }
  if (since) params.since = since
  if (until) params.until = until
  if (filtering) params.filtering = filtering
  const data = await graphPost(`act_${adAccountId}/insights`, params)
  return data
}

export async function getInsightsReport(reportRunId, accessToken) {
  const data = await graphGet(reportRunId, {
    access_token: accessToken,
  })
  return data
}

export async function getInsightsReportData(reportRunId, accessToken) {
  const data = await graphGet(`${reportRunId}/insights`, {
    access_token: accessToken,
  })
  return data.data || []
}

export async function deleteAdCampaign(campaignId, accessToken) {
  return graphDelete(campaignId, accessToken)
}

export async function deleteAdSet(adSetId, accessToken) {
  return graphDelete(adSetId, accessToken)
}

export async function deleteAdCreative(creativeId, accessToken) {
  return graphDelete(creativeId, accessToken)
}

export async function deleteAd(adId, accessToken) {
  return graphDelete(adId, accessToken)
}

export async function updateAdStatus(adId, status, accessToken) {
  const data = await graphPost(adId, {
    access_token: accessToken,
    status,
  })
  return data
}

export async function getObjectStatus(objectId, accessToken) {
  const data = await graphGet(objectId, {
    access_token: accessToken,
    fields: 'status,effective_status',
  })
  return data
}

export async function listAccountAds(adAccountId, accessToken, limit = 100) {
  const rows = []
  let after = null
  let truncated = false
  let endedFull = false
  for (let page = 0; page < 10; page += 1) {
    const params = {
      access_token: accessToken,
      fields: 'id,status,effective_status',
      limit,
    }
    if (after) params.after = after
    const data = await graphGet(`act_${adAccountId}/ads`, params)
    const pageRows = data.data || []
    rows.push(...pageRows)
    if (pageRows.length) endedFull = pageRows.length === limit
    after = data.paging?.cursors?.after || null
    if (!after) {
      if (endedFull) truncated = true
      break
    }
    if (page === 9) truncated = true
  }
  return { rows, truncated }
}

export async function getCampaignStatusesBatch(adAccountId, accessToken, fbCampaignIds) {
  if (!fbCampaignIds.length) return {}
  const ids = fbCampaignIds.join(',')
  const data = await graphGet('', {
    access_token: accessToken,
    ids,
    fields: 'effective_status,status',
  })
  const result = {}
  for (const [id, campaign] of Object.entries(data || {})) {
    if (campaign?.effective_status) {
      result[id] = campaign.effective_status
    } else if (campaign?.status) {
      result[id] = campaign.status
    }
  }
  return result
}

export async function searchMeta(params) {
  const data = await graphGet('search', {
    access_token: params.accessToken,
    type: params.type,
    q: params.q,
    limit: params.limit || 25,
    ...(params.extra || {}),
  })
  return data.data || []
}
