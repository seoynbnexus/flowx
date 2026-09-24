import { describe, it, expect, beforeAll, vi } from 'vitest'
import { generateUuid, uuidToBuffer } from '../../shared/utils/uuid.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import * as campaignService from '../../src/modules/campaigns/campaign.service.js'
import * as campaignRepo from '../../src/modules/campaigns/campaign.repository.js'
import * as execRepo from '../../src/modules/campaigns/campaign-execution.repository.js'
import * as execService from '../../src/modules/campaigns/campaign-execution.service.js'
import * as coinService from '../../shared/services/coin.service.js'
import * as subRepo from '../../src/modules/subscriptions/subscription.repository.js'
import { query, queryOne } from '../../shared/database/connection.js'

var metaMocks
vi.mock('../../shared/services/meta-ads.service.js', async () => {
  const actual = await vi.importActual('../../shared/services/meta-ads.service.js')
  const mocks = { ...actual, getObjectStatus: vi.fn().mockResolvedValue({ status: 'ACTIVE', effective_status: 'ACTIVE' }) }
  metaMocks = mocks
  return mocks
})
void metaMocks

const dateTag = Date.now()

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

async function walletCoins(userId) {
  const row = await queryOne('SELECT coins FROM user_wallets WHERE user_id = ?', [uuidToBuffer(userId)])
  return Number(row?.coins || 0)
}

async function seedChargedCampaign(clientId, tag, { chargedPaise = 10000, coins = 100, status = 'running' } = {}) {
  const campaignId = generateUuid()
  await campaignRepo.createCampaign(campaignId, clientId, { name: `ExecFin ${tag} ${dateTag}`, type: 'post' })
  await query('UPDATE campaigns SET status = ?, charged_ad_budget_paise = ? WHERE id = ?', [status, chargedPaise, uuidToBuffer(campaignId)])
  await campaignRepo.insertBillingEntry(campaignId, {
    kind: 'charge', paise: chargedPaise, coins, rate: 1, paidFromMonthly: 0, paidFromWallet: coins, reason: 'financial probe charge',
  })
  return campaignId
}

async function seedExecution(campaignId, ownerId, kind = 'client', status = 'pending') {
  return execRepo.createExecution({ campaignId, ownerUserId: ownerId, kind, status })
}

async function seedSpend(campaignId, spendPaise) {
  await campaignRepo.upsertDailyStat(campaignId, {
    statDate: '2026-07-01',
    impressions: 100, reach: 90, clicks: 5, ctr: 0.05, cpc: 1, cpm: 10,
    spendPaise, actions: {}, costPerActionType: {},
  })
}

async function refundRows(campaignId) {
  const entries = await campaignRepo.findBillingEntries(campaignId)
  return entries.filter(e => e.kind === 'refund')
}

