import * as execRepo from './campaign-execution.repository.js'
import * as campaignRepo from './campaign.repository.js'
import { EXECUTION_KIND, EXECUTION_STATUS } from './campaign-execution.model.js'
import { META_CONFIG } from '../../../shared/services/meta-oauth.config.js'
import { hashConfig } from '../../../shared/services/snapshot.js'
import { transaction } from '../../../shared/database/connection.js'
import { ConflictError, NotFoundError, ValidationError } from '../../../shared/errors/AppError.js'
import * as coinService from '../../../shared/services/coin.service.js'

const CHAIN_TYPES = ['facebook_campaign', 'ad_set', 'ad_creative', 'ad']

const TERMINAL_PARENT_COMPLETED = new Set(['completed', 'cancelled', 'archived'])

function latestChainForOwner(objects) {
  const sorted = [...objects].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  const chain = {}
  for (const row of sorted) {
    if (CHAIN_TYPES.includes(row.objectType) && !chain[row.objectType]) {
      chain[row.objectType] = row
    }
  }
  return chain
}

function latestRequestForPublisher(requests, publisherId) {
  const mine = requests.filter(r => r.publisherId === publisherId)
  mine.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  return mine[0] || null
}

function statusForChain(chain, parentStatus) {
  const complete = CHAIN_TYPES.every(type => chain[type])
  if (complete) {
    if (parentStatus === 'completed') return EXECUTION_STATUS.COMPLETED
    if (parentStatus === 'cancelled' || parentStatus === 'archived') return EXECUTION_STATUS.CANCELLED
    if (parentStatus === 'failed') return EXECUTION_STATUS.FAILED
    return EXECUTION_STATUS.ACTIVE
  }
  if (TERMINAL_PARENT_COMPLETED.has(parentStatus) || parentStatus === 'failed') return EXECUTION_STATUS.FAILED
  return EXECUTION_STATUS.PENDING
}

export function planExecutionsForCampaign({ campaign, metaObjects, publisherRequests = [], adAccountActId = null }) {
  const plans = []
  const byOwner = new Map()
  for (const row of metaObjects) {
    if (!row.createdForUserId) continue
    if (!byOwner.has(row.createdForUserId)) byOwner.set(row.createdForUserId, [])
    byOwner.get(row.createdForUserId).push(row)
  }

  const requestByPublisher = new Map()
  for (const request of publisherRequests) {
    if (!requestByPublisher.has(request.publisherId)) requestByPublisher.set(request.publisherId, [])
    requestByPublisher.get(request.publisherId).push(request)
  }

  const describeOwner = (ownerUserId, kind, requestId) => {
    const chain = latestChainForOwner(byOwner.get(ownerUserId) || [])
    const hasAnyObject = Object.keys(chain).length > 0
    return {
      campaignId: campaign.id,
      ownerUserId,
      kind,
      publisherRequestId: requestId,
      status: hasAnyObject ? statusForChain(chain, campaign.status) : null,
      fbPageId: null,
      adAccountActId,
      configHash: null,
      platformCampaignId: chain.facebook_campaign?.objectId || null,
      platformAdsetId: chain.ad_set?.objectId || null,
      platformCreativeId: chain.ad_creative?.objectId || null,
      platformAdId: chain.ad?.objectId || null,
      hasChain: hasAnyObject,
    }
  }

  const plannedKeys = new Set()
  const push = plan => {
    const key = `${plan.ownerUserId}:${plan.kind}`
    if (plannedKeys.has(key)) return
    plannedKeys.add(key)
    plans.push(plan)
  }

  for (const [ownerUserId] of byOwner) {
    const request = latestRequestForPublisher(publisherRequests, ownerUserId)
    if (ownerUserId === campaign.clientId) {
      push(describeOwner(ownerUserId, EXECUTION_KIND.CLIENT, null))
      if (request) push(describeOwner(ownerUserId, EXECUTION_KIND.PUBLISHER, request.id))
    } else {
      push(describeOwner(ownerUserId, EXECUTION_KIND.PUBLISHER, request ? request.id : null))
    }
  }

  const hasLiveRequests = publisherRequests.some(r => r.status === 'accepted' || r.status === 'published')
  if (!byOwner.has(campaign.clientId) && byOwner.size > 0 && hasLiveRequests &&
      !TERMINAL_PARENT_COMPLETED.has(campaign.status) && campaign.status !== 'failed') {
    push({
      campaignId: campaign.id,
      ownerUserId: campaign.clientId,
      kind: EXECUTION_KIND.CLIENT,
      publisherRequestId: null,
      status: EXECUTION_STATUS.PENDING,
      fbPageId: null,
      adAccountActId,
      configHash: null,
      platformCampaignId: null,
      platformAdsetId: null,
      platformCreativeId: null,
      platformAdId: null,
      hasChain: false,
    })
  }

  for (const [publisherId, rows] of requestByPublisher) {
    const key = `${publisherId}:${EXECUTION_KIND.PUBLISHER}`
    if (plannedKeys.has(key)) continue
    const request = latestRequestForPublisher(publisherRequests, publisherId)
    if (!request) continue
    if (request.status === 'failed') {
      push({
        campaignId: campaign.id,
        ownerUserId: publisherId,
        kind: EXECUTION_KIND.PUBLISHER,
        publisherRequestId: request.id,
        status: EXECUTION_STATUS.FAILED,
        fbPageId: null,
        adAccountActId,
        configHash: null,
        platformCampaignId: null,
        platformAdsetId: null,
        platformCreativeId: null,
        platformAdId: null,
        hasChain: false,
      })
    } else if (request.status === 'accepted' || request.status === 'published') {
      const parentTerminal = TERMINAL_PARENT_COMPLETED.has(campaign.status) || campaign.status === 'failed'
      push({
        campaignId: campaign.id,
        ownerUserId: publisherId,
        kind: EXECUTION_KIND.PUBLISHER,
        publisherRequestId: request.id,
        status: parentTerminal ? EXECUTION_STATUS.FAILED : EXECUTION_STATUS.PENDING,
        fbPageId: null,
        adAccountActId,
        configHash: null,
        platformCampaignId: null,
        platformAdsetId: null,
        platformCreativeId: null,
        platformAdId: null,
        hasChain: false,
      })
    }
  }

  return plans.filter(plan => plan.status !== null)
}

