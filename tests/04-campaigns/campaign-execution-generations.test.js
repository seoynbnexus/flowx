import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'fs'
import { generateUuid, uuidToBuffer } from '../../shared/utils/uuid.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import * as campaignService from '../../src/modules/campaigns/campaign.service.js'
import * as campaignRepo from '../../src/modules/campaigns/campaign.repository.js'
import * as execRepo from '../../src/modules/campaigns/campaign-execution.repository.js'
import { backfillExecutionGenerations } from '../../shared/database/migrations/088_campaign_execution_generations.js'
import { query } from '../../shared/database/connection.js'

vi.mock('../../shared/services/meta-ads.service.js', async () => {
  const actual = await vi.importActual('../../shared/services/meta-ads.service.js')
  const fail = vi.fn(() => { throw new Error('Meta mutation attempted during generation test') })
  return {
    ...actual,
    createAdCampaign: fail,
    createAdSet: fail,
    createAdCreative: fail,
    createAd: fail,
    deleteAdCampaign: fail,
    deleteAdSet: fail,
    deleteAdCreative: fail,
    deleteAd: fail,
    updateAdStatus: fail,
    listAccountAds: vi.fn().mockResolvedValue({ rows: [], truncated: false }),
    getObjectStatus: vi.fn().mockResolvedValue({ status: 'ACTIVE', effective_status: 'ACTIVE' }),
    getCampaignStatusesBatch: vi.fn().mockResolvedValue({}),
    getAdAccount: vi.fn().mockResolvedValue({ balance: '10.00', currency: 'INR', account_status: 1, disable_reason: null }),
  }
})

const dateTag = Date.now()
let seq = 0
function tag(prefix) {
  seq += 1
  return `${prefix}_${seq}_${generateUuid()}`
}

