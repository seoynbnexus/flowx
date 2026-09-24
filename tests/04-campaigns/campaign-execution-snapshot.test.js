import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { generateUuid, uuidToBuffer } from '../../shared/utils/uuid.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import * as campaignService from '../../src/modules/campaigns/campaign.service.js'
import * as campaignRepo from '../../src/modules/campaigns/campaign.repository.js'
import * as execRepo from '../../src/modules/campaigns/campaign-execution.repository.js'
import * as execService from '../../src/modules/campaigns/campaign-execution.service.js'
import * as subRepo from '../../src/modules/subscriptions/subscription.repository.js'
import { META_CONFIG } from '../../shared/services/meta-oauth.config.js'
import { query, queryOne } from '../../shared/database/connection.js'

var metaMocks
vi.mock('../../shared/services/meta-ads.service.js', async () => {
  const actual = await vi.importActual('../../shared/services/meta-ads.service.js')
  const mocks = {
    ...actual,
    __counter: 0,
    __nextMetaId: prefix => {
      mocks.__counter += 1
      return `snap_${prefix}_${mocks.__counter}`
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

async function setFlag(key, on) {
  await query(
    `INSERT INTO app_config (id, config_key, config_value, is_public, description, version)
     VALUES (?, ?, ?, 0, 'test', 1)
     ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
    [uuidToBuffer(generateUuid()), key, JSON.stringify(on)]
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

async function seedCampaign(ownerId, { status = 'awaiting_publishers', settings = {}, creative = {} } = {}) {
  const campaignId = generateUuid()
  await campaignRepo.createCampaign(campaignId, ownerId, { name: `Snap ${dateTag} ${campaignId.substring(0, 4)}`, type: 'post' })
  await campaignRepo.createCreative(generateUuid(), campaignId, {
    caption: 'frozen caption', mediaUrl: 'https://example.com/img.jpg', ...creative,
  })
  await campaignRepo.createMetaSettings(generateUuid(), campaignId, {
    objective: 'OUTCOME_TRAFFIC',
    budgetType: 'lifetime',
    budgetAmount: 500,
    endTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    ...settings,
  })
  await query('UPDATE campaigns SET status = ? WHERE id = ?', [status, uuidToBuffer(campaignId)])
  return campaignId
}

async function seedExecution(campaignId, ownerId, kind, { status = 'pending', fbPageId = null } = {}) {
  return execRepo.createExecution({ campaignId, ownerUserId: ownerId, kind, status, fbPageId })
}

async function snapshotMoney(userIds, campaignId) {
  const wallets = await query(`SELECT HEX(user_id) AS u, coins FROM user_wallets WHERE user_id IN (${userIds.map(() => '?').join(',')})`, userIds.map(uuidToBuffer))
  const billing = await query('SELECT kind, paise, coins FROM campaign_billing_entries WHERE campaign_id = ?', [uuidToBuffer(campaignId)])
  const campaign = await campaignRepo.findCampaignById(campaignId)
  return JSON.stringify({ wallets, billing, charged: campaign.chargedAdBudgetPaise })
}

async function snapshotObjects(campaignId) {
  return JSON.stringify(await query('SELECT object_type, object_id, created_for_user_id FROM campaign_meta_objects WHERE campaign_id = ?', [uuidToBuffer(campaignId)]))
}

describe('campaign execution snapshots (Step 10 — frozen configuration)', () => {
  let client, publisher

  beforeAll(async () => {
    client = await createTestUser({ email: `snap-client-${dateTag}@flowx-test.com`, password: 'Test@123', coins: 10000 })
    publisher = await createTestUser({ email: `snap-pub-${dateTag}@flowx-test.com`, password: 'Test@123', role: 'publisher' })
    await ensurePlan(client.id)
    await addVerifiedPage(client.id, `snap_page_${dateTag}`)
    await addVerifiedPage(publisher.id, `snap_pub_page_${dateTag}`)
    await setFlag('campaign_execution_runtime_enabled', true)
    await setFlag('boost_placement_fix_enabled', false)
  })

  afterAll(async () => {
    await setFlag('campaign_execution_runtime_enabled', false)
    await setFlag('boost_placement_fix_enabled', false)
  })

  it('1. snapshot creation freezes parent config plus execution page and hash', async () => {
    const campaignId = await seedCampaign(client.id)
    await seedExecution(campaignId, client.id, 'client', { status: 'pending' })
    const result = await campaignService.routeOwnerChainCreation(campaignId, client.id, `snap_page_${dateTag}`)
    expect(result.path).toBe('execution')
    expect(result.success).toBe(true)
    const snapshot = await campaignRepo.findCampaignSnapshot(campaignId)
    expect(snapshot).toBeTruthy()
    expect(snapshot.config.settings.objective).toBe('OUTCOME_TRAFFIC')
    expect(snapshot.config.creative.caption).toBe('frozen caption')
    expect(snapshot.graphVersion).toBe(META_CONFIG.graphVersion)
    expect(snapshot.hash).toMatch(/^[0-9a-f]{8}$/)
    const execution = await execRepo.findExecutionByOwner(campaignId, client.id, 'client')
    expect(execution.fbPageId).toBe(`snap_page_${dateTag}`)
    expect(execution.configHash).toBe(snapshot.hash)
  })

  it('2/3. serialization and hash are stable across equivalent inputs', async () => {
    const campaignId = await seedCampaign(client.id)
    const first = await execService.freezeCampaignSnapshotFor(campaignId)
    expect(first.frozen).toBe(true)
    const stored = await campaignRepo.findCampaignSnapshot(campaignId)
    const again = await execService.freezeCampaignSnapshotFor(campaignId)
    expect(again.hash).toBe(first.hash)
    expect(again.hash).toBe(stored.hash)
    expect(JSON.stringify(stored.config)).toBe(JSON.stringify((await campaignRepo.findCampaignSnapshot(campaignId)).config))
  })

  it('4. freeze is immutable: later runs do not rewrite the snapshot', async () => {
    const campaignId = await seedCampaign(client.id)
    await seedExecution(campaignId, client.id, 'client', { status: 'pending' })
    await campaignService.routeOwnerChainCreation(campaignId, client.id, `snap_page_${dateTag}`)
    const before = await campaignRepo.findCampaignSnapshot(campaignId)
    await campaignRepo.createCreative(generateUuid(), campaignId, { caption: 'edited caption', mediaUrl: 'https://example.com/other.jpg' })
    const execution = await execRepo.findExecutionByOwner(campaignId, client.id, 'client')
    expect(execution.configHash).toBe(before.hash)
    const after = await campaignRepo.findCampaignSnapshot(campaignId)
    expect(JSON.stringify(after.config)).toBe(JSON.stringify(before.config))
  })

  it('5. settings changed after freeze do not change the Meta request', async () => {
    const campaignId = await seedCampaign(client.id)
    await seedExecution(campaignId, publisher.id, 'publisher', { status: 'pending' })
    await campaignService.routeOwnerChainCreation(campaignId, publisher.id, `snap_pub_page_${dateTag}`)
    const snapshot = await campaignRepo.findCampaignSnapshot(campaignId)
    expect(snapshot.config.settings.objective).toBe('OUTCOME_TRAFFIC')
    await campaignRepo.createMetaSettings(generateUuid(), campaignId, {
      objective: 'OUTCOME_ENGAGEMENT',
      budgetType: 'lifetime',
      budgetAmount: 500,
      endTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    })
    const callsBefore = metaMocks.createAdCampaign.mock.calls.length
    const execution = await execRepo.findExecutionByOwner(campaignId, publisher.id, 'publisher')
    expect(execution.configHash).toBe(snapshot.hash)
    const secondPublisher = await createTestUser({ email: `snap-pub2-${dateTag}-${campaignId.substring(0, 4)}@flowx-test.com`, password: 'Test@123', role: 'publisher' })
    await addVerifiedPage(secondPublisher.id, `snap_pub2_${dateTag}`)
    await execRepo.createExecution({ campaignId, ownerUserId: secondPublisher.id, kind: 'publisher', status: 'pending' })
    const result = await campaignService.routeOwnerChainCreation(campaignId, secondPublisher.id, `snap_pub2_${dateTag}`)
    expect(result.path).toBe('execution')
    expect(result.success).toBe(true)
    const newCalls = metaMocks.createAdCampaign.mock.calls.slice(callsBefore)
    const realCalls = newCalls.filter(call => call[call.length - 1] !== true)
    expect(realCalls.length).toBeGreaterThan(0)
    for (const call of realCalls) {
      expect(call[2]).toBe('OUTCOME_TRAFFIC')
    }
    void result
  })

  it('6. creative changed after freeze does not change the Meta request', async () => {
    const campaignId = await seedCampaign(client.id)
    await seedExecution(campaignId, client.id, 'client', { status: 'pending' })
    await campaignService.routeOwnerChainCreation(campaignId, client.id, `snap_page_${dateTag}`)
    await campaignRepo.createCreative(generateUuid(), campaignId, { caption: 'edited live caption', mediaUrl: 'https://example.com/edited.jpg' })
    const execution = await execRepo.findExecutionByOwner(campaignId, client.id, 'client')
    await execRepo.updateExecution(execution.id, {
      status: 'pending', platformCampaignId: null, platformAdsetId: null, platformCreativeId: null, platformAdId: null,
    })
    await campaignRepo.deleteMetaObjectsForUser(campaignId, client.id)
    const callsBefore = metaMocks.createAdCreative.mock.calls.length
    const rerun = await campaignService.runExecutionChainCreation(campaignId, client.id, `snap_page_${dateTag}`)
    expect(rerun.path).toBe('execution')
    expect(rerun.success).toBe(true)
    const reread = await execRepo.findExecutionByOwner(campaignId, client.id, 'client')
    expect(reread.status).toBe('creating')
    const newCalls = metaMocks.createAdCreative.mock.calls.slice(callsBefore)
    const realCalls = newCalls.filter(call => call[call.length - 1] !== true)
    expect(realCalls.length).toBeGreaterThan(0)
    for (const call of realCalls) {
      expect(call[2]).toBe('frozen caption')
    }
  })

  it('7. placement flag flip keeps frozen placement authoritative', async () => {
    await setFlag('boost_placement_fix_enabled', false)
    const campaignId = await seedCampaign(client.id, {
      settings: { platformPlacement: { publisher_platforms: ['facebook'], facebook_positions: ['feed'] } },
    })
    await seedExecution(campaignId, publisher.id, 'publisher', { status: 'pending' })
    await campaignService.routeOwnerChainCreation(campaignId, publisher.id, `snap_pub_page_${dateTag}`)
    const snapshot = await campaignRepo.findCampaignSnapshot(campaignId)
    expect(snapshot.config.settings.platformPlacement).toEqual({ publisher_platforms: ['facebook'], facebook_positions: ['feed'] })
    await setFlag('boost_placement_fix_enabled', true)
    const callsBefore = metaMocks.createAdSet.mock.calls.length
    const execution = await execRepo.findExecutionByOwner(campaignId, publisher.id, 'publisher')
    await execRepo.updateExecution(execution.id, {
      status: 'pending', platformCampaignId: null, platformAdsetId: null, platformCreativeId: null, platformAdId: null,
    })
    await campaignRepo.deleteMetaObjectsForUser(campaignId, publisher.id)
    const result = await campaignService.routeOwnerChainCreation(campaignId, publisher.id, `snap_pub_page_${dateTag}`)
    expect(result.success).toBe(true)
    const newCalls = metaMocks.createAdSet.mock.calls.slice(callsBefore)
    const realCalls = newCalls.filter(call => call[call.length - 1] !== true)
    expect(realCalls.length).toBeGreaterThan(0)
    for (const call of realCalls) {
      expect(call[5]).toEqual({ publisher_platforms: ['facebook'], facebook_positions: ['feed'] })
    }
    await setFlag('boost_placement_fix_enabled', false)
  })

  it('8. graph version mismatch fails closed with zero Meta calls', async () => {
    const campaignId = await seedCampaign(client.id)
    await seedExecution(campaignId, client.id, 'client', { status: 'pending' })
    await campaignService.routeOwnerChainCreation(campaignId, client.id, `snap_page_${dateTag}`)
    await query('UPDATE campaigns SET resolved_graph_version = ? WHERE id = ?', ['v99.0', uuidToBuffer(campaignId)])
    const callsBefore = metaMocks.createAdCampaign.mock.calls.length
    const freshClient = await createTestUser({ email: `snap-cli3-${dateTag}-${campaignId.substring(0, 4)}@flowx-test.com`, password: 'Test@123', coins: 100 })
    await execRepo.createExecution({ campaignId, ownerUserId: freshClient.id, kind: 'publisher', status: 'pending' })
    await addVerifiedPage(freshClient.id, `snap_cli3_${dateTag}`)
    const result = await campaignService.routeOwnerChainCreation(campaignId, freshClient.id, `snap_cli3_${dateTag}`)
    expect(result.success).toBe(false)
    expect(result.failClosed).toBe(true)
    expect(result.error).toMatch(/version-mismatch/)
    expect(metaMocks.createAdCampaign.mock.calls.length).toBe(callsBefore)
  })

  it('9/10. frozen fb_page_id survives disconnect and reconnect', async () => {
    const campaignId = await seedCampaign(client.id)
    await seedExecution(campaignId, publisher.id, 'publisher', { status: 'pending' })
    const first = await campaignService.routeOwnerChainCreation(campaignId, publisher.id, `snap_pub_page_${dateTag}`)
    expect(first.success).toBe(true)
    const execution = await execRepo.findExecutionByOwner(campaignId, publisher.id, 'publisher')
    await execRepo.updateExecution(execution.id, {
      status: 'pending', platformCampaignId: null, platformAdsetId: null, platformCreativeId: null, platformAdId: null,
    })
    await campaignRepo.deleteMetaObjectsForUser(campaignId, publisher.id)
    const callsBefore = metaMocks.createAdCreative.mock.calls.length
    const second = await campaignService.routeOwnerChainCreation(campaignId, publisher.id, 'PAGE_B_AFTER_ROTATION')
    expect(second.success).toBe(true)
    const after = await execRepo.findExecutionByOwner(campaignId, publisher.id, 'publisher')
    expect(after.fbPageId).toBe(`snap_pub_page_${dateTag}`)
    const newCalls = metaMocks.createAdCreative.mock.calls.slice(callsBefore)
    const realCalls = newCalls.filter(call => call[call.length - 1] !== true)
    expect(realCalls.length).toBeGreaterThan(0)
    for (const call of realCalls) {
      expect(call[1]).toBe(`snap_pub_page_${dateTag}`)
    }
  })

  it('11/12/13. client, publisher and dual-kind snapshots are independent', async () => {
    const campaignId = await seedCampaign(client.id)
    await seedExecution(campaignId, client.id, 'client', { status: 'pending' })
    await seedExecution(campaignId, client.id, 'publisher', { status: 'pending' })
    await campaignService.routeOwnerChainCreation(campaignId, client.id, `snap_page_${dateTag}`)
    const clientExec = await execRepo.findExecutionByOwner(campaignId, client.id, 'client')
    const publisherExec = await execRepo.findExecutionByOwner(campaignId, client.id, 'publisher')
    expect(clientExec.fbPageId).toBe(`snap_page_${dateTag}`)
    expect(publisherExec.fbPageId).toBeNull()
    expect(clientExec.configHash).toBeTruthy()
    expect(publisherExec.configHash).toBeNull()
    const snapshot = await campaignRepo.findCampaignSnapshot(campaignId)
    expect(clientExec.configHash).toBe(snapshot.hash)
  })

  it('14. two executions share one parent snapshot; refreeze fails the old closed', async () => {
    const campaignId = await seedCampaign(client.id)
    await seedExecution(campaignId, client.id, 'client', { status: 'pending' })
    await seedExecution(campaignId, publisher.id, 'publisher', { status: 'pending' })
    await campaignService.routeOwnerChainCreation(campaignId, client.id, `snap_page_${dateTag}`)
    await campaignService.routeOwnerChainCreation(campaignId, publisher.id, `snap_pub_page_${dateTag}`)
    const first = await campaignRepo.findCampaignSnapshot(campaignId)
    const clientExec = await execRepo.findExecutionByOwner(campaignId, client.id, 'client')
    const publisherExec = await execRepo.findExecutionByOwner(campaignId, publisher.id, 'publisher')
    expect(clientExec.configHash).toBe(first.hash)
    expect(publisherExec.configHash).toBe(first.hash)
    await campaignRepo.createMetaSettings(generateUuid(), campaignId, {
      objective: 'OUTCOME_ENGAGEMENT',
      budgetType: 'lifetime',
      budgetAmount: 500,
      endTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    })
    const refrozen = await execService.freezeCampaignSnapshotFor(campaignId)
    expect(refrozen.frozen).toBe(true)
    expect(refrozen.hash).not.toBe(first.hash)
    await execRepo.updateExecution(clientExec.id, {
      status: 'pending', platformCampaignId: null, platformAdsetId: null, platformCreativeId: null, platformAdId: null,
    })
    await campaignRepo.deleteMetaObjectsForUser(campaignId, client.id)
    const callsBefore = metaMocks.createAdCampaign.mock.calls.length
    const stale = await campaignService.routeOwnerChainCreation(campaignId, client.id, `snap_page_${dateTag}`)
    expect(stale.success).toBe(false)
    expect(stale.failClosed).toBe(true)
    expect(stale.error).toMatch(/hash-mismatch/)
    expect(metaMocks.createAdCampaign.mock.calls.length).toBe(callsBefore)
  })

  it('15. historical execution without resolvable data fails closed explicitly', async () => {
    const campaignId = generateUuid()
    await campaignRepo.createCampaign(campaignId, client.id, { name: `Snap Bare ${dateTag}`, type: 'post' })
    await query('UPDATE campaigns SET status = ? WHERE id = ?', ['awaiting_publishers', uuidToBuffer(campaignId)])
    await seedExecution(campaignId, publisher.id, 'publisher', { status: 'pending' })
    const callsBefore = metaMocks.createAdCampaign.mock.calls.length
    const result = await campaignService.routeOwnerChainCreation(campaignId, publisher.id, `snap_pub_page_${dateTag}`)
    expect(result.success).toBe(false)
    expect(result.failClosed).toBe(true)
    expect(result.error).toMatch(/unresolvable/)
    expect(metaMocks.createAdCampaign.mock.calls.length).toBe(callsBefore)
    const execution = await execRepo.findExecutionByOwner(campaignId, publisher.id, 'publisher')
    expect(execution.status).toBe('pending')
    expect(execution.fbPageId).toBeNull()
  })

  it('16/17. snapshot backfill is idempotent, Meta-free and money-free', async () => {
    const campaignId = await seedCampaign(client.id)
    await seedExecution(campaignId, client.id, 'client', { status: 'pending' })
    const moneyBefore = await snapshotMoney([client.id, publisher.id], campaignId)
    const objectsBefore = await snapshotObjects(campaignId)
    for (const fn of Object.keys(metaMocks)) {
      if (metaMocks[fn]?.mock) metaMocks[fn].mockClear()
    }
    await execService.backfillExecutionSnapshots({ batch: 25, execute: true })
    const snapshot = await campaignRepo.findCampaignSnapshot(campaignId)
    expect(snapshot).toBeTruthy()
    await execService.backfillExecutionSnapshots({ batch: 25, execute: true })
    const resnapshot = await campaignRepo.findCampaignSnapshot(campaignId)
    expect(JSON.stringify(resnapshot.config)).toBe(JSON.stringify(snapshot.config))
    expect(resnapshot.hash).toBe(snapshot.hash)
    for (const fn of Object.keys(metaMocks)) {
      if (metaMocks[fn]?.mock) expect(metaMocks[fn]).not.toHaveBeenCalled()
    }
    expect(await snapshotMoney([client.id, publisher.id], campaignId)).toBe(moneyBefore)
    expect(await snapshotObjects(campaignId)).toBe(objectsBefore)
  })

  it('18/19. routing and backfill move no money and preserve historical rows', async () => {
    const campaignId = await seedCampaign(client.id)
    await seedExecution(campaignId, client.id, 'client', { status: 'pending' })
    const moneyBefore = await snapshotMoney([client.id, publisher.id], campaignId)
    const result = await campaignService.routeOwnerChainCreation(campaignId, client.id, `snap_page_${dateTag}`)
    expect(result.success).toBe(true)
    expect(await snapshotMoney([client.id, publisher.id], campaignId)).toBe(moneyBefore)
  })
})
