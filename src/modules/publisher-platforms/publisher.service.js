import * as repo from './publisher.repository.js';
import { generateUuid } from '../../../shared/utils/uuid.utils.js';
import { NotFoundError, ConflictError, ValidationError } from '../../../shared/errors/AppError.js';
import { ERROR_CODES } from '../../../shared/errors/errorCodes.js';
import { isMetaConfigured } from '../../../shared/services/meta-oauth.config.js';
import { generateOAuthUrl as buildAuthUrl } from '../../../shared/services/meta-auth.service.js';
import { getFacebookPageInsights, getFacebookPagePosts, getInstagramInsights, getInstagramMedia } from '../../../shared/services/meta-graph.service.js';

function extractUsername(platformCode, profileUrl) {
  const url = new URL(profileUrl.startsWith('http') ? profileUrl : `https://${profileUrl}`);
  const path = url.pathname.replace(/\/$/, '');
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] || null;
}

export async function submitAccount(userId, platformCode, profileUrl) {
  const platform = await repo.findPlatformByCode(platformCode);
  if (!platform) {
    throw new NotFoundError('Platform not found');
  }

  if (isMetaConfigured()) {
    throw new ValidationError('Meta OAuth is configured. Please use the OAuth connection flow instead of URL submission.');
  }

  const username = extractUsername(platformCode, profileUrl);

  try {
    const response = await fetch(profileUrl, { method: 'HEAD' });
    if (!response.ok) {
      throw new ValidationError('Profile URL is not reachable');
    }
  } catch {
    throw new ValidationError('Profile URL is not reachable');
  }

  const existing = await repo.findAccountByUserAndPlatform(userId, platform.id);
  if (existing) {
    if (existing.isActive) {
      throw new ConflictError('You already have an account linked for this platform');
    }
    return repo.reactivateAccount(existing.id, profileUrl, username);
  }

  return repo.createAccount(generateUuid(), userId, platform.id, profileUrl, username);
}

export async function listMyAccounts(userId) {
  return repo.listAccountsByUser(userId);
}

export async function removeAccount(userId, accountId) {
  const account = await repo.findAccountById(accountId);
  if (!account || account.userId !== userId) {
    throw new NotFoundError('Account not found');
  }
  await repo.softDeleteAccount(accountId);
}

export async function listAllAccounts(filters) {
  return repo.listAllAccounts(filters);
}

export async function verifyAccount(accountId, status, adminId) {
  const account = await repo.findAccountById(accountId);
  if (!account) {
    throw new NotFoundError('Account not found');
  }
  return repo.verifyAccount(accountId, status, adminId);
}

async function fetchMetricSafe(fetcher, metric) {
  try {
    const result = await fetcher(metric)
    return result
  } catch {
    return []
  }
}

async function fetchMetricsSafe(fetcher, metrics) {
  const results = await Promise.allSettled(
    metrics.map(m => fetchMetricSafe(fetcher, m))
  )
  return results.flatMap(r => (r.status === 'fulfilled' ? r.value : []))
}

function extractMetricValue(insights, metricName) {
  const metric = insights.find(m => m.name === metricName)
  if (!metric || !metric.values || metric.values.length === 0) return null
  return metric.values[metric.values.length - 1]?.value ?? null
}

function extractMetricChange(insights, metricName) {
  const metric = insights.find(m => m.name === metricName)
  if (!metric || !metric.values || metric.values.length < 2) return null
  const current = metric.values[metric.values.length - 1]?.value ?? 0
  const previous = metric.values[0]?.value ?? 0
  if (previous === 0) return null
  return Math.round(((current - previous) / previous) * 100)
}

const FACEBOOK_METRICS = [
  { label: 'Reach', key: 'reach', metric: 'page_impressions_unique' },
  { label: 'Impressions', key: 'impressions', metric: 'page_impressions' },
  { label: 'Engaged Users', key: 'engagement', metric: 'page_engaged_users' },
  { label: 'New Followers', key: 'newFollowers', metric: 'page_fan_adds' },
]

const INSTAGRAM_METRICS = [
  { label: 'Impressions', key: 'impressions', metric: 'impressions' },
  { label: 'Reach', key: 'reach', metric: 'reach' },
  { label: 'Profile Views', key: 'profileViews', metric: 'profile_views' },
  { label: 'Followers', key: 'followers', metric: 'follower_count' },
]

export async function getAccountInsights(accountId) {
  const account = await repo.findAccountById(accountId)
  if (!account) {
    throw new NotFoundError('Account not found')
  }

  if (!account.accessToken || account.tokenStatus !== 'active') {
    throw new NotFoundError('Account token has expired. Ask the publisher to reconnect.')
  }

  const platform = await repo.findPlatformById(account.platformId)
  if (!platform) {
    throw new NotFoundError('Platform not found')
  }

  const platformCode = platform.code
  const token = account.accessToken

  if (platformCode === 'facebook') {
    const pageId = account.platformUserId
    if (!pageId) {
      throw new NotFoundError('Facebook Page ID not found for this account')
    }

    const [rawInsights, posts] = await Promise.all([
      fetchMetricsSafe(
        (m) => getFacebookPageInsights(pageId, token, m, 'days_28'),
        FACEBOOK_METRICS.map(m => m.metric)
      ),
      getFacebookPagePosts(pageId, token).catch(() => []),
    ])

    const metrics = FACEBOOK_METRICS.map(({ label, key, metric }) => ({
      label,
      key,
      value: extractMetricValue(rawInsights, metric) ?? 0,
      change: extractMetricChange(rawInsights, metric),
    }))

    const followers = account.followersCount || 0

    const recentPosts = posts.map(post => ({
      id: post.id,
      caption: post.message || null,
      mediaUrl: null,
      permalink: null,
      timestamp: post.created_time,
      likes: post.likes?.summary?.total_count ?? 0,
      comments: post.comments?.summary?.total_count ?? 0,
      shares: post.shares?.count ?? 0,
    }))

    return {
      platform: 'facebook',
      username: account.platformUsername,
      displayName: account.platformDisplayName,
      avatarUrl: account.avatarUrl,
      followers,
      metrics,
      recentPosts,
    }
  }

  if (platformCode === 'instagram') {
    const igBusinessId = account.platformUserId
    if (!igBusinessId) {
      throw new NotFoundError('Instagram Business Account ID not found for this account')
    }

    const [rawInsights, media] = await Promise.all([
      fetchMetricsSafe(
        (m) => getInstagramInsights(igBusinessId, token, m),
        INSTAGRAM_METRICS.map(m => m.metric)
      ),
      getInstagramMedia(igBusinessId, token, 5).catch(() => []),
    ])

    const metrics = INSTAGRAM_METRICS.map(({ label, key, metric }) => ({
      label,
      key,
      value: extractMetricValue(rawInsights, metric) ?? 0,
      change: metric === 'follower_count' ? null : extractMetricChange(rawInsights, metric),
    }))

    const followers = extractMetricValue(rawInsights, 'follower_count') ?? (account.followersCount || 0)

    const recentPosts = media.map(item => ({
      id: item.id,
      caption: item.caption || null,
      mediaUrl: item.media_url || null,
      permalink: item.permalink || null,
      timestamp: item.timestamp,
      likes: item.like_count ?? 0,
      comments: item.comments_count ?? 0,
      shares: null,
    }))

    return {
      platform: 'instagram',
      username: account.platformUsername,
      displayName: account.platformDisplayName,
      avatarUrl: account.avatarUrl,
      followers,
      metrics,
      recentPosts,
    }
  }

  throw new NotFoundError(`Unsupported platform: ${platformCode}`)
}
