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

async function graphGet(path, params = {}) {
  const query = new URLSearchParams({ ...params, access_token: params.access_token })
  const url = `${META_CONFIG.graphUrl}/${path}?${query.toString()}`
  const res = await fetch(url)
  if (!res.ok) {
    const error = await res.text()
    throw new Error(`Graph API GET ${path} failed: ${error}`)
  }
  return res.json()
}

export async function createAdCampaign(adAccountId, name, objective, status = 'PAUSED', accessToken) {
  const data = await graphPost(`${adAccountId}/campaigns`, {
    access_token: accessToken,
    name,
    objective,
    status,
    special_ad_categories: [],
  })
  return data
}

export async function createAdSet(adAccountId, campaignId, targeting, budget, schedule, placement, accessToken) {
  const params = {
    access_token: accessToken,
    name: `Ad Set ${campaignId.substring(0, 8)}`,
    campaign_id: campaignId,
    daily_budget: budget.budgetType === 'daily' ? Math.round(budget.budgetAmount * 100) : undefined,
    lifetime_budget: budget.budgetType === 'lifetime' ? Math.round(budget.budgetAmount * 100) : undefined,
    bid_strategy: budget.bidStrategy || 'LOWEST_COST_WITHOUT_CAP',
    optimization_goal: budget.optimizationGoal || 'REACH',
    targeting: targeting,
    status: 'PAUSED',
  }

  if (schedule.startTime) params.start_time = schedule.startTime
  if (schedule.endTime) params.end_time = schedule.endTime

  if (placement) {
    params.publisher_platforms = placement.publisherPlatforms || ['facebook', 'instagram']
    if (placement.feedPositions) params.feed_positions = placement.feedPositions
    if (placement.instagramPositions) params.instagram_positions = placement.instagramPositions
  }

  const data = await graphPost(`${adAccountId}/adsets`, params)
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
    degrees_of_freedom_spec: { creative_features_spec: { standard_enhancements: { enroll_status: 'OPT_IN' } } },
  }

  const data = await graphPost(`${adAccountId}/adcreatives`, params)
  return data
}

export async function createAd(adAccountId, adSetId, creativeId, name, accessToken, status = 'PAUSED') {
  const data = await graphPost(`${adAccountId}/ads`, {
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
  const data = await graphGet(adAccountId, {
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
