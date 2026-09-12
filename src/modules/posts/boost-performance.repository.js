import { query, queryOne } from '../../../shared/database/connection.js'
import { uuidToBuffer, bufferToUuid, generateUuid } from '../../../shared/utils/uuid.utils.js'

function mapBoostDailyRow(row) {
  if (!row) return null
  const actions = typeof row.actions === 'string' ? safeParseJson(row.actions) : (row.actions || null)
  const costPerActionType = typeof row.cost_per_action_type === 'string' ? safeParseJson(row.cost_per_action_type) : (row.cost_per_action_type || null)
  return {
    id: bufferToUuid(row.id),
    postId: bufferToUuid(row.post_id),
    postTargetId: bufferToUuid(row.post_target_id),
    statDate: row.stat_date instanceof Date ? row.stat_date.toISOString().slice(0, 10) : String(row.stat_date || '').slice(0, 10),
    impressions: Number(row.impressions) || 0,
    reach: Number(row.reach) || 0,
    frequency: Number(row.frequency) || 0,
    clicks: Number(row.clicks) || 0,
    uniqueClicks: Number(row.unique_clicks) || 0,
    ctr: Number(row.ctr) || 0,
    cpc: Number(row.cpc) || 0,
    cpm: Number(row.cpm) || 0,
    spendPaise: Number(row.spend_paise) || 0,
    actions,
    costPerActionType,
    lastSource: row.last_source || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function safeParseJson(value) {
  try { return value ? JSON.parse(value) : null } catch { return null }
}

/**
 * Single canonical resolver for boost Meta object ids -> PostTarget.
 *
 * Checks promotion mappings first (newer architecture), then legacy
 * post_boost_targets. Every promotion target is 1:1 with a post target, and
 * post_boost_targets.object_id is globally UNIQUE, so one lookup round
 * (chunked x100 like findCampaignIdsByFbObjectIds) covers campaign, adset,
 * creative and ad ids — webhook events arrive at any of these levels.
 *
 * Returns Map<metaId, { postTargetId, postId, path, promotionTargetId? }>.
 * Never creates rows: an unresolvable id is simply absent from the map and
 * the caller (webhook / fan-out) treats it as ignorable.
 */
export async function resolveBoostObjectRefs(metaIds) {
  const ids = [...new Set((metaIds || []).map(String).filter(Boolean))]
  const map = new Map()
  if (!ids.length) return map
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100)
    const placeholders = chunk.map(() => '?').join(', ')
    const promoRows = await query(
      `SELECT ptgt.id AS ptgt_id, ptgt.post_target_id, pt.post_id,
              ptgt.platform_campaign_id, ptgt.platform_adset_id,
              ptgt.platform_creative_id, ptgt.platform_ad_id
         FROM promotion_targets ptgt
         JOIN post_targets pt ON pt.id = ptgt.post_target_id
        WHERE ptgt.platform_campaign_id IN (${placeholders})
           OR ptgt.platform_adset_id IN (${placeholders})
           OR ptgt.platform_creative_id IN (${placeholders})
           OR ptgt.platform_ad_id IN (${placeholders})`,
      [...chunk, ...chunk, ...chunk, ...chunk]
    )
    for (const row of promoRows) {
      // each platform_*_id is globally UNIQUE, so any of them maps to this ref
      const ids = [row.platform_campaign_id, row.platform_adset_id, row.platform_creative_id, row.platform_ad_id]
      for (const fbId of ids) {
        if (fbId && !map.has(String(fbId))) {
          map.set(String(fbId), {
            postTargetId: bufferToUuid(row.post_target_id),
            postId: bufferToUuid(row.post_id),
            path: 'promotion',
            promotionTargetId: bufferToUuid(row.ptgt_id),
            fbCampaignId: row.platform_campaign_id ? String(row.platform_campaign_id) : null,
          })
        }
      }
    }
    const legacyRows = await query(
      `SELECT pbt.object_id, pbt.post_target_id, pbt.post_id
         FROM post_boost_targets pbt
        WHERE pbt.object_id IN (${placeholders})`,
      chunk
    )
    for (const row of legacyRows) {
      const fbId = String(row.object_id)
      // promotion-first: a target with both mappings resolves to promotion
      if (!map.has(fbId)) {
        map.set(fbId, {
          postTargetId: bufferToUuid(row.post_target_id),
          postId: bufferToUuid(row.post_id),
          path: 'legacy',
          promotionTargetId: null,
          fbCampaignId: null,
        })
      }
    }
  }
  return map
}

