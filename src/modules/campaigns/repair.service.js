import * as repo from './campaign.repository.js'
import * as execRepo from './campaign-execution.repository.js'
import * as repairRepo from './repair.repository.js'
import * as mediaRepo from '../media-library/media.repository.js'
import { mediaUrlFor, getMaxFileBytes } from '../media-library/media.service.js'
import { NotFoundError, ValidationError, ForbiddenError } from '../../../shared/errors/AppError.js'
import {
  REPAIR_STATUS,
  ACTIVE_REPAIR_STATUSES,
  TERMINAL_REPAIR_STATUSES,
  SUPPORTED_REPAIR_CATEGORIES,
  ACTIVATION_MID_STATES,
  CLIENT_EDIT_ERROR_CODE,
  CLIENT_EDIT_CREATIVE_FIELDS,
  assertValidRepairTransition,
} from './repair.model.js'
import { CAMPAIGN_JOB_TYPES } from './campaign.model.js'
import { normalizeIssuesInfo, classifyIssueCode, instagramAppliesToPlacement, checkInstagramImageWidth } from '../../../shared/services/meta-issue-catalog.js'
import { evaluateRepairImage, evaluateRepairVideo } from '../../../shared/services/repair-media-criteria.js'
import { getObjectStatus, getMetaObject, isMissingObjectError, isRateLimitError } from '../../../shared/services/meta-ads.service.js'
import {
  createAdCreative,
  createAd,
  deleteAdCreative,
  deleteAd,
  deleteAdVideo,
  updateAdStatus,
  uploadRepairVideoFromUrl,
  waitForAdVideoReady,
  listAccountCreatives,
  listAdSetAds,
  extractMetaError,
} from '../../../shared/services/meta-ads.service.js'
import { classifyChainError } from '../../../shared/services/meta-chain-runner.js'
import { logMetaEvent } from '../../../shared/services/meta-logger.service.js'
import { getCampaignAccountContext, buildUrlTags } from './campaign.service.js'
import { recordRepairMetric } from './repair.metrics.js'
import { resolveCampaignSnapshot, liveGraphVersion } from './campaign-execution.service.js'
import { diffRepairSnapshot, diffSnapshotForMediaRepair } from './repair.snapshot.js'
import { buildRepairCreativeName, buildRepairAdName } from './repair.model.js'
import { queryOne } from '../../../shared/database/connection.js'

export async function loadRepairContext(repairId) {
  const repair = await repairRepo.findRepairById(repairId)
  if (!repair) return null
  const execution = await execRepo.findExecutionById(repair.executionId)
  if (!execution) return { repair, execution: null, generation: null, campaign: null }
  const generation = await execRepo.findGenerationByExecutionIdAndNumber(repair.executionId, repair.generationNo)
  const campaign = await repo.findCampaignById(execution.campaignId)
  return { repair, execution, generation, campaign }
}

export async function resolveRepairTarget(repairId) {
  const ctx = await loadRepairContext(repairId)
  if (!ctx || !ctx.repair) throw new NotFoundError('Repair not found')
  const { repair, execution, generation, campaign } = ctx
  if (!execution) throw new NotFoundError('Repair execution not found')
  if (!generation) throw new NotFoundError('Repair generation not found')
  const page = await repo.findVerifiedFacebookPage(execution.ownerUserId).catch(() => null)
  const account = await getCampaignAccountContext(execution.campaignId).catch(() => ({}))
  return {
    repair,
    campaign,
    execution,
    generation,
    ownerUserId: execution.ownerUserId,
    kind: execution.kind,
    pageId: page?.platformUserId || null,
    adAccountId: account?.accountId || null,
    systemToken: account?.accessToken || null,
    adId: generation.platformAdId,
    creativeId: generation.platformCreativeId,
    adsetId: generation.platformAdsetId,
    fbCampaignId: generation.platformCampaignId,
  }
}

export function validateReplacementMedia({ asset, ownerUserId, platformPlacement }) {
  if (!asset) {
    throw new ValidationError('Replacement media asset not found')
  }
  if (asset.userId !== ownerUserId) {
    throw new ForbiddenError('Replacement media must belong to the execution owner')
  }
  if (asset.mediaKind !== 'image' && asset.mediaKind !== 'video') {
    throw new ValidationError('Replacement media must be an image or video for the supported repair classes')
  }
  if (asset.width === null || asset.width === undefined || asset.height === null || asset.height === undefined) {
    throw new ValidationError('Replacement media dimensions are unknown — upload an image with measurable dimensions')
  }
  const gate = checkInstagramImageWidth(asset.width)
  if (!gate.ok) {
    throw new ValidationError(gate.message)
  }
  if (!instagramAppliesToPlacement(platformPlacement)) {
    throw new ValidationError('Instagram delivery does not apply to this execution placement')
  }
  return { width: asset.width, height: asset.height }
}

export async function resolveRepairMedia({ mediaAssetId = null, mediaUrl = null, ownerUserId, platformPlacement }) {
  if (mediaAssetId) {
    const asset = await mediaRepo.findMediaAssetById(mediaAssetId)
    if (!asset) {
      throw new ValidationError('Replacement media asset not found')
    }
    if (asset.mediaKind === 'video') {
      const video = evaluateRepairVideo({
        mimeType: asset.mimeType,
        mediaType: null,
        width: asset.width,
        height: asset.height,
        durationSeconds: null,
        codecs: null,
        sizeBytes: asset.sizeBytes,
      })
      if (!video.ok) {
        throw new ValidationError(video.failures[0].message)
      }
      validateReplacementMedia({ asset, ownerUserId, platformPlacement })
      return { assetId: asset.id, mediaUrl: mediaUrlFor(asset.storagePath), mediaWidth: asset.width, mediaHeight: asset.height, mediaKind: 'video', durationSeconds: null }
    }
    const image = evaluateRepairImage({
      mimeType: asset.mimeType,
      mediaType: null,
      width: asset.width,
      height: asset.height,
      sizeBytes: asset.sizeBytes,
    })
    if (!image.ok) {
      throw new ValidationError(image.failures[0].message)
    }
    validateReplacementMedia({ asset, ownerUserId, platformPlacement })
    return { assetId: asset.id, mediaUrl: mediaUrlFor(asset.storagePath), mediaWidth: asset.width, mediaHeight: asset.height, mediaKind: 'image', durationSeconds: null }
  }
  if (!mediaUrl || typeof mediaUrl !== 'string') {
    throw new ValidationError('Either mediaAssetId or mediaUrl is required')
  }
  const { fetchBoundedBytes } = await import('../../../shared/services/media-url.js')
  const { probeMedia } = await import('../../../shared/services/media-probe.js')
  let fetched = null
  try {
    fetched = await fetchBoundedBytes(mediaUrl, { maxBytes: await getMaxFileBytes() })
  } catch (err) {
    if (err?.code === 'MEDIA_SSRF_BLOCKED' || err?.code === 'MEDIA_URL_INVALID') {
      throw new ValidationError(err.message)
    }
    throw new ValidationError(`Could not fetch replacement media URL: ${err?.message || 'fetch failed'}`)
  }
  if (!fetched || fetched.statusCode < 200 || fetched.statusCode >= 300) {
    throw new ValidationError(`Replacement media URL returned HTTP ${fetched?.statusCode || 'unknown'}`)
  }
  if (fetched.truncated || !fetched.bytes?.length) {
    throw new ValidationError('Replacement media download was truncated or empty')
  }
  const probed = probeMedia(fetched.bytes)
  if (probed?.status !== 'valid' || (probed.kind !== 'image' && probed.kind !== 'video')) {
    throw new ValidationError(`Replacement URL did not resolve to a valid image or video${probed?.reason ? `: ${probed.reason}` : ''}`)
  }
  if (probed.kind === 'video') {
    const contentType = String(fetched.contentType || '').split(';')[0].trim().toLowerCase()
    const video = evaluateRepairVideo({
      mimeType: contentType || null,
      mediaType: probed.mediaType,
      width: probed.width,
      height: probed.height,
      durationSeconds: probed.durationSeconds ?? null,
      codecs: probed.codecs ?? null,
      sizeBytes: fetched.bytes.length,
    })
    if (!video.ok) {
      throw new ValidationError(video.failures[0].message)
    }
    if (!instagramAppliesToPlacement(platformPlacement)) {
      throw new ValidationError('Instagram delivery does not apply to this execution placement')
    }
    return { assetId: null, mediaUrl, mediaWidth: probed.width, mediaHeight: probed.height, mediaKind: 'video', durationSeconds: probed.durationSeconds ?? null }
  }
  const image = evaluateRepairImage({
    mimeType: null,
    mediaType: probed.mediaType,
    width: probed.width,
    height: probed.height,
    sizeBytes: fetched.bytes.length,
  })
  if (!image.ok) {
    throw new ValidationError(image.failures[0].message)
  }
  if (!instagramAppliesToPlacement(platformPlacement)) {
    throw new ValidationError('Instagram delivery does not apply to this execution placement')
  }
  return { assetId: null, mediaUrl, mediaWidth: probed.width, mediaHeight: probed.height, mediaKind: 'image', durationSeconds: null }
}

export async function ensureGenerationZero(execution) {
  const active = await execRepo.findActiveGeneration(execution.id)
  if (active) return active
  if (execution.activeGenerationNo !== null && execution.activeGenerationNo !== undefined
    && Number(execution.activeGenerationNo) !== 0) {
    throw new ValidationError('Execution points at a missing generation — refusing to fabricate history')
  }
  try {
    await execRepo.createGeneration({
      executionId: execution.id,
      generationNo: 0,
      status: 'active',
      platformCampaignId: execution.platformCampaignId,
      platformAdsetId: execution.platformAdsetId,
      platformCreativeId: execution.platformCreativeId,
      platformAdId: execution.platformAdId,
    })
  } catch (err) {
    if (err?.code !== 'ER_DUP_ENTRY') throw err
  }
  await execRepo.updateExecution(execution.id, { activeGenerationNo: 0 })
  const created = await execRepo.findActiveGeneration(execution.id)
  if (!created) throw new ValidationError('Execution has no active generation with a Meta ad to repair')
  return created
}

export async function requestRepair({ campaignId, executionId, actorId, mediaAssetId = null, mediaUrl = null, issueCode = null }) {
  const rollout = await getRepairRolloutMode()
  if (rollout !== 'admin_only' && rollout !== 'enabled') {
    throw new ForbiddenError('Repair rollout is off')
  }
  await assertRepairMutationsAllowed()
  const campaign = await repo.findCampaignById(campaignId)
  if (!campaign) throw new NotFoundError('Campaign not found')
  const execution = await execRepo.findExecutionById(executionId)
  if (!execution) throw new NotFoundError('Campaign execution not found')
  if (execution.campaignId !== campaignId) {
    throw new ValidationError('Execution does not belong to this campaign')
  }
  const generation = await ensureGenerationZero(execution)
  if (!generation.platformAdId) {
    throw new ValidationError('Execution has no active generation with a Meta ad to repair')
  }

  const issues = await repo.findMetaObjectIssuesByCampaignId(campaignId)
  const candidates = issues.filter(
    (issue) => issue.active && issue.executionId === executionId && issue.objectId === generation.platformAdId
  )
  let issue = null
  if (issueCode) {
    issue = candidates.find((candidate) => candidate.errorCode === String(issueCode)) || null
    if (!issue) throw new ValidationError(`No active issue ${issueCode} on this execution ad`)
  } else if (candidates.length === 1) {
    issue = candidates[0]
  } else if (candidates.length === 0) {
    throw new ValidationError('No active Meta issue on this execution ad')
  } else {
    throw new ValidationError('Multiple active issues on this execution ad — specify issueCode')
  }

  const classified = classifyIssueCode(issue.errorCode)
  if (!SUPPORTED_REPAIR_CATEGORIES.includes(classified.category)) {
    throw new ValidationError(`Issue category ${classified.category} is not repairable yet`)
  }
  if (!await isRepairCategoryEnabled(classified.category)) {
    throw new ValidationError(`Issue category ${classified.category} is not enabled`)
  }

  const metaSettings = await repo.findMetaSettingsByCampaignId(campaignId)
  const media = await resolveRepairMedia({
    mediaAssetId,
    mediaUrl,
    ownerUserId: execution.ownerUserId,
    platformPlacement: metaSettings?.platformPlacement,
  })

  const repairInput = {
    executionId,
    generationNo: generation.generationNo,
    objectId: generation.platformAdId,
    creativeId: generation.platformCreativeId,
    errorCode: issue.errorCode,
    status: REPAIR_STATUS.PENDING,
    mediaAssetId: media.assetId,
    mediaUrl: media.mediaUrl,
    mediaWidth: media.mediaWidth,
    mediaHeight: media.mediaHeight,
    metaIssueId: issue.id,
  }

  let repair = null
  let rearmed = false
  try {
    const id = await repairRepo.createRepair(repairInput)
    repair = await repairRepo.findRepairById(id)
  } catch (err) {
    if (err?.code !== 'ER_DUP_ENTRY') throw err
    repair = await repairRepo.findRepairByTriple(executionId, generation.platformAdId, issue.errorCode)
    if (!repair) throw err
    if (ACTIVE_REPAIR_STATUSES.includes(repair.status)) {
      return { repair, runKey: repair.runKey, status: repair.status, queued: false, duplicate: true, rearmed: false }
    }
    const won = await repairRepo.rearmRepair(repair.id, {
      mediaAssetId: media.assetId,
      mediaUrl: media.mediaUrl,
      mediaWidth: media.mediaWidth,
      mediaHeight: media.mediaHeight,
      metaIssueId: issue.id,
    })
    repair = await repairRepo.findRepairById(repair.id)
    rearmed = won === 1
    if (!rearmed) {
      return { repair, runKey: repair.runKey, status: repair.status, queued: false, duplicate: true, rearmed: false }
    }
  }

  // NOTE: campaign_id is intentionally NULL. campaign_jobs carries
  // UNIQUE(campaign_id, job_type), so a campaign-scoped repair job would
  // collide across independent per-execution repairs on one campaign
  // (second enqueue would hijack the first row's payload/run_key).
  // NULL campaign ids never collide on that key (account-job precedent:
  // SYNC_ACCOUNT_*); per-repair identity lives in UNIQUE(job_type, run_key)
  // plus the repair row's own triple UNIQUE. The worker loads all context
  // from payload.repairId, never from job.campaignId.
  await repo.requeueAutoJob(null, CAMPAIGN_JOB_TYPES.EXECUTION_REPAIR, { repairId: repair.id }, { runKey: repair.runKey })
  await recordRepairMetric('repair_requested', {
    code: issue.errorCode, category: classified.category, kind: execution.kind,
  })
  await logMetaEvent({ campaignId, userId: actorId || null, action: 'repair_requested', params: { repairId: repair.id, executionId, objectId: repair.objectId, generationNo: repair.generationNo, errorCode: repair.errorCode, rearmed } })
  return { repair, runKey: repair.runKey, status: repair.status, queued: true, duplicate: false, rearmed }
}

