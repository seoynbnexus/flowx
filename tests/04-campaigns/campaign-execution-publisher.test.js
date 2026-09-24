import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { generateUuid, uuidToBuffer, bufferToUuid } from '../../shared/utils/uuid.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import * as campaignService from '../../src/modules/campaigns/campaign.service.js'
import * as campaignRepo from '../../src/modules/campaigns/campaign.repository.js'
import * as execRepo from '../../src/modules/campaigns/campaign-execution.repository.js'
import * as execService from '../../src/modules/campaigns/campaign-execution.service.js'
import * as subRepo from '../../src/modules/subscriptions/subscription.repository.js'
import { query, queryOne } from '../../shared/database/connection.js'

var metaMocks
vi.mock('../../shared/services/meta-ads.service.js', async () => {
  const actual = await vi.importActual('../../shared/services/meta-ads.service.js')
  let counter = 0
  const nid = prefix => {
    counter += 1
    return `pubmat_${prefix}_${counter}`
  }
  const ledger = { campaigns: [], adsets: [], creatives: [], ads: [] }
  const mocks = {
    ...actual,
    __ledger: ledger,
    // NOTE: the counter is intentionally NEVER reset: campaign_meta_objects
    // carries a GLOBAL unique key on object_id, so reusing an ID from an
    // earlier test in this file collides with persisted rows. IDs must stay
    // monotonic per file; only the in-memory ledger is cleared.
    __reset: () => {
      ledger.campaigns = []
      ledger.adsets = []
      ledger.creatives = []
      ledger.ads = []
    },
    createAdCampaign: vi.fn().mockImplementation(async (adAccountId, name, objective, status, token, extra, validateOnly) => {
      if (validateOnly) return { id: 'validate_ok' }
      const id = nid('mock_campaign')
      ledger.campaigns.push({ id, name })
      return { id }
    }),
    createAdSet: vi.fn().mockImplementation(async (...args) => {
      const validateOnly = args[args.length - 1]
      if (validateOnly === true) return { id: 'validate_ok' }
      const id = nid('mock_adset')
      ledger.adsets.push({ id })
      return { id }
    }),
    createAdCreative: vi.fn().mockImplementation(async (...args) => {
      const id = nid('mock_creative')
      ledger.creatives.push({ id })
      return { id }
    }),
    createAd: vi.fn().mockImplementation(async (...args) => {
      const validateOnly = args[args.length - 1]
      if (validateOnly === true) return { id: 'validate_ok' }
      const id = nid('ad')
      ledger.ads.push({ id })
      return { id }
    }),
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
const savedEnv = {}

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

async function seedAwaitingCampaign(clientId, publisherIds) {
  const campaignId = generateUuid()
  await campaignRepo.createCampaign(campaignId, clientId, {
    name: `PubMat ${dateTag} ${campaignId.substring(0, 4)}`,
    type: 'post',
    publisherCount: publisherIds.length,
    coinsPerPublisher: 100,
  })
  await campaignRepo.createCreative(generateUuid(), campaignId, { caption: 'pubmat caption', mediaUrl: 'https://example.com/img.jpg' })
  await campaignRepo.createMetaSettings(generateUuid(), campaignId, {
    objective: 'OUTCOME_TRAFFIC',
    budgetType: 'lifetime',
    budgetAmount: 500,
    endTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  })
  await query('UPDATE campaigns SET status = ? WHERE id = ?', ['awaiting_publishers', uuidToBuffer(campaignId)])
  await campaignRepo.createPublisherRequests(campaignId, publisherIds, 100)
  const requests = await campaignRepo.findPublisherRequestsByCampaignId(campaignId)
  return { campaignId, requestIds: requests.map(r => r.id) }
}

async function countExecutions(campaignId, ownerId, kind) {
  const rows = await query(
    'SELECT id FROM campaign_executions WHERE campaign_id = ? AND owner_user_id = ? AND kind = ?',
    [uuidToBuffer(campaignId), uuidToBuffer(ownerId), kind]
  )
  return rows
}

function ledgerCreates() {
  return (
    metaMocks.createAdCampaign.mock.calls.filter(c => c[c.length - 1] !== true).length +
    metaMocks.createAdSet.mock.calls.filter(c => c[c.length - 1] !== true).length +
    metaMocks.createAdCreative.mock.calls.length +
    metaMocks.createAd.mock.calls.filter(c => c[c.length - 1] !== true).length
  )
}

describe('campaign execution publisher materialization (A-4 fix)', () => {
  let client, publisher

  beforeAll(async () => {
    savedEnv.accountId = process.env.META_AD_ACCOUNT_ID
    savedEnv.token = process.env.META_SYSTEM_USER_TOKEN
    process.env.META_AD_ACCOUNT_ID = 'act_pubmat_test_account'
    process.env.META_SYSTEM_USER_TOKEN = 'pubmat_test_system_token'
    client = await createTestUser({ email: `pubmat-client-${dateTag}@flowx-test.com`, password: 'Test@123', coins: 10000 })
    publisher = await createTestUser({ email: `pubmat-pub-${dateTag}@flowx-test.com`, password: 'Test@123', role: 'publisher' })
    await ensurePlan(client.id)
    await addVerifiedPage(client.id, `pubmat_page_${dateTag}`)
    await addVerifiedPage(publisher.id, `pubmat_pub_page_${dateTag}`)
    await setFlag('campaign_execution_runtime_enabled', true)
  })

  afterAll(async () => {
    if (savedEnv.accountId === undefined) delete process.env.META_AD_ACCOUNT_ID
    else process.env.META_AD_ACCOUNT_ID = savedEnv.accountId
    if (savedEnv.token === undefined) delete process.env.META_SYSTEM_USER_TOKEN
    else process.env.META_SYSTEM_USER_TOKEN = savedEnv.token
    await setFlag('campaign_execution_runtime_enabled', false)
  })

  it('1. accept stages exactly one pending publisher execution', async () => {
    const { campaignId, requestIds } = await seedAwaitingCampaign(client.id, [publisher.id])
    await campaignService.acceptPublisherRequest(publisher.id, requestIds[0])
    const rows = await countExecutions(campaignId, publisher.id, 'publisher')
    expect(rows).toHaveLength(1)
    const exec = await execRepo.findExecutionById(bufferToUuid(rows[0].id))
    expect(exec.status).toBe('pending')
    expect(exec.kind).toBe('publisher')
    expect(exec.platformCampaignId).toBeNull()
  })

  it('2. repeated and concurrent materialization stay at exactly one execution', async () => {
    const { campaignId, requestIds } = await seedAwaitingCampaign(client.id, [publisher.id])
    await campaignService.acceptPublisherRequest(publisher.id, requestIds[0])
    await expect(campaignService.acceptPublisherRequest(publisher.id, requestIds[0])).rejects.toThrow()
    const settled = await Promise.allSettled([
      execService.findOrCreatePendingExecution(campaignId, publisher.id, 'publisher'),
      execService.findOrCreatePendingExecution(campaignId, publisher.id, 'publisher'),
    ])
    expect(settled.every(s => s.status === 'fulfilled')).toBe(true)
    expect(settled[0].value.execution.id).toBe(settled[1].value.execution.id)
    const rows = await countExecutions(campaignId, publisher.id, 'publisher')
    expect(rows).toHaveLength(1)
  })

  it('3. accept does not create or touch client executions', async () => {
    const { campaignId, requestIds } = await seedAwaitingCampaign(client.id, [publisher.id])
    await campaignService.acceptPublisherRequest(publisher.id, requestIds[0])
    const clientRows = await countExecutions(campaignId, client.id, 'client')
    expect(clientRows).toHaveLength(0)
  })

  it('4. forceGoLive builds the publisher chain on the staged execution with IDs persisted', async () => {
    metaMocks.__reset()
    const { campaignId, requestIds } = await seedAwaitingCampaign(client.id, [publisher.id])
    await execRepo.createExecution({ campaignId, ownerUserId: client.id, kind: 'client', status: 'pending' })
    await campaignService.acceptPublisherRequest(publisher.id, requestIds[0])
    const before = await execRepo.findExecutionByOwner(campaignId, publisher.id, 'publisher')
    expect(before).not.toBeNull()
    const updated = await campaignService.forceGoLiveCampaign(null, campaignId)
    expect(updated.status).toBe('running')
    const after = await execRepo.findExecutionById(before.id)
    expect(after.platformCampaignId).toBeTruthy()
    expect(after.platformAdsetId).toBeTruthy()
    expect(after.platformAdId).toBeTruthy()
    const chains = await query(
      "SELECT object_id FROM campaign_meta_objects WHERE campaign_id = ? AND object_type = 'facebook_campaign' AND created_for_user_id = ?",
      [uuidToBuffer(campaignId), uuidToBuffer(publisher.id)]
    )
    expect(chains).toHaveLength(1)
    expect(chains[0].object_id).toBe(after.platformCampaignId)
    expect(await countExecutions(campaignId, publisher.id, 'publisher')).toHaveLength(1)
  })

  it('5. A-4 sequence invariant: one execution per executed owner, chains map 1:1, IDs populated', async () => {
    metaMocks.__reset()
    const walletsBefore = await queryOne('SELECT coins FROM user_wallets WHERE user_id = ?', [uuidToBuffer(client.id)])
    const { campaignId, requestIds } = await seedAwaitingCampaign(client.id, [publisher.id])
    await execRepo.createExecution({ campaignId, ownerUserId: client.id, kind: 'client', status: 'pending' })
    await campaignService.acceptPublisherRequest(publisher.id, requestIds[0])
    await campaignService.forceGoLiveCampaign(null, campaignId)

    const executions = await execRepo.findExecutionsByCampaignId(campaignId)
    const byKind = Object.fromEntries(executions.map(e => [e.kind, e]))
    expect(Object.keys(byKind).sort()).toEqual(['client', 'publisher'])
    const chains = await query(
      "SELECT object_id, HEX(created_for_user_id) AS owner FROM campaign_meta_objects WHERE campaign_id = ? AND object_type = 'facebook_campaign'",
      [uuidToBuffer(campaignId)]
    )
    expect(chains).toHaveLength(2)
    for (const chain of chains) {
      const match = executions.find(e => e.platformCampaignId === chain.object_id)
      expect(match).toBeTruthy()
      expect(match.platformCampaignId).toBeTruthy()
    }
    const clientChain = chains.find(c => c.owner === client.id.replace(/-/g, '').toUpperCase())
    expect(byKind.client.platformCampaignId).toBe(clientChain.object_id)
    const pubChain = chains.find(c => c.owner === publisher.id.replace(/-/g, '').toUpperCase())
    expect(byKind.publisher.platformCampaignId).toBe(pubChain.object_id)
    // No financial side effects from staging/routing itself.
    const billing = await query('SELECT * FROM campaign_billing_entries WHERE campaign_id = ?', [uuidToBuffer(campaignId)])
    expect(billing).toHaveLength(0)
    const walletsAfter = await queryOne('SELECT coins FROM user_wallets WHERE user_id = ?', [uuidToBuffer(client.id)])
    expect(Number(walletsAfter.coins)).toBe(Number(walletsBefore.coins))
  })

  it('6. accepted-while-OFF then flag ON: go-live stages at go-live and builds (no fail-closed)', async () => {
    await setFlag('campaign_execution_runtime_enabled', false)
    const { campaignId, requestIds } = await seedAwaitingCampaign(client.id, [publisher.id])
    await execRepo.createExecution({ campaignId, ownerUserId: client.id, kind: 'client', status: 'pending' })
    await campaignService.acceptPublisherRequest(publisher.id, requestIds[0])
    expect(await countExecutions(campaignId, publisher.id, 'publisher')).toHaveLength(0)
    await setFlag('campaign_execution_runtime_enabled', true)
    const updated = await campaignService.forceGoLiveCampaign(null, campaignId)
    expect(updated.status).toBe('running')
    const rows = await countExecutions(campaignId, publisher.id, 'publisher')
    expect(rows).toHaveLength(1)
    const exec = await execRepo.findExecutionById(bufferToUuid(rows[0].id))
    expect(exec.platformCampaignId).toBeTruthy()
  })

  it('7. runtime ON + missing execution fails closed with zero Meta creates', async () => {
    metaMocks.__reset()
    const createsBefore = ledgerCreates()
    const { campaignId } = await seedAwaitingCampaign(client.id, [publisher.id])
    const result = await campaignService.routeOwnerChainCreation(campaignId, publisher.id, `pubmat_pub_page_${dateTag}`)
    expect(result.success).toBe(false)
    expect(result.failClosed).toBe(true)
    expect(result.error).toMatch(/required but missing/i)
    expect(ledgerCreates()).toBe(createsBefore)
    expect(metaMocks.deleteAdCampaign).not.toHaveBeenCalled()
  })

  it('8. runtime OFF preserves legacy: no staging, legacy path builds', async () => {
    await setFlag('campaign_execution_runtime_enabled', false)
    try {
      const { campaignId, requestIds } = await seedAwaitingCampaign(client.id, [publisher.id])
      await campaignService.acceptPublisherRequest(publisher.id, requestIds[0])
      expect(await countExecutions(campaignId, publisher.id, 'publisher')).toHaveLength(0)
      const result = await campaignService.routeOwnerChainCreation(campaignId, publisher.id, `pubmat_pub_page_${dateTag}`)
      expect(result.path).toBe('legacy')
      expect(await countExecutions(campaignId, publisher.id, 'publisher')).toHaveLength(0)
    } finally {
      await setFlag('campaign_execution_runtime_enabled', true)
    }
  })

  it('9. retry after execution exists reuses the same execution with no duplicate chains', async () => {
    metaMocks.__reset()
    const { campaignId, requestIds } = await seedAwaitingCampaign(client.id, [publisher.id])
    await execRepo.createExecution({ campaignId, ownerUserId: client.id, kind: 'client', status: 'pending' })
    await campaignService.acceptPublisherRequest(publisher.id, requestIds[0])
    await campaignService.forceGoLiveCampaign(null, campaignId)
    const staged = await execRepo.findExecutionByOwner(campaignId, publisher.id, 'publisher')
    const chainsBefore = await query(
      "SELECT object_id FROM campaign_meta_objects WHERE campaign_id = ? AND object_type = 'facebook_campaign' AND created_for_user_id = ?",
      [uuidToBuffer(campaignId), uuidToBuffer(publisher.id)]
    )
    const result = await campaignService.retryCampaignMeta(campaignId)
    expect(result.success).toBe(true)
    const reused = await execRepo.findExecutionByOwner(campaignId, publisher.id, 'publisher')
    expect(reused.id).toBe(staged.id)
    expect(await countExecutions(campaignId, publisher.id, 'publisher')).toHaveLength(1)
    const chainsAfter = await query(
      "SELECT object_id FROM campaign_meta_objects WHERE campaign_id = ? AND object_type = 'facebook_campaign' AND created_for_user_id = ?",
      [uuidToBuffer(campaignId), uuidToBuffer(publisher.id)]
    )
    expect(chainsAfter.map(r => r.object_id).sort()).toEqual(chainsBefore.map(r => r.object_id).sort())
  })
})