function buildUpsertArgs(postId, postTargetId, statDate, data) {
  // spend within a stat_date bucket must stay monotonic: webhook amounts are
  // daily-cumulative for that date, and Insights daily rows lag real-time by
  // ~3h, so a later lagging value must never lower a fresher number.
  // All other metrics REPLACE — Insights is the complete (only) source.
  return [
    uuidToBuffer(generateUuid()),
    uuidToBuffer(postId),
    uuidToBuffer(postTargetId),
    statDate,
    data.impressions ?? 0,
    data.reach ?? 0,
    data.frequency ?? 0,
    data.clicks ?? 0,
    data.uniqueClicks ?? 0,
    data.ctr ?? 0,
    data.cpc ?? 0,
    data.cpm ?? 0,
    data.spendPaise ?? 0,
    data.actions !== undefined ? JSON.stringify(data.actions ?? {}) : null,
    data.costPerActionType !== undefined ? JSON.stringify(data.costPerActionType ?? {}) : null,
    data.lastSource || 'insights',
  ]
}

/**
 * Full-metrics upsert (Insights reconciliation writer). Idempotent: the same
 * report payload twice yields identical rows — countables REPLACE, spend is
 * monotonic, actions JSON is overwritten wholesale.
 */
export async function upsertBoostDailyStat({ postId, postTargetId, statDate, impressions, reach, frequency, clicks, uniqueClicks, ctr, cpc, cpm, spendPaise, actions, costPerActionType }) {
  const args = buildUpsertArgs(postId, postTargetId, statDate, {
    impressions, reach, frequency, clicks, uniqueClicks, ctr, cpc, cpm, spendPaise,
    actions, costPerActionType, lastSource: 'insights',
  })
  await query(
    `INSERT INTO post_boost_daily_stats
       (id, post_id, post_target_id, stat_date, impressions, reach, frequency, clicks, unique_clicks, ctr, cpc, cpm, spend_paise, actions, cost_per_action_type, last_source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       impressions = VALUES(impressions),
       reach = VALUES(reach),
       frequency = VALUES(frequency),
       clicks = VALUES(clicks),
       unique_clicks = VALUES(unique_clicks),
       ctr = VALUES(ctr),
       cpc = VALUES(cpc),
       cpm = VALUES(cpm),
       spend_paise = GREATEST(spend_paise, VALUES(spend_paise)),
       actions = VALUES(actions),
       cost_per_action_type = VALUES(cost_per_action_type),
       last_source = VALUES(last_source)`,
    args
  )
}

/**
 * Spend-only upsert (webhook fast-path writer). Never touches the other
 * metric columns; GREATEST keeps the bucket monotonic so duplicate or
 * out-of-order delivery can never double-count or decrease the day's spend.
 */
export async function upsertBoostSpendOnly(postId, postTargetId, statDate, spendPaise) {
  const id = generateUuid()
  await query(
    `INSERT INTO post_boost_daily_stats (id, post_id, post_target_id, stat_date, spend_paise, last_source)
     VALUES (?, ?, ?, ?, ?, 'webhook')
     ON DUPLICATE KEY UPDATE
       spend_paise = GREATEST(spend_paise, VALUES(spend_paise)),
       last_source = VALUES(last_source)`,
    [uuidToBuffer(id), uuidToBuffer(postId), uuidToBuffer(postTargetId), statDate, spendPaise]
  )
}

const BOOST_STATS_CHUNK = 500

/**
 * Genuinely bulk boost daily-stats upsert: one multi-row INSERT ... ON
 * DUPLICATE KEY UPDATE per bounded chunk (≤500 rows). Same semantics as
 * upsertBoostDailyStat (metrics REPLACE, spend monotonic via GREATEST).
 * `rows` entries carry { postId, postTargetId, statDate, ... }.
 */