// Client-initiated counterpart to requestRepair: there is no Meta-reported
// issue driving this (the client is proactively fixing their own creative
// on a FAILED, already-live campaign), so it skips the whole
// find-a-matching-active-issue step and uses the CLIENT_EDIT_ERROR_CODE
// sentinel as the (execution_id, object_id, error_code) triple's
// discriminator. Reuses the exact same generation state machine as
// Meta-issue-driven repairs (same worker, same job type, same kill switch),
// gated by its own rollout flag via isRepairCategoryEnabled('CLIENT_EDIT').
export async function requestContentAmendment({ campaignId, executionId, actorId, creative = {} }) {
  await assertRepairMutationsAllowed()
  if (!(await isRepairCategoryEnabled('CLIENT_EDIT'))) {
    throw new ForbiddenError('Client-initiated creative amendment is not enabled')
  }
  const campaign = await repo.findCampaignById(campaignId)
  if (!campaign) throw new NotFoundError('Campaign not found')
  const execution = await execRepo.findExecutionById(executionId)
  if (!execution) throw new NotFoundError('Campaign execution not found')
  if (execution.campaignId !== campaignId) {
    throw new ValidationError('Execution does not belong to this campaign')
  }
  const generation = await ensureGenerationZero(execution)
  if (!generation.platformAdId) {
    throw new ValidationError('Execution has no active generation with a Meta ad to amend')
  }

  const frozen = await repo.findCampaignSnapshot(campaignId)
  if (!frozen) throw new ValidationError('Campaign has no frozen snapshot to amend')
  const frozenCreative = frozen.config?.creative || {}

  const amendment = {}
  for (const key of CLIENT_EDIT_CREATIVE_FIELDS) {
    if (key === 'mediaUrl') continue
    if (creative[key] !== undefined) amendment[key] = creative[key]
  }
  if (!Object.keys(amendment).length && !creative.mediaUrl && !creative.mediaAssetId) {
    throw new ValidationError('No creative changes submitted')
  }

  const metaSettings = await repo.findMetaSettingsByCampaignId(campaignId)
  const media = await resolveRepairMedia({
    mediaAssetId: creative.mediaAssetId || null,
    mediaUrl: creative.mediaUrl || frozenCreative.mediaUrl || null,
    ownerUserId: execution.ownerUserId,
    platformPlacement: metaSettings?.platformPlacement,
  })
  if (creative.mediaUrl || creative.mediaAssetId) amendment.mediaUrl = media.mediaUrl

  const repairInput = {
    executionId,
    generationNo: generation.generationNo,
    objectId: generation.platformAdId,
    creativeId: generation.platformCreativeId,
    errorCode: CLIENT_EDIT_ERROR_CODE,
    status: REPAIR_STATUS.PENDING,
    mediaAssetId: media.assetId,
    mediaUrl: media.mediaUrl,
    mediaWidth: media.mediaWidth,
    mediaHeight: media.mediaHeight,
    amendmentCreative: amendment,
  }

  let repair = null
  let rearmed = false
  try {
    const id = await repairRepo.createRepair(repairInput)
    repair = await repairRepo.findRepairById(id)
  } catch (err) {
    if (err?.code !== 'ER_DUP_ENTRY') throw err
    repair = await repairRepo.findRepairByTriple(executionId, generation.platformAdId, CLIENT_EDIT_ERROR_CODE)
    if (!repair) throw err
    if (ACTIVE_REPAIR_STATUSES.includes(repair.status)) {
      return { repair, runKey: repair.runKey, status: repair.status, queued: false, duplicate: true, rearmed: false }
    }
    const won = await repairRepo.rearmRepair(repair.id, {
      mediaAssetId: media.assetId,
      mediaUrl: media.mediaUrl,
      mediaWidth: media.mediaWidth,
      mediaHeight: media.mediaHeight,
      amendmentCreative: amendment,
    })
    repair = await repairRepo.findRepairById(repair.id)
    rearmed = won === 1
    if (!rearmed) {
      return { repair, runKey: repair.runKey, status: repair.status, queued: false, duplicate: true, rearmed: false }
    }
  }

  await repo.requeueAutoJob(null, CAMPAIGN_JOB_TYPES.EXECUTION_REPAIR, { repairId: repair.id }, { runKey: repair.runKey })
  await recordRepairMetric('repair_requested', { code: CLIENT_EDIT_ERROR_CODE, category: 'CLIENT_EDIT', kind: execution.kind })
  await logMetaEvent({ campaignId, userId: actorId || null, action: 'content_amendment_requested', params: { repairId: repair.id, executionId, objectId: repair.objectId, generationNo: repair.generationNo, rearmed } })
  return { repair, runKey: repair.runKey, status: repair.status, queued: true, duplicate: false, rearmed }
}

export async function reconcileExactMetaObject(objectId, accessToken) {
  try {
    const data = await getMetaObject(objectId, accessToken, 'id,status,effective_status')
    return { outcome: 'present', data }
  } catch (err) {
    if (isMissingObjectError(err)) return { outcome: 'missing', error: err.message }
    if (isRateLimitError(err) || classifyChainError(err).kind === 'transient') {
      return { outcome: 'unknown', retryable: true, error: err.message }
    }
    return { outcome: 'unknown', retryable: false, error: err.message }
  }
}

async function repairDims(repair) {
  let kind = null
  try {
    const execution = await execRepo.findExecutionById(repair.executionId)
    kind = execution?.kind || null
  } catch {
    // metrics must never break repair flows
  }
  return { code: repair.errorCode, category: classifyIssueCode(repair.errorCode).category, kind }
}

async function transitionRepair(repair, toStatus, reason = null) {
  assertValidRepairTransition(repair.status, toStatus)
  const won = await repairRepo.updateRepairState(repair.id, [repair.status], toStatus)
  if (won !== 1) return null
  if (reason) await repairRepo.recordRepairRun(repair.id, { error: reason, attemptsIncrement: 0 })
  if ([REPAIR_STATUS.COMPLETED, REPAIR_STATUS.FAILED, REPAIR_STATUS.UNKNOWN].includes(toStatus)) {
    try {
      const dims = await repairDims(repair)
      let durationMs = null
      const createdAt = repair.createdAt ? new Date(repair.createdAt).getTime() : NaN
      if (Number.isFinite(createdAt)) durationMs = Math.max(0, Date.now() - createdAt)
      await recordRepairMetric(toStatus, { ...dims, state: repair.status, durationMs })
    } catch {
      // metrics must never break repair flows
    }
  }
  await logMetaEvent({
    campaignId: null,
    action: 'repair_transition',
    params: {
      repairId: repair.id,
      executionId: repair.executionId,
      objectId: repair.objectId,
      errorCode: repair.errorCode,
      from: repair.status,
      to: toStatus,
      reason,
    },
  })
  return repairRepo.findRepairById(repair.id)
}

export async function isRepairExecutionEnabled() {
  try {
    const row = await queryOne("SELECT config_value FROM app_config WHERE config_key = 'campaign_repair_execution_enabled'")
    if (!row) return false
    const value = typeof row.config_value === 'string' ? JSON.parse(row.config_value) : row.config_value
    return value === true
  } catch {
    return false
  }
}

// Test seam only: some suites deliberately test the creation phase in
// total isolation (asserting activation-only calls like updateAdStatus
// never fire). Production always chains; set
// repairJobOptions.chainActivationAfterCreation = false in such a suite's
// beforeAll/afterAll to opt out, matching this codebase's existing
// test-tunable-config pattern (igContainerPoll, postMediaProbe.enabled).
export const repairJobOptions = { chainActivationAfterCreation: true }

// runRepairCreation's success return ({done:true, state:'new_verified'})
// carries no requeueAfterSeconds, so processDueJobs marks the job 'done'
// immediately — nothing would ever re-invoke this repair again to run the
// activation/cutover phase. Chaining synchronously within the SAME job
// call (rather than requeuing a fresh tick) avoids an artificial delay:
// the replacement ad is already verified and ready, there's no reason to
// wait before cutting over.
async function runCreationThenChainActivation(repairId) {
  const created = await runRepairCreation(repairId)
  if (repairJobOptions.chainActivationAfterCreation
    && created?.state && ACTIVATION_ENTRY_STATES.includes(created.state)) {
    return runRepairActivation(repairId)
  }
  return created
}

export async function runRepairJob(repairId) {
  await assertRepairMutationsAllowed()
  const ctx = await loadRepairContext(repairId)
  if (!ctx || !ctx.repair) return { done: true, ignored: 'repair-missing' }
  const { repair, execution, generation, campaign } = ctx
  if (!execution || !generation || !campaign) {
    return { done: true, ignored: 'repair-context-incomplete' }
  }
  if (repair.status !== REPAIR_STATUS.PENDING) {
    if (repair.status === REPAIR_STATUS.READY_FOR_CREATION) {
      return runCreationThenChainActivation(repair.id)
    }
    // A repair that has finished creation (NEW_VERIFIED) still needs the
    // activation/cutover phase — pause the old ad, activate the new one,
    // move the pointer, supersede/clean up. Without this branch, the job
    // dispatcher had NO path to runRepairActivation at all: every repair
    // that ever reached NEW_VERIFIED got marked 'done' by processDueJobs
    // (runRepairCreation's success return carries no requeueAfterSeconds)
    // and sat there forever with a built-and-verified replacement ad that
    // never went live — the ONLY thing that ever finished a cutover in
    // this system's history was a direct manual/test call.
    if (repairJobOptions.chainActivationAfterCreation && ACTIVATION_ENTRY_STATES.includes(repair.status)) {
      return runRepairActivation(repair.id)
    }
    return { done: true, ignored: `repair-status-${repair.status}` }
  }
  // CLIENT_EDIT repairs are requested while the campaign is still FAILED
  // (requestClientCreativeAmendment never flips it — see that function's
  // comment). The rest of this worker's preflight/creation/activation
  // gates all require running/paused throughout, matching every other
  // repair's live-campaign assumption, so this is the one, one-time
  // resume point: the first time the worker actually starts on this
  // repair, not at request time.
  if (repair.errorCode === CLIENT_EDIT_ERROR_CODE && campaign.status === 'failed') {
    await repo.updateCampaignStatus(campaign.id, 'paused')
  }
  await repairRepo.recordRepairRun(repair.id, { attemptsIncrement: 1 })

  const account = await getCampaignAccountContext(execution.campaignId).catch(() => ({}))
  if (!account?.accessToken) {
    throw new Error('Meta not configured for repair preflight')
  }

  let statusData = null
  try {
    statusData = await getObjectStatus(generation.platformAdId, account.accessToken)
  } catch (err) {
    if (isMissingObjectError(err)) {
      await transitionRepair(repair, REPAIR_STATUS.UNKNOWN, `Target ad missing on Meta: ${err.message}`)
      return { done: true, state: REPAIR_STATUS.UNKNOWN }
    }
    const probe = await reconcileExactMetaObject(generation.platformAdId, account.accessToken)
    if (probe.outcome === 'missing') {
      await transitionRepair(repair, REPAIR_STATUS.UNKNOWN, `Target ad confirmed missing: ${probe.error}`)
      return { done: true, state: REPAIR_STATUS.UNKNOWN }
    }
    throw new Error(`Repair preflight read failed: ${err.message}`)
  }

  // CLIENT_EDIT has no corresponding Meta issue — see the matching skip in
  // runRepairCreation's preflight for why this check only applies to
  // Meta-issue-driven repairs.
  const live = normalizeIssuesInfo(statusData?.issues_info)
  const match = repair.errorCode === CLIENT_EDIT_ERROR_CODE || live.find((issue) => issue.errorCode === repair.errorCode)
  if (!match) {
    const codes = live.map((issue) => issue.errorCode).join(',') || 'none'
    await transitionRepair(repair, REPAIR_STATUS.SUPERSEDED, `Issue ${repair.errorCode} no longer reported; live codes: ${codes}`)
    return { done: true, state: REPAIR_STATUS.SUPERSEDED }
  }

  try {
    const metaSettings = await repo.findMetaSettingsByCampaignId(execution.campaignId)
    await resolveRepairMedia({
      mediaAssetId: repair.mediaAssetId,
      mediaUrl: repair.mediaUrl,
      ownerUserId: execution.ownerUserId,
      platformPlacement: metaSettings?.platformPlacement,
    })
  } catch (err) {
    await transitionRepair(repair, REPAIR_STATUS.FAILED, `Replacement media unavailable: ${err.message}`)
    return { done: true, state: REPAIR_STATUS.FAILED }
  }

  const ready = await transitionRepair(repair, REPAIR_STATUS.READY_FOR_CREATION)
  if (!ready) return { done: true, ignored: 'repair-transition-lost' }
  await logMetaEvent({ campaignId: execution.campaignId, action: 'repair_ready', params: { repairId: repair.id, executionId: execution.id, errorCode: repair.errorCode } })
  if (await isRepairExecutionEnabled()) {
    return runCreationThenChainActivation(repair.id)
  }
  return { done: true, state: REPAIR_STATUS.READY_FOR_CREATION }
}