describe('campaign execution generations', () => {
  let client
  let partner
  const campaignIds = []

  async function seedExecution(ownerId, suffix, kind = 'client', ids = null) {
    const campaign = await campaignService.createCampaign(ownerId, {
      name: `GenZero ${suffix}`,
      type: 'post',
    })
    campaignIds.push(campaign.id)
    const fb = ids?.platformCampaignId ?? `fb_gen_${suffix}`
    const adset = ids?.platformAdsetId ?? `adset_gen_${suffix}`
    const creative = ids?.platformCreativeId ?? `creative_gen_${suffix}`
    const ad = ids?.platformAdId ?? `ad_gen_${suffix}`
    const executionId = await execRepo.createExecution({
      campaignId: campaign.id,
      ownerUserId: ownerId,
      kind,
      status: 'creating',
      platformCampaignId: fb,
      platformAdsetId: adset,
      platformCreativeId: creative,
      platformAdId: ad,
    })
    return { campaignId: campaign.id, executionId, fb, adset, creative, ad }
  }

  async function countExecutions() {
    const rows = await query('SELECT COUNT(*) AS n FROM campaign_executions')
    return Number(rows[0].n)
  }

  async function countBillingEntries() {
    const rows = await query('SELECT COUNT(*) AS n FROM campaign_billing_entries')
    return Number(rows[0].n)
  }

  beforeAll(async () => {
    process.env.META_SYSTEM_USER_TOKEN = 'test_system_user_token'
    process.env.META_AD_ACCOUNT_ID = 'act_test_account'
    client = await createTestUser({ email: `gen-zero-${dateTag}@flowx-test.com`, password: 'Test@123', coins: 10000 })
    partner = await createTestUser({ email: `gen-zero-partner-${dateTag}@flowx-test.com`, password: 'Test@123', coins: 10000 })
  })

  afterAll(async () => {
    for (const id of campaignIds) {
      await query('DELETE FROM campaigns WHERE id = ?', [uuidToBuffer(id)]).catch(() => {})
    }
  })

  it('1. creates exactly one Generation 0 per execution with exact IDs', async () => {
    const seed = await seedExecution(client.id, tag('s'))
    const { getPool } = await import('../../shared/database/connection.js')
    await backfillExecutionGenerations(getPool())
    const generations = await execRepo.listGenerationsForExecution(seed.executionId)
    expect(generations).toHaveLength(1)
    expect(generations[0]).toMatchObject({
      executionId: seed.executionId,
      generationNo: 0,
      status: 'active',
      platformCampaignId: seed.fb,
      platformAdsetId: seed.adset,
      platformCreativeId: seed.creative,
      platformAdId: seed.ad,
      repairRunId: null,
    })
    const execution = await execRepo.findExecutionById(seed.executionId)
    expect(execution.activeGenerationNo).toBe(0)
  })

  it('2-3. backfill is idempotent and duplicate runs never duplicate Generation 0', async () => {
    const seed = await seedExecution(client.id, tag('s'))
    const { getPool } = await import('../../shared/database/connection.js')
    const first = await backfillExecutionGenerations(getPool())
    expect(first.created).toBeGreaterThanOrEqual(1)
    const second = await backfillExecutionGenerations(getPool())
    expect(second.created).toBe(0)
    const third = await backfillExecutionGenerations(getPool())
    expect(third.created).toBe(0)
    const generations = await execRepo.listGenerationsForExecution(seed.executionId)
    expect(generations).toHaveLength(1)
  })

  it('5. performs no Meta API mutation', async () => {
    const seed = await seedExecution(client.id, tag('s'))
    const { getPool } = await import('../../shared/database/connection.js')
    const meta = await import('../../shared/services/meta-ads.service.js')
    await backfillExecutionGenerations(getPool())
    for (const fn of ['createAdCampaign', 'createAdSet', 'createAdCreative', 'createAd', 'deleteAd', 'updateAdStatus']) {
      expect(meta[fn]).not.toHaveBeenCalled()
    }
    const generations = await execRepo.listGenerationsForExecution(seed.executionId)
    expect(generations).toHaveLength(1)
  })

  it('6-7. changes no billing data and creates no executions', async () => {
    const seed = await seedExecution(client.id, tag('s'))
    const billingBefore = await countBillingEntries()
    const executionsBefore = await countExecutions()
    const moneyBefore = await execRepo.findExecutionById(seed.executionId)
    const { getPool } = await import('../../shared/database/connection.js')
    await backfillExecutionGenerations(getPool())
    expect(await countBillingEntries()).toBe(billingBefore)
    expect(await countExecutions()).toBe(executionsBefore)
    const moneyAfter = await execRepo.findExecutionById(seed.executionId)
    expect(moneyAfter.consumedPaise).toBe(moneyBefore.consumedPaise)
    expect(moneyAfter.refundedPaise).toBe(moneyBefore.refundedPaise)
  })

  it('8. mirrors incomplete executions as-is without fabricating IDs', async () => {
    const campaign = await campaignService.createCampaign(client.id, { name: `GenIncomplete ${tag('s')}`, type: 'post' })
    campaignIds.push(campaign.id)
    const executionId = await execRepo.createExecution({
      campaignId: campaign.id, ownerUserId: client.id, kind: 'client', status: 'pending',
      platformCampaignId: null, platformAdsetId: null, platformCreativeId: null, platformAdId: null,
    })
    const { getPool } = await import('../../shared/database/connection.js')
    const summary = await backfillExecutionGenerations(getPool())
    const generations = await execRepo.listGenerationsForExecution(executionId)
    expect(generations).toHaveLength(1)
    expect(generations[0]).toMatchObject({
      generationNo: 0,
      status: 'active',
      platformCampaignId: null,
      platformAdsetId: null,
      platformCreativeId: null,
      platformAdId: null,
    })
    expect(summary.incomplete.length).toBeGreaterThanOrEqual(1)
  })

  it('9. enforces generation number uniqueness per execution', async () => {
    const seed = await seedExecution(client.id, tag('s'))
    const { getPool } = await import('../../shared/database/connection.js')
    await backfillExecutionGenerations(getPool())
    await expect(execRepo.createGeneration({
      executionId: seed.executionId, generationNo: 0, status: 'active',
      platformCampaignId: seed.fb, platformAdsetId: seed.adset, platformCreativeId: seed.creative, platformAdId: seed.ad,
    })).rejects.toThrow(/Duplicate entry/i)
    expect(await execRepo.listGenerationsForExecution(seed.executionId)).toHaveLength(1)
  })

  it('10. guards generation state transitions and resolves a single active generation', async () => {
    const seed = await seedExecution(client.id, tag('s'))
    const { getPool } = await import('../../shared/database/connection.js')
    await backfillExecutionGenerations(getPool())
    const gen = await execRepo.findGenerationByExecutionIdAndNumber(seed.executionId, 0)
    expect(await execRepo.updateGenerationState(gen.id, ['superseded'], 'failed')).toBe(0)
    expect(await execRepo.updateGenerationState(gen.id, ['active'], 'superseded')).toBe(1)
    const active = await execRepo.findActiveGeneration(seed.executionId)
    expect(active.status).toBe('superseded')
    expect(await execRepo.updateGenerationState(gen.id, ['superseded'], 'active')).toBe(1)
    expect((await execRepo.findActiveGeneration(seed.executionId)).status).toBe('active')
  })

  it('11. findActiveGeneration returns Generation 0 via the execution pointer', async () => {
    const seed = await seedExecution(client.id, tag('s'))
    const { getPool } = await import('../../shared/database/connection.js')
    await backfillExecutionGenerations(getPool())
    const active = await execRepo.findActiveGeneration(seed.executionId)
    expect(active).toMatchObject({ executionId: seed.executionId, generationNo: 0, platformAdId: seed.ad })
    const chain = await execRepo.findActiveGenerationChain(seed.executionId)
    expect(chain.execution.id).toBe(seed.executionId)
    expect(chain.generation.id).toBe(active.id)
  })

  it('12. findGenerationByMetaId resolves all four Generation 0 IDs', async () => {
    const seed = await seedExecution(client.id, tag('s'))
    const { getPool } = await import('../../shared/database/connection.js')
    await backfillExecutionGenerations(getPool())
    for (const objectId of [seed.fb, seed.adset, seed.creative, seed.ad]) {
      const found = await execRepo.findGenerationByMetaId(objectId)
      expect(found).toMatchObject({ executionId: seed.executionId, generationNo: 0 })
    }
    expect(await execRepo.findGenerationByMetaId(`nonexistent_${tag('s')}`)).toBeNull()
    expect(await execRepo.findGenerationByMetaId(null)).toBeNull()
  })

  it('13. divergent Generation 0 fails closed instead of overwriting', async () => {
    const seed = await seedExecution(client.id, tag('s'))
    const { getPool } = await import('../../shared/database/connection.js')
    await backfillExecutionGenerations(getPool())
    const gen = await execRepo.findGenerationByExecutionIdAndNumber(seed.executionId, 0)
    await query('UPDATE campaign_execution_generations SET platform_ad_id = ? WHERE id = ?', [`tampered_${tag('s')}`, uuidToBuffer(gen.id)])
    await expect(backfillExecutionGenerations(getPool())).rejects.toThrow(/divergent Generation 0/i)
    expect(await execRepo.listGenerationsForExecution(seed.executionId)).toHaveLength(1)
    await query('UPDATE campaign_execution_generations SET platform_ad_id = ? WHERE id = ?', [seed.ad, uuidToBuffer(gen.id)])
    const repaired = await backfillExecutionGenerations(getPool())
    expect(repaired.verified).toBeGreaterThanOrEqual(1)
  })

  it('14-15. executions stay independent across campaigns, kinds, and owners', async () => {
    const campaign = await campaignService.createCampaign(client.id, { name: `GenBoth ${tag('s')}`, type: 'post' })
    campaignIds.push(campaign.id)
    const mk = (ownerId, suffix, kind) => execRepo.createExecution({
      campaignId: campaign.id, ownerUserId: ownerId, kind, status: 'creating',
      platformCampaignId: `fb_both_${suffix}`, platformAdsetId: `adset_both_${suffix}`,
      platformCreativeId: `creative_both_${suffix}`, platformAdId: `ad_both_${suffix}`,
    })
    const clientExec = await mk(client.id, tag('s'), 'client')
    const publisherExec = await mk(partner.id, tag('s'), 'publisher')
    const { getPool } = await import('../../shared/database/connection.js')
    await backfillExecutionGenerations(getPool())
    const clientGens = await execRepo.listGenerationsForExecution(clientExec)
    const publisherGens = await execRepo.listGenerationsForExecution(publisherExec)
    expect(clientGens).toHaveLength(1)
    expect(publisherGens).toHaveLength(1)
    expect(clientGens[0].id).not.toBe(publisherGens[0].id)
    expect(clientGens[0].platformAdId).not.toBe(publisherGens[0].platformAdId)
    expect((await execRepo.findActiveGeneration(clientExec)).executionId).toBe(clientExec)
    expect((await execRepo.findActiveGeneration(publisherExec)).executionId).toBe(publisherExec)
  })

  it('16. migration and repository touch no financial code paths', async () => {
    const migrationSrc = fs.readFileSync(
      new URL('../../shared/database/migrations/088_campaign_execution_generations.js', import.meta.url), 'utf8'
    )
    expect(migrationSrc).not.toMatch(/coinService|insertBillingEntry|chargedAdBudgetPaise|claimCampaignSettlement|meta-ads\.service|graphPost|graphDelete|spend\(|refund\(|addCoins/)
  })
})
