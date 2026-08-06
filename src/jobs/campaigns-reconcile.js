import dotenv from 'dotenv'
dotenv.config()

import { closePool, query } from '../../shared/database/connection.js'
import { bufferToUuid } from '../../shared/utils/uuid.utils.js'
import { getCampaignInsights, deleteAdCampaign, extractMetaError } from '../../shared/services/meta-ads.service.js'
import { isRateLimited } from '../../shared/services/meta-rate-limiter.js'

const systemToken = process.env.META_SYSTEM_USER_TOKEN

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const RATE_LIMIT_CODES = new Set([80004, 613, 4, 17])
const RATE_LIMIT_RETRIES = 5
const RATE_LIMIT_WAIT_MS = 90000

function isRateLimitError(detail) {
  if (isRateLimited()) return true
  if (!detail) return false
  return RATE_LIMIT_CODES.has(Number(detail.code)) || Number(detail.subcode) === 2446079
}

async function sumSpendPaise(objectId) {
  try {
    const rows = await getCampaignInsights(objectId, systemToken, 'maximum')
    return rows.reduce((sum, row) => sum + (Number(row.spend) || 0) * 100, 0)
  } catch (err) {
    const detail = extractMetaError(err)
    if (detail?.code === 100) return 0
    if (isRateLimitError(detail)) {
      throw new Error(`Rate limited while reading spend for ${objectId}: ${err.message}`)
    }
    throw new Error(`Failed to read spend for ${objectId}: ${err.message}`)
  }
}

async function deleteZeroSpendCampaign(objectId) {
  const spendPaise = await sumSpendPaise(objectId)
  if (spendPaise > 0) return { kind: 'skipped', spendPaise }
  for (let attempt = 0; ; attempt += 1) {
    try {
      await deleteAdCampaign(objectId, systemToken)
      return { kind: 'deleted', spendPaise }
    } catch (err) {
      const detail = extractMetaError(err)
      if (detail?.code === 100) return { kind: 'alreadyGone', spendPaise }
      if (!isRateLimitError(detail)) {
        throw new Error(`Failed to delete ${objectId}: ${err.message}`)
      }
      if (attempt >= RATE_LIMIT_RETRIES) {
        throw new Error(`Rate limited while deleting ${objectId} after ${RATE_LIMIT_RETRIES} retries: ${err.message}`)
      }
      console.log(`[campaigns-reconcile] Delete ${objectId} rate-limited — waiting ${RATE_LIMIT_WAIT_MS / 1000}s (attempt ${attempt + 1}/${RATE_LIMIT_RETRIES})`)
      await sleep(RATE_LIMIT_WAIT_MS)
    }
  }
}

function groupByUser(rows) {
  const groups = new Map()
  for (const row of rows) {
    const key = row.createdForUserId || null
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }
  return groups
}

function survivorsPerGroup(group) {
  const fbRows = group
    .filter((row) => row.objectType === 'facebook_campaign')
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
  if (!fbRows.length) return { keepIds: new Set(), duplicateFbRows: [] }
  const maxFbTime = new Date(fbRows[fbRows.length - 1].createdAt).getTime()
  const keepIds = new Set([fbRows[fbRows.length - 1].id])
  for (const row of group) {
    if (row.objectType !== 'facebook_campaign' && new Date(row.createdAt).getTime() > maxFbTime) {
      keepIds.add(row.id)
    }
  }
  return { keepIds, duplicateFbRows: fbRows.slice(0, -1) }
}

async function pruneDbRows(binaryIds) {
  if (!binaryIds.length) return
  const placeholders = binaryIds.map(() => '?').join(',')
  await query(`DELETE FROM campaign_meta_objects WHERE id IN (${placeholders})`, binaryIds)
}

