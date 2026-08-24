import { query, queryOne } from '../../../shared/database/connection.js'
import { bufferToUuid } from '../../../shared/utils/uuid.utils.js'

function mapByStatus(rows) {
  const out = {}
  for (const r of rows) out[r.status] = Number(r.cnt)
  return out
}

export async function getClientCampaignStats(clientId) {
  const { uuidToBuffer } = await import('../../../shared/utils/uuid.utils.js')
  const idBuf = uuidToBuffer(clientId)
  const [countRow, statusRows, recentRows] = await Promise.all([
    queryOne('SELECT COUNT(*) as total FROM campaigns WHERE client_id = ? AND deleted_at IS NULL', [idBuf]),
    query('SELECT status, COUNT(*) as cnt FROM campaigns WHERE client_id = ? AND deleted_at IS NULL GROUP BY status', [idBuf]),
    query('SELECT * FROM campaigns WHERE client_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 3', [idBuf]),
  ])
  return {
    total: Number(countRow?.total || 0),
    byStatus: mapByStatus(statusRows),
    recent: recentRows.map(r => ({
      id: bufferToUuid(r.id),
      name: r.name,
      status: r.status,
      type: r.type,
      createdAt: r.created_at,
      scheduledAt: r.scheduled_at,
    })),
  }
}

export async function getClientPostStats(clientId) {
  const { uuidToBuffer } = await import('../../../shared/utils/uuid.utils.js')
  const idBuf = uuidToBuffer(clientId)
  const [countRow, statusRows, recentRows] = await Promise.all([
    queryOne('SELECT COUNT(*) as total FROM posts WHERE client_id = ? AND deleted_at IS NULL', [idBuf]),
    query('SELECT status, COUNT(*) as cnt FROM posts WHERE client_id = ? AND deleted_at IS NULL GROUP BY status', [idBuf]),
    query('SELECT * FROM posts WHERE client_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 3', [idBuf]),
  ])
  return {
    total: Number(countRow?.total || 0),
    byStatus: mapByStatus(statusRows),
    recent: recentRows.map(r => ({
      id: bufferToUuid(r.id),
      name: r.name,
      status: r.status,
      type: r.type,
      createdAt: r.created_at,
    })),
  }
}

export async function getClientWallet(clientId) {
  const { getAvailable } = await import('../../../shared/services/coin.service.js')
  const { total, monthlyRemaining, topupBalance, limit, used } = await getAvailable(clientId)
  return { balance: Number(total) || 0, monthlyRemaining, topupBalance: Number(topupBalance) || 0, limit, used }
}

export async function getClientPostsEngagement(clientId, limit = 10) {
  const { uuidToBuffer } = await import('../../../shared/utils/uuid.utils.js')
  const idBuf = uuidToBuffer(clientId)
  const lim = Math.min(Math.max(Number(limit) || 10, 1), 10)
  const rows = await query(
    `SELECT p.id, p.name, p.status, p.created_at,
            COALESCE(agg.views,0) as views,
            COALESCE(agg.reach,0) as reach,
            COALESCE(agg.likes,0) as likes,
            COALESCE(agg.comments,0) as comments,
            COALESCE(agg.impressions,0) as impressions,
            COALESCE(agg.totalEngagement,0) as totalEngagement
     FROM (SELECT id, name, status, created_at FROM posts WHERE client_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ?) p
     LEFT JOIN (
       SELECT ped.post_id,
              SUM(ped.views) as views, SUM(ped.reach) as reach, SUM(ped.likes) as likes,
              SUM(ped.comments) as comments, SUM(ped.impressions) as impressions,
              SUM(ped.views + ped.reach + ped.likes) as totalEngagement
       FROM post_engagement_daily ped
       INNER JOIN (
         SELECT post_id, target_id, MAX(stat_date) as max_date
         FROM post_engagement_daily
         WHERE post_id IN (SELECT id FROM posts WHERE client_id = ? AND deleted_at IS NULL)
         GROUP BY post_id, target_id
       ) m ON ped.post_id = m.post_id AND ped.target_id = m.target_id AND ped.stat_date = m.max_date
       GROUP BY ped.post_id
     ) agg ON agg.post_id = p.id
     ORDER BY totalEngagement DESC, p.created_at DESC`,
    [idBuf, String(lim), idBuf]
  )
  return rows.map(r => ({
    id: bufferToUuid(r.id),
    name: r.name,
    status: r.status,
    createdAt: r.created_at,
    views: Number(r.views) || 0,
    reach: Number(r.reach) || 0,
    likes: Number(r.likes) || 0,
    comments: Number(r.comments) || 0,
    impressions: Number(r.impressions) || 0,
    totalEngagement: Number(r.totalEngagement) || 0,
  }))
}