export async function adoptExecution(plan) {
  const existing = await execRepo.findExecutionByOwner(plan.campaignId, plan.ownerUserId, plan.kind)
  if (existing) return { execution: existing, created: false }
  const id = await execRepo.createExecution(plan)
  const execution = await execRepo.findExecutionByOwner(plan.campaignId, plan.ownerUserId, plan.kind)
  return { execution: { ...execution, id }, created: true }
}

export async function findOrCreatePendingExecution(campaignId, ownerUserId, kind) {
  const existing = await execRepo.findExecutionByOwner(campaignId, ownerUserId, kind)
  if (existing) return { execution: existing, created: false }
  try {
    const id = await execRepo.createExecution({ campaignId, ownerUserId, kind, status: 'pending' })
    const execution = await execRepo.findExecutionByOwner(campaignId, ownerUserId, kind)
    return { execution: { ...execution, id }, created: true }
  } catch (err) {
    if (err?.code === 'ER_DUP_ENTRY') {
      const raced = await execRepo.findExecutionByOwner(campaignId, ownerUserId, kind)
      if (raced) return { execution: raced, created: false }
    }
    throw err
  }
}

export async function rearmFailedExecution(campaignId, ownerUserId, kind) {
  const execution = await execRepo.findExecutionByOwner(campaignId, ownerUserId, kind)
  if (!execution) return { execution: null, rearmed: false }
  if (execution.status !== EXECUTION_STATUS.FAILED) return { execution, rearmed: false }
  const affected = await execRepo.updateExecutionWithStatusGuard(execution.id, ['failed'], { status: 'pending' })
  if (!affected) {
    return { execution: await execRepo.findExecutionByOwner(campaignId, ownerUserId, kind), rearmed: false }
  }
  return { execution: await execRepo.findExecutionById(execution.id), rearmed: true }
}

function assertWholeCoinShare(sharePaise) {
  if (!Number.isInteger(sharePaise) || sharePaise <= 0) {
    throw new ValidationError('Execution share must be a positive integer number of paise')
  }
  if (sharePaise % 100 !== 0) {
    throw new ValidationError('Execution share must be whole coins (multiple of 100 paise)')
  }
}