export async function upsertBoostDailyStatsBulk(rows) {
  const list = (rows || []).filter(r => r && r.statDate && r.postTargetId)
  if (!list.length) return 0
  let written = 0
  for (let offset = 0; offset < list.length; offset += BOOST_STATS_CHUNK) {
    const chunk = list.slice(offset, offset + BOOST_STATS_CHUNK)
    const placeholders = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')
    const params = []
    for (const r of chunk) {
      params.push(
        uuidToBuffer(generateUuid()),
        uuidToBuffer(r.postId),
        uuidToBuffer(r.postTargetId),
        r.statDate,
        r.impressions ?? 0,
        r.reach ?? 0,
        r.frequency ?? 0,
        r.clicks ?? 0,
        r.uniqueClicks ?? 0,
        r.ctr ?? 0,
        r.cpc ?? 0,
        r.cpm ?? 0,
        r.spendPaise ?? 0,
        JSON.stringify(r.actions ?? {}),
        JSON.stringify(r.costPerActionType ?? {}),
        'insights'
      )
    }
    await query(
      `INSERT INTO post_boost_daily_stats
         (id, post_id, post_target_id, stat_date, impressions, reach, frequency, clicks, unique_clicks, ctr, cpc, cpm, spend_paise, actions, cost_per_action_type, last_source)
       VALUES ${placeholders}
       ON DUPLICATE KEY UPDATE
         impressions = VALUES(impressions),
         reach = VALUES(reach),
         frequency = VALUES(frequency),
         clicks = VALUES(clicks),
         unique_clicks = VALUES(unique_clicks),
         ctr = VALUES(ctr),
         cpc = VALUES(cpc),
         cpm = VALUES(cpm),
         spend_paise = GREATEST(spend_paise, VALUES(spend_paise)),
         actions = VALUES(actions),
         cost_per_action_type = VALUES(cost_per_action_type),
         last_source = VALUES(last_source)`,
      params
    )
    written += chunk.length
  }
  return written
}

export async function findBoostDailyStatsByPostId(postId) {
  const rows = await query(
    `SELECT s.*,
            pt.target_type, pt.platform_account_id, pt.status AS target_status
       FROM post_boost_daily_stats s
       JOIN post_targets pt ON pt.id = s.post_target_id
      WHERE s.post_id = ?
      ORDER BY s.post_target_id ASC, s.stat_date ASC`,
    [uuidToBuffer(postId)]
  )
  return rows.map(mapBoostDailyRow)
}

export async function stampBoostSyncAt(postTargetIds) {
  if (!postTargetIds.length) return
  const placeholders = postTargetIds.map(() => '?').join(', ')
  await query(
    `UPDATE post_targets SET last_boost_sync_at = NOW() WHERE id IN (${placeholders})`,
    postTargetIds.map(uuidToBuffer)
  )
}

export async function stampBoostWebhookAt(postTargetId) {
  await query('UPDATE post_targets SET last_boost_webhook_at = NOW() WHERE id = ?', [uuidToBuffer(postTargetId)])
}

export async function resetBoostSyncForPost(postId) {
  const rows = await query(
    `SELECT DISTINCT pt.id FROM post_targets pt
      WHERE pt.post_id = ?
        AND (
          EXISTS (SELECT 1 FROM post_boost_targets pbt
                   WHERE pbt.post_target_id = pt.id AND pbt.object_type = 'facebook_campaign')
          OR EXISTS (SELECT 1 FROM promotion_targets ptgt
                      WHERE ptgt.post_target_id = pt.id AND ptgt.platform_campaign_id IS NOT NULL)
        )`,
    [uuidToBuffer(postId)]
  )
  if (!rows.length) return 0
  await query(
    `UPDATE post_targets SET last_boost_sync_at = NULL WHERE id IN (${rows.map(() => '?').join(', ')})`,
    rows.map(r => r.id)
  )
  return rows.length
}

/**
 * Due targets for the Insights reconciliation batch. A target is due when its
 * boost mapping exists (successfully-created Meta campaign only — never
 * scheduled/unpublished targets) AND:
 *   - never synced, or
 *   - sync is older than the fallback cadence (webhook-stale), or
 *   - webhook-healthy (a relevant webhook landed within freshSeconds) and
 *     sync is older than the healthy cadence.
 * Health is derived from the per-target last_boost_webhook_at timestamp,
 * never from last_source. Optional forcePostId bypasses staleness (manual
 * refresh). Bounded, ordered oldest-first, excludes posts with a queued or
 * running boost-performance job.
 */
