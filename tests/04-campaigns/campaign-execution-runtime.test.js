import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { generateUuid, uuidToBuffer } from '../../shared/utils/uuid.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import * as campaignService from '../../src/modules/campaigns/campaign.service.js'
import * as campaignRepo from '../../src/modules/campaigns/campaign.repository.js'
import * as execRepo from '../../src/modules/campaigns/campaign-execution.repository.js'
import * as subRepo from '../../src/modules/subscriptions/subscription.repository.js'
import { query, queryOne } from '../../shared/database/connection.js'
import { drainCampaignJobs } from '../../src/modules/campaigns/campaign.jobs.js'

var metaMocks
vi.mock('../../shared/services/meta-ads.service.js', async () => {
  const actual = await vi.importActual('../../shared/services/meta-ads.service.js')
  const mocks = {
    ...actual,
    __counter: 0,
    __nextMetaId: prefix => {
      mocks.__counter += 1
      return `rt_${prefix}_${mocks.__counter}`
    },
    createAdCampaign: vi.fn().mockImplementation(async () => ({ id: mocks.__nextMetaId('mock_campaign') })),
    createAdSet: vi.fn().mockImplementation(async () => ({ id: mocks.__nextMetaId('mock_adset') })),
    createAdCreative: vi.fn().mockImplementation(async () => ({ id: mocks.__nextMetaId('mock_creative') })),
    createAd: vi.fn().mockImplementation(async () => ({ id: mocks.__nextMetaId('mock_ad') })),
    updateAdStatus: vi.fn().mockResolvedValue({ success: true }),
    deleteAd: vi.fn().mockResolvedValue({}),
    deleteAdSet: vi.fn().mockResolvedValue({}),
    deleteAdCreative: vi.fn().mockResolvedValue({}),
    deleteAdCampaign: vi.fn().mockResolvedValue({}),
    getObjectStatus: vi.fn().mockResolvedValue({ status: 'ACTIVE', effective_status: 'ACTIVE' }),
    getMetaObject: vi.fn().mockImplementation(async id => ({ id })),
    listAccountCampaigns: vi.fn().mockResolvedValue({ rows: [], truncated: false }),
    listCampaignAdSets: vi.fn().mockResolvedValue({ rows: [], truncated: false }),
    listAdSetAds: vi.fn().mockResolvedValue({ rows: [], truncated: false }),
  }
  metaMocks = mocks
  return mocks
})

const dateTag = Date.now()

