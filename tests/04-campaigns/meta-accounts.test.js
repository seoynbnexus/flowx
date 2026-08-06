import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { vi } from 'vitest'
import * as repo from '../../src/modules/campaigns/campaign.repository.js'
import * as service from '../../src/modules/campaigns/campaign.service.js'
import * as limiter from '../../shared/services/meta-rate-limiter.js'
import { query } from '../../shared/database/connection.js'
import { generateUuid } from '../../shared/utils/uuid.utils.js'
import { createTestUser } from '../helpers/create-user.js'

var metaMocks

vi.mock('../../shared/services/meta-ads.service.js', async () => {
  const actual = await vi.importActual('../../shared/services/meta-ads.service.js')
  const mocks = {
    getObjectStatus: vi.fn().mockResolvedValue({ status: 'ACTIVE', effective_status: 'ACTIVE' }),
    listAccountAds: vi.fn().mockResolvedValue({ rows: [], truncated: false }),
    getAdAccount: vi.fn().mockResolvedValue({ balance: '10.00', currency: 'INR', account_status: 1, disable_reason: null }),
    createInsightsReport: vi.fn().mockResolvedValue({ report_run_id: 'run_x' }),
    getInsightsReport: vi.fn().mockResolvedValue({ async_status: 'Job Running' }),
    getInsightsReportData: vi.fn().mockResolvedValue([]),
    extractMetaError: vi.fn().mockReturnValue(null),
  }
  metaMocks = mocks
  return { ...actual, ...mocks }
})

const dateTag = Date.now()

async function cleanup() {
  await query('SET FOREIGN_KEY_CHECKS = 0')
  await query('DELETE FROM campaign_meta_objects')
  await query('DELETE FROM campaigns')
  await query('DELETE FROM meta_ad_accounts')
  await query('DELETE FROM campaign_jobs')
  await query('SET FOREIGN_KEY_CHECKS = 1')
}

beforeAll(async () => {
  process.env.META_SYSTEM_USER_TOKEN = 'test_system_user_token'
  process.env.META_AD_ACCOUNT_ID = 'act_env_fallback'
  await cleanup()
})

beforeEach(async () => {
  await cleanup()
  limiter.resetRateLimitState()
})

afterAll(async () => {
  await cleanup()
})

describe('per-account rate limiter', () => {
  it('tracks usage in independent per-account buckets', () => {
    limiter.recordUsage({ 'x-app-usage': { used: { call_count: 0.9, total_cputime: 0.1 } } }, 'act_A')
    limiter.recordUsage({ 'x-app-usage': { used: { call_count: 0.1, total_cputime: 0.1 } } }, 'act_B')

    expect(limiter.isRateLimited('act_A')).toBe(true)
    expect(limiter.isRateLimited('act_B')).toBe(false)
    expect(limiter.isRateLimited()).toBe(false)

    const states = limiter.getAllRateLimitStates()
    const a = states.find(s => s.accountId === 'act_A')
    expect(a.rateLimited).toBe(true)
  })

  it('applies cooldown to a single account only', () => {
    limiter.setCooldown(120, 'act_A')
    expect(limiter.isRateLimited('act_A')).toBe(true)
    expect(limiter.isRateLimited('act_B')).toBe(false)
    expect(limiter.isSoftThrottled('act_A')).toBe(true)
  })

  it('resets a single account bucket', () => {
    limiter.recordUsage({ 'x-app-usage': { used: { call_count: 0.95, total_cputime: 0.9 } } }, 'act_A')
    expect(limiter.isRateLimited('act_A')).toBe(true)
    limiter.resetRateLimitState('act_A')
    expect(limiter.isRateLimited('act_A')).toBe(false)
  })
})

describe('meta ad account repository', () => {
  it('persists and decrypts an account token', async () => {
    const accountId = `acct_${dateTag}`
    const created = await repo.createMetaAdAccount({
      metaAccountId: accountId,
      name: 'Test Account',
      token: 'secret-token-123',
      monthlyCapPaise: 500000,
      isPrimary: true,
    })

    expect(created.metaAccountId).toBe(accountId)
    expect(created.accessToken).toBe('secret-token-123')
    expect(created.monthlyCapPaise).toBe(500000)
    expect(created.isPrimary).toBe(true)

    const byMeta = await repo.findMetaAdAccountByMetaId(accountId)
    expect(byMeta.accessToken).toBe('secret-token-123')
    expect(byMeta.id).toBe(created.id)

    const listed = await repo.listMetaAdAccounts()
    expect(listed).toHaveLength(1)
    const activeOnly = await repo.listMetaAdAccounts({ activeOnly: true })
    expect(activeOnly).toHaveLength(1)
  })

  it('upserts on duplicate account_id and can disable', async () => {
    const accountId = `dup_${dateTag}`
    await repo.createMetaAdAccount({ metaAccountId: accountId, token: 't1', monthlyCapPaise: 100 })
    await repo.createMetaAdAccount({ metaAccountId: accountId, token: 't2', monthlyCapPaise: 200, status: 'disabled' })

    const accounts = await repo.listMetaAdAccounts()
    expect(accounts).toHaveLength(1)
    expect(accounts[0].monthlyCapPaise).toBe(200)
    expect(accounts[0].status).toBe('disabled')
    expect(await repo.listMetaAdAccounts({ activeOnly: true })).toHaveLength(0)
  })

  it('clears other primaries when one is promoted', async () => {
    const a = await repo.createMetaAdAccount({ metaAccountId: `p1_${dateTag}`, token: 't', isPrimary: true })
    const b = await repo.createMetaAdAccount({ metaAccountId: `p2_${dateTag}`, token: 't', isPrimary: true })
    await service.updateMetaAccount(a.id, { isPrimary: true })

    const accounts = await repo.listMetaAdAccounts()
    expect(accounts.find(x => x.id === a.id).isPrimary).toBe(true)
    expect(accounts.find(x => x.id === b.id).isPrimary).toBe(false)
  })
})