export async function findDueBoostPerformanceTargets({
  fallbackSeconds = 3600,
  healthySeconds = 21600,
  freshSeconds = 21600,
  forcePostId = null,
  limit = 100,
} = {}) {
  const fallback = Math.max(60, Math.floor(Number(fallbackSeconds) || 3600))
  const healthy = Math.max(60, Math.floor(Number(healthySeconds) || 21600))
  const fresh = Math.max(60, Math.floor(Number(freshSeconds) || 21600))
  const lim = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)))
  const params = []
  let forceClause = ''
  if (forcePostId) {
    forceClause = 'OR pt.post_id = ?'
    params.push(uuidToBuffer(forcePostId))
  }
  const rows = await query(
    `SELECT DISTINCT pt.id AS target_id, pt.post_id, pt.target_type,
            pt.platform_account_id, pt.status AS target_status,
            pt.last_boost_sync_at, pt.last_boost_webhook_at
       FROM post_targets pt
       JOIN posts p ON p.id = pt.post_id
      WHERE pt.status = 'posted'
        AND p.status NOT IN ('cancelled', 'failed', 'draft')
        AND (
          EXISTS (SELECT 1 FROM post_boost_targets pbt
                   WHERE pbt.post_target_id = pt.id AND pbt.object_type = 'facebook_campaign')
          OR EXISTS (SELECT 1 FROM promotion_targets ptgt
                      WHERE ptgt.post_target_id = pt.id AND ptgt.platform_campaign_id IS NOT NULL)
        )
        AND (
          pt.last_boost_sync_at IS NULL
          OR (
            pt.last_boost_webhook_at IS NOT NULL
            AND pt.last_boost_webhook_at >= DATE_SUB(NOW(), INTERVAL ${fresh} SECOND)
            AND pt.last_boost_sync_at < DATE_SUB(NOW(), INTERVAL ${healthy} SECOND)
          )
          OR (
            (pt.last_boost_webhook_at IS NULL OR pt.last_boost_webhook_at < DATE_SUB(NOW(), INTERVAL ${fresh} SECOND))
            AND pt.last_boost_sync_at < DATE_SUB(NOW(), INTERVAL ${fallback} SECOND)
          )
          ${forceClause}
        )
        AND NOT EXISTS (
          SELECT 1 FROM campaign_jobs j
          WHERE j.campaign_id = pt.post_id AND j.job_type = 'post_sync_boost_performance' AND j.status IN ('queued', 'running')
        )
      ORDER BY pt.last_boost_sync_at ASC
      LIMIT ${lim}`,
    params
  )
  return rows.map(r => ({
    postTargetId: bufferToUuid(r.target_id),
    postId: bufferToUuid(r.post_id),
    targetType: r.target_type,
    platformAccountId: r.platform_account_id ? bufferToUuid(r.platform_account_id) : null,
    targetStatus: r.target_status,
    lastBoostSyncAt: r.last_boost_sync_at || null,
    lastBoostWebhookAt: r.last_boost_webhook_at || null,
  }))
}

/**
 * Publisher owner identity for a mapping row. Only publisher targets carry
 * publisher_request_id (NULL for client targets) → identity fields are null
 * for client-owned targets by construction.
 */
function publisherIdentity(row) {
  const name = [row.publisher_first_name, row.publisher_last_name].filter(Boolean).join(' ').trim()
  return {
    publisherName: name || null,
    publisherEmail: row.publisher_email || null,
  }
}

/**
 * Boost mappings for a post's targets: latest facebook_campaign object per
 * target for each path. A mapping means "Meta boost successfully created" —
 * the performance read model is built from exactly this set (no fabricated
 * rows for scheduled/unpublished/failed-before-creation targets).
 * Promotion mapping wins when a target somehow has both (newer architecture).
 */