async function guardClaimDisposition(campaign) {
  if (campaign.settledAt) throw new ValidationError('Campaign already settled')
  const entries = await campaignRepo.findBillingEntries(campaign.id)
  const quarantine = classifyRuntimeQuarantine({
    campaign,
    chargeCount: entries.filter(e => e.kind === 'charge').length,
  })
  if (quarantine) throw new ValidationError(`Quarantined execution money (${quarantine})`)
  if (Number(campaign.chargedAdBudgetPaise) <= 0) {
    throw new ValidationError('No charged reservation to dispose')
  }
  return entries
}

function disposedState(execution) {
  if (execution.consumedPaise > 0) return 'consumed'
  if (execution.refundedPaise > 0) return 'refunded'
  return null
}

async function resolveContestedClaim(executionId) {
  const current = await execRepo.findExecutionById(executionId)
  const state = current ? disposedState(current) : null
  if (state) {
    return { disposed: state, alreadyDisposed: true, sharePaise: current.consumedPaise || current.refundedPaise }
  }
  throw new ConflictError('Execution claim contested')
}

export async function consumeExecutionShare(executionId, sharePaise) {
  assertWholeCoinShare(sharePaise)
  const stub = await execRepo.findExecutionById(executionId)
  if (!stub) throw new NotFoundError('Execution not found')
  const outcome = await transaction(async () => {
    await campaignRepo.lockCampaignById(stub.campaignId)
    const execution = await execRepo.findExecutionById(executionId)
    const campaign = await campaignRepo.findCampaignById(stub.campaignId)
    if (!execution || !campaign) throw new NotFoundError('Execution not found')
    await guardClaimDisposition(campaign)
    const won = await execRepo.claimExecutionConsume(execution.id, sharePaise)
    if (won) return { decided: true, disposed: 'consumed', alreadyDisposed: false, sharePaise }
    return { decided: false }
  })
  if (outcome.decided) return outcome
  return resolveContestedClaim(executionId)
}

export async function refundExecutionShare(executionId, sharePaise, { reason } = {}) {
  assertWholeCoinShare(sharePaise)
  const stub = await execRepo.findExecutionById(executionId)
  if (!stub) throw new NotFoundError('Execution not found')
  const outcome = await transaction(async () => {
    await campaignRepo.lockCampaignById(stub.campaignId)
    const execution = await execRepo.findExecutionById(executionId)
    const campaign = await campaignRepo.findCampaignById(stub.campaignId)
    if (!execution || !campaign) throw new NotFoundError('Execution not found')
    const entries = await guardClaimDisposition(campaign)
    const won = await execRepo.claimExecutionRefund(execution.id, sharePaise)
    if (!won) return { decided: false }
    const coins = sharePaise / 100
    const charge = entries.find(e => e.kind === 'charge')
    const fromMonthlyTotal = charge?.paidFromMonthly || 0
    const fromWalletTotal = charge?.paidFromWallet || 0
    const totalChargedCoins = fromMonthlyTotal + fromWalletTotal
    let monthlyShare = 0
    let walletShare = coins
    if (totalChargedCoins > 0) {
      monthlyShare = Math.round((coins * fromMonthlyTotal) / totalChargedCoins)
      walletShare = coins - monthlyShare
    }
    await coinService.refundWithDetail(campaign.clientId, coins, 'campaign_escrow', campaign.id,
      reason || `Execution reservation refund (${execution.kind} execution)`,
      { fromMonthly: monthlyShare, fromWallet: walletShare })
    await campaignRepo.insertBillingEntry(campaign.id, {
      kind: 'refund',
      paise: sharePaise,
      coins,
      rate: charge?.rate || 0,
      paidFromMonthly: monthlyShare,
      paidFromWallet: walletShare,
      reason: `Execution reservation refund: ${execution.kind} execution ${execution.id.substring(0, 8)}${reason ? ` — ${reason}` : ''}`,
    })
    return { decided: true, disposed: 'refunded', alreadyDisposed: false, sharePaise, coins }
  })
  if (outcome.decided) return outcome
  return resolveContestedClaim(executionId)
}

export const BACKFILL_CHECKPOINT_KEY = 'campaign_exec_backfill_after'
export const SNAPSHOT_BACKFILL_CHECKPOINT_KEY = 'campaign_snapshot_backfill_after'

export function liveGraphVersion() {
  return META_CONFIG.graphVersion
}