describe('campaign execution financial claims (Step 11)', () => {
  let client, publisher

  beforeAll(async () => {
    client = await createTestUser({ email: `execfin-client-${dateTag}@flowx-test.com`, password: 'Test@123', coins: 10000 })
    publisher = await createTestUser({ email: `execfin-pub-${dateTag}@flowx-test.com`, password: 'Test@123', role: 'publisher' })
    await ensurePlan(client.id)
  })

  it('1. consume is exactly once and moves no coins', async () => {
    const campaignId = await seedChargedCampaign(client.id, 'consume1')
    const executionId = await seedExecution(campaignId, client.id)
    const before = await walletCoins(client.id)
    const first = await execService.consumeExecutionShare(executionId, 10000)
    expect(first).toMatchObject({ disposed: 'consumed', alreadyDisposed: false })
    const second = await execService.consumeExecutionShare(executionId, 10000)
    expect(second).toMatchObject({ disposed: 'consumed', alreadyDisposed: true })
    const row = await execRepo.findExecutionById(executionId)
    expect(Number(row.consumedPaise)).toBe(10000)
    expect(await walletCoins(client.id)).toBe(before)
  })

  it('2/22. refund is exactly once; retry after success is a no-op', async () => {
    const campaignId = await seedChargedCampaign(client.id, 'refund1')
    const executionId = await seedExecution(campaignId, client.id)
    const before = await walletCoins(client.id)
    const first = await execService.refundExecutionShare(executionId, 10000, { reason: 'lost-response probe' })
    expect(first).toMatchObject({ disposed: 'refunded', alreadyDisposed: false, coins: 100 })
    void first
    const second = await execService.refundExecutionShare(executionId, 10000, { reason: 'retry after lost response' })
    expect(second).toMatchObject({ disposed: 'refunded', alreadyDisposed: true })
    expect(await walletCoins(client.id)).toBe(before + 100)
    expect(await refundRows(campaignId)).toHaveLength(1)
  })

  it('3. consume and refund are mutually exclusive in both orders', async () => {
    const campaignA = await seedChargedCampaign(client.id, 'excl-a')
    const execA = await seedExecution(campaignA, client.id)
    await execService.consumeExecutionShare(execA, 10000)
    const refundAfterConsume = await execService.refundExecutionShare(execA, 10000)
    expect(refundAfterConsume).toMatchObject({ disposed: 'consumed', alreadyDisposed: true })

    const campaignB = await seedChargedCampaign(client.id, 'excl-b')
    const before = await walletCoins(client.id)
    const execB = await seedExecution(campaignB, client.id)
    await execService.refundExecutionShare(execB, 10000)
    const consumeAfterRefund = await execService.consumeExecutionShare(execB, 10000)
    expect(consumeAfterRefund).toMatchObject({ disposed: 'refunded', alreadyDisposed: true })
    expect(await walletCoins(client.id)).toBe(before + 100)
  })

  it('4. concurrent consume claims dispose exactly once', async () => {
    const campaignId = await seedChargedCampaign(client.id, 'conc-consume')
    const executionId = await seedExecution(campaignId, client.id)
    const results = await Promise.all([
      execService.consumeExecutionShare(executionId, 10000),
      execService.consumeExecutionShare(executionId, 10000),
    ])
    expect(results.filter(r => !r.alreadyDisposed)).toHaveLength(1)
    const row = await execRepo.findExecutionById(executionId)
    expect(Number(row.consumedPaise)).toBe(10000)
    expect(Number(row.refundedPaise)).toBe(0)
  })

  it('5. concurrent refund claims credit exactly once', async () => {
    const campaignId = await seedChargedCampaign(client.id, 'conc-refund')
    const executionId = await seedExecution(campaignId, client.id)
    const before = await walletCoins(client.id)
    const results = await Promise.all([
      execService.refundExecutionShare(executionId, 10000),
      execService.refundExecutionShare(executionId, 10000),
    ])
    expect(results.filter(r => !r.alreadyDisposed)).toHaveLength(1)
    expect(await walletCoins(client.id)).toBe(before + 100)
    expect(await refundRows(campaignId)).toHaveLength(1)
  })

  it('6. concurrent consume-vs-refund yields exactly one disposition', async () => {
    const campaignId = await seedChargedCampaign(client.id, 'conc-mixed')
    const executionId = await seedExecution(campaignId, client.id)
    const before = await walletCoins(client.id)
    const [consumeResult, refundResult] = await Promise.all([
      execService.consumeExecutionShare(executionId, 10000),
      execService.refundExecutionShare(executionId, 10000),
    ])
    const winners = [consumeResult, refundResult].filter(r => !r.alreadyDisposed)
    expect(winners).toHaveLength(1)
    const row = await execRepo.findExecutionById(executionId)
    const consumed = Number(row.consumedPaise) > 0
    const refunded = Number(row.refundedPaise) > 0
    expect(consumed !== refunded).toBe(true)
    expect(await walletCoins(client.id)).toBe(before + (refunded ? 100 : 0))
  })

  it('7. settlement claim is guarded at the database', async () => {
    const campaignId = await seedChargedCampaign(client.id, 'settle-claim')
    expect(await campaignRepo.claimCampaignSettlement(campaignId)).toBe(1)
    expect(await campaignRepo.claimCampaignSettlement(campaignId)).toBe(0)
    expect(await campaignRepo.releaseCampaignSettlement(campaignId)).toBe(1)
    expect(await campaignRepo.claimCampaignSettlement(campaignId)).toBe(1)
    await campaignRepo.releaseCampaignSettlement(campaignId)
  })

  it('8/23. concurrent settlement settles exactly once', async () => {
    const campaignId = await seedChargedCampaign(client.id, 'conc-settle')
    await seedSpend(campaignId, 4000)
    const results = await Promise.all([
      campaignService.settleCampaignJob(campaignId),
      campaignService.settleCampaignJob(campaignId),
    ])
    const settled = results.filter(r => r.refundCoins === 60)
    const duplicates = results.filter(r => r.alreadySettled)
    expect(settled).toHaveLength(1)
    expect(duplicates).toHaveLength(1)
    const entries = await campaignRepo.findBillingEntries(campaignId)
    expect(entries.filter(e => e.kind === 'refund')).toHaveLength(1)
    expect(entries.filter(e => e.kind === 'settle')).toHaveLength(1)
  })

  it('9. reservation refund plus spend settlement never double-refunds (900/300/500 → 100)', async () => {
    const campaignId = await seedChargedCampaign(client.id, 'anti-double', { chargedPaise: 90000, coins: 900 })
    const executionId = await seedExecution(campaignId, client.id)
    const before = await walletCoins(client.id)
    await execService.refundExecutionShare(executionId, 30000, { reason: 'failed target share' })
    await seedSpend(campaignId, 50000)
    const result = await campaignService.settleCampaignJob(campaignId)
    expect(result.success).toBe(true)
    expect(result.alreadyRefundedPaise).toBe(30000)
    const rows = await refundRows(campaignId)
    expect(rows).toHaveLength(2)
    const settleRefund = rows.find(r => Number(r.paise) === 10000)
    expect(settleRefund).toBeTruthy()
    const totalRefunded = rows.reduce((sum, r) => sum + Number(r.paise), 0)
    expect(totalRefunded).toBe(40000)
    expect(await walletCoins(client.id)).toBe(before + 400)
  })

  it('10/11/12. exact-spend settles with no refund row; over-spend deducts the delta', async () => {
    const exactId = await seedChargedCampaign(client.id, 'exact')
    await seedSpend(exactId, 10000)
    const exact = await campaignService.settleCampaignJob(exactId)
    expect(exact.success).toBe(true)
    expect(exact.refundCoins).toBe(0)
    expect(await refundRows(exactId)).toHaveLength(0)
    const exactEntries = await campaignRepo.findBillingEntries(exactId)
    expect(exactEntries.some(e => e.kind === 'settle')).toBe(true)

    const overId = await seedChargedCampaign(client.id, 'over')
    await seedSpend(overId, 16000)
    const totalBefore = (await coinService.getAvailable(client.id)).total
    const walletBefore = await walletCoins(client.id)
    const over = await campaignService.settleCampaignJob(overId)
    expect(over.overspendCoins).toBe(60)
    expect((await coinService.getAvailable(client.id)).total).toBe(totalBefore - 60)
    expect(await walletCoins(client.id)).toBe(walletBefore)
  })

  it('13. insufficient hold releases the claim; top-up then settles', async () => {
    const broke = await createTestUser({ email: `execfin-broke-${dateTag}@flowx-test.com`, password: 'Test@123', coins: 0 })
    const campaignId = await seedChargedCampaign(broke.id, 'hold')
    await seedSpend(campaignId, 2000000)
    const held = await campaignService.settleCampaignJob(campaignId)
    expect(held.held).toBe(true)
    const mid = await campaignRepo.findCampaignById(campaignId)
    expect(mid.settledAt).toBeNull()
    await query('UPDATE user_wallets SET coins = coins + 50000 WHERE user_id = ?', [uuidToBuffer(broke.id)])
    const settled = await campaignService.settleCampaignJob(campaignId)
    expect(settled.success).toBe(true)
    expect(settled.held).toBeUndefined()
    expect(settled.overspendCoins).toBeGreaterThan(0)
    const done = await campaignRepo.findCampaignById(campaignId)
    expect(done.settledAt).toBeTruthy()
  })

  it('14/15. nothing-charged and already-settled stay stable', async () => {
    const freeId = await seedChargedCampaign(client.id, 'free')
    await query('UPDATE campaigns SET charged_ad_budget_paise = 0 WHERE id = ?', [uuidToBuffer(freeId)])
    expect((await campaignService.settleCampaignJob(freeId)).nothingCharged).toBe(true)
    const doneId = await seedChargedCampaign(client.id, 'done')
    await seedSpend(doneId, 1000)
    await campaignService.settleCampaignJob(doneId)
    expect((await campaignService.settleCampaignJob(doneId)).alreadySettled).toBe(true)
  })

  it('17. publisher execution refunds credit the client, never the publisher', async () => {
    const campaignId = await seedChargedCampaign(client.id, 'pub-acct')
    const executionId = await seedExecution(campaignId, publisher.id, 'publisher')
    const clientBefore = await walletCoins(client.id)
    const publisherWalletBefore = await queryOne('SELECT coins FROM user_wallets WHERE user_id = ?', [uuidToBuffer(publisher.id)])
    const result = await execService.refundExecutionShare(executionId, 10000, { reason: 'publisher share' })
    expect(result.disposed).toBe('refunded')
    expect(await walletCoins(client.id)).toBe(clientBefore + 100)
    const publisherWalletAfter = await queryOne('SELECT coins FROM user_wallets WHERE user_id = ?', [uuidToBuffer(publisher.id)])
    expect(Number(publisherWalletAfter?.coins || 0)).toBe(Number(publisherWalletBefore?.coins || 0))
  })

  it('18. charged-zero campaigns refuse disposition without inventing money', async () => {
    const campaignId = generateUuid()
    await campaignRepo.createCampaign(campaignId, client.id, { name: `ExecFin Zero ${dateTag}`, type: 'post' })
    const executionId = await seedExecution(campaignId, client.id)
    const before = await walletCoins(client.id)
    await expect(execService.consumeExecutionShare(executionId, 10000)).rejects.toThrow(/No charged reservation/)
    await expect(execService.refundExecutionShare(executionId, 10000)).rejects.toThrow(/No charged reservation/)
    expect(await walletCoins(client.id)).toBe(before)
    const row = await execRepo.findExecutionById(executionId)
    expect(Number(row.consumedPaise)).toBe(0)
    expect(Number(row.refundedPaise)).toBe(0)
  })

  it('19. escrow-only quarantine refuses both dispositions with zero movement', async () => {
    const campaignId = generateUuid()
    await campaignRepo.createCampaign(campaignId, client.id, { name: `ExecFin Esc ${dateTag}`, type: 'post' })
    await query('UPDATE campaigns SET status = ?, escrow_amount = 550 WHERE id = ?', ['pending_review', uuidToBuffer(campaignId)])
    const executionId = await seedExecution(campaignId, client.id)
    const before = await walletCoins(client.id)
    await expect(execService.consumeExecutionShare(executionId, 10000)).rejects.toThrow(/uarantined/)
    await expect(execService.refundExecutionShare(executionId, 10000)).rejects.toThrow(/uarantined/)
    expect(await walletCoins(client.id)).toBe(before)
    expect(await refundRows(campaignId)).toHaveLength(0)
  })

  it('19b. in-flight escrow without charged reservation refuses without inventing money', async () => {
    const campaignId = generateUuid()
    await campaignRepo.createCampaign(campaignId, client.id, { name: `ExecFin EscFly ${dateTag}`, type: 'post' })
    await query('UPDATE campaigns SET status = ?, escrow_amount = 550 WHERE id = ?', ['paused', uuidToBuffer(campaignId)])
    const executionId = await seedExecution(campaignId, client.id)
    const before = await walletCoins(client.id)
    await expect(execService.consumeExecutionShare(executionId, 10000)).rejects.toThrow(/No charged reservation/)
    await expect(execService.refundExecutionShare(executionId, 10000)).rejects.toThrow(/No charged reservation/)
    expect(await walletCoins(client.id)).toBe(before)
    expect(await refundRows(campaignId)).toHaveLength(0)
  })

  it('20. billing-anomaly quarantine refuses both dispositions with zero movement', async () => {
    const campaignId = await seedChargedCampaign(client.id, 'anomaly')
    await campaignRepo.insertBillingEntry(campaignId, {
      kind: 'charge', paise: 10000, coins: 100, rate: 1, paidFromMonthly: 0, paidFromWallet: 100, reason: 'duplicate charge probe',
    })
    const executionId = await seedExecution(campaignId, client.id)
    const before = await walletCoins(client.id)
    await expect(execService.consumeExecutionShare(executionId, 10000)).rejects.toThrow(/uarantined/)
    await expect(execService.refundExecutionShare(executionId, 10000)).rejects.toThrow(/uarantined/)
    expect(await walletCoins(client.id)).toBe(before)
    const row = await execRepo.findExecutionById(executionId)
    expect(Number(row.consumedPaise)).toBe(0)
    expect(Number(row.refundedPaise)).toBe(0)
  })

  it('21. unrelated wallet activity is never consumed', async () => {
    const campaignId = await seedChargedCampaign(client.id, 'unrelated')
    const executionId = await seedExecution(campaignId, client.id)
    await query('UPDATE user_wallets SET coins = coins + 250 WHERE user_id = ?', [uuidToBuffer(client.id)])
    const before = await walletCoins(client.id)
    const consumed = await execService.consumeExecutionShare(executionId, 10000)
    expect(consumed.disposed).toBe('consumed')
    expect(await walletCoins(client.id)).toBe(before)
  })

  it('23. reservation refund racing spend settlement keeps an exact total', async () => {
    const campaignId = await seedChargedCampaign(client.id, 'race-settle', { chargedPaise: 90000, coins: 900 })
    const executionId = await seedExecution(campaignId, client.id)
    await seedSpend(campaignId, 50000)
    const before = await walletCoins(client.id)
    const outcomes = await Promise.allSettled([
      execService.refundExecutionShare(executionId, 30000, { reason: 'race share' }),
      campaignService.settleCampaignJob(campaignId),
    ])
    expect(outcomes.every(o => o.status === 'fulfilled' || (o.status === 'rejected' && /already settled/i.test(o.reason?.message || '')))).toBe(true)
    const totalRefunded = (await refundRows(campaignId)).reduce((sum, r) => sum + Number(r.paise), 0)
    expect(totalRefunded).toBe(40000)
    expect(await walletCoins(client.id)).toBe(before + 400)
  })
})
