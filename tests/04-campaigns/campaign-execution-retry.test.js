import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { generateUuid, uuidToBuffer } from '../../shared/utils/uuid.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import * as campaignService from '../../src/modules/campaigns/campaign.service.js'
import * as campaignRepo from '../../src/modules/campaigns/campaign.repository.js'
import * as execRepo from '../../src/modules/campaigns/campaign-execution.repository.js'
import * as execService from '../../src/modules/campaigns/campaign-execution.service.js'
import * as subRepo from '../../src/modules/subscriptions/subscription.repository.js'
import * as coinService from '../../shared/services/coin.service.js'
import { query, queryOne } from '../../shared/database/connection.js'
import { drainCampaignJobs } from '../../src/modules/campaigns/campaign.jobs.js'

var metaMocks
vi.mock('../../shared/services/meta-ads.service.js', async () => {
  const actual = await vi.importActual('../../shared/services/meta-ads.service.js')
  const ledger = { campaigns: [], adsets: [], creatives: [], ads: [] }
  const faults = {}
  let seq = 0
  const nid = prefix => {
    seq += 1
    return `retry_${prefix}_${seq}`
  }
  const takeFault = fn => (faults[fn] && faults[fn].length ? faults[fn].shift() : null)
  const mocks = {
    ...actual,
    __ledger: ledger,
    __faults: faults,
    __reset: () => {
      ledger.campaigns = []
      ledger.adsets = []
      ledger.creatives = []
      ledger.ads = []
      for (const key of Object.keys(faults)) delete faults[key]
    },
    createAdCampaign: vi.fn().mockImplementation(async (adAccountId, name, objective, status, token, extra, validateOnly) => {
      if (validateOnly) return { id: 'validate_ok' }
      const fault = takeFault('createAdCampaign')
      if (fault?.record) ledger.campaigns.push({ id: nid('camp'), name })
      if (fault?.error) throw fault.error
      const id = nid('camp')
      ledger.campaigns.push({ id, name })
      return { id }
    }),
    createAdSet: vi.fn().mockImplementation(async (adAccountId, fbCampaignId, targeting, budget, schedule, placement, token, validateOnly) => {
      if (validateOnly) return { id: 'validate_ok' }
      const fault = takeFault('createAdSet')
      if (fault?.record) ledger.adsets.push({ id: nid('set'), name: `Ad Set ${fbCampaignId.substring(0, 8)}`, campaignId: fbCampaignId })
      if (fault?.error) throw fault.error
      const id = nid('set')
      ledger.adsets.push({ id, name: `Ad Set ${fbCampaignId.substring(0, 8)}`, campaignId: fbCampaignId })
      return { id }
    }),
    createAdCreative: vi.fn().mockImplementation(async (adAccountId, pageId, message, mediaUrl, callToAction, token, extra, validateOnly) => {
      if (validateOnly) return { id: 'validate_ok' }
      const fault = takeFault('createAdCreative')
      if (fault?.record) ledger.creatives.push({ id: nid('cr') })
      if (fault?.error) throw fault.error
      const id = nid('cr')
      ledger.creatives.push({ id })
      return { id }
    }),
    createAd: vi.fn().mockImplementation(async (adAccountId, adSetId, creativeId, name, token, status, extra, validateOnly) => {
      if (validateOnly) return { id: 'validate_ok' }
      const fault = takeFault('createAd')
      if (fault?.record) ledger.ads.push({ id: nid('ad'), name, adsetId: adSetId, creative: { id: creativeId } })
      if (fault?.error) throw fault.error
      const id = nid('ad')
      ledger.ads.push({ id, name, adsetId: adSetId, creative: { id: creativeId } })
      return { id }
    }),
    updateAdStatus: vi.fn().mockResolvedValue({ success: true }),
    deleteAd: vi.fn().mockImplementation(async id => {
      ledger.ads = ledger.ads.filter(o => o.id !== id)
      return {}
    }),
    deleteAdSet: vi.fn().mockImplementation(async id => {
      ledger.adsets = ledger.adsets.filter(o => o.id !== id)
      return {}
    }),
    deleteAdCreative: vi.fn().mockImplementation(async id => {
      ledger.creatives = ledger.creatives.filter(o => o.id !== id)
      return {}
    }),
    deleteAdCampaign: vi.fn().mockImplementation(async id => {
      ledger.campaigns = ledger.campaigns.filter(o => o.id !== id)
      return {}
    }),
    getObjectStatus: vi.fn().mockResolvedValue({ status: 'ACTIVE', effective_status: 'ACTIVE' }),
    getMetaObject: vi.fn().mockImplementation(async id => {
      const found = [...ledger.campaigns, ...ledger.adsets, ...ledger.creatives, ...ledger.ads].find(o => o.id === id)
      if (!found) {
        const error = new Error(`Graph API GET ${id} failed: {"error":{"code":100,"error_subcode":33,"message":"Unsupported get request. Object with ID ${id} does not exist"}}`)
        error.statusCode = 400
        throw error
      }
      return { id }
    }),
    listAccountCampaigns: vi.fn().mockImplementation(async () => ({ rows: [...ledger.campaigns], truncated: false })),
    listCampaignAdSets: vi.fn().mockImplementation(async fbCampaignId => ({
      rows: ledger.adsets.filter(o => o.campaignId === fbCampaignId),
      truncated: false,
    })),
    listAdSetAds: vi.fn().mockImplementation(async fbAdSetId => ({
      rows: ledger.ads.filter(o => o.adsetId === fbAdSetId),
      truncated: false,
    })),
  }
  metaMocks = mocks
  return mocks
})

