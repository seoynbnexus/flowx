import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { generateUuid, uuidToBuffer } from '../../shared/utils/uuid.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import * as campaignService from '../../src/modules/campaigns/campaign.service.js'
import * as campaignRepo from '../../src/modules/campaigns/campaign.repository.js'
import * as execRepo from '../../src/modules/campaigns/campaign-execution.repository.js'
import * as subRepo from '../../src/modules/subscriptions/subscription.repository.js'
import { query, queryOne, transaction } from '../../shared/database/connection.js'

var metaMocks
vi.mock('../../shared/services/meta-ads.service.js', async () => {
  const actual = await vi.importActual('../../shared/services/meta-ads.service.js')
  const ledger = { campaigns: [], adsets: [], creatives: [], ads: [] }
  const faults = {}
  let seq = 0
  const nid = prefix => {
    seq += 1
    return `resume_${prefix}_${seq}`
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

function timeoutError() {
  const error = new Error('Meta request timed out after 20000ms')
  error.code = 'ETIMEDOUT'
  return error
}

function transientError() {
  const error = new Error('Graph API POST act_x/campaigns failed: {"error":{"code":2,"message":"Service temporarily unavailable"}}')
  error.statusCode = 500
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

async function seedCampaign(ownerId, { status = 'awaiting_publishers', settings = {}, creative = {} } = {}) {
  const campaignId = generateUuid()
  await campaignRepo.createCampaign(campaignId, ownerId, { name: `Resume ${dateTag} ${campaignId.substring(0, 4)}`, type: 'post' })
  await campaignRepo.createCreative(generateUuid(), campaignId, {
    caption: 'resume caption', mediaUrl: 'https://example.com/img.jpg', ...creative,
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

describe('campaign execution resume (Step 12 — durable Meta resume)', () => {
  let client, publisher

  beforeAll(async () => {
    client = await createTestUser({ email: `resume-client-${dateTag}@flowx-test.com`, password: 'Test@123', coins: 10000 })
    publisher = await createTestUser({ email: `resume-pub-${dateTag}@flowx-test.com`, password: 'Test@123', role: 'publisher' })
    await ensurePlan(client.id)
    await addVerifiedPage(client.id, `resume_page_${dateTag}`)
    await addVerifiedPage(publisher.id, `resume_pub_page_${dateTag}`)
    await setFlag('campaign_execution_runtime_enabled', true)
  })

  afterAll(async () => {
    await setFlag('campaign_execution_runtime_enabled', false)
  })

  it('1. fresh execution creates one complete chain on one execution row', async () => {
    metaMocks.__reset()
    const campaignId = await seedCampaign(client.id)
    await seedExecution(campaignId, client.id, 'client')
    const result = await campaignService.routeOwnerChainCreation(campaignId, client.id, `resume_page_${dateTag}`)
    expect(result.path).toBe('execution')
    expect(result.success).toBe(true)
    expect(ledgerCounts()).toEqual({ campaigns: 1, adsets: 1, creatives: 1, ads: 1 })
    const execution = await execRepo.findExecutionByOwner(campaignId, client.id, 'client')
    expect(execution.status).toBe('creating')
    expect(execution.attempts).toBe(1)
    const rows = await execRepo.findExecutionsByCampaignId(campaignId)
    expect(rows).toHaveLength(1)
  })

  it('2. existing complete IDs short-circuit with zero Meta calls', async () => {
    metaMocks.__reset()
    const campaignId = await seedCampaign(client.id)
    await seedExecution(campaignId, client.id, 'client', {
      status: 'creating',
      platformCampaignId: 'ext_camp', platformAdsetId: 'ext_set', platformCreativeId: 'ext_cr', platformAdId: 'ext_ad',
    })
    const calls = fn => metaMocks[fn].mock.calls.length
    const before = {
      create: calls('createAdCampaign') + calls('createAdSet') + calls('createAdCreative') + calls('createAd'),
      list: calls('listAccountCampaigns') + calls('listCampaignAdSets') + calls('listAdSetAds'),
    }
    const result = await campaignService.routeOwnerChainCreation(campaignId, client.id, `resume_page_${dateTag}`)
    expect(result).toMatchObject({ path: 'execution', success: true, skipped: 'already-live' })
    expect(calls('createAdCampaign') + calls('createAdSet') + calls('createAdCreative') + calls('createAd')).toBe(before.create)
    expect(calls('listAccountCampaigns') + calls('listCampaignAdSets') + calls('listAdSetAds')).toBe(before.list)
    expect(ledgerCounts()).toEqual({ campaigns: 0, adsets: 0, creatives: 0, ads: 0 })
  })

  it('3/9. campaign persisted, worker crashed: resume adopts campaign and creates only children', async () => {
    metaMocks.__reset()
    const campaignId = await seedCampaign(client.id)
    await seedExecution(campaignId, client.id, 'client', { status: 'pending', attempts: 1 })
    const campaign = await campaignRepo.findCampaignById(campaignId)
    const chainName = `FlowX-${campaign.name}-${campaign.id.substring(0, 8)}`
    metaMocks.__ledger.campaigns.push({ id: 'orphan_camp_9', name: chainName })
    const result = await campaignService.routeOwnerChainCreation(campaignId, client.id, `resume_page_${dateTag}`)
    expect(result.success).toBe(true)
    expect(ledgerCounts()).toEqual({ campaigns: 1, adsets: 1, creatives: 1, ads: 1 })
    const execution = await execRepo.findExecutionByOwner(campaignId, client.id, 'client')
    expect(execution.platformCampaignId).toBe('orphan_camp_9')
    expect(execution.platformAdsetId).toBeTruthy()
  })

  it('4/10. adset persisted: resume continues from creative', async () => {
    metaMocks.__reset()
    const campaignId = await seedCampaign(client.id)
    const campaign = await campaignRepo.findCampaignById(campaignId)
    const chainName = `FlowX-${campaign.name}-${campaign.id.substring(0, 8)}`
    metaMocks.__ledger.campaigns.push({ id: 'crash_camp_10', name: chainName })
    metaMocks.__ledger.adsets.push({ id: 'crash_set_10', name: 'Ad Set crash_ca', campaignId: 'crash_camp_10' })
    await seedExecution(campaignId, client.id, 'client', {
      status: 'pending', attempts: 1, platformCampaignId: 'crash_camp_10',
    })
    const realAdSetCalls = () => metaMocks.createAdSet.mock.calls.filter(call => call[call.length - 1] !== true).length
    const setCallsBefore = realAdSetCalls()
    const result = await campaignService.routeOwnerChainCreation(campaignId, client.id, `resume_page_${dateTag}`)
    expect(result.success).toBe(true)
    expect(realAdSetCalls()).toBe(setCallsBefore)
    expect(ledgerCounts()).toEqual({ campaigns: 1, adsets: 1, creatives: 1, ads: 1 })
    const execution = await execRepo.findExecutionByOwner(campaignId, client.id, 'client')
    expect(execution.platformAdsetId).toBe('crash_set_10')
    expect(execution.platformCreativeId).toBeTruthy()
    expect(execution.platformAdId).toBeTruthy()
  })

  it('5/12. creative and ad persisted: resume adopts the tail', async () => {
    metaMocks.__reset()
    const campaignId = await seedCampaign(client.id)
    const campaign = await campaignRepo.findCampaignById(campaignId)
    const chainName = `FlowX-${campaign.name}-${campaign.id.substring(0, 8)}`
    metaMocks.__ledger.campaigns.push({ id: 'tail_camp_12', name: chainName })
    metaMocks.__ledger.adsets.push({ id: 'tail_set_12', name: 'Ad Set tail_cam', campaignId: 'tail_camp_12' })
    metaMocks.__ledger.ads.push({ id: 'tail_ad_12', name: chainName, adsetId: 'tail_set_12', creative: { id: 'tail_cr_12' } })
    metaMocks.__ledger.creatives.push({ id: 'tail_cr_12' })
    await seedExecution(campaignId, client.id, 'client', {
      status: 'pending', attempts: 2, platformCampaignId: 'tail_camp_12', platformAdsetId: 'tail_set_12',
    })
    const createCalls = () => metaMocks.createAdCampaign.mock.calls.length + metaMocks.createAdSet.mock.calls.length +
      metaMocks.createAdCreative.mock.calls.length + metaMocks.createAd.mock.calls.length
    const before = createCalls()
    const result = await campaignService.routeOwnerChainCreation(campaignId, client.id, `resume_page_${dateTag}`)
    expect(result.success).toBe(true)
    expect(createCalls()).toBe(before)
    expect(ledgerCounts()).toEqual({ campaigns: 1, adsets: 1, creatives: 1, ads: 1 })
    const execution = await execRepo.findExecutionByOwner(campaignId, client.id, 'client')
    expect(execution.platformAdId).toBe('tail_ad_12')
    expect(execution.platformCreativeId).toBe('tail_cr_12')
  })

  it('6. legacy complete chain adopts with zero creates', async () => {
    metaMocks.__reset()
    const campaignId = await seedCampaign(client.id)
    await seedLegacyObjects(campaignId, client.id, 'legacy6')
    await seedExecution(campaignId, client.id, 'client')
    const createCalls = () => metaMocks.createAdCampaign.mock.calls.length + metaMocks.createAd.mock.calls.length
    const before = createCalls()
    const result = await campaignService.routeOwnerChainCreation(campaignId, client.id, `resume_page_${dateTag}`)
    expect(result).toMatchObject({ success: true, skipped: 'adopted-legacy-chain' })
    expect(createCalls()).toBe(before)
    const execution = await execRepo.findExecutionByOwner(campaignId, client.id, 'client')
    expect(execution.platformCampaignId).toBe('legacy6_facebook_campaign')
  })

  it('7. legacy partial chain preserves IDs and continues only the missing tail', async () => {
    metaMocks.__reset()
    const campaignId = await seedCampaign(client.id)
    await seedLegacyObjects(campaignId, client.id, 'legacy7', ['facebook_campaign'])
    await seedExecution(campaignId, client.id, 'client')
    const result = await campaignService.routeOwnerChainCreation(campaignId, client.id, `resume_page_${dateTag}`)
    expect(result.success).toBe(true)
    expect(ledgerCounts().campaigns).toBe(0)
    expect(ledgerCounts().adsets).toBe(1)
    const execution = await execRepo.findExecutionByOwner(campaignId, client.id, 'client')
    expect(execution.platformCampaignId).toBe('legacy7_facebook_campaign')
    expect(execution.platformAdId).toBeTruthy()
  })

  it('8/18. contradictory legacy IDs fail closed with zero creates', async () => {
    metaMocks.__reset()
    const campaignId = await seedCampaign(client.id)
    await seedLegacyObjects(campaignId, client.id, 'contra8', ['ad_creative', 'ad'])
    await seedExecution(campaignId, client.id, 'client')
    const createCalls = () => metaMocks.createAdCampaign.mock.calls.length + metaMocks.createAd.mock.calls.length
    const before = createCalls()
    const result = await campaignService.routeOwnerChainCreation(campaignId, client.id, `resume_page_${dateTag}`)
    expect(result.success).toBe(false)
    expect(result.failClosed).toBe(true)
    expect(createCalls()).toBe(before)
    expect(ledgerCounts()).toEqual({ campaigns: 0, adsets: 0, creatives: 0, ads: 0 })
  })

  it('duplicate owner campaigns fail closed instead of guessing', async () => {
    metaMocks.__reset()
    const campaignId = await seedCampaign(client.id)
    const campaign = await campaignRepo.findCampaignById(campaignId)
    const chainName = `FlowX-${campaign.name}-${campaign.id.substring(0, 8)}`
    metaMocks.__ledger.campaigns.push({ id: 'dup_a', name: chainName })
    metaMocks.__ledger.campaigns.push({ id: 'dup_b', name: chainName })
    await seedExecution(campaignId, client.id, 'client', { status: 'pending', attempts: 1 })
    const result = await campaignService.routeOwnerChainCreation(campaignId, client.id, `resume_page_${dateTag}`)
    expect(result.success).toBe(false)
    expect(result.failClosed).toBe(true)
    expect(ledgerCounts().campaigns).toBe(2)
  })

  it('13/17/20. ambiguous campaign response reconciles and adopts instead of duplicating', async () => {
    metaMocks.__reset()
    const campaignId = await seedCampaign(client.id)
    await seedExecution(campaignId, client.id, 'client', { status: 'pending', attempts: 1 })
    metaMocks.__faults.createAdCampaign = [{ record: true, error: timeoutError() }]
    const result = await campaignService.routeOwnerChainCreation(campaignId, client.id, `resume_page_${dateTag}`)
    expect(result.success).toBe(true)
    expect(ledgerCounts().campaigns).toBe(1)
    const execution = await execRepo.findExecutionByOwner(campaignId, client.id, 'client')
    expect(execution.platformCampaignId).toBe(metaMocks.__ledger.campaigns[0].id)
  })

  it('14. ambiguous adset response reconciles the lost adset', async () => {
    metaMocks.__reset()
    const campaignId = await seedCampaign(client.id)
    await seedExecution(campaignId, client.id, 'client', { status: 'pending', attempts: 1 })
    const campaign = await campaignRepo.findCampaignById(campaignId)
    const chainName = `FlowX-${campaign.name}-${campaign.id.substring(0, 8)}`
    metaMocks.__ledger.campaigns.push({ id: 'amb_camp_14', name: chainName })
    metaMocks.__ledger.adsets.push({ id: 'amb_set_14', name: 'Ad Set amb_camp', campaignId: 'amb_camp_14' })
    await execRepo.updateExecution(
      (await execRepo.findExecutionByOwner(campaignId, client.id, 'client')).id,
      { platformCampaignId: 'amb_camp_14' }
    )
    metaMocks.__faults.createAdSet = [{ record: true, error: timeoutError() }]
    const result = await campaignService.routeOwnerChainCreation(campaignId, client.id, `resume_page_${dateTag}`)
    expect(result.success).toBe(true)
    expect(ledgerCounts().adsets).toBe(1)
    const execution = await execRepo.findExecutionByOwner(campaignId, client.id, 'client')
    expect(execution.platformAdsetId).toBe('amb_set_14')
  })

  it('16. ambiguous ad response adopts the lost ad and its creative', async () => {
    metaMocks.__reset()
    const campaignId = await seedCampaign(client.id)
    const campaign = await campaignRepo.findCampaignById(campaignId)
    const chainName = `FlowX-${campaign.name}-${campaign.id.substring(0, 8)}`
    metaMocks.__ledger.campaigns.push({ id: 'amb_camp_16', name: chainName })
    metaMocks.__ledger.adsets.push({ id: 'amb_set_16', name: 'Ad Set amb_camp', campaignId: 'amb_camp_16' })
    metaMocks.__ledger.ads.push({ id: 'amb_ad_16', name: chainName, adsetId: 'amb_set_16', creative: { id: 'amb_cr_16' } })
    metaMocks.__ledger.creatives.push({ id: 'amb_cr_16' })
    await seedExecution(campaignId, client.id, 'client', {
      status: 'pending', attempts: 2, platformCampaignId: 'amb_camp_16', platformAdsetId: 'amb_set_16',
    })
    metaMocks.__faults.createAd = [{ record: true, error: timeoutError() }]
    const result = await campaignService.routeOwnerChainCreation(campaignId, client.id, `resume_page_${dateTag}`)
    expect(result.success).toBe(true)
    expect(ledgerCounts().ads).toBe(1)
    const execution = await execRepo.findExecutionByOwner(campaignId, client.id, 'client')
    expect(execution.platformAdId).toBe('amb_ad_16')
    expect(execution.platformCreativeId).toBe('amb_cr_16')
  })

  it('15. ambiguous creative response recovers via fan-out lookup without duplicating', async () => {
    metaMocks.__reset()
    const campaignId = await seedCampaign(client.id)
    await seedExecution(campaignId, client.id, 'client', { status: 'pending', attempts: 1 })
    const campaign = await campaignRepo.findCampaignById(campaignId)
    const chainName = `FlowX-${campaign.name}-${campaign.id.substring(0, 8)}`
    metaMocks.__ledger.campaigns.push({ id: 'no_fp_camp_15', name: chainName })
    await execRepo.updateExecution(
      (await execRepo.findExecutionByOwner(campaignId, client.id, 'client')).id,
      { platformCampaignId: 'no_fp_camp_15' }
    )
    metaMocks.__faults.createAdCreative = [{ record: true, error: timeoutError() }]
    const result = await campaignService.routeOwnerChainCreation(campaignId, client.id, `resume_page_${dateTag}`)
    expect(result.success).toBe(true)
    expect(ledgerCounts().creatives).toBeLessThanOrEqual(2)
    const execution = await execRepo.findExecutionByOwner(campaignId, client.id, 'client')
    expect(execution.platformCreativeId).toBeTruthy()
    expect(execution.platformAdId).toBeTruthy()
    const countsBefore = ledgerCounts()
    const third = await campaignService.routeOwnerChainCreation(campaignId, client.id, `resume_page_${dateTag}`)
    expect(third).toMatchObject({ success: true, skipped: 'already-live' })
    expect(ledgerCounts()).toEqual(countsBefore)
  })

  it('transient failure preserves the partial chain and reports retryable', async () => {
    metaMocks.__reset()
    const campaignId = await seedCampaign(client.id)
    await seedExecution(campaignId, client.id, 'client', { status: 'pending', attempts: 1 })
    metaMocks.__faults.createAdSet = [{ error: transientError() }, { error: transientError() }]
    const result = await campaignService.routeOwnerChainCreation(campaignId, client.id, `resume_page_${dateTag}`)
    expect(result.success).toBe(false)
    expect(result.retryable).toBe(true)
    expect(result.classification).toBe('transient')
    expect(ledgerCounts()).toEqual({ campaigns: 1, adsets: 0, creatives: 0, ads: 0 })
    const execution = await execRepo.findExecutionByOwner(campaignId, client.id, 'client')
    expect(execution.platformCampaignId).toBeTruthy()
    expect(execution.error).toMatch(/^\[transient\]/)
  })

  it('permanent failure rolls back only this run and reports failedStep', async () => {
    metaMocks.__reset()
    const campaignId = await seedCampaign(client.id)
    await seedExecution(campaignId, client.id, 'client', { status: 'pending', attempts: 1 })
    const permanent = new Error('Graph API POST act_x/adsets failed: {"error":{"error_user_msg":"bad geo","code":100}}')
    permanent.statusCode = 400
    metaMocks.__faults.createAdSet = [{ error: permanent }]
    const result = await campaignService.routeOwnerChainCreation(campaignId, client.id, `resume_page_${dateTag}`)
    expect(result.success).toBe(false)
    expect(result.retryable).toBeUndefined()
    expect(result.failedStep).toBe('ad_set')
    expect(ledgerCounts()).toEqual({ campaigns: 0, adsets: 0, creatives: 0, ads: 0 })
  })

  it('19. two sequential workers resume the same execution id with one chain', async () => {
    metaMocks.__reset()
    const campaignId = await seedCampaign(client.id)
    const executionId = await seedExecution(campaignId, client.id, 'client')
    const first = await campaignService.routeOwnerChainCreation(campaignId, client.id, `resume_page_${dateTag}`)
    expect(first.success).toBe(true)
    expect(first.executionId).toBe(executionId)
    const second = await campaignService.routeOwnerChainCreation(campaignId, client.id, `resume_page_${dateTag}`)
    expect(second).toMatchObject({ success: true, skipped: 'already-live', executionId })
    expect(ledgerCounts()).toEqual({ campaigns: 1, adsets: 1, creatives: 1, ads: 1 })
    const rows = await execRepo.findExecutionsByCampaignId(campaignId)
    expect(rows).toHaveLength(1)
  })

  it('19b. concurrent workers under the campaign lock produce one chain', async () => {
    metaMocks.__reset()
    const campaignId = await seedCampaign(client.id)
    const executionId = await seedExecution(campaignId, client.id, 'client')
    const lockedRoute = () => transaction(async () => {
      await campaignRepo.lockCampaignById(campaignId)
      return campaignService.routeOwnerChainCreation(campaignId, client.id, `resume_page_${dateTag}`)
    })
    const [a, b] = await Promise.all([lockedRoute(), lockedRoute()])
    expect(a.success).toBe(true)
    expect(b.success).toBe(true)
    expect(a.executionId).toBe(executionId)
    expect(b.executionId).toBe(executionId)
    expect(ledgerCounts()).toEqual({ campaigns: 1, adsets: 1, creatives: 1, ads: 1 })
  })

  it('21/22/23. resume uses the frozen snapshot and frozen page, never live state', async () => {
    metaMocks.__reset()
    const campaignId = await seedCampaign(client.id)
    await seedExecution(campaignId, client.id, 'client')
    await campaignService.routeOwnerChainCreation(campaignId, client.id, `resume_page_${dateTag}`)
    await campaignRepo.createMetaSettings(generateUuid(), campaignId, {
      objective: 'OUTCOME_ENGAGEMENT',
      budgetType: 'lifetime',
      budgetAmount: 500,
      endTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    })
    await campaignRepo.createCreative(generateUuid(), campaignId, { caption: 'live caption', mediaUrl: 'https://example.com/live.jpg' })
    const doomed = await execRepo.findExecutionByOwner(campaignId, client.id, 'client')
    const purgedIds = new Set([doomed.platformCampaignId, doomed.platformAdsetId, doomed.platformCreativeId, doomed.platformAdId])
    await execRepo.updateExecution(doomed.id, {
      status: 'pending', platformCampaignId: null, platformAdsetId: null, platformCreativeId: null, platformAdId: null,
    })
    await campaignRepo.deleteMetaObjectsForUser(campaignId, client.id)
    for (const bucket of ['campaigns', 'adsets', 'creatives', 'ads']) {
      metaMocks.__ledger[bucket] = metaMocks.__ledger[bucket].filter(o => !purgedIds.has(o.id))
    }
    const campaignCallsBefore = metaMocks.createAdCampaign.mock.calls.length
    const creativeCallsBefore = metaMocks.createAdCreative.mock.calls.length
    const result = await campaignService.routeOwnerChainCreation(campaignId, client.id, 'ROTATED_PAGE')
    expect(result.success).toBe(true)
    const newCampaignCalls = metaMocks.createAdCampaign.mock.calls.slice(campaignCallsBefore)
      .filter(call => call[call.length - 1] !== true)
    expect(newCampaignCalls.length).toBeGreaterThan(0)
    for (const call of newCampaignCalls) expect(call[2]).toBe('OUTCOME_TRAFFIC')
    const newCreativeCalls = metaMocks.createAdCreative.mock.calls.slice(creativeCallsBefore)
      .filter(call => call[call.length - 1] !== true)
    expect(newCreativeCalls.length).toBeGreaterThan(0)
    for (const call of newCreativeCalls) {
      expect(call[1]).toBe(`resume_page_${dateTag}`)
      expect(call[2]).toBe('resume caption')
    }
  })

  it('24/25/26. invalid snapshot, terminal and quarantined executions create nothing', async () => {
    metaMocks.__reset()
    const calls = () => metaMocks.createAdCampaign.mock.calls.length + metaMocks.createAd.mock.calls.length
    const badSnapshot = await seedCampaign(client.id)
    await seedExecution(badSnapshot, client.id, 'client')
    await campaignService.routeOwnerChainCreation(badSnapshot, client.id, `resume_page_${dateTag}`)
    await query('UPDATE campaigns SET resolved_graph_version = ? WHERE id = ?', ['v99.0', uuidToBuffer(badSnapshot)])
    const stranger = await createTestUser({ email: `resume-stranger-${dateTag}@flowx-test.com`, password: 'Test@123', role: 'publisher' })
    await addVerifiedPage(stranger.id, `resume_stranger_${dateTag}`)
    await execRepo.createExecution({ campaignId: badSnapshot, ownerUserId: stranger.id, kind: 'publisher', status: 'pending' })
    const beforeBad = calls()
    const rBad = await campaignService.routeOwnerChainCreation(badSnapshot, stranger.id, `resume_stranger_${dateTag}`)
    expect(rBad).toMatchObject({ success: false, failClosed: true })

    const terminal = await seedCampaign(client.id)
    await seedExecution(terminal, publisher.id, 'publisher', { status: 'failed' })
    const beforeTerminal = calls()
    const rTerminal = await campaignService.routeOwnerChainCreation(terminal, publisher.id, `resume_pub_page_${dateTag}`)
    expect(rTerminal).toMatchObject({ success: false, skipped: 'terminal' })

    const quarantined = await seedCampaign(client.id, { status: 'pending_review' })
    await query('UPDATE campaigns SET escrow_amount = 550 WHERE id = ?', [uuidToBuffer(quarantined)])
    await seedExecution(quarantined, publisher.id, 'publisher', { status: 'pending' })
    const beforeQuar = calls()
    const rQuar = await campaignService.routeOwnerChainCreation(quarantined, publisher.id, `resume_pub_page_${dateTag}`)
    expect(rQuar).toMatchObject({ success: false, skipped: 'quarantined' })

    expect(calls()).toBe(beforeBad)
    void beforeTerminal
    void beforeQuar
  })

  it('27/28. resume moves no money and preserves historical rows', async () => {
    metaMocks.__reset()
    const campaignId = await seedCampaign(client.id)
    const chain = await seedLegacyObjects(campaignId, client.id, 'money27', ['facebook_campaign', 'ad_set'])
    void chain
    await seedExecution(campaignId, client.id, 'client')
    const moneyBefore = await snapshotMoney([client.id, publisher.id], campaignId)
    const objectsBefore = JSON.stringify(await query('SELECT object_type, object_id, created_for_user_id FROM campaign_meta_objects WHERE campaign_id = ?', [uuidToBuffer(campaignId)]))
    const result = await campaignService.routeOwnerChainCreation(campaignId, client.id, `resume_page_${dateTag}`)
    expect(result.success).toBe(true)
    expect(await snapshotMoney([client.id, publisher.id], campaignId)).toBe(moneyBefore)
    const execution = await execRepo.findExecutionByOwner(campaignId, client.id, 'client')
    expect(Number(execution.consumedPaise)).toBe(0)
    expect(Number(execution.refundedPaise)).toBe(0)
    const objectsAfter = JSON.stringify(await query('SELECT object_type, object_id, created_for_user_id FROM campaign_meta_objects WHERE campaign_id = ?', [uuidToBuffer(campaignId)]))
    const beforeRows = JSON.parse(objectsBefore)
    const afterRows = JSON.parse(objectsAfter)
    for (const row of beforeRows) {
      expect(afterRows).toContainEqual(row)
    }
    expect(ledgerCounts().campaigns).toBe(0)
  })
})