export async function getClientEngagementDaily(clientId) {
  const { uuidToBuffer } = await import('../../../shared/utils/uuid.utils.js')
  const idBuf = uuidToBuffer(clientId)
  const rows = await query(
    `SELECT ped.stat_date as date,
            COALESCE(SUM(ped.reach),0) as reach,
            COALESCE(SUM(ped.views),0) as views,
            COALESCE(SUM(ped.impressions),0) as impressions
     FROM post_engagement_daily ped
     JOIN posts p ON p.id = ped.post_id
     WHERE p.client_id = ? AND p.deleted_at IS NULL
       AND ped.stat_date >= DATE_SUB(CURDATE(), INTERVAL 14 DAY)
     GROUP BY ped.stat_date
     ORDER BY ped.stat_date ASC`,
    [idBuf]
  )
  return rows.map(r => ({
    date: r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10),
    reach: Number(r.reach) || 0,
    views: Number(r.views) || 0,
    impressions: Number(r.impressions) || 0,
  }))
}

export async function getClientLifetimeEngagement(clientId) {
  const { uuidToBuffer } = await import('../../../shared/utils/uuid.utils.js')
  const idBuf = uuidToBuffer(clientId)
  const row = await queryOne(
    `SELECT COALESCE(SUM(ped.reach),0) as reach,
            COALESCE(SUM(ped.views),0) as views,
            COALESCE(SUM(ped.likes),0) as likes,
            COALESCE(SUM(ped.comments),0) as comments,
            COALESCE(SUM(ped.impressions),0) as impressions
     FROM post_engagement_daily ped
     INNER JOIN (
       SELECT post_id, target_id, MAX(stat_date) as max_date
       FROM post_engagement_daily
       WHERE post_id IN (SELECT id FROM posts WHERE client_id = ? AND deleted_at IS NULL)
       GROUP BY post_id, target_id
     ) m ON ped.post_id = m.post_id AND ped.target_id = m.target_id AND ped.stat_date = m.max_date
     JOIN posts p ON p.id = ped.post_id
     WHERE p.client_id = ? AND p.deleted_at IS NULL`,
    [idBuf, idBuf]
  )
  return {
    reach: Number(row?.reach || 0),
    views: Number(row?.views || 0),
    likes: Number(row?.likes || 0),
    comments: Number(row?.comments || 0),
    impressions: Number(row?.impressions || 0),
  }
}

export async function getClientSpendDaily(clientId) {
  const { uuidToBuffer } = await import('../../../shared/utils/uuid.utils.js')
  const idBuf = uuidToBuffer(clientId)
  const rows = await query(
    `SELECT cds.stat_date as date, COALESCE(SUM(cds.spend_paise),0) as spendPaise
     FROM campaign_daily_stats cds
     JOIN campaigns c ON c.id = cds.campaign_id
     WHERE c.client_id = ? AND c.deleted_at IS NULL
       AND cds.stat_date >= DATE_SUB(CURDATE(), INTERVAL 14 DAY)
     GROUP BY cds.stat_date
     ORDER BY cds.stat_date ASC`,
    [idBuf]
  )
  return rows.map(r => ({
    date: r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10),
    spendPaise: Number(r.spendPaise) || 0,
  }))
}