export const ACTIVATION_ENTRY_STATES = [
  REPAIR_STATUS.NEW_VERIFIED,
  REPAIR_STATUS.NEW_ACTIVATING,
  REPAIR_STATUS.NEW_ACTIVE_VERIFIED,
  REPAIR_STATUS.OLD_PAUSING,
  REPAIR_STATUS.OLD_PAUSED_VERIFIED,
  REPAIR_STATUS.ACTIVE_POINTER_MOVED,
  REPAIR_STATUS.OLD_CLEANUP,
]

export const REPAIR_ROLLOUT_FLAG = 'campaign_repair_rollout'
export const REPAIR_KILL_FLAG = 'campaign_repair_killed'

export async function readRepairFlag(key) {
  try {
    const row = await queryOne(`SELECT config_value FROM app_config WHERE config_key = ?`, [key])
    if (!row) return undefined
    const value = typeof row.config_value === 'string' ? JSON.parse(row.config_value) : row.config_value
    return value
  } catch {
    return undefined
  }
}

export async function getRepairRolloutMode() {
  const value = await readRepairFlag(REPAIR_ROLLOUT_FLAG)
  if (value === 'admin_only' || value === 'enabled') return value
  return 'off'
}

export async function isRepairKilled() {
  return (await readRepairFlag(REPAIR_KILL_FLAG)) === true
}

export function repairCategoryFlagKey(category) {
  return `campaign_repair_category_${String(category || 'unknown').toLowerCase()}`
}

export async function isRepairCategoryEnabled(category) {
  if (!SUPPORTED_REPAIR_CATEGORIES.includes(category)) return false
  const value = await readRepairFlag(repairCategoryFlagKey(category))
  if (value === undefined) return category === 'MEDIA_DIMENSION'
  return value === true
}

export async function assertRepairMutationsAllowed() {
  if (await isRepairKilled()) {
    throw new Error('Repair mutations disabled by kill switch')
  }
}

export async function getExecutionRepairStatus(executionId) {
  const execution = await execRepo.findExecutionById(executionId)
  if (!execution) throw new NotFoundError('Campaign execution not found')
  const campaign = await repo.findCampaignById(execution.campaignId)
  if (!campaign) throw new NotFoundError('Campaign not found')
  const generation = await execRepo.findActiveGeneration(executionId)
  const target = generation?.platformAdId
    ? { generation, adId: generation.platformAdId, creativeId: generation.platformCreativeId }
    : execution.platformAdId
      ? { generation: null, adId: execution.platformAdId, creativeId: execution.platformCreativeId }
      : null
  const allIssues = await repo.findMetaObjectIssuesByCampaignId(execution.campaignId)
  const issues = []
  for (const issue of allIssues.filter((entry) => entry.active && entry.executionId === executionId)) {
    const classified = classifyIssueCode(issue.errorCode)
    const supported = SUPPORTED_REPAIR_CATEGORIES.includes(classified.category)
    const repairable = supported && await isRepairCategoryEnabled(classified.category)
    issues.push({
      id: issue.id,
      objectId: issue.objectId,
      creativeId: issue.creativeId,
      level: issue.level,
      errorCode: issue.errorCode,
      summary: issue.summary,
      message: issue.message,
      errorType: issue.errorType,
      observedAt: issue.observedAt,
      category: classified.category,
      guidance: classified.guidance,
      severity: classified.severity,
      requiredInput: classified.requiredInput || null,
      supported,
      repairable,
    })
  }
  const repairs = await repairRepo.listRepairsForExecution(executionId)
  const activeRepair = repairs.find((repair) => ACTIVE_REPAIR_STATUSES.includes(repair.status)) || null
  const completedCount = repairs.filter((repair) => repair.status === REPAIR_STATUS.COMPLETED).length
  const lastRepair = repairs.length ? repairs[repairs.length - 1] : null
  const issuePresent = issues.length > 0
  const actionableRepair = activeRepair
    && [REPAIR_STATUS.FAILED, REPAIR_STATUS.UNKNOWN].includes(activeRepair.status)
    ? activeRepair
    : null

  let workflowState = 'HEALTHY'
  if (actionableRepair) {
    workflowState = 'ACTION_REQUIRED'
  } else if (activeRepair) {
    workflowState = activeRepair.status === REPAIR_STATUS.NEW_VERIFIED ? 'REPAIR_READY' : 'REPAIR_IN_PROGRESS'
  } else if (issuePresent) {
    workflowState = 'ACTION_REQUIRED'
  } else if (completedCount > 0) {
    workflowState = 'COMPLETED'
  }
  const health = !issuePresent && !actionableRepair ? 'HEALTHY' : 'ACTION_REQUIRED'

  const reasons = []
  if (['cancelled', 'completed'].includes(execution.status)) reasons.push('execution-terminal')
  if (campaign.settledAt) reasons.push('campaign-settled')
  if (!target) reasons.push('no-repair-target')
  if (!issuePresent) {
    reasons.push('no-active-issue')
  } else if (!issues.some((issue) => issue.repairable)) {
    reasons.push(issues.some((issue) => issue.supported) ? 'issue-disabled' : 'issue-unsupported')
  }
  if (activeRepair) reasons.push('repair-in-progress')
  const eligible = reasons.length === 0

  return {
    executionId: execution.id,
    campaignId: execution.campaignId,
    kind: execution.kind,
    ownerUserId: execution.ownerUserId,
    health,
    workflowState,
    eligible,
    reasons,
    issues,
    activeRepair: activeRepair ? {
      id: activeRepair.id,
      status: activeRepair.status,
      objectId: activeRepair.objectId,
      errorCode: activeRepair.errorCode,
      runKey: activeRepair.runKey,
      attempts: activeRepair.attempts,
      updatedAt: activeRepair.updatedAt,
    } : null,
    lastRepair: lastRepair ? {
      id: lastRepair.id,
      status: lastRepair.status,
      objectId: lastRepair.objectId,
      errorCode: lastRepair.errorCode,
      attempts: lastRepair.attempts,
      updatedAt: lastRepair.updatedAt,
    } : null,
    completedRepairs: completedCount,
    generation: generation ? {
      generationNo: generation.generationNo,
      status: generation.status,
      platformCampaignId: generation.platformCampaignId,
      platformAdsetId: generation.platformAdsetId,
      platformCreativeId: generation.platformCreativeId,
      platformAdId: generation.platformAdId,
    } : null,
  }
}

export async function previewRepair(args) {
  const result = await previewRepairInner(args)
  await recordRepairMetric(result.ok ? 'preview_pass' : 'preview_fail', { code: args.issueCode || null })
  return result
}

function repairMediaDisplayName(media) {
  if (!media?.mediaUrl || typeof media.mediaUrl !== 'string') return null
  try {
    const last = String(new URL(media.mediaUrl).pathname).split('/').filter(Boolean).pop() || ''
    if (last) return last.slice(0, 120)
  } catch {
    // fall through to raw URL
  }
  return media.mediaUrl.slice(0, 120)
}

async function previewRepairInner({ campaignId, executionId, mediaAssetId = null, mediaUrl = null, issueCode = null }) {
  const checks = []
  const check = (key, ok, message = null) => {
    const passed = !!ok
    checks.push({ key, ok: passed, message: passed ? null : message })
    return passed
  }
  const campaign = await repo.findCampaignById(campaignId)
  if (!check('campaign', !!campaign, campaign ? null : 'Campaign not found')) {
    return { ok: false, checks }
  }
  const execution = await execRepo.findExecutionById(executionId)
  if (!check('execution', !!execution, execution ? null : 'Campaign execution not found')) {
    return { ok: false, checks }
  }
  if (!check('execution-scope', execution.campaignId === campaignId, 'Execution does not belong to this campaign')) {
    return { ok: false, checks }
  }
  if (!check('execution-live', !['cancelled', 'completed'].includes(execution.status), `Execution is ${execution.status}`)) {
    return { ok: false, checks }
  }
  if (!check('campaign-settled', !campaign.settledAt, 'Campaign is settled')) {
    return { ok: false, checks }
  }
  const generation = await execRepo.findActiveGeneration(executionId)
  const target = generation?.platformAdId
    ? { adId: generation.platformAdId, creativeId: generation.platformCreativeId }
    : execution.platformAdId
      ? { adId: execution.platformAdId, creativeId: execution.platformCreativeId }
      : null
  if (!check('generation-target', !!target, 'No active generation with a Meta ad')) {
    return { ok: false, checks }
  }
  const issues = (await repo.findMetaObjectIssuesByCampaignId(campaignId))
    .filter((issue) => issue.active && issue.executionId === executionId && issue.objectId === target.adId)
  let issue = null
  if (issueCode) {
    issue = issues.find((candidate) => candidate.errorCode === String(issueCode)) || null
    if (!check('issue-selected', !!issue, `No active issue ${issueCode} on this execution ad`)) {
      return { ok: false, checks }
    }
  } else if (issues.length === 1) {
    issue = issues[0]
    check('issue-selected', true)
  } else if (!check('issue-selected', false, issues.length === 0 ? 'No active Meta issue on this execution ad' : 'Multiple active issues — specify issueCode')) {
    return { ok: false, checks }
  }
  const classified = classifyIssueCode(issue.errorCode)
  const categoryEnabled = await isRepairCategoryEnabled(classified.category)
  if (!check('issue-supported', SUPPORTED_REPAIR_CATEGORIES.includes(classified.category) && categoryEnabled, `Issue category ${classified.category} is not repairable yet`)) {
    return { ok: false, checks }
  }
  const metaSettings = await repo.findMetaSettingsByCampaignId(campaignId)
  let media = null
  try {
    media = await resolveRepairMedia({
      mediaAssetId,
      mediaUrl,
      ownerUserId: execution.ownerUserId,
      platformPlacement: metaSettings?.platformPlacement,
    })
    check('media', true)
  } catch (err) {
    check('media', false, err.message)
    return { ok: false, checks }
  }
  const frozen = await repo.findCampaignSnapshot(campaignId)
  if (!check('snapshot-frozen', !!frozen, 'No frozen execution snapshot')) {
    return { ok: false, checks }
  }
  const [liveCampaign, liveCreative, liveSettings] = await Promise.all([
    repo.findCampaignById(campaignId),
    repo.findCreativeByCampaignId(campaignId),
    repo.findMetaSettingsByCampaignId(campaignId),
  ])
  const liveResolved = resolveCampaignSnapshot({ campaign: liveCampaign, creative: liveCreative, metaSettings: liveSettings })
  if (!check('snapshot-live', liveResolved.ok, liveResolved.ok ? null : `Live config unresolvable: ${liveResolved.reason}`)) {
    return { ok: false, checks }
  }
  const diff = diffSnapshotForMediaRepair({ frozenConfig: frozen.config, liveConfig: liveResolved.config, amendment: { mediaUrl: media.mediaUrl } })
  if (!check('snapshot-diff', diff.ok, diff.ok ? null : `Snapshot drift: ${diff.reason}`)) {
    return { ok: false, checks }
  }
  const account = await getCampaignAccountContext(campaignId).catch(() => ({}))
  if (!check('account', !!(account?.accountId && account?.accessToken), 'Meta account context unavailable')) {
    return { ok: false, checks }
  }
  try {
    const statusData = await getObjectStatus(target.adId, account.accessToken)
    const liveIssues = normalizeIssuesInfo(statusData?.issues_info)
    if (!check('issue-live', liveIssues.some((entry) => entry.errorCode === issue.errorCode), 'Issue no longer reported by Meta')) {
      return { ok: false, checks }
    }
  } catch (err) {
    check('issue-live', false, `Meta read failed: ${err.message}`)
    return { ok: false, checks }
  }
  const repairs = await repairRepo.listRepairsForExecution(executionId)
  const conflict = repairs.find((row) => row.objectId === target.adId && ACTIVE_REPAIR_STATUSES.includes(row.status))
  if (!check('no-conflict', !conflict, conflict ? `Repair ${conflict.id} already ${conflict.status}` : null)) {
    return { ok: false, checks }
  }
  return {
    ok: true,
    checks,
    issue: {
      errorCode: issue.errorCode,
      summary: issue.summary,
      message: issue.message,
      level: issue.level,
      category: classified.category,
      guidance: classified.guidance,
    },
    media: { assetId: media.assetId, url: media.mediaUrl, width: media.mediaWidth, height: media.mediaHeight, name: repairMediaDisplayName(media), kind: media.mediaKind || 'image', durationSeconds: media.durationSeconds ?? null },
    execution: { executionId: execution.id, kind: execution.kind, ownerUserId: execution.ownerUserId, adId: target.adId, creativeId: target.creativeId },
  }
}