function deepCopy(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value))
}

export function resolveCampaignSnapshot({ campaign, creative, metaSettings }) {
  if (!campaign) return { ok: false, reason: 'missing-campaign' }
  if (!creative) return { ok: false, reason: 'missing-creative' }
  if (!metaSettings) return { ok: false, reason: 'missing-meta-settings' }
  const config = {
    campaign: {
      id: campaign.id,
      name: campaign.name,
      scheduledAt: campaign.scheduledAt ? new Date(campaign.scheduledAt).toISOString() : null,
    },
    creative: {
      caption: creative.caption ?? null,
      textBody: creative.textBody ?? null,
      mediaUrl: creative.mediaUrl ?? null,
      callToAction: creative.callToAction ?? null,
      headline: creative.headline ?? null,
      description: creative.description ?? null,
      utmSource: creative.utmSource ?? null,
      utmMedium: creative.utmMedium ?? null,
      utmCampaign: creative.utmCampaign ?? null,
      utmContent: creative.utmContent ?? null,
      utmTerm: creative.utmTerm ?? null,
    },
    settings: {
      budgetAmount: metaSettings.budgetAmount ?? null,
      budgetType: metaSettings.budgetType ?? null,
      bidStrategy: metaSettings.bidStrategy ?? null,
      optimizationGoal: metaSettings.optimizationGoal ?? null,
      billingEvent: metaSettings.billingEvent ?? null,
      spendCap: metaSettings.spendCap ?? null,
      endTime: metaSettings.endTime ? new Date(metaSettings.endTime).toISOString() : null,
      targeting: deepCopy(metaSettings.targeting ?? {}),
      platformPlacement: deepCopy(metaSettings.platformPlacement ?? {}),
      objective: metaSettings.objective ?? null,
    },
  }
  const graphVersion = liveGraphVersion()
  return { ok: true, config, graphVersion, hash: hashConfig({ config, graphVersion }) }
}

export async function freezeCampaignSnapshotFor(campaignId) {
  const [campaign, creative, metaSettings] = await Promise.all([
    campaignRepo.findCampaignById(campaignId),
    campaignRepo.findCreativeByCampaignId(campaignId),
    campaignRepo.findMetaSettingsByCampaignId(campaignId),
  ])
  const resolved = resolveCampaignSnapshot({ campaign, creative, metaSettings })
  if (!resolved.ok) return { frozen: false, reason: resolved.reason }
  await campaignRepo.freezeCampaignSnapshot(campaignId, {
    config: resolved.config,
    hash: resolved.hash,
    graphVersion: resolved.graphVersion,
  })
  return { frozen: true, hash: resolved.hash, graphVersion: resolved.graphVersion }
}

export async function ensureCampaignSnapshot(campaignId) {
  const existing = await campaignRepo.findCampaignSnapshot(campaignId)
  if (existing) return { snapshot: existing, created: false }
  const frozen = await freezeCampaignSnapshotFor(campaignId)
  if (!frozen.frozen) return { snapshot: null, created: false, reason: frozen.reason }
  return { snapshot: await campaignRepo.findCampaignSnapshot(campaignId), created: true }
}

// A frozen snapshot is a deliberate one-time-per-chain freeze (see
// ensureCampaignSnapshot) so a build never mixes half-old/half-new inputs
// while Meta objects are being created. But nothing re-freezes it when the
// client edits campaign_meta_settings afterwards — every subsequent
// approve/retry silently rebuilds from the ORIGINAL, possibly since-fixed,
// values (e.g. an end date the client corrected after a schedule-validation
// failure keeps failing with the same stale date forever). This is only
// safe to do automatically while NO owner execution has created any real
// Meta object yet — once a chain has partially built, its campaign
// name/objective/etc. may already exist on Meta with the old values, and
// blindly re-freezing would create a genuine inconsistency instead of
// fixing one.
export async function refreezeCampaignSnapshotIfUnbuilt(campaignId) {
  const executions = await execRepo.findExecutionsByCampaignId(campaignId)
  const chainStarted = executions.some(e =>
    e.platformCampaignId || e.platformAdsetId || e.platformCreativeId || e.platformAdId
  )
  if (chainStarted) return { refrozen: false, reason: 'chain-in-progress' }
  const frozen = await freezeCampaignSnapshotFor(campaignId)
  if (!frozen.frozen) return { refrozen: false, reason: frozen.reason }
  for (const execution of executions) {
    if (execution.configHash && execution.configHash !== frozen.hash) {
      await execRepo.updateExecution(execution.id, { configHash: null })
    }
  }
  return { refrozen: true, hash: frozen.hash }
}