describe('campaign account assignment', () => {
  it('assigns campaigns to the least-loaded account and skips capped accounts', async () => {
    const accA = await repo.createMetaAdAccount({ metaAccountId: `capA_${dateTag}`, token: 't', monthlyCapPaise: 1000 })
    await repo.createMetaAdAccount({ metaAccountId: `capB_${dateTag}`, token: 't', monthlyCapPaise: 1000 })
    const user = await createTestUser({ email: `assign-${dateTag}@flowx-test.com`, password: 'Test@123', coins: 1000 })

    const c1 = await service.createCampaign(user.id, { name: 'Assign 1', type: 'post' })
    await repo.updateCampaignStatus(c1.id, 'approved')
    await repo.updateCampaign(c1.id, { chargedAdBudgetPaise: 999 })

    const c2 = await service.createCampaign(user.id, { name: 'Assign 2', type: 'post' })
    expect(c1.adAccountDbId).toBe(accA.id)
    expect(c2.adAccountDbId).not.toBe(accA.id)
    expect(c2.adAccountDbId).not.toBeNull()

    await repo.updateCampaignStatus(c2.id, 'approved')
    await repo.updateCampaign(c2.id, { chargedAdBudgetPaise: 1000 })

    const c3 = await service.createCampaign(user.id, { name: 'Assign 3', type: 'post' })
    expect(c3.adAccountDbId).not.toBeNull()
  })

  it('falls back to env account when no accounts are configured', async () => {
    const user = await createTestUser({ email: `envfb-${dateTag}@flowx-test.com`, password: 'Test@123', coins: 1000 })

    const c = await service.createCampaign(user.id, { name: 'Env Fallback', type: 'post' })
    expect(c.adAccountDbId).toBeNull()

    const ctx = await service.getCampaignAccountContext(c.id)
    expect(ctx.accountId).toBe('act_env_fallback')
    expect(ctx.accessToken).toBe('test_system_user_token')
    expect(ctx.accountDbId).toBeNull()

    const syncCtx = await service.resolveAccountContext('act_env_fallback')
    expect(syncCtx.accessToken).toBe('test_system_user_token')
  })

  it('uses the campaign-assigned account token for sync context', async () => {
    const accA = await repo.createMetaAdAccount({ metaAccountId: `ctxA_${dateTag}`, token: 'token-A', monthlyCapPaise: 0 })
    const user = await createTestUser({ email: `ctx-${dateTag}@flowx-test.com`, password: 'Test@123', coins: 1000 })

    const c = await service.createCampaign(user.id, { name: 'Ctx', type: 'post' })
    await repo.updateCampaign(c.id, { adAccountId: accA.id })

    const ctx = await service.getCampaignAccountContext(c.id)
    expect(ctx.accountId).toBe(`ctxA_${dateTag}`)
    expect(ctx.accessToken).toBe('token-A')
    expect(ctx.accountDbId).toBe(accA.id)
  })

  it('prefers the env system user token over a stored token for the env primary account', async () => {
    const acc = await repo.createMetaAdAccount({ metaAccountId: 'act_env_fallback', token: 'stale-token', monthlyCapPaise: 500 })
    const user = await createTestUser({ email: `envtok-${dateTag}@flowx-test.com`, password: 'Test@123', coins: 1000 })

    const ctx = await service.resolveAccountContext('act_env_fallback')
    expect(ctx.accountId).toBe('act_env_fallback')
    expect(ctx.accessToken).toBe('test_system_user_token')
    expect(ctx.accountDbId).toBe(acc.id)

    const c = await service.createCampaign(user.id, { name: 'EnvTok', type: 'post' })
    await repo.updateCampaign(c.id, { adAccountId: acc.id })

    const campCtx = await service.getCampaignAccountContext(c.id)
    expect(campCtx.accessToken).toBe('test_system_user_token')
    expect(campCtx.accountDbId).toBe(acc.id)
  })

  it('does not persist a token for the env primary account via admin create', async () => {
    const created = await service.createMetaAccount({
      metaAccountId: 'act_env_fallback',
      name: 'Env Primary',
      token: 'should-not-be-stored',
      isPrimary: true,
    })
    expect(created.accessToken).toBeNull()

    const ctx = await service.resolveAccountContext('act_env_fallback')
    expect(ctx.accessToken).toBe('test_system_user_token')
    expect(ctx.accountDbId).toBe(created.id)

    const row = await repo.findMetaAdAccountById(created.id)
    expect(row.accessToken).toBeNull()
  })
})