async function reconcile(filterCampaignId = null) {
  const dupRows = await query(
    `SELECT campaign_id, COUNT(*) AS cnt
     FROM campaign_meta_objects
     WHERE object_type = 'facebook_campaign'
     GROUP BY campaign_id
     HAVING cnt > 1
     ORDER BY cnt DESC`
  )

  let targets = dupRows
  if (filterCampaignId) {
    const bin = Buffer.from(filterCampaignId.replace(/-/g, ''), 'hex')
    targets = dupRows.filter((row) => row.campaign_id.equals(bin))
    if (!targets.length) {
      throw new Error(`No duplicate facebook_campaign rows found for ${filterCampaignId}`)
    }
  }

  const results = []
  for (const target of targets) {
    const campaignIdStr = bufferToUuid(target.campaign_id)
    const rows = await query('SELECT * FROM campaign_meta_objects WHERE campaign_id = ?', [target.campaign_id])
    const mapped = rows.map((row) => ({
      id: Buffer.from(row.id),
      objectType: row.object_type,
      objectId: row.object_id,
      createdForUserId: row.created_for_user_id ? bufferToUuid(row.created_for_user_id) : null,
      createdAt: row.created_at,
    }))

    const summary = {
      campaignId: campaignIdStr,
      facebookCampaignRows: target.cnt,
      deletedOnMeta: [],
      skippedWithSpend: [],
      alreadyGone: [],
      prunedDb: 0,
      kept: [],
    }

    const pruneIds = []
    for (const group of groupByUser(mapped).values()) {
      const { keepIds, duplicateFbRows } = survivorsPerGroup(group)
      for (const dup of duplicateFbRows) {
        const result = await deleteZeroSpendCampaign(dup.objectId)
        await sleep(250)
        if (result.kind === 'skipped') {
          summary.skippedWithSpend.push({ objectId: dup.objectId, spendPaise: result.spendPaise })
          continue
        }
        if (result.kind === 'alreadyGone') {
          summary.alreadyGone.push(dup.objectId)
        } else {
          summary.deletedOnMeta.push(dup.objectId)
        }
        pruneIds.push(dup.id)
      }
      for (const row of group) {
        if (keepIds.has(row.id)) {
          summary.kept.push(row.objectId)
        } else if (!duplicateFbRows.some((dup) => dup.id === row.id)) {
          pruneIds.push(row.id)
        }
      }
    }

    if (pruneIds.length) {
      await pruneDbRows(pruneIds)
      summary.prunedDb = pruneIds.length
    }

    results.push(summary)
    console.log(`[campaigns-reconcile] ${campaignIdStr}: ${summary.facebookCampaignRows} fb-campaign rows -> deleted ${summary.deletedOnMeta.length} on Meta${summary.skippedWithSpend.length ? `, skipped ${summary.skippedWithSpend.length} (has spend)` : ''}${summary.alreadyGone.length ? `, ${summary.alreadyGone.length} already gone` : ''}, pruned ${summary.prunedDb} DB rows`)
  }

  return results
}

const campaignFlagIndex = process.argv.indexOf('--campaign')
const filterCampaignId = campaignFlagIndex >= 0 ? process.argv[campaignFlagIndex + 1] : null

try {
  if (isRateLimited()) {
    console.error('[campaigns-reconcile] Meta is currently rate limited — aborting')
    process.exit(1)
  }
  const results = await reconcile(filterCampaignId)
  console.log(`[campaigns-reconcile] Done: ${results.length} campaign(s) processed`)
  for (const summary of results) {
    console.log(`  ${summary.campaignId}: deleted ${summary.deletedOnMeta.length}, skipped-with-spend ${summary.skippedWithSpend.length}, gone ${summary.alreadyGone.length}, pruned ${summary.prunedDb} DB rows, kept ${summary.kept.length}`)
    for (const skipped of summary.skippedWithSpend) {
      console.log(`    KEPT ${skipped.objectId} — has spend of ${(skipped.spendPaise / 100).toFixed(2)} INR`)
    }
  }
} catch (err) {
  console.error('[campaigns-reconcile] Fatal:', err.message)
  process.exit(1)
} finally {
  await closePool()
}