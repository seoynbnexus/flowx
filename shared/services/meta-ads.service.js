import { META_CONFIG } from './meta-oauth.config.js'

async function graphPost(path, params = {}) {
  const query = new URLSearchParams({ access_token: params.access_token })
  const url = `${META_CONFIG.graphUrl}/${path}?${query.toString()}`

  const body = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (key !== 'access_token') {
      body.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value))
    }
  }

  const res = await fetch(url, { method: 'POST', body: body.toString() })
  if (!res.ok) {
    const error = await res.text()
    throw new Error(`Graph API POST ${path} failed: ${error}`)
  }
  return res.json()
}

async function graphDelete(path, accessToken) {
  const url = `${META_CONFIG.graphUrl}/${path}?access_token=${accessToken}`
  const res = await fetch(url, { method: 'DELETE' })
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
  const res = await fetch(url)
  if (!res.ok) {
    const error = await res.text()
    throw new Error(`Graph API GET ${path} failed: ${error}`)
  }
  return res.json()
}

export async function createAdCampaign(adAccountId, name, objective, status = 'PAUSED', accessToken) {
  const data = await graphPost(`act_${adAccountId}/campaigns`, {
    access_token: accessToken,
    name,
    objective,
    status,
    special_ad_categories: [],
    is_adset_budget_sharing_enabled: false,
  })
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

export async function createAdSet(adAccountId, campaignId, targeting, budget, schedule, placement, accessToken) {
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

  const data = await graphPost(`act_${adAccountId}/adsets`, params)
  return data
}

export async function createAdCreative(adAccountId, pageId, message, mediaUrl, callToAction, accessToken) {
  const objectStorySpec = {
    page_id: pageId,
  }

  if (mediaUrl) {
    objectStorySpec.link_data = {
      link: mediaUrl,
      message: message || '',
      call_to_action: callToAction ? { type: callToAction } : undefined,
    }
  } else {
    objectStorySpec.page_id = pageId
  }

  const params = {
    access_token: accessToken,
    name: `Creative ${Date.now()}`,
    object_story_spec: objectStorySpec,
  }

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

export async function createAd(adAccountId, adSetId, creativeId, name, accessToken, status = 'PAUSED') {
  const data = await graphPost(`act_${adAccountId}/ads`, {
    access_token: accessToken,
    name: name || `Ad ${Date.now()}`,
    adset_id: adSetId,
    creative: { creative_id: creativeId },
    status,
  })
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