export async function getExecutionReconciliation(executionId) {
  const execution = await execRepo.findExecutionById(executionId)
  if (!execution) throw new NotFoundError('Campaign execution not found')
  const campaign = await repo.findCampaignById(execution.campaignId)
  const generations = await execRepo.listGenerationsForExecution(executionId)
  const repairs = await repairRepo.listRepairsForExecution(executionId)
  const metaObjects = campaign ? await repo.findMetaObjectsByCampaignId(campaign.id) : []
  const ownObjects = metaObjects.filter((o) => !o.createdForUserId || o.createdForUserId === execution.ownerUserId)
  const issues = campaign ? await repo.findMetaObjectIssuesByCampaignId(campaign.id) : []
  const ownIssues = issues.filter((issue) => issue.executionId === executionId && issue.active)

  const checks = []
  const check = (name, ok, detail = null) => checks.push({ check: name, ok: !!ok, detail })

  const activeNo = execution.activeGenerationNo
  check('pointer-present', activeNo !== null && activeNo !== undefined, { activeGenerationNo: activeNo })
  const activeGen = generations.find((gen) => Number(gen.generationNo) === Number(activeNo)) || null
  check('pointer-references-existing-generation', activeNo === null || !!activeGen, { activeGenerationNo: activeNo })
  const activeCount = generations.filter((gen) => gen.status === 'active').length
  check('single-active-generation', activeCount <= 1, { activeCount })
  check('active-generation-has-ad', !activeGen || !!activeGen.platformAdId, { adId: activeGen?.platformAdId || null })

  const metaById = new Map(ownObjects.map((o) => [o.objectId, o]))
  if (activeGen?.platformAdId) {
    const row = metaById.get(activeGen.platformAdId)
    check('active-ad-not-deleted', !row || row.status !== 'DELETED', { status: row?.status || 'untracked' })
  }
  const seenNumbers = new Set()
  let duplicateNumbers = false
  for (const gen of generations) {
    if (seenNumbers.has(gen.generationNo)) duplicateNumbers = true
    seenNumbers.add(gen.generationNo)
  }
  check('unique-generation-numbers', !duplicateNumbers, { generations: generations.length })

  const idOwners = new Map()
  let duplicateIdentity = false
  for (const gen of generations) {
    for (const id of [gen.platformCreativeId, gen.platformAdId]) {
      if (!id) continue
      if (idOwners.has(id) && idOwners.get(id) !== gen.id) duplicateIdentity = true
      idOwners.set(id, gen.id)
    }
  }
  check('unique-replacement-identity', !duplicateIdentity, {})

  const strayActive = generations.filter((gen) => gen.status === 'active'
    && activeNo !== null && activeNo !== undefined && Number(gen.generationNo) !== Number(activeNo))
  check('no-unexpected-active-generation', strayActive.length === 0, { ids: strayActive.map((gen) => gen.id) })

  const slotIds = [execution.platformCreativeId, execution.platformAdId].filter(Boolean)
  const unlinked = ownObjects.filter((o) => ['ad', 'ad_creative'].includes(o.objectType)
    && !slotIds.includes(o.objectId) && ![...idOwners.keys()].includes(o.objectId))
  check('meta-linkage-complete', unlinked.length === 0, { unlinked: unlinked.map((o) => `${o.objectType}:${o.objectId}`) })

  const nonterminal = repairs.filter((repair) => ![...TERMINAL_REPAIR_STATUSES].includes(repair.status))
  check('no-stuck-repair', nonterminal.length === 0, {
    repairs: nonterminal.map((repair) => ({ id: repair.id, status: repair.status, objectId: repair.objectId, errorCode: repair.errorCode })),
  })
  const unknownRepairs = repairs.filter((repair) => repair.status === REPAIR_STATUS.UNKNOWN)
  check('no-unknown-repair', unknownRepairs.length === 0, { ids: unknownRepairs.map((repair) => repair.id) })
  const pendingCleanup = repairs.filter((repair) => repair.status === REPAIR_STATUS.OLD_CLEANUP)
  check('no-pending-cleanup', pendingCleanup.length === 0, { ids: pendingCleanup.map((repair) => repair.id) })

  return {
    campaign: campaign ? { id: campaign.id, name: campaign.name, status: campaign.status, metaStatus: campaign.metaStatus } : null,
    execution: {
      id: execution.id, ownerUserId: execution.ownerUserId, kind: execution.kind,
      status: execution.status, activeGenerationNo: execution.activeGenerationNo,
    },
    owner: execution.ownerUserId,
    kind: execution.kind,
    activeGeneration: activeGen ? {
      id: activeGen.id, generationNo: activeGen.generationNo, status: activeGen.status,
      platformCampaignId: activeGen.platformCampaignId, platformAdsetId: activeGen.platformAdsetId,
      platformCreativeId: activeGen.platformCreativeId, platformAdId: activeGen.platformAdId,
      metaStatus: activeGen.platformAdId ? (metaById.get(activeGen.platformAdId)?.status || null) : null,
      issues: ownIssues.filter((issue) => issue.objectId === activeGen.platformAdId)
        .map((issue) => ({ errorCode: issue.errorCode, summary: issue.summary, level: issue.level, observedAt: issue.observedAt })),
    } : null,
    generations: generations.map((gen) => ({
      id: gen.id, generationNo: gen.generationNo, status: gen.status,
      platformCampaignId: gen.platformCampaignId, platformAdsetId: gen.platformAdsetId,
      platformCreativeId: gen.platformCreativeId, platformAdId: gen.platformAdId,
      metaStatus: gen.platformAdId ? (metaById.get(gen.platformAdId)?.status || null) : null,
    })),
    repairs: repairs.map((repair) => ({
      id: repair.id, status: repair.status, objectId: repair.objectId, errorCode: repair.errorCode,
      runKey: repair.runKey, attempts: repair.attempts, updatedAt: repair.updatedAt,
    })),
    checks,
    healthy: checks.every((entry) => entry.ok),
  }
}

export async function getCampaignReconciliation(campaignId) {
  const campaign = await repo.findCampaignById(campaignId)
  if (!campaign) throw new NotFoundError('Campaign not found')
  const executions = await execRepo.findExecutionsByCampaignId(campaignId)
  const reports = []
  for (const execution of executions) {
    reports.push(await getExecutionReconciliation(execution.id))
  }
  return { campaign: { id: campaign.id, name: campaign.name, status: campaign.status }, executions: reports, healthy: reports.every((report) => report.healthy) }
}

export async function getRepairFleetSummary() {
  const { getRepairFleetSummary: fleetSummary } = await import('./repair.metrics.js')
  return fleetSummary()
}

export async function getRepairMetrics() {
  const { getRepairMetrics: metrics } = await import('./repair.metrics.js')
  return metrics()
}

export async function getRepairReadiness() {
  const checks = []
  const check = (name, ok, detail = null) => {
    checks.push({ check: name, ok: !!ok, detail })
    return !!ok
  }
  const { query: dbQuery } = await import('../../../shared/database/connection.js')
  const tableNames = async (name) => (await dbQuery(
    'SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [name]
  )).length > 0
  const columnNames = async (table) => (await dbQuery(
    'SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [table]
  )).map((row) => row.name)
  check('table-meta-object-issues', await tableNames('meta_object_issues'))
  check('table-generations', await tableNames('campaign_execution_generations'))
  check('table-repairs', await tableNames('campaign_execution_repairs'))
  const execColumns = await columnNames('campaign_executions')
  check('column-active-generation-no', execColumns.includes('active_generation_no'))
  const repairColumns = await columnNames('campaign_execution_repairs')
  check('column-repair-amendment', repairColumns.includes('amended_config') && repairColumns.includes('amended_config_hash'))
  let statusValues = []
  try {
    const rows = await dbQuery(
      "SELECT COLUMN_TYPE AS columnType FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'campaign_execution_repairs' AND COLUMN_NAME = 'status'"
    )
    const match = rows.length ? String(rows[0].columnType || rows[0].COLUMN_TYPE).match(/^enum\((.*)\)$/i) : null
    statusValues = match ? match[1].split(',').map((v) => v.trim().replace(/^'(.*)'$/, '$1')) : []
  } catch {
    statusValues = []
  }
  const requiredStates = ['pending', 'ready_for_creation', 'new_verified', 'new_activating', 'old_cleanup', 'completed', 'failed', 'unknown', 'superseded']
  check('repair-status-vocabulary', requiredStates.every((state) => statusValues.includes(state)), {
    missing: requiredStates.filter((state) => !statusValues.includes(state)),
  })

  const rollout = await getRepairRolloutMode()
  const killed = await isRepairKilled()
  const executionEnabled = await isRepairExecutionEnabled()
  const mediaDimension = await isRepairCategoryEnabled('MEDIA_DIMENSION')
  check('flag-rollout-safe-default', rollout === 'off', { rollout })
  check('flag-kill-safe-default', !killed, { killed })
  check('flag-execution-readable', true, { executionEnabled })
  check('flag-category-readable', true, { mediaDimensionEnabled: mediaDimension })
  check('worker-job-type-registered', CAMPAIGN_JOB_TYPES.EXECUTION_REPAIR === 'execution_repair')
  check('admin-authorization', true, { guard: 'campaigns.review (route-level, test-enforced)' })

  let stage = 0
  if (rollout === 'enabled') {
    stage = 3
  } else if (rollout === 'admin_only') {
    stage = mediaDimension ? 2 : 1
  }
  const ready = checks.every((entry) => entry.ok)
  return {
    ready,
    stage,
    flags: { rollout, killed, executionEnabled, mediaDimensionEnabled: mediaDimension },
    checks,
  }
}

// Statuses a generation can be created/verified/activated through before
// reaching a terminal outcome (active/superseded/failed). Used by the
// creation-phase generation lookup to tell "this repair's own in-progress
// generation, safe to resume" apart from "a terminal generation left
// behind by a completely different, already-resolved or abandoned repair"
// — the latter must never be adopted as the thing being built right now.
const NON_TERMINAL_GENERATION_STATUSES = ['creating', 'created', 'verified', 'unknown']

// Genuinely dead statuses — never a valid "this is the generation in
// question" answer for any purpose, whether looking for an in-progress
// build or for an idempotent post-completion check. 'failed' means a
// repair attempt died outright and was abandoned; 'superseded' means a
// LATER generation has already replaced it. Deliberately excludes
// 'active', unlike NON_TERMINAL_GENERATION_STATUSES's complement — a
// completed repair's active generation IS a valid answer for retry/
// idempotency lookups (findStagingGeneration), just not for "is there
// something still being built" (the creation-phase lookup).
const DEAD_GENERATION_STATUSES = ['failed', 'superseded']

// An execution accumulates one terminal (active/superseded/failed)
// generation per past repair over its lifetime, plus at most one
// NON-terminal in-flight generation for whichever repair is currently
// running (enforced by the guard in runRepairCreation). "Staging" must mean
// "the generation THIS repair created" — which is exactly the set of
// generations numbered beyond the one this repair started from
// (repair.generationNo, the baseline it's replacing) — not "any generation
// with number > 0" (that broke on a second repair, which sees a prior,
// now-terminal repair's generation alongside its own) and not "any
// non-terminal generation" (that broke idempotent re-checks of a repair
// whose own generation has already gone active). For a fresh execution's
// first-ever repair (generationNo 0) this is identical to the original
// `> 0` filter — zero behavior change there.
async function findStagingGeneration(executionId, sinceGenerationNo = 0) {
  const gens = await execRepo.listGenerationsForExecution(executionId)
  // A DEAD generation (failed/superseded) numbered above the baseline can
  // only be history left by a completely different, already-resolved or
  // abandoned repair — never "the generation THIS repair is activating".
  // 'active' stays a valid candidate: callers use this to idempotently
  // re-check a repair whose generation has already completed, not only to
  // find an in-progress build. Without excluding dead ones, a failed
  // generation sitting alongside the genuinely relevant one made every
  // lookup see 2 candidates and refuse as ambiguous.
  const staging = gens.filter((gen) => Number(gen.generationNo) > Number(sinceGenerationNo)
    && !DEAD_GENERATION_STATUSES.includes(gen.status))
  if (!staging.length) return { generation: null, ambiguous: false }
  if (staging.length > 1) return { generation: null, ambiguous: true }
  return { generation: staging[0], ambiguous: false }
}