export async function findBoostMappingsByPostId(postId) {
  const promoRows = await query(
    `SELECT ptgt.id AS ptgt_id, ptgt.post_target_id, ptgt.platform,
            ptgt.status AS ptgt_status, ptgt.platform_campaign_id AS fb_campaign_id,
            ptgt.platform_adset_id AS fb_adset_id, ptgt.platform_creative_id AS fb_creative_id,
            ptgt.platform_ad_id AS fb_ad_id, ptgt.error AS ptgt_error,
            pt.target_type, pt.platform_account_id, pt.status AS target_status,
            pt.last_boost_sync_at, pt.last_boost_webhook_at,
            upa.platform_user_id, upa.platform_display_name, upa.platform_username,
            pl.code AS platform_code,
            pubu.email AS publisher_email, pubp.first_name AS publisher_first_name,
            pubp.last_name AS publisher_last_name
       FROM promotion_targets ptgt
       JOIN post_targets pt ON pt.id = ptgt.post_target_id
       LEFT JOIN user_platform_accounts upa ON upa.id = pt.platform_account_id
       LEFT JOIN platforms pl ON pl.id = upa.platform_id
       LEFT JOIN post_publisher_requests ppr ON ppr.id = pt.publisher_request_id
       LEFT JOIN users pubu ON pubu.id = ppr.publisher_id
       LEFT JOIN user_profiles pubp ON pubp.user_id = pubu.id
      WHERE pt.post_id = ? AND ptgt.platform_campaign_id IS NOT NULL`,
    [uuidToBuffer(postId)]
  )
  const byTarget = new Map()
  for (const row of promoRows) {
    byTarget.set(bufferToUuid(row.post_target_id), {
      path: 'promotion',
      promotionTargetId: bufferToUuid(row.ptgt_id),
      postTargetId: bufferToUuid(row.post_target_id),
      platform: row.platform || row.platform_code || null,
      platformCode: row.platform_code || row.platform || null,
      platformUserId: row.platform_user_id || null,
      platformDisplayName: row.platform_display_name || null,
      platformUsername: row.platform_username || null,
      boostStatus: row.ptgt_status || null,
      error: row.ptgt_error || null,
      fbCampaignId: row.fb_campaign_id || null,
      fbAdsetId: row.fb_adset_id || null,
      fbCreativeId: row.fb_creative_id || null,
      fbAdId: row.fb_ad_id || null,
      targetType: row.target_type || null,
      targetStatus: row.target_status || null,
      lastBoostSyncAt: row.last_boost_sync_at || null,
      lastBoostWebhookAt: row.last_boost_webhook_at || null,
      ...publisherIdentity(row),
    })
  }
  const legacyRows = await query(
    `SELECT pbt.post_target_id, pbt.object_type, pbt.object_id, pbt.status AS obj_status,
            pbt.boost_status, pbt.created_at,
            pt.target_type, pt.platform_account_id, pt.status AS target_status,
            pt.last_boost_sync_at, pt.last_boost_webhook_at,
            upa.platform_user_id, upa.platform_display_name, upa.platform_username,
            pl.code AS platform_code,
            pubu.email AS publisher_email, pubp.first_name AS publisher_first_name,
            pubp.last_name AS publisher_last_name
       FROM post_boost_targets pbt
       JOIN post_targets pt ON pt.id = pbt.post_target_id
       LEFT JOIN user_platform_accounts upa ON upa.id = pt.platform_account_id
       LEFT JOIN platforms pl ON pl.id = upa.platform_id
       LEFT JOIN post_publisher_requests ppr ON ppr.id = pt.publisher_request_id
       LEFT JOIN users pubu ON pubu.id = ppr.publisher_id
       LEFT JOIN user_profiles pubp ON pubp.user_id = pubu.id
      WHERE pbt.post_id = ? AND pbt.object_type = 'facebook_campaign'
      ORDER BY pbt.created_at DESC`,
    [uuidToBuffer(postId)]
  )
  const legacyByTarget = new Map()
  for (const row of legacyRows) {
    const key = bufferToUuid(row.post_target_id)
    if (byTarget.has(key) || legacyByTarget.has(key)) continue
    legacyByTarget.set(key, {
      path: 'legacy',
      promotionTargetId: null,
      postTargetId: key,
      platform: row.platform_code || null,
      platformCode: row.platform_code || null,
      platformUserId: row.platform_user_id || null,
      platformDisplayName: row.platform_display_name || null,
      platformUsername: row.platform_username || null,
      boostStatus: row.boost_status || null,
      error: null,
      fbCampaignId: row.object_id || null,
      fbAdsetId: null,
      fbCreativeId: null,
      fbAdId: null,
      targetType: row.target_type || null,
      targetStatus: row.target_status || null,
      lastBoostSyncAt: row.last_boost_sync_at || null,
      lastBoostWebhookAt: row.last_boost_webhook_at || null,
      ...publisherIdentity(row),
    })
  }
  for (const [key, value] of legacyByTarget) byTarget.set(key, value)
  const adRows = await query(
    `SELECT post_target_id, object_type, object_id FROM post_boost_targets
      WHERE post_id = ? AND object_type IN ('ad_set', 'ad_creative', 'ad')`,
    [uuidToBuffer(postId)]
  )
  const adByTarget = {}
  for (const row of adRows) {
    const key = bufferToUuid(row.post_target_id)
    if (!adByTarget[key]) adByTarget[key] = {}
    if (row.object_type === 'ad_set' && !adByTarget[key].fbAdsetId) adByTarget[key].fbAdsetId = row.object_id
    if (row.object_type === 'ad_creative' && !adByTarget[key].fbCreativeId) adByTarget[key].fbCreativeId = row.object_id
    if (row.object_type === 'ad' && !adByTarget[key].fbAdId) adByTarget[key].fbAdId = row.object_id
  }
  for (const [key, value] of byTarget) {
    if (value.path === 'legacy' && adByTarget[key]) {
      value.fbAdsetId = value.fbAdsetId || adByTarget[key].fbAdsetId || null
      value.fbCreativeId = value.fbCreativeId || adByTarget[key].fbCreativeId || null
      value.fbAdId = value.fbAdId || adByTarget[key].fbAdId || null
    }
  }
  return [...byTarget.values()]
}