const dateTag = Date.now()
const savedEnv = {}

function timeoutError() {
  const error = new Error('Meta request timed out after 20000ms')
  error.code = 'ETIMEDOUT'
  return error
}

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

async function seedCampaign(ownerId, { status = 'running', settings = {}, creative = {} } = {}) {
  const campaignId = generateUuid()
  await campaignRepo.createCampaign(campaignId, ownerId, { name: `Retry ${dateTag} ${campaignId.substring(0, 4)}`, type: 'post' })
  await campaignRepo.createCreative(generateUuid(), campaignId, {
    caption: 'retry caption', mediaUrl: 'https://example.com/img.jpg', ...creative,
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

async function seedExecution(campaignId, ownerId, kind, fields = {}) {
  return execRepo.createExecution({ campaignId, ownerUserId: ownerId, kind, status: 'pending', ...fields })
}

async function seedLegacyObjects(campaignId, ownerId, prefix, types = ['facebook_campaign', 'ad_set', 'ad_creative', 'ad']) {
  const chain = {}
  for (const objectType of types) {
    const objectId = `${prefix}_${objectType}`
    await campaignRepo.createMetaObject(campaignId, objectType, objectId, null, 'ACTIVE', ownerId)
    chain[objectType] = objectId
  }
  return chain
}

function ledgerCounts() {
  return {
    campaigns: metaMocks.__ledger.campaigns.length,
    adsets: metaMocks.__ledger.adsets.length,
    creatives: metaMocks.__ledger.creatives.length,
    ads: metaMocks.__ledger.ads.length,
  }
}

async function snapshotMoney(userIds, campaignId) {
  const wallets = await query(`SELECT HEX(user_id) AS u, coins FROM user_wallets WHERE user_id IN (${userIds.map(() => '?').join(',')})`, userIds.map(uuidToBuffer))
  const billing = await query('SELECT kind, paise, coins FROM campaign_billing_entries WHERE campaign_id = ?', [uuidToBuffer(campaignId)])
  const campaign = await campaignRepo.findCampaignById(campaignId)
  const executions = await execRepo.findExecutionsByCampaignId(campaignId)
  return JSON.stringify({
    wallets, billing, charged: campaign.chargedAdBudgetPaise,
    consumed: executions.map(e => e.consumedPaise), refunded: executions.map(e => e.refundedPaise),
  })
}

describe('campaign execution retry (Step 14 — deterministic retry semantics)', () => {
  let client, publisher

  beforeAll(async () => {
    savedEnv.accountId = process.env.META_AD_ACCOUNT_ID
    savedEnv.token = process.env.META_SYSTEM_USER_TOKEN
    process.env.META_AD_ACCOUNT_ID = 'act_retry_test_account'
    process.env.META_SYSTEM_USER_TOKEN = 'retry_test_system_token'
    client = await createTestUser({ email: `retry-client-${dateTag}@flowx-test.com`, password: 'Test@123', coins: 10000 })
    publisher = await createTestUser({ email: `retry-pub-${dateTag}@flowx-test.com`, password: 'Test@123', role: 'publisher' })
    await ensurePlan(client.id)
    await addVerifiedPage(client.id, `retry_page_${dateTag}`)
    await addVerifiedPage(publisher.id, `retry_pub_page_${dateTag}`)
    await setFlag('campaign_execution_runtime_enabled', true)
  })

  afterAll(async () => {
    if (savedEnv.accountId === undefined) delete process.env.META_AD_ACCOUNT_ID
    else process.env.META_AD_ACCOUNT_ID = savedEnv.accountId
    if (savedEnv.token === undefined) delete process.env.META_SYSTEM_USER_TOKEN
    else process.env.META_SYSTEM_USER_TOKEN = savedEnv.token
    await setFlag('campaign_execution_runtime_enabled', false)
  })

  it('1. retry preserves execution identity and adopts the complete chain with zero Meta calls', async () => {
    metaMocks.__reset()
    const campaignId = await seedCampaign(client.id)
    const executionId = await seedExecution(campaignId, client.id, 'client', {
      status: 'failed',
      platformCampaignId: 'retry_keep_camp_1',
      platformAdsetId: 'retry_keep_set_1',
      platformCreativeId: 'retry_keep_cr_1',
      platformAdId: 'retry_keep_ad_1',
    })
    const ledgerBefore = ledgerCounts()
    const result = await campaignService.retryCampaignMeta(campaignId)
    expect(result.success).toBe(true)
    expect(ledgerCounts()).toEqual(ledgerBefore)
    const execution = await execRepo.findExecutionById(executionId)
    expect(execution.status).toBe('pending')
    expect(execution.platformCampaignId).toBeTruthy()
    const rows = await execRepo.findExecutionsByCampaignId(campaignId)
    expect(rows).toHaveLength(1)
  })

  it('2. surgical resume recreates only missing objects, reusing M1/M2', async () => {
    metaMocks.__reset()
    const campaignId = await seedCampaign(client.id)
    const campaign = await campaignRepo.findCampaignById(campaignId)
    const chainName = `FlowX-${campaign.name}-${campaign.id.substring(0, 8)}`
    metaMocks.__ledger.campaigns.push({ id: 'retry_m1_case2', name: chainName })
    metaMocks.__ledger.adsets.push({ id: 'retry_m2_case2', name: 'Ad Set retry_m1', campaignId: 'retry_m1_case2' })
    const executionId = await seedExecution(campaignId, client.id, 'client', {
      status: 'failed',
      platformCampaignId: 'retry_m1_case2',
      platformAdsetId: 'retry_m2_case2',
    })
    const result = await campaignService.retryCampaignMeta(campaignId)
    expect(result.success).toBe(true)
    expect(ledgerCounts()).toEqual({ campaigns: 1, adsets: 1, creatives: 1, ads: 1 })
    expect(metaMocks.__ledger.campaigns[0].id).toBe('retry_m1_case2')
    expect(metaMocks.__ledger.adsets[0].id).toBe('retry_m2_case2')
    const execution = await execRepo.findExecutionById(executionId)
    expect(execution.platformCreativeId).toBeTruthy()
    expect(execution.platformAdId).toBeTruthy()
    expect(execution.platformCreativeId).not.toBe('retry_m2_case2')
  })

  it('3. retry performs zero deletes and preserves all persisted IDs', async () => {
    metaMocks.__reset()
    const campaignId = await seedCampaign(client.id)
    await seedLegacyObjects(campaignId, client.id, 'retrykeep3')
    await seedExecution(campaignId, client.id, 'client', { status: 'failed' })
    const calls = fn => metaMocks[fn].mock.calls.length
    const before = {
      del: calls('deleteAdCampaign') + calls('deleteAdSet') + calls('deleteAdCreative') + calls('deleteAd'),
      create: calls('createAdCampaign') + calls('createAdSet') + calls('createAdCreative') + calls('createAd'),
    }
    const result = await campaignService.retryCampaignMeta(campaignId)
    expect(result.success).toBe(true)
    expect(calls('deleteAdCampaign') + calls('deleteAdSet') + calls('deleteAdCreative') + calls('deleteAd')).toBe(before.del)
    expect(calls('createAdCampaign') + calls('createAdSet') + calls('createAdCreative') + calls('createAd')).toBe(before.create)
    const execution = await execRepo.findExecutionByOwner(campaignId, client.id, 'client')
    expect(execution.platformCampaignId).toBe('retrykeep3_facebook_campaign')
    expect(execution.platformAdId).toBe('retrykeep3_ad')
  })

  it('4. failed execution is rearmed to pending and routed in one retry', async () => {
    metaMocks.__reset()
    const campaignId = await seedCampaign(client.id)
    const executionId = await seedExecution(campaignId, client.id, 'client', { status: 'failed', error: 'earlier boom' })
    const result = await campaignService.retryCampaignMeta(campaignId)
    expect(result.success).toBe(true)
    const execution = await execRepo.findExecutionById(executionId)
    expect(execution.status).not.toBe('failed')
    expect(ledgerCounts()).toEqual({ campaigns: 1, adsets: 1, creatives: 1, ads: 1 })
  })

  it('5/6. active and paused executions adopt-skip with zero Meta calls', async () => {
    metaMocks.__reset()
    for (const status of ['active', 'paused']) {
      const campaignId = await seedCampaign(client.id)
      await seedExecution(campaignId, client.id, 'client', {
        status,
        platformCampaignId: `live_camp_${status}`,
        platformAdsetId: `live_set_${status}`,
        platformCreativeId: `live_cr_${status}`,
        platformAdId: `live_ad_${status}`,
      })
      const calls = fn => metaMocks[fn].mock.calls.length
      const before = calls('createAdCampaign') + calls('createAd') + calls('deleteAdCampaign') + calls('deleteAd')
      const result = await campaignService.retryCampaignMeta(campaignId)
      expect(result.success).toBe(true)
      expect(result.actionable).toBe(false)
      expect(calls('createAdCampaign') + calls('createAd') + calls('deleteAdCampaign') + calls('deleteAd')).toBe(before)
      expect(ledgerCounts()).toEqual({ campaigns: 0, adsets: 0, creatives: 0, ads: 0 })
      const execution = await execRepo.findExecutionByOwner(campaignId, client.id, 'client')
      expect(execution.status).toBe(status)
      const logs = await query('SELECT notes FROM campaign_review_log WHERE campaign_id = ?', [uuidToBuffer(campaignId)])
      expect(logs.some(l => (l.notes || '').includes('nothing to do'))).toBe(true)
    }
  })

  it('7/8. cancelled and completed executions stay terminal and untouched', async () => {
    metaMocks.__reset()
    for (const status of ['cancelled', 'completed']) {
      const campaignId = await seedCampaign(client.id)
      await seedExecution(campaignId, client.id, 'client', { status })
      const calls = fn => metaMocks[fn].mock.calls.length
      const before = calls('createAdCampaign') + calls('deleteAdCampaign')
      const result = await campaignService.retryCampaignMeta(campaignId)
      expect(result.success).toBe(false)
      expect(result.error).toMatch(/terminal/i)
      expect(calls('createAdCampaign') + calls('deleteAdCampaign')).toBe(before)
      expect(ledgerCounts()).toEqual({ campaigns: 0, adsets: 0, creatives: 0, ads: 0 })
      const execution = await execRepo.findExecutionByOwner(campaignId, client.id, 'client')
      expect(execution.status).toBe(status)
    }
  })

  it('9. quarantined executions are refused with zero Meta calls and zero money movement', async () => {
    metaMocks.__reset()
    const campaignId = await seedCampaign(client.id)
    await query('UPDATE campaigns SET charged_ad_budget_paise = 10000 WHERE id = ?', [uuidToBuffer(campaignId)])
    await seedExecution(campaignId, client.id, 'client', { status: 'failed' })
    const moneyBefore = await snapshotMoney([client.id], campaignId)
    const result = await campaignService.retryCampaignMeta(campaignId)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/quarantined/i)
    expect(ledgerCounts()).toEqual({ campaigns: 0, adsets: 0, creatives: 0, ads: 0 })
    expect(await snapshotMoney([client.id], campaignId)).toBe(moneyBefore)
  })

  it('10. pending execution with nothing persisted builds the full chain once', async () => {
    metaMocks.__reset()
    const campaignId = await seedCampaign(client.id)
    await seedExecution(campaignId, client.id, 'client', { status: 'pending' })
    const result = await campaignService.retryCampaignMeta(campaignId)
    expect(result.success).toBe(true)
    expect(ledgerCounts()).toEqual({ campaigns: 1, adsets: 1, creatives: 1, ads: 1 })
    const rows = await execRepo.findExecutionsByCampaignId(campaignId)
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('creating')
  })

  it('11. ambiguous ad loss during retry is adopted, never duplicated', async () => {
    metaMocks.__reset()
    const campaignId = await seedCampaign(client.id)
    const campaign = await campaignRepo.findCampaignById(campaignId)
    const chainName = `FlowX-${campaign.name}-${campaign.id.substring(0, 8)}`
    metaMocks.__ledger.campaigns.push({ id: 'retry_amb_camp_11', name: chainName })
    metaMocks.__ledger.adsets.push({ id: 'retry_amb_set_11', name: 'Ad Set retry_am', campaignId: 'retry_amb_camp_11' })
    metaMocks.__ledger.ads.push({ id: 'retry_amb_ad_11', name: chainName, adsetId: 'retry_amb_set_11', creative: { id: 'retry_amb_cr_11' } })
    metaMocks.__ledger.creatives.push({ id: 'retry_amb_cr_11' })
    await seedExecution(campaignId, client.id, 'client', {
      status: 'failed',
      platformCampaignId: 'retry_amb_camp_11',
      platformAdsetId: 'retry_amb_set_11',
    })
    metaMocks.__faults.createAd = [{ record: true, error: timeoutError() }]
    const result = await campaignService.retryCampaignMeta(campaignId)
    expect(result.success).toBe(true)
    expect(ledgerCounts().ads).toBe(1)
    const execution = await execRepo.findExecutionByOwner(campaignId, client.id, 'client')
    expect(execution.platformAdId).toBe('retry_amb_ad_11')
    expect(execution.platformCreativeId).toBe('retry_amb_cr_11')
  })

  it('12. permanent failure keeps diagnostics with no wipe of pre-existing data', async () => {
    metaMocks.__reset()
    const campaignId = await seedCampaign(client.id)
    const executionId = await seedExecution(campaignId, client.id, 'client', { status: 'failed' })
    const permanent = new Error('Graph API POST act_x/adsets failed: {"error":{"error_user_msg":"bad geo","code":100}}')
    permanent.statusCode = 400
    metaMocks.__faults.createAdSet = [{ error: permanent }]
    await expect(campaignService.retryCampaignMeta(campaignId)).rejects.toThrow(/bad geo/)
    const execution = await execRepo.findExecutionById(executionId)
    expect(execution.status).toBe('failed')
    expect(execution.error).toMatch(/bad geo/)
    expect(ledgerCounts()).toEqual({ campaigns: 0, adsets: 0, creatives: 0, ads: 0 })
    const rows = await campaignRepo.findMetaObjectsByCampaignId(campaignId)
    expect(rows).toHaveLength(0)
  })

  it('12b. a broken client leg does not block an independently-fixable publisher leg', async () => {
    metaMocks.__reset()
    const campaignId = await seedCampaign(client.id)
    await seedExecution(campaignId, client.id, 'client', { status: 'failed' })
    await campaignRepo.createPublisherRequests(campaignId, [publisher.id], 50)
    const requests = await campaignRepo.findPublisherRequestsByCampaignId(campaignId)
    await campaignRepo.updatePublisherRequestStatus(requests[0].id, 'accepted', new Date())

    const permanent = new Error('Graph API POST act_x/adsets failed: {"error":{"error_user_msg":"bad geo","code":100}}')
    permanent.statusCode = 400
    metaMocks.__faults.createAdSet = [{ error: permanent }]

    // Real progress was made (the publisher leg), so this reports success —
    // matching the codebase's existing "partial progress is still progress"
    // convention — but the client's own failure is preserved, not silently
    // swallowed (see the review log + diagnostics assertions below).
    const result = await campaignService.retryCampaignMeta(campaignId)
    expect(result.success).toBe(true)

    // The client leg's own diagnostics are preserved (thrown outside the
    // transaction in the total-failure case, so nothing here is ever rolled
    // back)...
    const clientExecution = await execRepo.findExecutionByOwner(campaignId, client.id, 'client')
    expect(clientExecution.status).toBe('failed')
    expect(clientExecution.error).toMatch(/bad geo/)
    // ...while the publisher's independently-fixable leg was still built,
    // committed, and reflected in the request status — proving the client
    // failure never short-circuited the publisher retry.
    const publisherExecution = await execRepo.findExecutionByOwner(campaignId, publisher.id, 'publisher')
    expect(publisherExecution.status).not.toBe('failed')
    expect(publisherExecution.platformAdId).toBeTruthy()
    const updatedRequest = await campaignRepo.findPublisherRequestById(requests[0].id)
    expect(updatedRequest.status).toBe('published')
    const logs = await query('SELECT notes FROM campaign_review_log WHERE campaign_id = ?', [uuidToBuffer(campaignId)])
    expect(logs.some(l => (l.notes || '').includes('client leg failed'))).toBe(true)
  })

  it('12c. a broken client leg throws when there is no publisher to fall back on (nothing at all succeeded)', async () => {
    metaMocks.__reset()
    const campaignId = await seedCampaign(client.id)
    const executionId = await seedExecution(campaignId, client.id, 'client', { status: 'failed' })

    const permanent = new Error('Graph API POST act_x/adsets failed: {"error":{"error_user_msg":"bad geo again","code":100}}')
    permanent.statusCode = 400
    metaMocks.__faults.createAdSet = [{ error: permanent }]

    await expect(campaignService.retryCampaignMeta(campaignId)).rejects.toThrow(/bad geo again/)
    const execution = await execRepo.findExecutionById(executionId)
    expect(execution.status).toBe('failed')
    expect(execution.error).toMatch(/bad geo again/)
  })

  it('C1. a retryable failure deep in the chain preserves earlier-created objects across the throw (rollback-safety proof)', async () => {
    metaMocks.__reset()
    const campaignId = await seedCampaign(client.id)
    const executionId = await seedExecution(campaignId, client.id, 'client', { status: 'pending' })

    // A transient (statusCode >= 500) failure on the 3rd of 4 steps — the
    // facebook_campaign and ad_set steps before it succeed and persist.
    // Being "retryable" (not permanent), buildOwnerMetaChain deliberately
    // does NOT roll back those two objects on Meta's side — the bug this
    // test proves fixed is that the OLD code's outer transaction wrapper
    // would erase their DB rows anyway when the call later throws, even
    // though nothing asked for them to be undone.
    const transient = new Error('Service Unavailable')
    transient.statusCode = 503
    metaMocks.__faults.createAdCreative = [{ error: transient }]

    await expect(campaignService.retryCampaignMeta(campaignId)).rejects.toThrow()

    expect(ledgerCounts()).toEqual({ campaigns: 1, adsets: 1, creatives: 0, ads: 0 })
    const rows = await campaignRepo.findMetaObjectsByCampaignId(campaignId)
    expect(rows.map(r => r.objectType).sort()).toEqual(['ad_set', 'facebook_campaign'])

    const execution = await execRepo.findExecutionById(executionId)
    expect(execution.status).toBe('pending') // released, not stuck at 'creating'
    expect(execution.platformCampaignId).toBeTruthy()
    expect(execution.platformAdsetId).toBeTruthy()
    expect(execution.platformCreativeId).toBeFalsy()
    expect(execution.platformAdId).toBeFalsy()

    // A second retry adopts the two survivors instead of duplicating them —
    // zero new createAdCampaign/createAdSet calls, only the remaining steps run.
    const campaignCallsBefore = metaMocks.createAdCampaign.mock.calls.length
    const adsetCallsBefore = metaMocks.createAdSet.mock.calls.length
    const second = await campaignService.retryCampaignMeta(campaignId)
    expect(second.success).toBe(true)
    expect(metaMocks.createAdCampaign.mock.calls.length).toBe(campaignCallsBefore)
    expect(metaMocks.createAdSet.mock.calls.length).toBe(adsetCallsBefore)
    expect(ledgerCounts()).toEqual({ campaigns: 1, adsets: 1, creatives: 1, ads: 1 })
    const finalExecution = await execRepo.findExecutionById(executionId)
    expect(finalExecution.platformCampaignId).toBe(execution.platformCampaignId)
    expect(finalExecution.platformAdsetId).toBe(execution.platformAdsetId)
  })

  it('C1b. two callers racing to build the SAME never-built execution converge on one chain (genuine concurrency, not lock-serialized)', async () => {
    metaMocks.__reset()
    const campaignId = await seedCampaign(client.id)
    await seedExecution(campaignId, client.id, 'client', { status: 'pending' })

    // Both calls' phase-1 (lock+stage) transactions still serialize briefly,
    // but phase 2 (the actual Meta-calling work) now runs unlocked for both
    // — this is the scenario the atomic per-execution claim exists for.
    const results = await Promise.allSettled([
      campaignService.retryCampaignMeta(campaignId),
      campaignService.retryCampaignMeta(campaignId),
    ])
    const fulfilled = results.filter(r => r.status === 'fulfilled')
    const rejected = results.filter(r => r.status === 'rejected')
    expect(fulfilled.length).toBeGreaterThanOrEqual(1)
    for (const r of rejected) {
      expect(r.reason?.message).toMatch(/concurrent caller|claimed-elsewhere/)
    }
    expect(ledgerCounts()).toEqual({ campaigns: 1, adsets: 1, creatives: 1, ads: 1 })
    const rows = await execRepo.findExecutionsByCampaignId(campaignId)
    expect(rows).toHaveLength(1)
  })

  it('C1c. forceGoLiveCampaign never double-refunds unfilled publisher slots across a retried phase-2 failure', async () => {
    metaMocks.__reset()
    const refundClient = await createTestUser({ email: `retry-refund-${dateTag}@flowx-test.com`, password: 'Test@123', coins: 5000 })
    await ensurePlan(refundClient.id)
    // Deliberately no verified page for refundClient — publishAdForClient's
    // gate check fails immediately, which is enough to trigger a phase-2
    // failure without needing a Meta fault; the refund guard (phase 1) is
    // what this test targets, not the specific failure reason.
    const campaignId = generateUuid()
    await campaignRepo.createCampaign(campaignId, refundClient.id, {
      name: `Refund Guard ${generateUuid().substring(0, 8)}`,
      type: 'post',
      publisherCount: 2,
      coinsPerPublisher: 100,
    })
    await campaignRepo.createCreative(generateUuid(), campaignId, { caption: 'refund guard', mediaUrl: 'https://example.com/img.jpg' })
    await campaignRepo.createMetaSettings(generateUuid(), campaignId, {
      objective: 'OUTCOME_TRAFFIC', budgetType: 'lifetime', budgetAmount: 500,
      endTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    })
    await query('UPDATE campaigns SET status = ? WHERE id = ?', ['awaiting_publishers', uuidToBuffer(campaignId)])
    // Both of the 2 publisher slots were invited (matching how a real
    // approval sends one request per slot); only one accepted, so the
    // other is genuinely still 'pending' — that's the request phase 1
    // cancels and refunds the share for.
    const pubB = await createTestUser({ email: `retry-refund-pubB-${dateTag}@flowx-test.com`, password: 'Test@123', role: 'publisher' })
    await campaignRepo.createPublisherRequests(campaignId, [publisher.id, pubB.id], 100)
    const requestsForRefundTest = await campaignRepo.findPublisherRequestsByCampaignId(campaignId)
    const acceptedRequest = requestsForRefundTest.find(r => r.publisherId === publisher.id)
    await campaignRepo.updatePublisherRequestStatus(acceptedRequest.id, 'accepted', new Date())

    const refundSpy = vi.spyOn(coinService, 'refund')
    try {
      await expect(campaignService.forceGoLiveCampaign(null, campaignId)).rejects.toThrow()
      expect(refundSpy).toHaveBeenCalledTimes(1)
      expect(refundSpy).toHaveBeenCalledWith(refundClient.id, 110, 'campaign_escrow', campaignId, expect.any(String))

      // Retried after the phase-2 failure: phase 1 finds zero pending
      // requests left to cancel (already cancelled by the first attempt)
      // and correctly skips refunding again.
      await expect(campaignService.forceGoLiveCampaign(null, campaignId)).rejects.toThrow()
      expect(refundSpy).toHaveBeenCalledTimes(1)
    } finally {
      refundSpy.mockRestore()
    }
  })

  it('C1d. one publisher\'s guard-mismatch throw does not block the other publishers in the same forceGoLiveCampaign call', async () => {
    metaMocks.__reset()
    const owner = await createTestUser({ email: `retry-multi-owner-${dateTag}@flowx-test.com`, password: 'Test@123', coins: 5000 })
    await ensurePlan(owner.id)
    await addVerifiedPage(owner.id, `retry_multi_owner_page_${dateTag}`)
    const pubGood = await createTestUser({ email: `retry-pub-good-${dateTag}@flowx-test.com`, password: 'Test@123', role: 'publisher' })
    const pubBad = await createTestUser({ email: `retry-pub-bad-${dateTag}@flowx-test.com`, password: 'Test@123', role: 'publisher' })
    await addVerifiedPage(pubGood.id, `retry_pub_good_page_${dateTag}`)
    await addVerifiedPage(pubBad.id, `retry_pub_bad_page_${dateTag}`)

    const campaignId = generateUuid()
    await campaignRepo.createCampaign(campaignId, owner.id, {
      name: `Multi Owner ${generateUuid().substring(0, 8)}`,
      type: 'post', publisherCount: 2, coinsPerPublisher: 100,
    })
    await campaignRepo.createCreative(generateUuid(), campaignId, { caption: 'multi owner', mediaUrl: 'https://example.com/img.jpg' })
    await campaignRepo.createMetaSettings(generateUuid(), campaignId, {
      objective: 'OUTCOME_TRAFFIC', budgetType: 'lifetime', budgetAmount: 500,
      endTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    })
    await query('UPDATE campaigns SET status = ? WHERE id = ?', ['awaiting_publishers', uuidToBuffer(campaignId)])
    await campaignRepo.createPublisherRequests(campaignId, [pubGood.id, pubBad.id], 100)
    const requests = await campaignRepo.findPublisherRequestsByCampaignId(campaignId)
    for (const r of requests) {
      await campaignRepo.updatePublisherRequestStatus(r.id, 'accepted', new Date())
    }
    const badRequest = requests.find(r => r.publisherId === pubBad.id)

    // Force the guard-update to mismatch for pubBad only, by flipping its
    // request out of 'accepted' underneath the loop right before it runs —
    // simulating a genuinely concurrent status change mid-flight.
    const originalGuard = campaignRepo.updatePublisherRequestPublishedWithGuard
    const spy = vi.spyOn(campaignRepo, 'updatePublisherRequestPublishedWithGuard').mockImplementation(async (id, fromStatus) => {
      if (id === badRequest.id) throw new Error('simulated guard mismatch')
      return originalGuard(id, fromStatus)
    })
    try {
      const result = await campaignService.forceGoLiveCampaign(null, campaignId)
      expect(result.status).toBe('running')
    } finally {
      spy.mockRestore()
    }

    const goodExecution = await execRepo.findExecutionByOwner(campaignId, pubGood.id, 'publisher')
    expect(goodExecution.platformAdId).toBeTruthy()
    const badExecution = await execRepo.findExecutionByOwner(campaignId, pubBad.id, 'publisher')
    // The chain was still built for pubBad on Meta's side (the guard throw
    // happens AFTER routeOwnerChainCreation succeeds) — only the request
    // status bookkeeping for that one publisher was affected, and it did
    // not stop pubGood from completing.
    expect(badExecution.platformAdId).toBeTruthy()
  })

  it('13. concurrent retry calls converge on one effective chain', async () => {
    metaMocks.__reset()
    const campaignId = await seedCampaign(client.id)
    await seedExecution(campaignId, client.id, 'client', { status: 'failed' })
    const results = await Promise.allSettled([
      campaignService.retryCampaignMeta(campaignId),
      campaignService.retryCampaignMeta(campaignId),
    ])
    // Genuine concurrency: the atomic per-execution claim (Part A of the C1
    // fix) now lets both calls race for real instead of being serialized end
    // to end by the campaign lock. Exactly one wins and builds the chain;
    // the loser correctly rejects with a transient "claimed by a concurrent
    // caller" error rather than silently no-op succeeding — that's the
    // desired new behavior (a job-queue caller retries shortly after), not
    // a regression. What must still hold is convergence on one chain.
    const fulfilled = results.filter(r => r.status === 'fulfilled')
    const rejected = results.filter(r => r.status === 'rejected')
    expect(fulfilled.length).toBeGreaterThanOrEqual(1)
    for (const r of rejected) {
      expect(r.reason?.message).toMatch(/concurrent caller|claimed-elsewhere/)
    }
    expect(ledgerCounts()).toEqual({ campaigns: 1, adsets: 1, creatives: 1, ads: 1 })
    const rows = await execRepo.findExecutionsByCampaignId(campaignId)
    expect(rows).toHaveLength(1)
  })

  it('14/15. retry moves no money and leaves financial claims untouched', async () => {
    metaMocks.__reset()
    const campaignId = await seedCampaign(client.id)
    await seedExecution(campaignId, client.id, 'client', { status: 'failed' })
    const moneyBefore = await snapshotMoney([client.id], campaignId)
    const results = await Promise.allSettled([
      campaignService.retryCampaignMeta(campaignId),
      campaignService.retryCampaignMeta(campaignId),
    ])
    // See test 13 — one caller may legitimately lose the concurrent claim
    // and reject; money must stay untouched regardless of which one wins.
    const rejected = results.filter(r => r.status === 'rejected')
    for (const r of rejected) {
      expect(r.reason?.message).toMatch(/concurrent caller|claimed-elsewhere/)
    }
    expect(await snapshotMoney([client.id], campaignId)).toBe(moneyBefore)
    const execution = await execRepo.findExecutionByOwner(campaignId, client.id, 'client')
    expect(Number(execution.consumedPaise)).toBe(0)
    expect(Number(execution.refundedPaise)).toBe(0)
  })

  it('16. legacy campaign without execution rows gets rows created and chain adopted', async () => {
    metaMocks.__reset()
    const campaignId = await seedCampaign(client.id)
    await seedLegacyObjects(campaignId, client.id, 'retrylegacy16')
    expect(await execRepo.findExecutionsByCampaignId(campaignId)).toHaveLength(0)
    const result = await campaignService.retryCampaignMeta(campaignId)
    expect(result.success).toBe(true)
    const rows = await execRepo.findExecutionsByCampaignId(campaignId)
    expect(rows).toHaveLength(1)
    expect(rows[0].platformCampaignId).toBe('retrylegacy16_facebook_campaign')
    expect(ledgerCounts()).toEqual({ campaigns: 0, adsets: 0, creatives: 0, ads: 0 })
  })

  it('17. invalid snapshot fails closed with zero Meta creates', async () => {
    metaMocks.__reset()
    const campaignId = await seedCampaign(client.id)
    await seedExecution(campaignId, client.id, 'client', { status: 'failed' })
    await campaignService.retryCampaignMeta(campaignId)
    await query('UPDATE campaigns SET resolved_graph_version = ? WHERE id = ?', ['v99.0', uuidToBuffer(campaignId)])
    await execRepo.updateExecution(
      (await execRepo.findExecutionByOwner(campaignId, client.id, 'client')).id,
      { status: 'pending', platformCampaignId: null, platformAdsetId: null, platformCreativeId: null, platformAdId: null }
    )
    await campaignRepo.deleteMetaObjectsForUser(campaignId, client.id)
    const calls = fn => metaMocks[fn].mock.calls.length
    const before = calls('createAdCampaign') + calls('createAd')
    await expect(campaignService.retryCampaignMeta(campaignId)).rejects.toThrow(/version-mismatch/)
    expect(calls('createAdCampaign') + calls('createAd')).toBe(before)
  })

  it('18. retry via queued job drains to done through the real worker', async () => {
    metaMocks.__reset()
    const campaignId = await seedCampaign(client.id)
    await seedExecution(campaignId, client.id, 'client', { status: 'failed' })
    const queued = await campaignService.queueRetryMeta(campaignId)
    expect(queued.queued).toBe(true)
    expect(queued.jobId).toBeTruthy()
    await drainCampaignJobs()
    const execution = await execRepo.findExecutionByOwner(campaignId, client.id, 'client')
    expect(execution.status).not.toBe('failed')
    expect(ledgerCounts()).toEqual({ campaigns: 1, adsets: 1, creatives: 1, ads: 1 })
  })

  it('19. rearm helper is exact and idempotent', async () => {
    const campaignId = await seedCampaign(client.id)
    const missing = await execService.rearmFailedExecution(campaignId, client.id, 'client')
    expect(missing).toEqual({ execution: null, rearmed: false })
    const executionId = await seedExecution(campaignId, client.id, 'client', { status: 'active' })
    void executionId
    const active = await execService.rearmFailedExecution(campaignId, client.id, 'client')
    expect(active.rearmed).toBe(false)
    expect(active.execution.status).toBe('active')
    await execRepo.updateExecutionWithStatusGuard(
      (await execRepo.findExecutionByOwner(campaignId, client.id, 'client')).id,
      ['active'], { status: 'failed' }
    )
    const first = await execService.rearmFailedExecution(campaignId, client.id, 'client')
    expect(first.rearmed).toBe(true)
    expect(first.execution.status).toBe('pending')
    const second = await execService.rearmFailedExecution(campaignId, client.id, 'client')
    expect(second.rearmed).toBe(false)
    expect(second.execution.status).toBe('pending')
  })

  it('20. repeated retries never create a second execution', async () => {
    metaMocks.__reset()
    const campaignId = await seedCampaign(client.id)
    await seedExecution(campaignId, client.id, 'client', { status: 'failed' })
    await campaignService.retryCampaignMeta(campaignId)
    await campaignService.retryCampaignMeta(campaignId)
    await campaignService.retryCampaignMeta(campaignId)
    const rows = await execRepo.findExecutionsByCampaignId(campaignId)
    expect(rows).toHaveLength(1)
    expect(ledgerCounts()).toEqual({ campaigns: 1, adsets: 1, creatives: 1, ads: 1 })
  })
})