async function activationPreflight({ repair, execution, campaign, gen0, gen1 }) {
  if (['cancelled', 'completed'].includes(execution.status)) {
    return { ok: false, fail: `execution-${execution.status}` }
  }
  if (!['running', 'paused'].includes(campaign.status)) {
    return { ok: false, fail: `campaign-${campaign.status}-not-live` }
  }
  if (campaign.settledAt) return { ok: false, fail: 'campaign-settled' }
  if (!gen0 || !gen0.platformAdId) return { ok: false, fail: 'gen0-missing-ad' }
  if (!gen1 || !gen1.platformAdId || !gen1.platformCreativeId) {
    return { ok: false, fail: 'gen1-incomplete' }
  }
  if (gen1.platformAdId === gen0.platformAdId) return { ok: false, fail: 'gen1-same-as-gen0' }

  const page = await repo.findVerifiedFacebookPage(execution.ownerUserId).catch(() => null)
  if (!page) return { ok: false, fail: 'owner-page-unavailable' }
  if (execution.fbPageId && String(page.platformUserId) !== String(execution.fbPageId)) {
    return { ok: false, fail: 'page-rotated' }
  }
  const account = await getCampaignAccountContext(execution.campaignId).catch(() => ({}))
  const adAccountId = account?.accountId || null
  const systemToken = account?.accessToken || null
  if (!adAccountId || !systemToken) {
    return { ok: false, transient: 'Meta account context unavailable for repair activation' }
  }
  if (execution.adAccountActId && String(execution.adAccountActId) !== String(adAccountId)
    && String(execution.adAccountActId) !== `act_${adAccountId}`) {
    return { ok: false, fail: 'account-rotated' }
  }

  const frozen = await repo.findCampaignSnapshot(execution.campaignId)
  if (!frozen) return { ok: false, fail: 'missing-frozen-snapshot' }
  if (frozen.graphVersion !== liveGraphVersion()) {
    return { ok: false, fail: `snapshot-version-mismatch:${frozen.graphVersion || 'none'}` }
  }
  const [liveCampaign, liveCreative, liveSettings] = await Promise.all([
    repo.findCampaignById(execution.campaignId),
    repo.findCreativeByCampaignId(execution.campaignId),
    repo.findMetaSettingsByCampaignId(execution.campaignId),
  ])
  const liveResolved = resolveCampaignSnapshot({ campaign: liveCampaign, creative: liveCreative, metaSettings: liveSettings })
  if (!liveResolved.ok) return { ok: false, fail: `unresolvable-live-config:${liveResolved.reason}` }
  const diff = diffRepairSnapshot({ repair, frozenConfig: frozen.config, liveConfig: liveResolved.config })
  if (!diff.ok) return { ok: false, fail: `snapshot-diff:${diff.reason}` }

  const siblings = await repairRepo.listRepairsForExecution(execution.id)
  const conflict = siblings.find((row) => row.id !== repair.id && row.objectId === repair.objectId
    && [...CREATION_MID_STATES, ...ACTIVATION_MID_STATES].includes(row.status))
  if (conflict) return { ok: false, fail: `conflicting-repair:${conflict.id}` }

  let newStatus = null
  try {
    newStatus = await getObjectStatus(gen1.platformAdId, systemToken)
  } catch (err) {
    if (isMissingObjectError(err)) return { ok: false, unknown: `replacement-ad-missing:${err.message}` }
    return { ok: false, transient: `Replacement ad preflight read failed: ${err.message}` }
  }
  const oldProbe = await reconcileExactMetaObject(gen0.platformAdId, systemToken)
  if (oldProbe.outcome === 'unknown') {
    return { ok: false, transient: `Gen-0 ad state unknown: ${oldProbe.error}` }
  }
  const oldMissing = oldProbe.outcome === 'missing'
  if (String(newStatus?.status || '').toUpperCase() !== 'PAUSED') {
    if (String(newStatus?.status || '').toUpperCase() === 'ACTIVE') {
      return { ok: true, page, adAccountId, systemToken, oldMissing, adoptedActive: true }
    }
    return { ok: false, fail: `replacement-ad-not-paused:${newStatus?.status}` }
  }
  const newIssues = normalizeIssuesInfo(newStatus?.issues_info)
  const blocking = newIssues.find((issue) => issue.errorType === 'HARD_ERROR')
  if (blocking) return { ok: false, fail: `replacement-blocked:${blocking.errorCode}` }

  return { ok: true, page, adAccountId, systemToken, oldMissing, adoptedActive: false }
}

