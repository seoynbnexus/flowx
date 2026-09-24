import * as promoRepo from './promotion.repository.js'
import * as repairRepo from './promotion-repair.repository.js'
import { resolveAccountContext } from '../campaigns/campaign.service.js'
import { getAdStatusesWithIssuesBatch } from '../../../shared/services/meta-ads.service.js'
import { normalizeIssuesInfo } from '../../../shared/services/meta-issue-catalog.js'
import { isRateLimited, tokenKeyFor } from '../../../shared/services/meta-rate-limiter.js'
import { logMetaEvent } from '../../../shared/services/meta-logger.service.js'
import { applyBoostMetaStatus } from './boost-performance.service.js'

const BATCH_LIMIT = 100

/**
 * Ad-level status+issues poll for live (active/paused) promotion targets.
 * Independent of the Insights-piggyback cadence (1-6h, and only after a
 * completed report) — issue detection needs to be far faster than spend
 * reporting for a disapproval to become actionable. Persists every
 * currently-reported issue for admin visibility (via
 * promotion_target_issues) regardless of whether any repair category is
 * enabled yet, then delegates the FAILED-vs-needs_repair decision to
 * applyBoostMetaStatus.
 */
export async function syncPromotionTargetStatusJob() {
  const { accountId: adAccountId, accessToken: systemToken } = await resolveAccountContext()
  if (!systemToken) return { processed: 0, skipped: 'no_token' }
  if (isRateLimited(tokenKeyFor(systemToken))) {
    return { processed: 0, skipped: 'rate_limited' }
  }

  const targets = await promoRepo.findDuePromotionTargetsForStatusSync(BATCH_LIMIT)
  if (!targets.length) return { processed: 0 }

  let statuses
  try {
    statuses = await getAdStatusesWithIssuesBatch(adAccountId, systemToken, targets.map((t) => t.platformAdId))
  } catch (err) {
    await logMetaEvent({ action: 'promotion_status_sync_error', error: err?.message || String(err) })
    return { processed: 0, error: err?.message || String(err) }
  }

  let applied = 0
  for (const t of targets) {
    const entry = statuses[t.platformAdId]
    if (!entry) {
      await promoRepo.stampPromotionTargetStatusSync(t.id)
      continue
    }
    try {
      const normalized = normalizeIssuesInfo(entry.issuesInfo)
      const codes = normalized.map((issue) => issue.errorCode)
      for (const issue of normalized) {
        await repairRepo.upsertPromotionTargetIssue(t.id, { objectId: t.platformAdId, ...issue })
      }
      await repairRepo.deactivateMissingPromotionTargetIssues(t.id, t.platformAdId, codes)

      if (entry.status) {
        const result = await applyBoostMetaStatus(
          { path: 'promotion', promotionTargetId: t.id, postTargetId: t.postTargetId, postId: t.postId },
          entry.status,
          entry.issuesInfo
        )
        if (result.applied) applied += 1
      }
    } catch (err) {
      await logMetaEvent({ action: 'promotion_status_sync_row_error', promotionTargetId: t.id, error: err?.message || String(err) })
    } finally {
      await promoRepo.stampPromotionTargetStatusSync(t.id)
    }
  }
  return { processed: targets.length, applied }
}

export async function schedulePromotionTargetStatusSyncs() {
  return syncPromotionTargetStatusJob()
}