async function setRuntimeFlag(on) {
  await query(
    `INSERT INTO app_config (id, config_key, config_value, is_public, description, version)
     VALUES (?, 'campaign_execution_runtime_enabled', ?, 0, 'test', 1)
     ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
    [uuidToBuffer(generateUuid()), JSON.stringify(on)]
  )
}

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

async function addVerifiedPage(userId, platformUserId) {
  const fbPlatform = await queryOne("SELECT id FROM platforms WHERE code = 'facebook'")
  if (!fbPlatform) return
  await query(
    `INSERT INTO user_platform_accounts (id, user_id, platform_id, profile_url, platform_user_id, platform_username, token_type, token_expires_at, verification_status)
     VALUES (?, ?, ?, ?, ?, ?, 'page', DATE_ADD(NOW(), INTERVAL 60 DAY), 'verified')`,
    [uuidToBuffer(generateUuid()), uuidToBuffer(userId), fbPlatform.id, 'https://fb.com/test', platformUserId, 'TestPage']
  )
}

async function seedCampaign(ownerId, { status = 'awaiting_publishers' } = {}) {
  const campaignId = generateUuid()
  await campaignRepo.createCampaign(campaignId, ownerId, { name: `Runtime ${dateTag} ${campaignId.substring(0, 4)}`, type: 'post' })
  await campaignRepo.createCreative(generateUuid(), campaignId, { caption: 'runtime', mediaUrl: 'https://example.com/img.jpg' })
  await campaignRepo.createMetaSettings(generateUuid(), campaignId, {
    objective: 'OUTCOME_TRAFFIC',
    budgetType: 'lifetime',
    budgetAmount: 500,
    endTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  })
  await query('UPDATE campaigns SET status = ? WHERE id = ?', [status, uuidToBuffer(campaignId)])
  return campaignId
}

async function seedExecution(campaignId, ownerId, kind, { status = 'pending', chain = null, requestId = null } = {}) {
  return execRepo.createExecution({
    campaignId,
    ownerUserId: ownerId,
    kind,
    publisherRequestId: requestId,
    status,
    platformCampaignId: chain?.facebook_campaign || null,
    platformAdsetId: chain?.ad_set || null,
    platformCreativeId: chain?.ad_creative || null,
    platformAdId: chain?.ad || null,
  })
}

async function seedLegacyChain(campaignId, ownerId, prefix) {
  const chain = {}
  for (const [objectType, suffix] of [['facebook_campaign', 'camp'], ['ad_set', 'set'], ['ad_creative', 'cr'], ['ad', 'ad']]) {
    const objectId = `${prefix}_${suffix}`
    await campaignRepo.createMetaObject(campaignId, objectType, objectId, null, 'ACTIVE', ownerId)
    chain[objectType] = objectId
  }
  return chain
}

async function snapshotMoney(userIds, campaignId) {
  const wallets = await query(`SELECT HEX(user_id) AS u, coins FROM user_wallets WHERE user_id IN (${userIds.map(() => '?').join(',')})`, userIds.map(uuidToBuffer))
  const billing = await query('SELECT kind, paise, coins FROM campaign_billing_entries WHERE campaign_id = ?', [uuidToBuffer(campaignId)])
  const campaign = await campaignRepo.findCampaignById(campaignId)
  const objects = await query('SELECT object_type, object_id, created_for_user_id FROM campaign_meta_objects WHERE campaign_id = ?', [uuidToBuffer(campaignId)])
  return JSON.stringify({ wallets, billing, charged: campaign.chargedAdBudgetPaise, escrow: campaign.escrowAmount, objects })
}

describe('campaign execution runtime (Step 9 — routing authority only)', () => {
  let client, publisher

  beforeAll(async () => {
    client = await createTestUser({ email: `rt-client-${dateTag}@flowx-test.com`, password: 'Test@123', coins: 10000 })
    publisher = await createTestUser({ email: `rt-pub-${dateTag}@flowx-test.com`, password: 'Test@123', role: 'publisher' })
    await ensurePlan(client.id)
    await addVerifiedPage(client.id, `rt_page_${dateTag}`)
    await addVerifiedPage(publisher.id, `rt_pub_page_${dateTag}`)
    await setRuntimeFlag(false)
  })

  afterAll(async () => {
    await setRuntimeFlag(false)
  })

  it('1. flag OFF routes to the legacy path and leaves execution rows untouched', async () => {
    await setRuntimeFlag(false)
    expect(await campaignService.isCampaignExecutionRuntimeEnabled()).toBe(false)
    const campaignId = await seedCampaign(client.id)
    await seedExecution(campaignId, client.id, 'client', { status: 'pending' })
    const result = await campaignService.routeOwnerChainCreation(campaignId, client.id, `rt_page_${dateTag}`)
    expect(result.path).toBe('legacy')
    expect(result.success).toBe(true)
    const objects = await campaignRepo.findMetaObjectsForUser(campaignId, client.id)
    expect(objects).toHaveLength(4)
    const execution = await execRepo.findExecutionByOwner(campaignId, client.id, 'client')
    expect(execution.status).toBe('pending')
    expect(execution.platformCampaignId).toBeNull()
    expect(execution.attempts).toBe(0)
  })

  it('2/8. flag ON with an eligible publisher execution runs the execution path exactly once', async () => {
    await setRuntimeFlag(true)
    const campaignId = await seedCampaign(client.id)
    await seedExecution(campaignId, publisher.id, 'publisher', { status: 'pending' })
    const routed = await campaignService.routeOwnerChainCreation(campaignId, publisher.id, `rt_pub_page_${dateTag}`)
    expect(routed.path).toBe('execution')
    expect(routed.success).toBe(true)
    expect(routed.executionId).toBeTruthy()
    const objects = await campaignRepo.findMetaObjectsForUser(campaignId, publisher.id)
    expect(objects).toHaveLength(4)
    const execution = await execRepo.findExecutionByOwner(campaignId, publisher.id, 'publisher')
    expect(execution.status).toBe('creating')
    expect(execution.platformCampaignId).toBeTruthy()
    expect(execution.platformAdsetId).toBeTruthy()
    expect(execution.platformCreativeId).toBeTruthy()
    expect(execution.platformAdId).toBeTruthy()
    expect(execution.attempts).toBe(1)
  })

  it('7. flag ON with an eligible client execution runs the execution path', async () => {
    await setRuntimeFlag(true)
    const campaignId = await seedCampaign(client.id)
    await seedExecution(campaignId, client.id, 'client', { status: 'pending' })
    const result = await campaignService.routeOwnerChainCreation(campaignId, client.id, `rt_page_${dateTag}`)
    expect(result.path).toBe('execution')
    expect(result.success).toBe(true)
    const execution = await execRepo.findExecutionByOwner(campaignId, client.id, 'client')
    expect(execution.status).toBe('creating')
    expect(execution.platformCampaignId).toBeTruthy()
  })

  it('3. flag ON with no execution fails closed with zero Meta calls', async () => {
    await setRuntimeFlag(true)
    const campaignId = await seedCampaign(client.id)
    const callsBefore = metaMocks.createAdCampaign.mock.calls.length
    const result = await campaignService.routeOwnerChainCreation(campaignId, client.id, `rt_page_${dateTag}`)
    expect(result.path).toBe('execution')
    expect(result.success).toBe(false)
    expect(result.failClosed).toBe(true)
    expect(result.error).toMatch(/required but missing/i)
    expect(metaMocks.createAdCampaign.mock.calls.length).toBe(callsBefore)
    const objects = await campaignRepo.findMetaObjectsForUser(campaignId, client.id)
    expect(objects).toHaveLength(0)
  })

  // Regression: every test above drives routeOwnerChainCreation directly
  // after manually seeding an execution row via the seedExecution test
  // helper — that never exercised the real caller. approveCampaign's
  // client-only (no publisher adjustments) branch enqueued the
  // approve_go_live job WITHOUT ever staging that row first, so a brand new
  // client-only campaign always died with "Campaign execution required but
  // missing" the first time anyone approved it with the flag on (live-found
  // on campaign A-7). confirmAdjustments' client-only branch had the exact
  // same gap. Both are now fixed by staging via findOrCreatePendingExecution
  // before enqueueing, mirroring queuePublisherApprovalFlow's own pattern.
  it('16. approveCampaign (client-only, no adjustments) stages the execution before enqueueing — does not fail closed', async () => {
    await setRuntimeFlag(true)
    const campaignId = await seedCampaign(client.id, { status: 'pending_review' })
    const beforeExecution = await execRepo.findExecutionByOwner(campaignId, client.id, 'client')
    expect(beforeExecution).toBeNull()

    const result = await campaignService.approveCampaign(client.id, campaignId, {})
    expect(result.queued).toBe(true)

    const staged = await execRepo.findExecutionByOwner(campaignId, client.id, 'client')
    expect(staged).toBeTruthy()
    expect(staged.status).toBe('pending')

    await drainCampaignJobs()

    const campaign = await campaignRepo.findCampaignById(campaignId)
    expect(campaign.metaStatus).not.toBe('failed')
    expect(campaign.metaError).toBeFalsy()
    expect(['running', 'scheduled']).toContain(campaign.status)

    const execution = await execRepo.findExecutionByOwner(campaignId, client.id, 'client')
    expect(execution.status).toBe('creating')
    expect(execution.platformCampaignId).toBeTruthy()
    expect(execution.platformAdsetId).toBeTruthy()
    expect(execution.platformCreativeId).toBeTruthy()
    expect(execution.platformAdId).toBeTruthy()
  })

  it('17. confirmAdjustments (client-only) also stages the execution before enqueueing', async () => {
    await setRuntimeFlag(true)
    const campaignId = await seedCampaign(client.id, { status: 'approved' })
    await query('UPDATE campaigns SET admin_notes = ? WHERE id = ?', ['Budget adjusted', uuidToBuffer(campaignId)])

    const result = await campaignService.confirmAdjustments(client.id, campaignId)
    expect(result.queued).toBe(true)

    const staged = await execRepo.findExecutionByOwner(campaignId, client.id, 'client')
    expect(staged).toBeTruthy()

    await drainCampaignJobs()

    const campaign = await campaignRepo.findCampaignById(campaignId)
    expect(campaign.metaStatus).not.toBe('failed')
    expect(campaign.metaError).toBeFalsy()
  })

  // Regression: campaign.status stays PENDING_REVIEW even after a
  // permanently-failed publish attempt (the transition only happens once
  // publishAdForClient succeeds), so an admin routinely clicks Approve again
  // on the SAME campaign after fixing whatever caused the failure (e.g. a
  // bad schedule). Before this fix, the second approval found the execution
  // row still sitting in its terminal 'failed' state from the first attempt
  // and immediately failed closed with "Execution terminal (failed)"
  // instead of actually retrying — live-observed on campaign A-7.
  it('18. re-approving after a prior permanent execution failure rearms it instead of failing closed on "Execution terminal"', async () => {
    await setRuntimeFlag(true)
    const campaignId = await seedCampaign(client.id, { status: 'pending_review' })
    await seedExecution(campaignId, client.id, 'client', { status: 'failed' })

    const result = await campaignService.approveCampaign(client.id, campaignId, {})
    expect(result.queued).toBe(true)

    const rearmed = await execRepo.findExecutionByOwner(campaignId, client.id, 'client')
    expect(rearmed.status).toBe('pending')

    await drainCampaignJobs()

    const campaign = await campaignRepo.findCampaignById(campaignId)
    expect(campaign.metaStatus).not.toBe('failed')
    expect(campaign.metaError).toBeFalsy()
    expect(['running', 'scheduled']).toContain(campaign.status)

    const execution = await execRepo.findExecutionByOwner(campaignId, client.id, 'client')
    expect(execution.status).toBe('creating')
    expect(execution.platformAdId).toBeTruthy()
  })

  it('19. re-confirming after a prior permanent execution failure rearms it too', async () => {
    await setRuntimeFlag(true)
    const campaignId = await seedCampaign(client.id, { status: 'approved' })
    await query('UPDATE campaigns SET admin_notes = ? WHERE id = ?', ['Budget adjusted', uuidToBuffer(campaignId)])
    await seedExecution(campaignId, client.id, 'client', { status: 'failed' })

    const result = await campaignService.confirmAdjustments(client.id, campaignId)
    expect(result.queued).toBe(true)

    const rearmed = await execRepo.findExecutionByOwner(campaignId, client.id, 'client')
    expect(rearmed.status).toBe('pending')

    await drainCampaignJobs()

    const campaign = await campaignRepo.findCampaignById(campaignId)
    expect(campaign.metaStatus).not.toBe('failed')
    expect(campaign.metaError).toBeFalsy()
  })

  it('4. quarantined executions are excluded with zero Meta calls', async () => {
    await setRuntimeFlag(true)
    const campaignId = await seedCampaign(client.id, { status: 'pending_review' })
    await query('UPDATE campaigns SET escrow_amount = 550 WHERE id = ?', [uuidToBuffer(campaignId)])
    await seedExecution(campaignId, publisher.id, 'publisher', { status: 'pending' })
    const callsBefore = metaMocks.createAdCampaign.mock.calls.length
    const result = await campaignService.routeOwnerChainCreation(campaignId, publisher.id, `rt_pub_page_${dateTag}`)
    expect(result.path).toBe('execution')
    expect(result.success).toBe(false)
    expect(result.skipped).toBe('quarantined')
    expect(result.quarantine).toBe('escrow-unsettled')
    expect(metaMocks.createAdCampaign.mock.calls.length).toBe(callsBefore)
    const objects = await campaignRepo.findMetaObjectsForUser(campaignId, publisher.id)
    expect(objects).toHaveLength(0)
  })

  it('5. failed executions route deterministically with zero Meta calls', async () => {
    await setRuntimeFlag(true)
    const campaignId = await seedCampaign(client.id)
    await seedExecution(campaignId, publisher.id, 'publisher', { status: 'failed' })
    const callsBefore = metaMocks.createAdCampaign.mock.calls.length
    const result = await campaignService.routeOwnerChainCreation(campaignId, publisher.id, `rt_pub_page_${dateTag}`)
    expect(result.path).toBe('execution')
    expect(result.success).toBe(false)
    expect(result.skipped).toBe('terminal')
    expect(metaMocks.createAdCampaign.mock.calls.length).toBe(callsBefore)
  })

  it('6. pending executions create exactly one chain', async () => {
    await setRuntimeFlag(true)
    const campaignId = await seedCampaign(client.id)
    await seedExecution(campaignId, publisher.id, 'publisher', { status: 'pending' })
    const campaignCalls = metaMocks.createAdCampaign.mock.calls.length
    const result = await campaignService.routeOwnerChainCreation(campaignId, publisher.id, `rt_pub_page_${dateTag}`)
    expect(result.success).toBe(true)
    expect(metaMocks.createAdCampaign.mock.calls.length).toBe(campaignCalls + 2)
    const objects = await campaignRepo.findMetaObjectsForUser(campaignId, publisher.id)
    expect(objects).toHaveLength(4)
  })

  it('9. client and publisher kinds for the same owner route independently', async () => {
    await setRuntimeFlag(true)
    const campaignId = await seedCampaign(client.id)
    await seedExecution(campaignId, client.id, 'client', { status: 'pending' })
    await seedExecution(campaignId, client.id, 'publisher', { status: 'pending' })
    const forClient = await campaignService.routeOwnerChainCreation(campaignId, client.id, `rt_page_${dateTag}`)
    expect(forClient.path).toBe('execution')
    expect(forClient.success).toBe(true)
    const clientExec = await execRepo.findExecutionByOwner(campaignId, client.id, 'client')
    const publisherExec = await execRepo.findExecutionByOwner(campaignId, client.id, 'publisher')
    expect(clientExec.status).toBe('creating')
    expect(publisherExec.status).toBe('pending')
  })

  it('10. mixed populations route deterministically per execution', async () => {
    await setRuntimeFlag(true)
    const legacyOnly = await seedCampaign(client.id)
    const live = await seedCampaign(client.id)
    const liveChain = await seedLegacyChain(live, publisher.id, `rt_live_${dateTag}`)
    await seedExecution(live, publisher.id, 'publisher', { status: 'active', chain: liveChain })
    const failed = await seedCampaign(client.id)
    await seedExecution(failed, publisher.id, 'publisher', { status: 'failed' })
    const pending = await seedCampaign(client.id)
    await seedExecution(pending, publisher.id, 'publisher', { status: 'pending' })
    const quarantined = await seedCampaign(client.id, { status: 'pending_review' })
    await query('UPDATE campaigns SET escrow_amount = 550 WHERE id = ?', [uuidToBuffer(quarantined)])
    await seedExecution(quarantined, publisher.id, 'publisher', { status: 'pending' })

    const rLegacy = await campaignService.routeOwnerChainCreation(legacyOnly, client.id, `rt_page_${dateTag}`)
    expect(rLegacy).toMatchObject({ path: 'execution', success: false, failClosed: true })
    const rLive = await campaignService.routeOwnerChainCreation(live, publisher.id, `rt_pub_page_${dateTag}`)
    expect(rLive).toMatchObject({ path: 'execution', success: true, skipped: 'already-live' })
    const rFailed = await campaignService.routeOwnerChainCreation(failed, publisher.id, `rt_pub_page_${dateTag}`)
    expect(rFailed).toMatchObject({ path: 'execution', success: false, skipped: 'terminal' })
    const rPending = await campaignService.routeOwnerChainCreation(pending, publisher.id, `rt_pub_page_${dateTag}`)
    expect(rPending).toMatchObject({ path: 'execution', success: true })
    expect(rPending.skipped).toBeUndefined()
    const rQuar = await campaignService.routeOwnerChainCreation(quarantined, publisher.id, `rt_pub_page_${dateTag}`)
    expect(rQuar).toMatchObject({ path: 'execution', success: false, skipped: 'quarantined' })
  })

  it('11. existing Meta IDs are adopted, never recreated', async () => {
    await setRuntimeFlag(true)
    const campaignId = await seedCampaign(client.id)
    const chain = await seedLegacyChain(campaignId, publisher.id, `rt_adopt_${dateTag}`)
    await seedExecution(campaignId, publisher.id, 'publisher', { status: 'pending' })
    const callsBefore = metaMocks.createAdCampaign.mock.calls.length
    const result = await campaignService.routeOwnerChainCreation(campaignId, publisher.id, `rt_pub_page_${dateTag}`)
    expect(result.path).toBe('execution')
    expect(result.success).toBe(true)
    expect(result.skipped).toBe('adopted-legacy-chain')
    expect(metaMocks.createAdCampaign.mock.calls.length).toBe(callsBefore)
    const execution = await execRepo.findExecutionByOwner(campaignId, publisher.id, 'publisher')
    expect(execution.platformCampaignId).toBe(chain.facebook_campaign)
    expect(execution.platformAdId).toBe(chain.ad)
    const objects = await campaignRepo.findMetaObjectsForUser(campaignId, publisher.id)
    expect(objects).toHaveLength(4)
  })

  it('12. exactly one side-effecting path runs per execution', async () => {
    await setRuntimeFlag(true)
    const campaignId = await seedCampaign(client.id)
    await seedExecution(campaignId, publisher.id, 'publisher', { status: 'pending' })
    const campaignCalls = metaMocks.createAdCampaign.mock.calls.length
    const adCalls = metaMocks.createAd.mock.calls.length
    const result = await campaignService.routeOwnerChainCreation(campaignId, publisher.id, `rt_pub_page_${dateTag}`)
    expect(result.path).toBe('execution')
    expect(metaMocks.createAdCampaign.mock.calls.length).toBe(campaignCalls + 2)
    expect(metaMocks.createAd.mock.calls.length).toBe(adCalls + 2)
    const execution = await execRepo.findExecutionByOwner(campaignId, publisher.id, 'publisher')
    expect(execution.platformCampaignId).toBeTruthy()
    const objects = await campaignRepo.findMetaObjectsForUser(campaignId, publisher.id)
    const campaignIds = objects.filter(o => o.objectType === 'facebook_campaign')
    expect(campaignIds).toHaveLength(1)
  })

  it('13. rollback ON to OFF restores legacy routing without deleting rows', async () => {
    await setRuntimeFlag(true)
    const campaignId = await seedCampaign(client.id)
    await seedExecution(campaignId, client.id, 'client', { status: 'pending' })
    const onResult = await campaignService.routeOwnerChainCreation(campaignId, client.id, `rt_page_${dateTag}`)
    expect(onResult.path).toBe('execution')
    await setRuntimeFlag(false)
    const offResult = await campaignService.routeOwnerChainCreation(campaignId, client.id, `rt_page_${dateTag}`)
    expect(offResult.path).toBe('legacy')
    expect(offResult.success).toBe(true)
    const objects = await campaignRepo.findMetaObjectsForUser(campaignId, client.id)
    expect(objects.filter(o => o.objectType === 'facebook_campaign')).toHaveLength(1)
    const execution = await execRepo.findExecutionByOwner(campaignId, client.id, 'client')
    expect(execution).toBeTruthy()
  })

  it('14/15. routing moves no money and preserves historical meta rows', async () => {
    await setRuntimeFlag(true)
    const campaignId = await seedCampaign(client.id)
    const chain = await seedLegacyChain(campaignId, client.id, `rt_money_${dateTag}`)
    await seedExecution(campaignId, client.id, 'client', { status: 'active', chain })
    const before = await snapshotMoney([client.id, publisher.id], campaignId)
    const result = await campaignService.routeOwnerChainCreation(campaignId, client.id, `rt_page_${dateTag}`)
    expect(result).toMatchObject({ path: 'execution', success: true, skipped: 'already-live' })
    const after = await snapshotMoney([client.id, publisher.id], campaignId)
    expect(after).toBe(before)
    void chain
  })
})