describe('account-scoped sync', () => {
  async function seedRunningCampaign(userId, adObjectId) {
    const campaign = await service.createCampaign(userId, {
      name: `Scope ${generateUuid().substring(0, 8)}`,
      type: 'post',
    })
    await repo.createMetaObject(campaign.id, 'facebook_campaign', `fb_${generateUuid()}`, null, 'ACTIVE', userId)
    await repo.createMetaObject(campaign.id, 'ad_set', `as_${generateUuid()}`, null, 'ACTIVE', userId)
    await repo.createMetaObject(campaign.id, 'ad', adObjectId, null, 'ACTIVE', userId)
    await repo.updateCampaignStatus(campaign.id, 'running')
    return campaign
  }

  it('syncs only campaigns assigned to the given account', async () => {
    const accA = await repo.createMetaAdAccount({ metaAccountId: `scopeA_${dateTag}`, token: 't' })
    const accB = await repo.createMetaAdAccount({ metaAccountId: `scopeB_${dateTag}`, token: 't' })
    const user = await createTestUser({ email: `scope-${dateTag}@flowx-test.com`, password: 'Test@123', coins: 1000 })

    const adObjectId = `scope_ad_${generateUuid()}`
    const campaign = await seedRunningCampaign(user.id, adObjectId)
    await repo.updateCampaign(campaign.id, { adAccountId: accA.id })

    metaMocks.listAccountAds.mockResolvedValue({
      rows: [{ id: adObjectId, status: 'ACTIVE', effective_status: 'ACTIVE' }],
      truncated: false,
    })

    const resultA = await service.syncAccountStatusJob(`scopeA_${dateTag}`)
    expect(resultA.success).toBe(true)
    expect(resultA.campaigns).toBe(1)

    const resultB = await service.syncAccountStatusJob(`scopeB_${dateTag}`)
    expect(resultB.success).toBe(true)
    expect(resultB.skipped).toBe(true)
  })

  it('unassigned campaigns are picked up only by the env fallback account', async () => {
    const user = await createTestUser({ email: `unassign-${dateTag}@flowx-test.com`, password: 'Test@123', coins: 1000 })

    const adObjectId = `unassigned_ad_${generateUuid()}`
    await seedRunningCampaign(user.id, adObjectId)
    await repo.createMetaAdAccount({ metaAccountId: `scopeC_${dateTag}`, token: 't' })

    metaMocks.listAccountAds.mockResolvedValue({
      rows: [{ id: adObjectId, status: 'ACTIVE', effective_status: 'ACTIVE' }],
      truncated: false,
    })

    const other = await service.syncAccountStatusJob(`scopeC_${dateTag}`)
    expect(other.skipped).toBe(true)

    const envFallback = await service.syncAccountStatusJob('act_env_fallback')
    expect(envFallback.success).toBe(true)
    expect(envFallback.campaigns).toBe(1)
  })
})

describe('multi-account scheduler', () => {
  it('enqueues account-level jobs per configured account', async () => {
    const accA = await repo.createMetaAdAccount({ metaAccountId: `schA_${dateTag}`, token: 't' })
    await repo.createMetaAdAccount({ metaAccountId: `schB_${dateTag}`, token: 't' })
    const user = await createTestUser({ email: `sched-${dateTag}@flowx-test.com`, password: 'Test@123', coins: 1000 })

    const campaign = await service.createCampaign(user.id, { name: 'Sched', type: 'post' })
    await repo.createMetaObject(campaign.id, 'facebook_campaign', `fb_${generateUuid()}`, null, 'ACTIVE', user.id)
    await repo.createMetaObject(campaign.id, 'ad_set', `as_${generateUuid()}`, null, 'ACTIVE', user.id)
    await repo.createMetaObject(campaign.id, 'ad', `ad_${generateUuid()}`, null, 'ACTIVE', user.id)
    await repo.updateCampaign(campaign.id, { adAccountId: accA.id })
    await repo.updateCampaignStatus(campaign.id, 'running')

    const result = await service.scheduleCampaignSyncs()
    expect(result.skipped).toBeUndefined()
    expect(result.statusEnqueued).toBe(2)
    expect(result.insightsEnqueued).toBe(2)

    const jobs = await query(
      "SELECT run_key FROM campaign_jobs WHERE job_type IN ('sync_account_status', 'sync_account_insights')"
    )
    const runKeys = jobs.map(j => j.run_key)
    expect(runKeys).toContain(`status:schA_${dateTag}`)
    expect(runKeys).toContain(`status:schB_${dateTag}`)
    expect(runKeys).toContain(`insights:schA_${dateTag}`)
    expect(runKeys).toContain(`insights:schB_${dateTag}`)

    const again = await service.scheduleCampaignSyncs()
    expect(again.statusEnqueued).toBe(0)
    expect(again.insightsEnqueued).toBe(0)
  })
})