export function checkExecutionSnapshot(snapshots, execution) {
  if (!snapshots) return { ok: false, reason: 'missing-snapshot' }
  if (snapshots.graphVersion !== liveGraphVersion()) return { ok: false, reason: 'version-mismatch' }
  if (execution.configHash && execution.configHash !== snapshots.hash) return { ok: false, reason: 'hash-mismatch' }
  return { ok: true, config: deepCopy(snapshots.config) }
}

export async function backfillExecutionSnapshots({ batch = 25, afterId = null, execute = false, maxBatches = null, onEvent = null } = {}) {
  const summary = { campaigns: 0, frozen: 0, stamped: 0, skipped: [], nextAfterId: afterId }
  const emit = event => {
    if (onEvent) onEvent(event)
  }
  let batches = 0
  for (;;) {
    const candidates = await execRepo.findBackfillCandidateCampaigns(batch, afterId)
    if (!candidates.length) break
    for (const candidate of candidates) {
      afterId = candidate.id
      summary.nextAfterId = afterId
      const executions = await execRepo.findExecutionsByCampaignId(candidate.id)
      if (!executions.length) continue
      summary.campaigns += 1
      const existing = await campaignRepo.findCampaignSnapshot(candidate.id)
      if (!existing) {
        const [campaign, creative, metaSettings] = await Promise.all([
          campaignRepo.findCampaignById(candidate.id),
          campaignRepo.findCreativeByCampaignId(candidate.id),
          campaignRepo.findMetaSettingsByCampaignId(candidate.id),
        ])
        const resolved = resolveCampaignSnapshot({ campaign, creative, metaSettings })
        if (!resolved.ok) {
          summary.skipped.push({ campaignId: candidate.id, reason: resolved.reason })
          emit({ type: 'snapshot-skipped', campaignId: candidate.id, reason: resolved.reason })
          continue
        }
        if (!execute) {
          emit({ type: 'snapshot-plan', campaignId: candidate.id })
          continue
        }
        await campaignRepo.freezeCampaignSnapshot(candidate.id, {
          config: resolved.config,
          hash: resolved.hash,
          graphVersion: resolved.graphVersion,
        })
        summary.frozen += 1
        emit({ type: 'snapshot-frozen', campaignId: candidate.id })
      }
      if (!execute) continue
      const snapshot = await campaignRepo.findCampaignSnapshot(candidate.id)
      for (const execution of executions) {
        if (!execution.configHash && snapshot) {
          await execRepo.updateExecution(execution.id, { configHash: snapshot.hash })
          summary.stamped += 1
        }
      }
    }
    batches += 1
    emit({ type: 'batch', afterId, batches })
    if (candidates.length < batch) break
    if (maxBatches !== null && batches >= maxBatches) break
  }
  return summary
}

export function classifyQuarantine({ campaign, chargeCount }) {
  if (Number(campaign.chargedAdBudgetPaise) > 0 && !campaign.settledAt && chargeCount !== 1) {
    return 'billing-anomaly'
  }
  const terminal = TERMINAL_PARENT_COMPLETED.has(campaign.status) || campaign.status === 'failed'
  if (!terminal && Number(campaign.chargedAdBudgetPaise) === 0 && Number(campaign.escrowAmount) > 0) {
    return 'escrow-unsettled'
  }
  return null
}

const RUNTIME_ESCROW_HOLDING_STATUSES = new Set([
  'awaiting_publishers', 'running', 'paused', 'scheduled', 'completed', 'cancelled', 'archived',
])

export function classifyRuntimeQuarantine({ campaign, chargeCount }) {
  if (Number(campaign.chargedAdBudgetPaise) > 0 && !campaign.settledAt && chargeCount !== 1) {
    return 'billing-anomaly'
  }
  if (!RUNTIME_ESCROW_HOLDING_STATUSES.has(campaign.status) &&
      Number(campaign.chargedAdBudgetPaise) === 0 && Number(campaign.escrowAmount) > 0) {
    return 'escrow-unsettled'
  }
  return null
}

