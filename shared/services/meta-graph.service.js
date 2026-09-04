import { META_CONFIG } from './meta-oauth.config.js';
import { apiFetch } from '../utils/api-logger.js'
import { recordUsage, setCooldown, tokenKeyFor } from './meta-rate-limiter.js'

const RATE_LIMIT_CODES = new Set([80004, 613, 4, 17])
const RATE_LIMIT_SUBCODE = 2446079

async function maybeCooldown(res, errorText, key) {
  if (res.status === 429) {
    setCooldown(120, key)
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
    setCooldown(120, key)
  }
}

async function graphGet(path, params = {}) {
  const query = new URLSearchParams({ ...params, access_token: params.access_token });
  const url = `${META_CONFIG.graphUrl}/${path}?${query.toString()}`;
  const key = tokenKeyFor(params.access_token)
  const res = await apiFetch(url, {}, { service: 'meta_graph', operation: path })
  recordUsage(res.headers, key)
  if (!res.ok) {
    const error = await res.text();
    await maybeCooldown(res, error, key)
    throw new Error(`Graph API GET ${path} failed: ${error}`);
  }
  return res.json();
}

export async function getFacebookPages(userToken) {
  const data = await graphGet('me/accounts', {
    access_token: userToken,
    fields: 'id,name,access_token,picture',
  });
  return data.data || [];
}

export async function getInstagramBusinessAccount(pageId, pageToken) {
  const data = await graphGet(pageId, {
    access_token: pageToken,
    fields: 'instagram_business_account{id,username,name,profile_picture_url,followers_count,media_count}',
  });
  return data.instagram_business_account || null;
}

export async function getInstagramProfile(igBusinessId, token) {
  const data = await graphGet(igBusinessId, {
    access_token: token,
    fields: 'id,username,name,profile_picture_url,followers_count,media_count',
  });
  return data;
}

export async function getMe(userToken) {
  const data = await graphGet('me', {
    access_token: userToken,
    fields: 'id,name,picture',
  });
  return data;
}

export async function getInstagramMedia(igBusinessId, token, limit = 25) {
  const data = await graphGet(`${igBusinessId}/media`, {
    access_token: token,
    fields: 'id,caption,media_type,media_url,permalink,timestamp,like_count,comments_count',
    limit: String(limit),
  });
  return data.data || [];
}

export async function getInstagramInsights(igBusinessId, token, metric = 'impressions,reach,profile_views,follower_count') {
  const data = await graphGet(`${igBusinessId}/insights`, {
    access_token: token,
    metric,
    period: 'day',
  });
  return data.data || [];
}

export async function getMediaInsights(mediaId, token, metric = 'impressions,reach,engagement') {
  const data = await graphGet(`${mediaId}/insights`, {
    access_token: token,
    metric,
  });
  return data.data || [];
}

export async function getPageDetails(pageId, pageToken) {
  const data = await graphGet(pageId, {
    access_token: pageToken,
    fields: 'id,name,about,followers_count,picture{url},website,username',
  })
  return data
}

export async function getFacebookPageInsights(pageId, pageToken, metric, period = 'days_28') {
  const data = await graphGet(`${pageId}/insights`, {
    access_token: pageToken,
    metric,
    period,
  })
  return data.data || []
}

export async function getFacebookPagePosts(pageId, pageToken, limit = 5) {
  const data = await graphGet(`${pageId}/feed`, {
    access_token: pageToken,
    fields: 'id,message,created_time,likes.summary(true),comments.summary(true),shares',
    limit: String(limit),
  })
  return data.data || []
}

export async function getPageAccessToken(pageId, userToken) {
  const data = await graphGet(pageId, {
    access_token: userToken,
    fields: 'access_token',
  });
  return data.access_token || null;
}

export async function getUserBusinesses(userToken) {
  const data = await graphGet('me/businesses', {
    access_token: userToken,
    fields: 'id,name',
  });
  return data.data || [];
}

export async function getBusinessOwnedPages(businessId, userToken) {
  const data = await graphGet(`${businessId}/owned_pages`, {
    access_token: userToken,
    fields: 'id,name,picture,access_token',
  });
  return data.data || [];
}

export async function getBusinessClientPages(businessId, userToken) {
  const data = await graphGet(`${businessId}/client_pages`, {
    access_token: userToken,
    fields: 'id,name,picture,access_token',
  });
  return data.data || [];
}

export async function getBusinessOwnedInstagramAccounts(businessId, userToken) {
  const data = await graphGet(`${businessId}/owned_instagram_accounts`, {
    access_token: userToken,
    fields: 'instagram_business_account{id,username,name,profile_picture_url,followers_count}',
  });
  return data.data?.map(item => item.instagram_business_account).filter(Boolean) || [];
}

export async function getBusinessClientInstagramAccounts(businessId, userToken) {
  const data = await graphGet(`${businessId}/client_instagram_accounts`, {
    access_token: userToken,
    fields: 'instagram_business_account{id,username,name,profile_picture_url,followers_count}',
  });
  return data.data?.map(item => item.instagram_business_account).filter(Boolean) || [];
}

function extractIgBusinessId(data) {
  if (data?.instagram_business_account?.id) {
    return data.instagram_business_account.id;
  }
  return null;
}

export { extractIgBusinessId };

export async function subscribePage(pageId, pageToken, fields = ['feed']) {
  const { apiFetch } = await import('../utils/api-logger.js')
  const { META_CONFIG } = await import('./meta-oauth.config.js')
  const url = `${META_CONFIG.graphUrl}/${pageId}/subscribed_apps?access_token=${pageToken}`
  const body = new URLSearchParams({ subscribed_fields: fields.join(',') })
  const res = await apiFetch(url, { method: 'POST', body: body.toString() }, { service: 'meta_graph', operation: `POST ${pageId}/subscribed_apps` })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Subscribe page ${pageId} failed: ${err}`)
  }
  return res.json()
}

export async function subscribeInstagram(igUserId, accessToken, fields = ['comments', 'story_insights', 'mentions']) {
  const { apiFetch } = await import('../utils/api-logger.js')
  const { META_CONFIG } = await import('./meta-oauth.config.js')
  const url = `${META_CONFIG.graphUrl}/${igUserId}/subscribed_apps?access_token=${accessToken}`
  const body = new URLSearchParams({ subscribed_fields: fields.join(',') })
  const res = await apiFetch(url, { method: 'POST', body: body.toString() }, { service: 'meta_graph', operation: `POST ${igUserId}/subscribed_apps` })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Subscribe Instagram ${igUserId} failed: ${err}`)
  }
  return res.json()
}

export async function getSubscribedApps(objectId, accessToken) {
  const data = await graphGet(`${objectId}/subscribed_apps`, { access_token: accessToken })
  return data.data || []
}
