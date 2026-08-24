import * as repo from './dashboard.repository.js'
import { queryOne, query } from '../../../shared/database/connection.js'

const cache = new Map()
const CACHE_TTL_MS = 30 * 1000

function getCached(key) {
  const entry = cache.get(key)
  if (!entry) return null
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    cache.delete(key)
    return null
  }
  return entry.data
}

function setCached(key, data) {
  cache.set(key, { data, ts: Date.now() })
}

export async function getClientDashboard(clientId) {
  const cacheKey = `client:${clientId}`
  const cached = getCached(cacheKey)
  if (cached) return cached

  const [campaigns, posts, wallet, engagementDaily, spendDaily, postsEngagement, lifetime] = await Promise.all([
    repo.getClientCampaignStats(clientId),
    repo.getClientPostStats(clientId),
    repo.getClientWallet(clientId),
    repo.getClientEngagementDaily(clientId),
    repo.getClientSpendDaily(clientId),
    repo.getClientPostsEngagement(clientId, 10),
    repo.getClientLifetimeEngagement(clientId),
  ])

  const totalViews = engagementDaily.reduce((s, d) => s + d.views, 0)
  const totalReach = engagementDaily.reduce((s, d) => s + d.reach, 0)
  const totalSpendPaise = spendDaily.reduce((s, d) => s + d.spendPaise, 0)

  const data = {
    campaigns,
    posts,
    wallet,
    engagement: { daily: engagementDaily, postsEngagement, lifetime, totalViews, totalReach, totalSpendPaise, spendDaily },
  }
  setCached(cacheKey, data)
  return data
}

export async function getPublisherDashboard(publisherId) {
  const cacheKey = `publisher:${publisherId}`
  const cached = getCached(cacheKey)
  if (cached) return cached

  const [earnings, requests, connectedAccounts] = await Promise.all([
    repo.getPublisherEarnings(publisherId),
    repo.getPublisherRequestStats(publisherId),
    repo.getPublisherConnectedAccounts(publisherId),
  ])

  const { getNotifications } = await import('../notifications/notifications.repository.js')
  const recentActivity = await getNotifications(publisherId, 1, 5).catch(() => ({ items: [] }))
  const { getUnreadCountsByType } = await import('../notifications/notifications.repository.js')
  const unreadCounts = await getUnreadCountsByType(publisherId).catch(() => ({ campaign: 0, post: 0, total: 0 }))

  const data = {
    earnings,
    requests,
    accounts: { connected: connectedAccounts },
    recentActivity: recentActivity.items || [],
    unreadCounts,
  }
  setCached(cacheKey, data)
  return data
}

export async function getAdminDashboard() {
  const cacheKey = 'admin:overview'
  const cached = getCached(cacheKey)
  if (cached) return cached

  const [overviewVals, campaignStats, postStats, pendingQueues, walletStats, metaSync] = await Promise.all([
    Promise.all([
      queryOne('SELECT COUNT(*) as count FROM users'),
      queryOne('SELECT COUNT(DISTINCT user_id) as count FROM auth_login_history WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY) AND success = 1'),
      queryOne('SELECT COUNT(*) as count FROM ai_usage_log WHERE was_blocked = 0'),
      queryOne('SELECT COALESCE(SUM(coins_spent), 0) as total FROM ai_usage_log WHERE was_blocked = 0'),
    ]),
    repo.getAdminCampaignStats(),
    repo.getAdminPostStats(),
    repo.getAdminPendingQueues(),
    query('SELECT COUNT(*) as wallet_count, COALESCE(SUM(coins),0) as total_coins FROM user_wallets').then(r => r[0]),
    (async () => {
      try {
        const { getMetaSyncHealth } = await import('../campaigns/campaign.service.js')
        return await getMetaSyncHealth()
      } catch {
        return null
      }
    })(),
  ])

  const [totalUsers, wau, totalAi, totalCoins] = overviewVals

  const data = {
    overview: {
      totalUsers: Number(totalUsers?.count || 0),
      weeklyActiveUsers: Number(wau?.count || 0),
      totalAiGenerations: Number(totalAi?.count || 0),
      totalAiCoinsSpent: Number(totalCoins?.total || 0),
    },
    campaigns: campaignStats,
    posts: postStats,
    pendingQueues,
    wallet: {
      totalCoins: Number(walletStats?.total_coins || 0),
      walletCount: Number(walletStats?.wallet_count || 0),
    },
    metaSync: metaSync ? {
      running: metaSync.runningCount ?? metaSync.running ?? 0,
      failedJobs: metaSync.failedJobs ?? campaignStats.failedJobs,
      rateLimited: metaSync.rateLimited ?? false,
    } : null,
  }
  setCached(cacheKey, data)
  return data
}

export function clearDashboardCache(prefix) {
  if (!prefix) { cache.clear(); return }
  for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k)
}
