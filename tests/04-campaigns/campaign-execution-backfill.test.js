import { describe, it, expect, beforeAll, vi } from 'vitest'
import { generateUuid, uuidToBuffer } from '../../shared/utils/uuid.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import * as campaignRepo from '../../src/modules/campaigns/campaign.repository.js'
import * as execRepo from '../../src/modules/campaigns/campaign-execution.repository.js'
import * as execService from '../../src/modules/campaigns/campaign-execution.service.js'
import * as metaAds from '../../shared/services/meta-ads.service.js'
import * as subRepo from '../../src/modules/subscriptions/subscription.repository.js'
import { query } from '../../shared/database/connection.js'

var metaMocks
vi.mock('../../shared/services/meta-ads.service.js', async () => {
  const actual = await vi.importActual('../../shared/services/meta-ads.service.js')
  const mocks = {
    ...actual,
    createAdCampaign: vi.fn(),
    createAdSet: vi.fn(),
    createAdCreative: vi.fn(),
    createAd: vi.fn(),
    updateAdStatus: vi.fn(),
    deleteAd: vi.fn(),
    deleteAdSet: vi.fn(),
    deleteAdCreative: vi.fn(),
    deleteAdCampaign: vi.fn(),
    getObjectStatus: vi.fn(),
    listAccountAds: vi.fn(),
  }
  metaMocks = mocks
  return mocks
})

const dateTag = Date.now()
let metaFnNames = []

async function ensurePlan(userId) {
  const sub = await subRepo.findUserSubscription(userId)
  if (sub) return
  const starter = await subRepo.findPlanBySlug('starter')
  if (starter) {
    await subRepo.upsertUserSubscription(userId, starter.id, {
      status: 'active',
      billingCycle: 'monthly',
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    })
  }
}

async function seedChain(campaignId, ownerId, prefix) {
  for (const objectType of ['facebook_campaign', 'ad_set', 'ad_creative', 'ad']) {
    await campaignRepo.createMetaObject(campaignId, objectType, `${prefix}_${objectType}`, null, 'ACTIVE', ownerId)
  }
}

async function seedRequest(campaignId, publisherId, status = 'published') {
  const id = generateUuid()
  await query(
    `INSERT INTO campaign_publisher_requests (id, campaign_id, publisher_id, coins_offered, status)
     VALUES (?, ?, ?, 10, ?)`,
    [uuidToBuffer(id), uuidToBuffer(campaignId), uuidToBuffer(publisherId), status]
  )
  return id
}

async function snapshotFinancialState(userIds, campaignIds) {
  const wallets = await query('SELECT HEX(user_id) AS u, coins FROM user_wallets WHERE ' + userIds.map(() => 'user_id = ?').join(' OR '), userIds.map(uuidToBuffer)) || []
  const billing = await query('SELECT campaign_id, kind, paise, coins FROM campaign_billing_entries')
  const campaigns = await query('SELECT id, status, charged_ad_budget_paise, escrow_amount, settled_at FROM campaigns')
  const objects = await query('SELECT campaign_id, object_type, object_id, created_for_user_id, status FROM campaign_meta_objects')
  const jobs = await query('SELECT COUNT(*) AS n FROM campaign_jobs')
  return JSON.stringify({ wallets, billing, campaigns, objects, jobs: jobs[0].n, scopedCampaigns: campaignIds })
}