/**
 * fb campaign id per post target for a set of target ids: latest
 * facebook_campaign mapping per target. Promotion mapping wins when a target
 * somehow carries both (newer architecture). Returned as
 * { postTargetId: fbCampaignId }.
 */
export async function findBoostCampaignIdsByTargets(postTargetIds) {
  const ids = [...new Set((postTargetIds || []).filter(Boolean))]
  if (!ids.length) return {}
  const placeholders = ids.map(() => '?').join(', ')
  const promoRows = await query(
    `SELECT post_target_id, platform_campaign_id FROM promotion_targets
      WHERE post_target_id IN (${placeholders}) AND platform_campaign_id IS NOT NULL`,
    ids.map(uuidToBuffer)
  )
  const result = {}
  for (const row of promoRows) {
    result[bufferToUuid(row.post_target_id)] = String(row.platform_campaign_id)
  }
  const legacyRows = await query(
    `SELECT post_target_id, object_id FROM post_boost_targets
      WHERE post_target_id IN (${placeholders}) AND object_type = 'facebook_campaign'
      ORDER BY created_at DESC`,
    ids.map(uuidToBuffer)
  )
  for (const row of legacyRows) {
    const key = bufferToUuid(row.post_target_id)
    if (!result[key]) result[key] = String(row.object_id)
  }
  return result
}

/**
 * Earliest Meta campaign-mapping creation time across a set of post targets —
 * used as the Insights `since` for the first (historical) reconciliation,
 * bounded by the caller to at most 90 days back.
 */
export async function findEarliestBoostMappingAt(postTargetIds) {
  if (!postTargetIds.length) return null
  const placeholders = postTargetIds.map(() => '?').join(', ')
  const row = await queryOne(
    `SELECT MIN(created_at) AS earliest FROM (
       SELECT pbt.created_at AS created_at FROM post_boost_targets pbt
        WHERE pbt.post_target_id IN (${placeholders}) AND pbt.object_type = 'facebook_campaign'
       UNION ALL
       SELECT ptgt.created_at AS created_at FROM promotion_targets ptgt
        WHERE ptgt.post_target_id IN (${placeholders}) AND ptgt.platform_campaign_id IS NOT NULL
     ) t`,
    [...postTargetIds.map(uuidToBuffer), ...postTargetIds.map(uuidToBuffer)]
  )
  return row?.earliest || null
}