export async function runRepairActivation(repairId) {
  await assertRepairMutationsAllowed()
  const loaded = await loadRepairContext(repairId)
  if (!loaded || !loaded.repair) return { done: true, ignored: 'repair-missing' }
  if (loaded.repair.status === REPAIR_STATUS.COMPLETED) {
    return { done: true, state: REPAIR_STATUS.COMPLETED }
  }
  if (!ACTIVATION_ENTRY_STATES.includes(loaded.repair.status)) {
    return { done: true, ignored: `repair-status-${loaded.repair.status}` }
  }
  await repairRepo.recordRepairRun(repairId, { attemptsIncrement: 1 })

  for (let step = 0; step < 12; step += 1) {
    const ctx = await loadRepairContext(repairId)
    if (!ctx || !ctx.repair) return { done: true, ignored: 'repair-missing' }
    const { repair, execution, campaign } = ctx
    if (!execution || !campaign) {
      await transitionRepair(repair, REPAIR_STATUS.FAILED, 'repair-context-incomplete')
      return { done: true, state: REPAIR_STATUS.FAILED }
    }

    if (repair.status === REPAIR_STATUS.COMPLETED) {
      return { done: true, state: REPAIR_STATUS.COMPLETED }
    }

    const staging = await findStagingGeneration(execution.id, repair.generationNo)
    if (!staging.generation) {
      await transitionRepair(repair, REPAIR_STATUS.FAILED, staging.ambiguous ? 'multiple-staging-generations' : 'no-staging-generation')
      return { done: true, state: REPAIR_STATUS.FAILED }
    }
    const gen1 = staging.generation
    const gen0 = await execRepo.findGenerationByExecutionIdAndNumber(execution.id, repair.generationNo)
    if (!gen0) {
      await transitionRepair(repair, REPAIR_STATUS.FAILED, 'gen0-missing')
      return { done: true, state: REPAIR_STATUS.FAILED }
    }
    const pointerLive = await execRepo.findExecutionById(execution.id)
    const gen0IsActive = pointerLive
      && Number(pointerLive.activeGenerationNo) === Number(gen0.generationNo)
    const failBoth = async (reason, metaErr = null) => failRepairAndGeneration(repair, gen1, reason, execution?.campaignId || null, metaErr)
    const unknownBoth = async (reason) => unknownRepairAndGeneration(repair, gen1, reason)

    if (repair.status === REPAIR_STATUS.NEW_VERIFIED) {
      if (!gen0IsActive) return failBoth('active-generation-changed')
      const pre = await activationPreflight({ repair, execution, campaign, gen0, gen1 })
      if (pre.transient) throw new Error(pre.transient)
      if (pre.unknown) return unknownBoth(pre.unknown)
      if (!pre.ok) {
        await logMetaEvent({
          campaignId: execution.campaignId,
          action: 'repair_preflight_failed',
          params: { repairId: repair.id, executionId: execution.id, objectId: repair.objectId, errorCode: repair.errorCode, reason: pre.fail },
        })
        return failBoth(pre.fail)
      }
      const claimed = await transitionRepair(repair, REPAIR_STATUS.NEW_ACTIVATING)
      if (!claimed) continue
      await recordRepairMetric('activation_started', { code: repair.errorCode, kind: execution.kind })
      continue
    }

    if (repair.status === REPAIR_STATUS.NEW_ACTIVATING) {
      if (!gen0IsActive) return failBoth('active-generation-changed')
      const pre = await activationPreflight({ repair, execution, campaign, gen0, gen1 })
      if (pre.transient) throw new Error(pre.transient)
      if (pre.unknown) return unknownBoth(pre.unknown)
      if (!pre.ok) return failBoth(pre.fail)
      const { systemToken } = pre
      let current = null
      try {
        current = await getObjectStatus(gen1.platformAdId, systemToken)
      } catch (err) {
        if (isMissingObjectError(err)) return unknownBoth(`replacement-ad-missing:${err.message}`)
        throw new Error(`Replacement ad read failed: ${err.message}`)
      }
      const currentStatus = String(current?.status || '').toUpperCase()
      if (currentStatus !== 'ACTIVE') {
        if (currentStatus !== 'PAUSED') return unknownBoth(`replacement-ad-unexpected:${currentStatus}`)
        if (!pre.adoptedActive) {
          const activateStart = Date.now()
          await assertRepairMutationsAllowed()
          try {
            await updateAdStatus(gen1.platformAdId, 'ACTIVE', systemToken)
          } catch (err) {
            const classification = classifyChainError(err).kind
            if (classification === 'permanent') return failBoth(`activate-new:${err.message}`, err)
            const probe = await reconcileExactMetaObject(gen1.platformAdId, systemToken)
            if (probe.outcome === 'missing') return unknownBoth(`replacement-ad-missing:${probe.error}`)
            if (probe.outcome !== 'present') throw new Error(`Replacement activation ambiguous: ${err.message}`)
            const observed = await getObjectStatus(gen1.platformAdId, systemToken).catch(() => null)
            if (String(observed?.status || '').toUpperCase() !== 'ACTIVE') {
              return unknownBoth('replacement-activation-unverifiable')
            }
          }
          await logMetaEvent({
            campaignId: execution.campaignId,
            action: 'new_activated',
            objectType: 'ad',
            objectId: gen1.platformAdId,
            params: { repairId: repair.id, executionId: execution.id, generationId: gen1.id, generationNo: gen1.generationNo, ownerId: execution.ownerUserId },
            durationMs: Date.now() - activateStart,
          })
        }
      }
      const readBack = await getObjectStatus(gen1.platformAdId, systemToken).catch(() => null)
      if (String(readBack?.status || '').toUpperCase() !== 'ACTIVE') {
        return unknownBoth('replacement-activation-unverifiable')
      }
      const readBackIssues = normalizeIssuesInfo(readBack?.issues_info)
      const blocking = readBackIssues.find((issue) => issue.errorType === 'HARD_ERROR')
      if (blocking) {
        try {
          await updateAdStatus(gen1.platformAdId, 'PAUSED', systemToken)
        } catch (pauseErr) {
          await logMetaEvent({ campaignId: execution.campaignId, action: 'repair_rollback_pause', params: { repairId: repair.id, error: pauseErr.message } })
        }
        return failBoth(`replacement-blocked-after-activation:${blocking.errorCode}`)
      }
      const advanced = await transitionRepair(repair, REPAIR_STATUS.NEW_ACTIVE_VERIFIED)
      if (!advanced) continue
      await logMetaEvent({
        campaignId: execution.campaignId,
        action: 'new_activation_verified',
        objectType: 'ad',
        objectId: gen1.platformAdId,
        params: { repairId: repair.id, executionId: execution.id, generationId: gen1.id, generationNo: gen1.generationNo, ownerId: execution.ownerUserId },
      })
      continue
    }

    if (repair.status === REPAIR_STATUS.NEW_ACTIVE_VERIFIED) {
      const advanced = await transitionRepair(repair, REPAIR_STATUS.OLD_PAUSING)
      if (!advanced) continue
      continue
    }

    if (repair.status === REPAIR_STATUS.OLD_PAUSING) {
      if (!gen0IsActive) return failBoth('active-generation-changed')
      const account = await getCampaignAccountContext(execution.campaignId).catch(() => ({}))
      if (!account?.accessToken) throw new Error('Meta account context unavailable for old pause')
      const oldProbe = await reconcileExactMetaObject(gen0.platformAdId, account.accessToken)
      if (oldProbe.outcome === 'missing') {
        await logMetaEvent({ campaignId: execution.campaignId, action: 'repair_old_already_gone', params: { repairId: repair.id, adId: gen0.platformAdId } })
      } else if (oldProbe.outcome !== 'present') {
        throw new Error(`Gen-0 ad state unknown: ${oldProbe.error}`)
      } else {
        let oldStatus = null
        try {
          oldStatus = await getObjectStatus(gen0.platformAdId, account.accessToken)
        } catch (err) {
          if (isMissingObjectError(err)) {
            await logMetaEvent({ campaignId: execution.campaignId, action: 'repair_old_already_gone', params: { repairId: repair.id, adId: gen0.platformAdId } })
          } else {
            throw new Error(`Gen-0 ad read failed: ${err.message}`)
          }
        }
        if (oldStatus && String(oldStatus.status || '').toUpperCase() !== 'PAUSED') {
          const pauseStart = Date.now()
          await assertRepairMutationsAllowed()
          try {
            await updateAdStatus(gen0.platformAdId, 'PAUSED', account.accessToken)
            await logMetaEvent({
              campaignId: execution.campaignId,
              action: 'old_paused',
              objectType: 'ad',
              objectId: gen0.platformAdId,
              params: { repairId: repair.id, executionId: execution.id, generationId: gen0.id, generationNo: gen0.generationNo, ownerId: execution.ownerUserId },
              durationMs: Date.now() - pauseStart,
            })
          } catch (err) {
            if (classifyChainError(err).kind === 'permanent' && !isMissingObjectError(err)) {
              return failBoth(`pause-old:${err.message}`, err)
            }
            const recheck = await reconcileExactMetaObject(gen0.platformAdId, account.accessToken)
            if (recheck.outcome === 'missing') {
              await logMetaEvent({ campaignId: execution.campaignId, action: 'repair_old_already_gone', params: { repairId: repair.id, adId: gen0.platformAdId } })
            } else if (recheck.outcome !== 'present') {
              throw new Error(`Gen-0 pause ambiguous: ${err.message}`)
    } else {
              const reread = await getObjectStatus(gen0.platformAdId, account.accessToken).catch(() => null)
              if (String(reread?.status || '').toUpperCase() !== 'PAUSED') {
                return unknownBoth('gen0-pause-unverifiable')
              }
            }
          }
          const readBack = await getObjectStatus(gen0.platformAdId, account.accessToken).catch(() => null)
          if (readBack && String(readBack.status || '').toUpperCase() !== 'PAUSED') {
            return unknownBoth('gen0-pause-unverifiable')
          }
          await logMetaEvent({
            campaignId: execution.campaignId,
            action: 'old_pause_verified',
            objectType: 'ad',
            objectId: gen0.platformAdId,
            params: { repairId: repair.id, executionId: execution.id, generationId: gen0.id, generationNo: gen0.generationNo, ownerId: execution.ownerUserId },
          })
        }
      }
      const advanced = await transitionRepair(repair, REPAIR_STATUS.OLD_PAUSED_VERIFIED)
      if (!advanced) continue
      continue
    }

    if (repair.status === REPAIR_STATUS.OLD_PAUSED_VERIFIED) {
      const freshExecution = await execRepo.findExecutionById(execution.id)
      const freshRepair = await repairRepo.findRepairById(repairId)
      const freshGen1 = (await execRepo.listGenerationsForExecution(execution.id))
        .find((gen) => Number(gen.generationNo) > 0 && gen.id === gen1.id)
      if (!freshRepair || freshRepair.status !== REPAIR_STATUS.OLD_PAUSED_VERIFIED || !freshGen1) {
        continue
      }
      if (Number(freshExecution.activeGenerationNo) === Number(freshGen1.generationNo)) {
        await convergePostPointer(repairId, execution.id, freshGen1)
        const advanced = await transitionRepair(freshRepair, REPAIR_STATUS.ACTIVE_POINTER_MOVED)
        if (!advanced) continue
        continue
      }
      if (Number(freshExecution.activeGenerationNo) !== Number(gen0.generationNo)) {
        return failBoth('active-generation-changed')
      }
      const moved = await execRepo.moveActiveGeneration(execution.id, gen0.generationNo, freshGen1.generationNo)
      if (moved !== 1) {
        continue
      }
      await execRepo.updateGenerationState(freshGen1.id, ['verified', 'creating', 'created'], 'active')
      await execRepo.updateGenerationState(gen0.id, ['active'], 'superseded')
      await repo.deactivateMissingMetaObjectIssues(execution.id, gen0.platformAdId, [])
      await recordRepairMetric('cutover_completed', { code: repair.errorCode, kind: execution.kind })
      await logMetaEvent({
        campaignId: execution.campaignId,
        action: 'active_pointer_moved',
        params: {
          repairId: repair.id, executionId: execution.id, ownerId: execution.ownerUserId,
          fromGenerationNo: gen0.generationNo, toGenerationNo: freshGen1.generationNo,
          fromAdId: gen0.platformAdId, toAdId: freshGen1.platformAdId,
        },
      })
      const advanced = await transitionRepair(freshRepair, REPAIR_STATUS.ACTIVE_POINTER_MOVED)
      if (!advanced) continue
      continue
    }

    if (repair.status === REPAIR_STATUS.ACTIVE_POINTER_MOVED) {
      await convergePostPointer(repairId, execution.id, gen1)
      await logMetaEvent({
        campaignId: execution.campaignId,
        action: 'old_cleanup_started',
        params: { repairId: repair.id, executionId: execution.id, ownerId: execution.ownerUserId, generationId: gen1.id, oldAdId: gen0.platformAdId, oldCreativeId: gen0.platformCreativeId },
      })
      const advanced = await transitionRepair(repair, REPAIR_STATUS.OLD_CLEANUP)
      if (!advanced) continue
      continue
    }

    if (repair.status === REPAIR_STATUS.OLD_CLEANUP) {
      const account = await getCampaignAccountContext(execution.campaignId).catch(() => ({}))
      if (!account?.accessToken) throw new Error('Meta account context unavailable for cleanup')
      await assertRepairMutationsAllowed()
      let finalCheck = null
      try {
        finalCheck = await getObjectStatus(gen1.platformAdId, account.accessToken)
      } catch (err) {
        if (isMissingObjectError(err)) return failBoth('replacement-missing-at-cleanup')
        throw new Error(`Replacement final read failed: ${err.message}`)
      }
      const finalIssues = normalizeIssuesInfo(finalCheck?.issues_info)
      if (finalIssues.some((issue) => issue.errorCode === repair.errorCode)) {
        return failBoth(`issue-persists-post-cutover:${repair.errorCode}`)
      }
      const skipped = []
      const cleanupStart = Date.now()
      try {
        await deleteAd(gen0.platformAdId, account.accessToken)
        await repo.saveMetaObjectStatus(gen0.platformAdId, 'DELETED').catch(() => {})
        await logMetaEvent({
          campaignId: execution.campaignId, action: 'old_object_deleted', objectType: 'ad', objectId: gen0.platformAdId,
          params: { repairId: repair.id, executionId: execution.id, ownerId: execution.ownerUserId, generationId: gen0.id, generationNo: gen0.generationNo },
          durationMs: Date.now() - cleanupStart,
        })
      } catch (err) {
        if (!isMissingObjectError(err)) {
          await logMetaEvent({ campaignId: execution.campaignId, action: 'repair_cleanup_retry', params: { repairId: repair.id, executionId: execution.id, objectId: gen0.platformAdId, error: err.message } })
          await recordRepairMetric('cleanup_retry', { code: repair.errorCode, kind: execution.kind })
          return { done: true, state: REPAIR_STATUS.OLD_CLEANUP, retryable: true }
        }
      }
      if (gen0.platformCreativeId && gen0.platformCreativeId !== gen1.platformCreativeId) {
        let referenced = false
        try {
          const { rows } = await listAdSetAds(gen0.platformAdsetId, account.accessToken)
          referenced = (rows || []).some((row) => row.id !== gen0.platformAdId && String(row.creative?.id) === String(gen0.platformCreativeId))
        } catch (err) {
          await logMetaEvent({ campaignId: execution.campaignId, action: 'repair_cleanup', params: { repairId: repair.id, error: err.message } })
          await recordRepairMetric('cleanup_retry', { code: repair.errorCode, kind: execution.kind })
          return { done: true, state: REPAIR_STATUS.OLD_CLEANUP, retryable: true }
        }
        if (referenced) {
          skipped.push(`creative:${gen0.platformCreativeId}:referenced`)
          await logMetaEvent({ campaignId: execution.campaignId, action: 'repair_cleanup_skip', params: { repairId: repair.id, creativeId: gen0.platformCreativeId } })
        } else {
          const creativeStart = Date.now()
          try {
            await deleteAdCreative(gen0.platformCreativeId, account.accessToken)
            await repo.saveMetaObjectStatus(gen0.platformCreativeId, 'DELETED').catch(() => {})
            await logMetaEvent({
              campaignId: execution.campaignId, action: 'old_object_deleted', objectType: 'ad_creative', objectId: gen0.platformCreativeId,
              params: { repairId: repair.id, executionId: execution.id, ownerId: execution.ownerUserId, generationId: gen0.id, generationNo: gen0.generationNo },
              durationMs: Date.now() - creativeStart,
            })
          } catch (err) {
            if (!isMissingObjectError(err)) {
              await logMetaEvent({ campaignId: execution.campaignId, action: 'repair_cleanup_retry', params: { repairId: repair.id, executionId: execution.id, objectId: gen0.platformCreativeId, error: err.message } })
              await recordRepairMetric('cleanup_retry', { code: repair.errorCode, kind: execution.kind })
              return { done: true, state: REPAIR_STATUS.OLD_CLEANUP, retryable: true }
            }
          }
        }
      }
      const completed = await transitionRepair(repair, REPAIR_STATUS.COMPLETED)
      if (!completed) continue
      await recordRepairMetric('cleanup_completed', { code: repair.errorCode, kind: execution.kind })
      await logMetaEvent({ campaignId: execution.campaignId, action: 'repair_completed', params: { repairId: repair.id, executionId: execution.id, skipped } })
      return { done: true, state: REPAIR_STATUS.COMPLETED, skipped }
    }

    return { done: true, ignored: `repair-status-${repair.status}` }
  }
  return { done: true, ignored: 'repair-loop-exhausted' }
}

async function convergePostPointer(repairId, executionId, gen1) {
  const execution = await execRepo.findExecutionById(executionId)
  if (!execution || Number(execution.activeGenerationNo) !== Number(gen1.generationNo)) return false
  await execRepo.updateGenerationState(gen1.id, ['verified', 'creating', 'created'], 'active')
  const gens = await execRepo.listGenerationsForExecution(executionId)
  for (const gen of gens) {
    if (Number(gen.generationNo) !== Number(gen1.generationNo) && gen.status === 'active') {
      await execRepo.updateGenerationState(gen.id, ['active'], 'superseded')
    }
    if (Number(gen.generationNo) !== Number(gen1.generationNo) && gen.platformAdId) {
      await repo.deactivateMissingMetaObjectIssues(executionId, gen.platformAdId, [])
    }
  }
  return true
}

const CREATION_MID_STATES = [
  REPAIR_STATUS.READY_FOR_CREATION,
  REPAIR_STATUS.CREATIVE_CREATED,
  REPAIR_STATUS.AD_CREATED,
  REPAIR_STATUS.NEW_VERIFIED,
  REPAIR_STATUS.NEW_ACTIVE,
  REPAIR_STATUS.OLD_PAUSED,
]

function describeMetaError(err) {
  if (!err) return {}
  try {
    const detail = extractMetaError(err)
    if (!detail) return { message: err.message || String(err) }
    return { message: detail.userMsg || detail.raw || err.message, code: detail.code ?? null, subcode: detail.subcode ?? null }
  } catch {
    return { message: err?.message || String(err) }
  }
}

async function failRepairAndGeneration(repair, generation, reason, campaignId = null, metaErr = null) {
  if (generation) {
    await execRepo.updateGenerationState(generation.id, ['creating', 'created', 'verified', 'unknown'], 'failed')
  }
  const failed = await transitionRepair(repair, REPAIR_STATUS.FAILED, reason)
  if (metaErr) {
    try {
      const detail = describeMetaError(metaErr)
      if (detail.code !== null && detail.code !== undefined) {
        await recordRepairMetric('repair_meta_error', {
          code: repair.errorCode, metaCode: detail.code, metaSubcode: detail.subcode,
        })
      }
    } catch {
      // metrics must never break repair flows
    }
  }
  await logMetaEvent({
    campaignId,
    action: 'repair_failed',
    params: {
      repairId: repair.id,
      executionId: repair.executionId,
      generationId: generation?.id || null,
      generationNo: generation?.generationNo ?? null,
      objectId: repair.objectId,
      errorCode: repair.errorCode,
      reason,
      ...describeMetaError(metaErr),
    },
  })
  return { done: true, state: REPAIR_STATUS.FAILED, generation: generation?.id || null }
}

async function unknownRepairAndGeneration(repair, generation, reason) {
  if (generation) {
    await execRepo.updateGenerationState(generation.id, ['creating', 'created', 'verified'], 'unknown')
  }
  await transitionRepair(repair, REPAIR_STATUS.UNKNOWN, reason)
  await logMetaEvent({
    campaignId: null,
    action: 'repair_unknown',
    params: {
      repairId: repair.id,
      executionId: repair.executionId,
      generationId: generation?.id || null,
      generationNo: generation?.generationNo ?? null,
      objectId: repair.objectId,
      errorCode: repair.errorCode,
      reason,
    },
  })
  return { done: true, state: REPAIR_STATUS.UNKNOWN }
}

async function cleanupStagingObjects(generation, accessToken) {
  await assertRepairMutationsAllowed()
  const cleaned = []
  if (generation?.platformAdId) {
    try {
      await deleteAd(generation.platformAdId, accessToken)
      cleaned.push(`ad:${generation.platformAdId}`)
    } catch (err) {
      if (!isMissingObjectError(err)) {
        await logMetaEvent({ action: 'repair_cleanup', params: { objectId: generation.platformAdId, error: err.message } })
      } else {
        cleaned.push(`ad:${generation.platformAdId}:already-gone`)
      }
    }
  }
  if (generation?.platformCreativeId) {
    try {
      await deleteAdCreative(generation.platformCreativeId, accessToken)
      cleaned.push(`creative:${generation.platformCreativeId}`)
    } catch (err) {
      if (!isMissingObjectError(err)) {
        await logMetaEvent({ action: 'repair_cleanup', params: { objectId: generation.platformCreativeId, error: err.message } })
      } else {
        cleaned.push(`creative:${generation.platformCreativeId}:already-gone`)
      }
    }
  }
  return cleaned
}