describe('campaign execution backfill proof-suite (12-constraint gate)', () => {
  let client, publisher

  beforeAll(async () => {
    client = await createTestUser({ email: `execbt-client-${dateTag}@flowx-test.com`, password: 'Test@123', coins: 10000 })
    publisher = await createTestUser({ email: `execbt-pub-${dateTag}@flowx-test.com`, password: 'Test@123', role: 'publisher' })
    await ensurePlan(client.id)
    metaFnNames = Object.keys(metaMocks).filter(k => metaMocks[k]?.mock)
    expect(metaFnNames.length).toBeGreaterThan(0)
  })

  async function seedBackfillScenario(tag) {
    const campaignId = generateUuid()
    await campaignRepo.createCampaign(campaignId, client.id, { name: `ExecBT ${tag} ${dateTag}`, type: 'post' })
    await query('UPDATE campaigns SET status = ? WHERE id = ?', ['paused', uuidToBuffer(campaignId)])
    await seedChain(campaignId, client.id, `bt_${tag}_cli`)
    await seedRequest(campaignId, publisher.id, 'published')
    return campaignId
  }

  it('execute is Meta-free: zero Meta API calls across a full run', async () => {
    const campaignId = await seedBackfillScenario('metafree')
    for (const fn of metaFnNames) metaMocks[fn].mockClear()
    const summary = await execService.runExecutionBackfill({ execute: true, onlyCampaign: campaignId })
    expect(summary.created).toBe(2)
    for (const fn of metaFnNames) {
      expect(metaMocks[fn]).not.toHaveBeenCalled()
    }
  })

  it('execute is money-free and byte-equivalent: wallets, billing, money columns, objects, jobs, statuses', async () => {
    const campaignId = await seedBackfillScenario('moneyfree')
    await campaignRepo.updateCampaign(campaignId, { chargedAdBudgetPaise: 50000 })
    await campaignRepo.insertBillingEntry(campaignId, {
      kind: 'charge', paise: 50000, coins: 500, rate: 1, paidFromMonthly: 500, paidFromWallet: 0, reason: 'byte-equivalence probe',
    })
    const before = await snapshotFinancialState([client.id, publisher.id], [campaignId])
    const summary = await execService.runExecutionBackfill({ execute: true, onlyCampaign: campaignId })
    expect(summary.created).toBe(2)
    const after = await snapshotFinancialState([client.id, publisher.id], [campaignId])
    expect(after).toBe(before)
  })

  it('second execute is idempotent: zero created, all existing', async () => {
    const campaignId = await seedBackfillScenario('idem')
    const first = await execService.runExecutionBackfill({ execute: true, onlyCampaign: campaignId })
    expect(first.created).toBe(2)
    const second = await execService.runExecutionBackfill({ execute: true, onlyCampaign: campaignId })
    expect(second.created).toBe(0)
    expect(second.existing).toBe(2)
  })

  it('verify passes after execute and flags tampering as divergent', async () => {
    const campaignId = await seedBackfillScenario('verify')
    await execService.runExecutionBackfill({ execute: true, onlyCampaign: campaignId })
    const clean = await execService.runExecutionBackfill({ verify: true, onlyCampaign: campaignId })
    expect(clean.divergent).toHaveLength(0)
    const rows = await execRepo.findExecutionsByCampaignId(campaignId)
    await execRepo.updateExecution(rows[0].id, { status: 'failed', error: 'tamper probe' })
    const dirty = await execService.runExecutionBackfill({ verify: true, onlyCampaign: campaignId })
    expect(dirty.divergent).toHaveLength(1)
    expect(dirty.divergent[0].type).toBe('divergent')
  })

  it('quarantines escrow-unsettled and billing-anomaly campaigns unless explicitly targeted', async () => {
    const escrowId = generateUuid()
    await campaignRepo.createCampaign(escrowId, client.id, { name: `ExecBT Esc ${dateTag}`, type: 'post' })
    await query('UPDATE campaigns SET status = ?, escrow_amount = 550 WHERE id = ?', ['paused', uuidToBuffer(escrowId)])
    await seedChain(escrowId, client.id, 'bt_esc')

    const anomalyId = generateUuid()
    await campaignRepo.createCampaign(anomalyId, client.id, { name: `ExecBT Anom ${dateTag}`, type: 'post' })
    await query('UPDATE campaigns SET status = ?, charged_ad_budget_paise = 10000 WHERE id = ?', ['paused', uuidToBuffer(anomalyId)])
    await seedChain(anomalyId, client.id, 'bt_anom')
    for (let i = 0; i < 2; i += 1) {
      await campaignRepo.insertBillingEntry(anomalyId, {
        kind: 'charge', paise: 10000, coins: 100, rate: 1, paidFromMonthly: 0, paidFromWallet: 100, reason: `dup ${i}`,
      })
    }

    const escrowPlan = await execService.planCampaignExecutions(escrowId)
    expect(escrowPlan.quarantine).toBe('escrow-unsettled')
    const anomalyPlan = await execService.planCampaignExecutions(anomalyId)
    expect(anomalyPlan.quarantine).toBe('billing-anomaly')

    const skipped = await execService.runExecutionBackfill({ execute: true, onlyCampaign: escrowId })
    expect(skipped.created).toBe(0)
    expect(skipped.skipped).toHaveLength(1)
    expect(skipped.skipped[0].reason).toBe('escrow-unsettled')
    expect((await execRepo.findExecutionsByCampaignId(escrowId))).toHaveLength(0)

    const skippedAnomaly = await execService.runExecutionBackfill({ execute: true, onlyCampaign: anomalyId })
    expect(skippedAnomaly.created).toBe(0)
    expect(skippedAnomaly.skipped[0].reason).toBe('billing-anomaly')

    const direct = await execService.runExecutionBackfill({ execute: true, onlyCampaign: escrowId, includeQuarantined: true })
    expect(direct.created).toBe(1)

    const manualAnomaly = await execService.runExecutionBackfill({ execute: true, onlyCampaign: anomalyId, includeQuarantined: true })
    expect(manualAnomaly.created).toBe(1)
    const anomalyRows = await execRepo.findExecutionsByCampaignId(anomalyId)
    expect(anomalyRows[0].consumedPaise).toBe(0)
    expect(anomalyRows[0].refundedPaise).toBe(0)
  })

  it('crash recovery: checkpoint resume completes exactly once with no duplicates', async () => {
    const ids = []
    for (const tag of ['crash-a', 'crash-b', 'crash-c']) {
      const campaignId = generateUuid()
      await campaignRepo.createCampaign(campaignId, client.id, { name: `ExecBT ${tag} ${dateTag}`, type: 'post' })
      await query('UPDATE campaigns SET status = ? WHERE id = ?', ['paused', uuidToBuffer(campaignId)])
      await seedChain(campaignId, client.id, `bt_${tag}`)
      ids.push(campaignId)
    }
    const ordered = await execRepo.findBackfillCandidateCampaigns(10000, null)
    const order = new Map(ordered.map((c, i) => [c.id, i]))
    const mineFirst = [...ids].sort((a, b) => order.get(a) - order.get(b))[0]
    const beforeMine = ordered.filter(c => order.get(c.id) < order.get(mineFirst)).map(c => c.id).pop() || null
    const first = await execService.runExecutionBackfill({ execute: true, batch: 1, maxBatches: 1, afterId: beforeMine })
    expect(first.created).toBe(1)
    await campaignRepo.saveMetaSyncState(execService.BACKFILL_CHECKPOINT_KEY, { afterId: first.nextAfterId })
    const checkpoint = await campaignRepo.getMetaSyncState(execService.BACKFILL_CHECKPOINT_KEY)
    expect(checkpoint.afterId).toBe(first.nextAfterId)
    await execService.runExecutionBackfill({ execute: true, batch: 50, afterId: checkpoint.afterId })
    for (const campaignId of ids) {
      const rows = await execRepo.findExecutionsByCampaignId(campaignId)
      expect(rows).toHaveLength(1)
    }
    await execService.runExecutionBackfill({ execute: true, batch: 50, afterId: null })
    for (const campaignId of ids) {
      const rows = await execRepo.findExecutionsByCampaignId(campaignId)
      expect(rows).toHaveLength(1)
    }
    await campaignRepo.clearMetaSyncState(execService.BACKFILL_CHECKPOINT_KEY)
  })

  it('diff detects missing, divergent and extra rows', async () => {
    const stored = [{ ownerUserId: 'u1', kind: 'client', status: 'active', platformCampaignId: 'c1', platformAdsetId: 's1', platformCreativeId: 'cr1', platformAdId: 'a1' }]
    const plans = [
      { ownerUserId: 'u1', kind: 'client', status: 'failed', platformCampaignId: 'c1', platformAdsetId: 's1', platformCreativeId: 'cr1', platformAdId: 'a1' },
      { ownerUserId: 'u2', kind: 'publisher', status: 'pending', platformCampaignId: null, platformAdsetId: null, platformCreativeId: null, platformAdId: null },
    ]
    const diffs = execService.diffExecutionsAgainstPlans(stored, plans)
    expect(diffs.map(d => d.type).sort()).toEqual(['divergent', 'missing'])
    const clean = execService.diffExecutionsAgainstPlans(
      [{ ownerUserId: 'u1', kind: 'client', status: 'active', platformCampaignId: 'c1', platformAdsetId: 's1', platformCreativeId: 'cr1', platformAdId: 'a1' }],
      [{ ownerUserId: 'u1', kind: 'client', status: 'active', platformCampaignId: 'c1', platformAdsetId: 's1', platformCreativeId: 'cr1', platformAdId: 'a1' }]
    )
    expect(clean).toHaveLength(0)
  })
})