export async function planCampaignExecutions(campaignId) {
  const repo = campaignRepo
  const [campaign, metaObjects, publisherRequests, billingEntries] = await Promise.all([
    repo.findCampaignById(campaignId),
    repo.findMetaObjectsByCampaignId(campaignId),
    repo.findPublisherRequestsByCampaignId(campaignId),
    repo.findBillingEntries(campaignId),
  ])
  if (!campaign) return null
  let adAccountActId = null
  try {
    const account = await repo.findCampaignAdAccount(campaignId)
    adAccountActId = account?.metaAccountId || null
  } catch {
    adAccountActId = null
  }
  const chargeCount = billingEntries.filter(e => e.kind === 'charge').length
  const plans = planExecutionsForCampaign({
    campaign: { id: campaign.id, clientId: campaign.clientId, status: campaign.status },
    metaObjects,
    publisherRequests,
    adAccountActId,
  })
  return { campaign, plans, quarantine: classifyQuarantine({ campaign, chargeCount }) }
}

export function diffExecutionsAgainstPlans(stored, plans) {
  const diffs = []
  const storedKeys = new Set(stored.map(e => `${e.ownerUserId}:${e.kind}`))
  for (const plan of plans) {
    const match = stored.find(e => e.ownerUserId === plan.ownerUserId && e.kind === plan.kind)
    if (!match) {
      diffs.push({ type: 'missing', ownerUserId: plan.ownerUserId, kind: plan.kind, plannedStatus: plan.status })
    } else if (
      match.status !== plan.status ||
      match.platformCampaignId !== plan.platformCampaignId ||
      match.platformAdsetId !== plan.platformAdsetId ||
      match.platformCreativeId !== plan.platformCreativeId ||
      match.platformAdId !== plan.platformAdId
    ) {
      diffs.push({ type: 'divergent', ownerUserId: match.ownerUserId, kind: match.kind, storedStatus: match.status, plannedStatus: plan.status })
    }
    storedKeys.delete(`${plan.ownerUserId}:${plan.kind}`)
  }
  for (const extra of storedKeys) {
    const [ownerUserId, kind] = extra.split(':')
    diffs.push({ type: 'extra', ownerUserId, kind })
  }
  return diffs
}

export async function runExecutionBackfill({
  execute = false,
  verify = false,
  batch = 25,
  afterId = null,
  onlyCampaign = null,
  includeQuarantined = false,
  maxBatches = null,
  onEvent = null,
} = {}) {
  const summary = { campaigns: 0, planned: 0, created: 0, existing: 0, skipped: [], divergent: [], nextAfterId: afterId }
  const emit = event => {
    if (onEvent) onEvent(event)
  }
  let batches = 0
  for (;;) {
    const candidates = onlyCampaign
      ? [{ id: onlyCampaign }]
      : await execRepo.findBackfillCandidateCampaigns(batch, afterId)
    if (!candidates.length) break
    for (const candidate of candidates) {
      afterId = candidate.id
      summary.nextAfterId = afterId
      const described = await planCampaignExecutions(candidate.id)
      if (!described) continue
      const { campaign, plans, quarantine } = described
      summary.campaigns += 1
      const quarantined = quarantine && !includeQuarantined
      if (quarantined) {
        summary.skipped.push({ campaignId: campaign.id, reason: quarantine })
        emit({ type: 'quarantined', campaignId: campaign.id, reason: quarantine, plans: plans.length })
        continue
      }
      summary.planned += plans.length
      if (verify) {
        const stored = await execRepo.findExecutionsByCampaignId(campaign.id)
        for (const diff of diffExecutionsAgainstPlans(stored, plans)) {
          summary.divergent.push({ campaignId: campaign.id, ...diff })
          emit({ type: 'divergent', campaignId: campaign.id, ...diff })
        }
        continue
      }
      for (const plan of plans) {
        emit({ type: 'plan', plan, dryRun: !execute })
        if (!execute) continue
        const { created } = await adoptExecution(plan)
        if (created) summary.created += 1
        else summary.existing += 1
      }
    }
    batches += 1
    emit({ type: 'batch', afterId, batches })
    if (onlyCampaign || candidates.length < batch) break
    if (maxBatches !== null && batches >= maxBatches) break
  }
  return summary
}