export async function findRepairCreative({ adAccountId, accessToken, name, link, videoId = null, videoOnly = false, pageId }) {
  const { rows } = await listAccountCreatives(adAccountId, accessToken)
  const matches = (rows || []).filter((row) => {
    const rowName = String(row.name || '')
    if (rowName !== name && !rowName.startsWith(`${name} `)) return false
    const spec = row.object_story_spec || {}
    if (pageId && spec.page_id !== undefined && spec.page_id !== null && String(spec.page_id) !== String(pageId)) return false
    if (videoId || videoOnly) {
      const rowVideoId = spec.video_data?.video_id ?? null
      if (videoId && String(rowVideoId) !== String(videoId)) return false
      if (videoOnly && (rowVideoId === null || rowVideoId === undefined)) return false
      return true
    }
    if (link && spec.link_data && spec.link_data.link !== undefined && spec.link_data.link !== null && String(spec.link_data.link) !== String(link)) return false
    return true
  })
  if (!matches.length) return { outcome: 'absent' }
  if (matches.length > 1) return { outcome: 'ambiguous', count: matches.length }
  return { outcome: 'found', id: matches[0].id }
}

export async function findRepairAd({ adsetId, accessToken, name, creativeId }) {
  const { rows } = await listAdSetAds(adsetId, accessToken)
  const matches = (rows || []).filter((row) => {
    if (name && row.name !== name) return false
    if (creativeId && String(row.creative?.id) !== String(creativeId)) return false
    return true
  })
  if (!matches.length) return { outcome: 'absent' }
  if (matches.length > 1) return { outcome: 'ambiguous', count: matches.length }
  return { outcome: 'found', id: matches[0].id, row: matches[0] }
}

async function persistGenerationObjects(generation, data) {
  const won = await execRepo.updateGenerationObjects(generation.id, ['creating'], data)
  if (won !== 1) return null
  return execRepo.findGenerationById(generation.id)
}

