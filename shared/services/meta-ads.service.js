import { META_CONFIG } from './meta-oauth.config.js'
import { apiFetch } from '../utils/api-logger.js'

async function graphPost(path, params = {}) {
  const query = new URLSearchParams({ access_token: params.access_token })
  const url = `${META_CONFIG.graphUrl}/${path}?${query.toString()}`

  const body = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (key !== 'access_token') {
      body.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value))
    }
  }

  const res = await apiFetch(url, { method: 'POST', body: body.toString() }, { service: 'meta_ads', operation: `POST ${path}` })
  if (!res.ok) {
    const error = await res.text()
    throw new Error(`Graph API POST ${path} failed: ${error}`)
  }
  return res.json()
}

async function graphDelete(path, accessToken) {
  const url = `${META_CONFIG.graphUrl}/${path}?access_token=${accessToken}`
  const res = await apiFetch(url, { method: 'DELETE' }, { service: 'meta_ads', operation: `DELETE ${path}` })
  if (!res.ok) {
    const error = await res.text()
    throw new Error(`Graph API DELETE ${path} failed: ${error}`)
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
  const res = await apiFetch(url, {}, { service: 'meta_ads', operation: `GET ${path}` })
  if (!res.ok) {
    const error = await res.text()
    throw new Error(`Graph API GET ${path} failed: ${error}`)
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

export async function createFeedPost(pageId, message, mediaUrl, scheduledPublishTime, accessToken) {
  const params = {
    access_token: accessToken,
    message: message || '',
  }

  if (mediaUrl) {
    params.attached_media = JSON.stringify([{ media_fbid: mediaUrl }])
  }

  if (scheduledPublishTime) {
    params.scheduled_publish_time = Math.floor(new Date(scheduledPublishTime).getTime() / 1000)
    params.published = false
  }

  const data = await graphPost(`${pageId}/feed`, params)
  return data
}

export async function createInstagramMedia(igBusinessAccountId, mediaUrl, caption, accessToken) {
  const params = {
    access_token: accessToken,
    image_url: mediaUrl,
    caption: caption || '',
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

export async function createInstagramStory(igBusinessAccountId, mediaUrl, accessToken) {
  const params = {
    access_token: accessToken,
    media_type: 'STORIES',
  }

  if (mediaUrl.match(/\.(mp4|mov)$/i)) {
    params.video_url = mediaUrl
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

export async function getCampaignSpend(campaignId, accessToken) {
  const data = await graphGet(campaignId, {
    access_token: accessToken,
    fields: 'spend',
  })
  return data
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
