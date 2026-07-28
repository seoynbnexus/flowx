import { META_CONFIG } from './meta-oauth.config.js';
import { apiFetch } from '../utils/api-logger.js'

async function graphGet(path, params = {}) {
  const query = new URLSearchParams({ ...params, access_token: params.access_token });
  const url = `${META_CONFIG.graphUrl}/${path}?${query.toString()}`;
  const res = await apiFetch(url, {}, { service: 'meta_graph', operation: path })
  if (!res.ok) {
    const error = await res.text();
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