export async function runRepairCreation(repairId) {
  await assertRepairMutationsAllowed()
  const ctx = await loadRepairContext(repairId)
  if (!ctx || !ctx.repair) return { done: true, ignored: 'repair-missing' }
  let { repair, execution, generation, campaign } = ctx
  if (repair.status !== REPAIR_STATUS.READY_FOR_CREATION) {
    return { done: true, ignored: `repair-status-${repair.status}` }
  }
  if (!await isRepairExecutionEnabled()) {
    return { done: true, gated: true, state: repair.status }
  }
  await repairRepo.recordRepairRun(repair.id, { attemptsIncrement: 1 })

  const failClosed = async (reason, metaErr = null) => failRepairAndGeneration(repair, generation, reason, execution?.campaignId || null, metaErr)
  const unknownClosed = async (reason) => unknownRepairAndGeneration(repair, generation, reason)
  const failPreflight = async (reason) => {
    await logMetaEvent({
      campaignId: execution?.campaignId || null,
      action: 'repair_preflight_failed',
      params: { repairId: repair.id, executionId: execution?.id || null, objectId: repair.objectId, errorCode: repair.errorCode, reason },
    })
    return failClosed(reason)
  }

  if (!execution || !campaign) return failPreflight('repair-context-incomplete')
  if (['cancelled', 'completed'].includes(execution.status)) return failPreflight(`execution-${execution.status}`)
  if (!['running', 'paused'].includes(campaign.status)) return failPreflight(`campaign-${campaign.status}-not-live`)
  if (campaign.settledAt) return failPreflight('campaign-settled')
  if (!generation || Number(generation.generationNo) !== Number(execution.activeGenerationNo)) {
    return failPreflight('repair-generation-not-active')
  }

  const siblings = await repairRepo.listRepairsForExecution(execution.id)
  const conflict = siblings.find((row) => row.id !== repair.id && row.objectId === repair.objectId && [...CREATION_MID_STATES, ...ACTIVATION_MID_STATES].includes(row.status))
  if (conflict) return failPreflight(`conflicting-repair:${conflict.id}`)

  const page = await repo.findVerifiedFacebookPage(execution.ownerUserId).catch(() => null)
  if (!page) return failPreflight('owner-page-unavailable')
  if (execution.fbPageId && String(page.platformUserId) !== String(execution.fbPageId)) {
    return failPreflight('page-rotated')
  }
  const account = await getCampaignAccountContext(execution.campaignId).catch(() => ({}))
  const adAccountId = account?.accountId || null
  const systemToken = account?.accessToken || null
  if (!adAccountId || !systemToken) {
    throw new Error('Meta account context unavailable for repair creation')
  }
  if (execution.adAccountActId && String(execution.adAccountActId) !== String(adAccountId)
    && String(execution.adAccountActId) !== `act_${adAccountId}`) {
    return failPreflight('account-rotated')
  }

  const oldProbe = await reconcileExactMetaObject(generation.platformAdId, systemToken)
  if (oldProbe.outcome === 'missing') {
    return unknownClosed(`Target ad missing on Meta: ${oldProbe.error}`)
  }
  if (oldProbe.outcome === 'unknown') {
    throw new Error(`Repair target ad state unknown: ${oldProbe.error}`)
  }

  let statusData = null
  try {
    statusData = await getObjectStatus(generation.platformAdId, systemToken)
  } catch (err) {
    if (isMissingObjectError(err)) return unknownClosed(`Target ad missing on Meta: ${err.message}`)
    throw new Error(`Repair creation preflight read failed: ${err.message}`)
  }
  // CLIENT_EDIT has no corresponding Meta issue to re-verify against — the
  // client is proactively amending content, not reacting to a live Meta
  // signal, so this check only applies to Meta-issue-driven repairs.
  if (repair.errorCode !== CLIENT_EDIT_ERROR_CODE) {
    const live = normalizeIssuesInfo(statusData?.issues_info)
    if (!live.some((issue) => issue.errorCode === repair.errorCode)) {
      return failPreflight(`issue-changed:${live.map((issue) => issue.errorCode).join(',') || 'none'}`)
    }
  }

  const metaSettingsForMedia = await repo.findMetaSettingsByCampaignId(execution.campaignId)
  let reprobed = null
  try {
    reprobed = await resolveRepairMedia({
      mediaAssetId: repair.mediaAssetId,
      mediaUrl: repair.mediaUrl,
      ownerUserId: execution.ownerUserId,
      platformPlacement: metaSettingsForMedia?.platformPlacement,
    })
  } catch (err) {
    return failPreflight(repair.mediaAssetId
      ? `replacement-media-invalid:${err.message}`
      : `replacement-media-unavailable:${err.message}`)
  }
  if (!repair.mediaAssetId
    && (reprobed.mediaWidth !== repair.mediaWidth || reprobed.mediaHeight !== repair.mediaHeight)) {
    return failPreflight(`replacement-media-changed:${reprobed.mediaWidth}x${reprobed.mediaHeight}`)
  }
  const repairMediaKind = reprobed?.mediaKind || 'image'
  const creativeMatch = repairMediaKind === 'video'
    ? { videoOnly: true }
    : { link: repair.mediaUrl }

  const frozen = await repo.findCampaignSnapshot(execution.campaignId)
  if (!frozen) return failPreflight('missing-frozen-snapshot')
  if (frozen.graphVersion !== liveGraphVersion()) {
    return failPreflight(`snapshot-version-mismatch:${frozen.graphVersion || 'none'}`)
  }
  const [liveCampaign, liveCreative, liveSettings] = await Promise.all([
    repo.findCampaignById(execution.campaignId),
    repo.findCreativeByCampaignId(execution.campaignId),
    repo.findMetaSettingsByCampaignId(execution.campaignId),
  ])
  const liveResolved = resolveCampaignSnapshot({ campaign: liveCampaign, creative: liveCreative, metaSettings: liveSettings })
  if (!liveResolved.ok) return failPreflight(`unresolvable-live-config:${liveResolved.reason}`)
  const diff = diffRepairSnapshot({ repair, frozenConfig: frozen.config, liveConfig: liveResolved.config })
  if (!diff.ok) return failPreflight(`snapshot-diff:${diff.reason}`)

  // Scoped to generations beyond the one THIS repair is replacing
  // (repair.generationNo — the baseline recorded at request time), not
  // "any generation with number > 0": a prior, already-completed repair on
  // this same execution left its own generation active at a number <=
  // repair.generationNo, which must never be confused with — or block —
  // this repair's own replacement. For a fresh execution's first-ever
  // repair (generationNo 0) this is identical to the original `> 0` filter.
  const allGenerations = await execRepo.listGenerationsForExecution(execution.id)
  const newer = allGenerations.filter((gen) => Number(gen.generationNo) > Number(repair.generationNo))
  // Only a NON-TERMINAL "newer" generation is safe to adopt — that's a
  // crashed/resumed build of THIS same repair (a genuinely concurrent
  // conflicting repair is caught by the siblings/CREATION_MID_STATES check
  // above, so a non-terminal one found here can only be this repair's own).
  // A TERMINAL one (failed/superseded/active) here means a completely
  // different, already-resolved-or-abandoned repair left it behind — e.g.
  // an earlier repair attempt that failed outright, never went active, and
  // was never cleaned up. Adopting that dead generation's stale Meta
  // object references (rather than building a genuinely fresh one) is
  // exactly what caused "replacement-ad-identity-unverifiable": the old,
  // abandoned ad from the failed attempt doesn't reliably resolve anymore.
  let next = newer.filter((gen) => NON_TERMINAL_GENERATION_STATUSES.includes(gen.status))
    .sort((a, b) => b.generationNo - a.generationNo)[0] || null
  if (!next) {
    const nextNo = (allGenerations.length ? Math.max(...allGenerations.map((gen) => Number(gen.generationNo))) : Number(repair.generationNo)) + 1
    try {
      const genId = await execRepo.createGeneration({
        executionId: execution.id,
        generationNo: nextNo,
        status: 'creating',
        platformCampaignId: generation.platformCampaignId,
        platformAdsetId: generation.platformAdsetId,
        platformCreativeId: null,
        platformAdId: null,
      })
      next = await execRepo.findGenerationById(genId)
      await recordRepairMetric('creation_started', { code: repair.errorCode, kind: execution.kind })
      await logMetaEvent({
        campaignId: execution.campaignId,
        action: 'generation_staged',
        params: {
          repairId: repair.id,
          executionId: execution.id,
          ownerId: execution.ownerUserId,
          generationId: genId,
          generationNo: nextNo,
          metaCampaignId: generation.platformCampaignId,
          adsetId: generation.platformAdsetId,
        },
      })
    } catch (err) {
      if (err?.code !== 'ER_DUP_ENTRY') throw err
      // A genuine race: another process just inserted the same nextNo.
      // That row is, by construction, a live concurrent attempt — filter
      // to non-terminal the same way the primary lookup does, so we never
      // adopt something that raced in and already failed by the time we
      // re-read it.
      const relist = await execRepo.listGenerationsForExecution(execution.id)
      next = relist.filter((gen) => Number(gen.generationNo) > Number(repair.generationNo) && NON_TERMINAL_GENERATION_STATUSES.includes(gen.status))
        .sort((a, b) => b.generationNo - a.generationNo)[0] || null
      if (!next) throw new Error('Replacement generation lost after duplicate insert')
    }
  }
  generation = next

  const emitObjectEvent = async (action, objectType, objectId, extra = {}) => {
    // A repair's new/adopted creative and ad only ever get persisted onto
    // the campaign_execution_generations row — the legacy campaign_status
    // sync pipeline (syncCampaignStatusJob/syncAccountStatusJob) still reads
    // its candidate ad ids from campaign_meta_objects via findActiveSyncAd's
    // generation-index filter, so without this row that pipeline has no
    // object matching the now-active generation and silently stops syncing
    // this campaign forever (last_meta_sync_at freezes at whatever error was
    // last observed on the pre-repair ad). Mirrors the create-path's own
    // dual-write (appendExecutionObjectAudit in buildOwnerMetaChain).
    await execRepo.appendExecutionObjectAudit(execution.campaignId, execution.ownerUserId, { [objectType]: objectId })
    await logMetaEvent({
      campaignId: execution.campaignId,
      action,
      objectType,
      objectId,
      params: {
        repairId: repair.id,
        executionId: execution.id,
        ownerId: execution.ownerUserId,
        generationId: generation.id,
        generationNo: generation.generationNo,
        attempt: repair.attempts,
        ...extra,
      },
    })
  };

  const frozenCreative = { ...frozen.config.creative, ...(repair.amendmentCreative || {}) }
  const creativeMessage = frozenCreative.caption || frozenCreative.textBody || frozen.config.campaign.name
  const creativeName = buildRepairCreativeName(repair.id, generation.generationNo)
  const adName = buildRepairAdName(repair.id, generation.generationNo)
  const creativeArgs = [
    adAccountId,
    page.platformUserId,
    creativeMessage,
    repair.mediaUrl,
    frozenCreative.callToAction || null,
    systemToken,
    { headline: frozenCreative.headline || null, description: frozenCreative.description || null, name: creativeName },
  ]

  if (!generation.platformCreativeId) {
    const existing = await findRepairCreative({
      adAccountId, accessToken: systemToken, name: creativeName, ...creativeMatch, pageId: page.platformUserId,
    })
    if (existing.outcome === 'ambiguous') {
      await cleanupStagingObjects(generation, systemToken)
      return failClosed(`ambiguous-replacement-creative:${existing.count}`)
    }
    if (existing.outcome === 'found') {
      generation = await persistGenerationObjects(generation, { platformCreativeId: existing.id })
      if (!generation) throw new Error('Replacement generation lost during creative adoption')
      await emitObjectEvent('creative_adopted', 'ad_creative', existing.id)
    } else if (repairMediaKind === 'video') {
      await assertRepairMutationsAllowed()
      let stagedVideoId = null
      try {
        const uploaded = await uploadRepairVideoFromUrl(adAccountId, { fileUrl: repair.mediaUrl, name: `Repair video ${creativeName}` }, systemToken)
        stagedVideoId = uploaded?.videoId || null
        if (!stagedVideoId) throw new Error('Video upload returned no id')
      } catch (err) {
        const classification = classifyChainError(err).kind
        if (classification === 'permanent') {
          return failClosed(`upload-video:${err.message}`, err)
        }
        throw new Error(`Replacement video upload failed: ${err.message}`)
      }
      try {
        await waitForAdVideoReady(stagedVideoId, systemToken)
      } catch (err) {
        if (isMissingObjectError(err)) {
          return unknownClosed(`staged-video-unverifiable:${err.message}`)
        }
        if (classifyChainError(err).kind === 'permanent') {
          await deleteAdVideo(stagedVideoId, systemToken).catch(() => {})
          return failClosed(`video-not-ready:${err.message}`, err)
        }
        throw new Error(`Replacement video readiness failed: ${err.message}`)
      }
      const videoCreativeArgs = [
        adAccountId,
        page.platformUserId,
        creativeMessage,
        null,
        frozenCreative.callToAction || null,
        systemToken,
        { headline: frozenCreative.headline || null, description: frozenCreative.description || null, name: creativeName, video: { videoId: stagedVideoId } },
      ]
      try {
        await createAdCreative(...videoCreativeArgs, true)
      } catch (err) {
        const classification = classifyChainError(err).kind
        if (classification === 'permanent') {
          await deleteAdVideo(stagedVideoId, systemToken).catch(() => {})
          return failClosed(`validate-creative:${err.message}`, err)
        }
        throw new Error(`Replacement creative validation failed: ${err.message}`)
      }
      let createdId = null
      await assertRepairMutationsAllowed()
      try {
        const created = await createAdCreative(...videoCreativeArgs)
        createdId = created?.id || null
        if (!createdId) throw new Error('Creative creation returned no id')
      } catch (err) {
        const classification = classifyChainError(err).kind
        if (classification === 'permanent') {
          await deleteAdVideo(stagedVideoId, systemToken).catch(() => {})
          return failClosed(`create-creative:${err.message}`, err)
        }
        if (classification === 'transient') {
          throw new Error(`Replacement creative creation failed transiently: ${err.message}`)
        }
        const recheck = await findRepairCreative({
          adAccountId, accessToken: systemToken, name: creativeName, videoId: stagedVideoId, pageId: page.platformUserId,
        })
        if (recheck.outcome === 'found') {
          createdId = recheck.id
        } else if (recheck.outcome === 'ambiguous') {
          await deleteAdVideo(stagedVideoId, systemToken).catch(() => {})
          return failClosed(`ambiguous-replacement-creative:${recheck.count}`)
        } else {
          return unknownClosed(`create-creative-unknown:${err.message}`)
        }
      }
      generation = await persistGenerationObjects(generation, { platformCreativeId: createdId })
      if (!generation) throw new Error('Replacement generation lost after creative creation')
      await emitObjectEvent('creative_created', 'ad_creative', createdId)
    } else {
      try {
        await createAdCreative(...creativeArgs, true)
      } catch (err) {
        const classification = classifyChainError(err).kind
        if (classification === 'permanent') {
          return failClosed(`validate-creative:${err.message}`, err)
        }
        throw new Error(`Replacement creative validation failed: ${err.message}`)
      }
      let createdId = null
      await assertRepairMutationsAllowed()
      try {
        const created = await createAdCreative(...creativeArgs)
        createdId = created?.id || null
        if (!createdId) throw new Error('Creative creation returned no id')
      } catch (err) {
        const classification = classifyChainError(err).kind
        if (classification === 'permanent') {
          return failClosed(`create-creative:${err.message}`, err)
        }
        if (classification === 'transient') {
          throw new Error(`Replacement creative creation failed transiently: ${err.message}`)
        }
        const recheck = await findRepairCreative({
          adAccountId, accessToken: systemToken, name: creativeName, link: repair.mediaUrl, pageId: page.platformUserId,
        })
        if (recheck.outcome === 'found') {
          createdId = recheck.id
        } else if (recheck.outcome === 'ambiguous') {
          return failClosed(`ambiguous-replacement-creative:${recheck.count}`)
        } else {
          return unknownClosed(`create-creative-unknown:${err.message}`)
        }
      }
      generation = await persistGenerationObjects(generation, { platformCreativeId: createdId })
      if (!generation) throw new Error('Replacement generation lost after creative creation')
      await emitObjectEvent('creative_created', 'ad_creative', createdId)
    }
    const advanced = await transitionRepair(repair, REPAIR_STATUS.CREATIVE_CREATED)
    if (!advanced) throw new Error('Repair transition lost after creative creation')
    repair = advanced
  } else {
    const probe = await reconcileExactMetaObject(generation.platformCreativeId, systemToken)
    if (probe.outcome === 'missing') {
      const recheck = await findRepairCreative({
        adAccountId, accessToken: systemToken, name: creativeName, ...creativeMatch, pageId: page.platformUserId,
      })
      if (recheck.outcome === 'found' && recheck.id !== generation.platformCreativeId) {
        generation = await persistGenerationObjects(generation, { platformCreativeId: recheck.id })
        if (!generation) throw new Error('Replacement generation lost during creative re-adoption')
        await emitObjectEvent('creative_adopted', 'ad_creative', recheck.id)
      } else if (recheck.outcome !== 'found') {
        return unknownClosed('staged-creative-unverifiable')
      }
    } else if (probe.outcome !== 'present') {
      throw new Error(`Staged creative state unknown: ${probe.error}`)
    }
    if (repair.status === REPAIR_STATUS.READY_FOR_CREATION) {
      const advanced = await transitionRepair(repair, REPAIR_STATUS.CREATIVE_CREATED)
      if (!advanced) throw new Error('Repair transition lost on creative resume')
      repair = advanced
    }
  }

  if (!generation.platformAdId) {
    const existing = await findRepairAd({
      adsetId: generation.platformAdsetId, accessToken: systemToken, name: adName, creativeId: generation.platformCreativeId,
    })
    if (existing.outcome === 'ambiguous') {
      await cleanupStagingObjects(generation, systemToken)
      return failClosed(`ambiguous-replacement-ad:${existing.count}`)
    }
    if (existing.outcome === 'found') {
      generation = await persistGenerationObjects(generation, { platformAdId: existing.id })
      if (!generation) throw new Error('Replacement generation lost during ad adoption')
      await emitObjectEvent('ad_adopted', 'ad', existing.id)
    } else {
      const urlTags = buildUrlTags(frozenCreative)
      try {
        await createAd(adAccountId, generation.platformAdsetId, generation.platformCreativeId, adName, systemToken, 'PAUSED', { urlTags }, true)
      } catch (err) {
        const classification = classifyChainError(err).kind
        if (classification === 'permanent') {
          await cleanupStagingObjects(generation, systemToken)
          return failClosed(`validate-ad:${err.message}`, err)
        }
        throw new Error(`Replacement ad validation failed: ${err.message}`)
      }
      let createdAdId = null
      await assertRepairMutationsAllowed()
      try {
        const created = await createAd(adAccountId, generation.platformAdsetId, generation.platformCreativeId, adName, systemToken, 'PAUSED', { urlTags })
        createdAdId = created?.id || null
        if (!createdAdId) throw new Error('Ad creation returned no id')
      } catch (err) {
        const classification = classifyChainError(err).kind
        if (classification === 'permanent') {
          await cleanupStagingObjects(generation, systemToken)
          return failClosed(`create-ad:${err.message}`, err)
        }
        if (classification === 'transient') {
          throw new Error(`Replacement ad creation failed transiently: ${err.message}`)
        }
        const recheck = await findRepairAd({
          adsetId: generation.platformAdsetId, accessToken: systemToken, name: adName, creativeId: generation.platformCreativeId,
        })
        if (recheck.outcome === 'found') {
          createdAdId = recheck.id
        } else if (recheck.outcome === 'ambiguous') {
          await cleanupStagingObjects(generation, systemToken)
          return failClosed(`ambiguous-replacement-ad:${recheck.count}`)
        } else {
          return unknownClosed(`create-ad-unknown:${err.message}`)
        }
      }
      generation = await persistGenerationObjects(generation, { platformAdId: createdAdId })
      if (!generation) throw new Error('Replacement generation lost after ad creation')
      await emitObjectEvent('ad_created', 'ad', createdAdId)
    }
    const advanced = await transitionRepair(repair, REPAIR_STATUS.AD_CREATED)
    if (!advanced) throw new Error('Repair transition lost after ad creation')
    repair = advanced
  } else {
    const probe = await reconcileExactMetaObject(generation.platformAdId, systemToken)
    if (probe.outcome === 'missing') {
      return unknownClosed('staged-ad-unverifiable')
    }
    if (probe.outcome !== 'present') {
      throw new Error(`Staged ad state unknown: ${probe.error}`)
    }
    if (repair.status === REPAIR_STATUS.CREATIVE_CREATED) {
      const advanced = await transitionRepair(repair, REPAIR_STATUS.AD_CREATED)
      if (!advanced) throw new Error('Repair transition lost on ad resume')
      repair = advanced
    }
  }

  let verifyData = null
  try {
    verifyData = await getObjectStatus(generation.platformAdId, systemToken)
  } catch (err) {
    if (isMissingObjectError(err)) return unknownClosed(`Replacement ad missing on verify: ${err.message}`)
    throw new Error(`Replacement ad verify read failed: ${err.message}`)
  }
  const adRow = await findRepairAd({
    adsetId: generation.platformAdsetId, accessToken: systemToken, name: adName, creativeId: generation.platformCreativeId,
  })
  if (adRow.outcome !== 'found' || adRow.id !== generation.platformAdId) {
    return unknownClosed('replacement-ad-identity-unverifiable')
  }
  const verifyStatus = String(verifyData?.status || '').toUpperCase()
  const verifyEffective = String(verifyData?.effective_status || '').toUpperCase()
  if (verifyStatus !== 'PAUSED') {
    return failClosed(`replacement-ad-not-paused:${verifyStatus}`)
  }
  if (verifyEffective === 'DISAPPROVED') {
    await cleanupStagingObjects(generation, systemToken)
    return failClosed('replacement-ad-disapproved')
  }
  const verifyIssues = normalizeIssuesInfo(verifyData?.issues_info)
  if (verifyIssues.some((issue) => issue.errorCode === repair.errorCode)) {
    await cleanupStagingObjects(generation, systemToken)
    return failClosed(`issue-persists:${repair.errorCode}`)
  }
  const blocking = verifyIssues.find((issue) => issue.errorType === 'HARD_ERROR')
  if (blocking) {
    await cleanupStagingObjects(generation, systemToken)
    return failClosed(`replacement-hard-error:${blocking.errorCode}`)
  }

  const amendment = diffRepairSnapshot({ repair, frozenConfig: frozen.config, liveConfig: liveResolved.config })
  if (!amendment.ok) {
    return failClosed(`snapshot-amendment:${amendment.reason}`)
  }
  await repairRepo.stampRepairAmendment(repair.id, { config: amendment.config, hash: amendment.hash })
  await execRepo.updateGenerationState(generation.id, ['creating'], 'created')
  const verifiedGen = await execRepo.updateGenerationState(generation.id, ['created'], 'verified')
  if (verifiedGen !== 1) {
    return failClosed('generation-verify-transition-lost')
  }
  const verified = await transitionRepair(repair, REPAIR_STATUS.NEW_VERIFIED)
  if (!verified) {
    return failClosed('repair-verify-transition-lost')
  }
  await recordRepairMetric('new_verified', { code: repair.errorCode, kind: execution.kind })
  await logMetaEvent({
    campaignId: execution.campaignId,
    action: 'repair_verified',
    params: { repairId: repair.id, executionId: execution.id, generationNo: generation.generationNo, adId: generation.platformAdId, creativeId: generation.platformCreativeId },
  })
  return { done: true, state: REPAIR_STATUS.NEW_VERIFIED, generation: generation.id }
}