export async function getPublisherRequestStats(publisherId) {
  const { uuidToBuffer } = await import('../../../shared/utils/uuid.utils.js')
  const idBuf = uuidToBuffer(publisherId)
  const [campaignRows, postRows] = await Promise.all([
    query('SELECT status, COUNT(*) as cnt FROM campaign_publisher_requests WHERE publisher_id = ? GROUP BY status', [idBuf]),
    query('SELECT status, COUNT(*) as cnt FROM post_publisher_requests WHERE publisher_id = ? GROUP BY status', [idBuf]),
  ])
  return {
    campaigns: mapByStatus(campaignRows),
    posts: mapByStatus(postRows),
  }
}

export async function getPublisherEarnings(publisherId) {
  const { uuidToBuffer } = await import('../../../shared/utils/uuid.utils.js')
  const idBuf = uuidToBuffer(publisherId)
  const [walletRow, lifetimeRow, monthRow] = await Promise.all([
    queryOne('SELECT coins FROM user_wallets WHERE user_id = ?', [idBuf]),
    queryOne("SELECT COALESCE(SUM(amount),0) as total FROM transactions WHERE user_id = ? AND type = 'credit'", [idBuf]),
    queryOne("SELECT COALESCE(SUM(amount),0) as total FROM transactions WHERE user_id = ? AND type = 'credit' AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)", [idBuf]),
  ])
  return {
    currentBalance: walletRow ? Number(walletRow.coins) : 0,
    lifetimeEarned: Number(lifetimeRow?.total || 0),
    thisMonth: Number(monthRow?.total || 0),
  }
}

export async function getPublisherConnectedAccounts(publisherId) {
  const { uuidToBuffer } = await import('../../../shared/utils/uuid.utils.js')
  const row = await queryOne('SELECT COUNT(*) as total FROM user_platform_accounts WHERE user_id = ? AND verification_status = ?', [uuidToBuffer(publisherId), 'verified'])
  return Number(row?.total || 0)
}

export async function getAdminCampaignStats() {
  const [totalRow, statusRows, unsettledRow, failedJobsRow] = await Promise.all([
    queryOne('SELECT COUNT(*) as total FROM campaigns WHERE deleted_at IS NULL'),
    query('SELECT status, COUNT(*) as cnt FROM campaigns WHERE deleted_at IS NULL GROUP BY status'),
    queryOne('SELECT COUNT(*) as total FROM campaigns WHERE charged_ad_budget_paise > 0 AND settled_at IS NULL AND deleted_at IS NULL'),
    queryOne("SELECT COUNT(*) as total FROM campaign_jobs WHERE status IN ('dead','failed')"),
  ])
  return {
    total: Number(totalRow?.total || 0),
    byStatus: mapByStatus(statusRows),
    unsettled: Number(unsettledRow?.total || 0),
    failedJobs: Number(failedJobsRow?.total || 0),
  }
}

export async function getAdminPostStats() {
  const [totalRow, statusRows] = await Promise.all([
    queryOne('SELECT COUNT(*) as total FROM posts WHERE deleted_at IS NULL'),
    query('SELECT status, COUNT(*) as cnt FROM posts WHERE deleted_at IS NULL GROUP BY status'),
  ])
  return {
    total: Number(totalRow?.total || 0),
    byStatus: mapByStatus(statusRows),
  }
}

export async function getAdminPendingQueues() {
  const [platformPending, identityPending] = await Promise.all([
    queryOne("SELECT COUNT(*) as total FROM user_platform_accounts WHERE verification_status = 'pending'"),
    queryOne("SELECT COUNT(*) as total FROM identity_documents WHERE status = 'pending'"),
  ])
  return {
    platformAccounts: Number(platformPending?.total || 0),
    identityDocs: Number(identityPending?.total || 0),
  }
}
