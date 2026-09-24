import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'fs'
import supertest from 'supertest'
import { generateUuid, uuidToBuffer } from '../../shared/utils/uuid.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import { loginAgent } from '../helpers/auth.js'
import * as campaignService from '../../src/modules/campaigns/campaign.service.js'
import * as campaignRepo from '../../src/modules/campaigns/campaign.repository.js'
import * as execRepo from '../../src/modules/campaigns/campaign-execution.repository.js'
import * as repairRepo from '../../src/modules/campaigns/repair.repository.js'
import * as repairService from '../../src/modules/campaigns/repair.service.js'
import { diffSnapshotForMediaRepair } from '../../src/modules/campaigns/repair.snapshot.js'
import { REPAIR_STATUS, ACTIVE_REPAIR_STATUSES, buildRepairRunKey } from '../../src/modules/campaigns/repair.model.js'
import * as mediaRepo from '../../src/modules/media-library/media.repository.js'
import { query } from '../../shared/database/connection.js'

var metaMocks
const mutationCalls = []
function throwingMutation(name) {
  return vi.fn(() => {
    mutationCalls.push(name)
    throw new Error(`Meta mutation attempted: ${name}`)
  })
}
vi.mock('../../shared/services/meta-ads.service.js', async () => {
  const actual = await vi.importActual('../../shared/services/meta-ads.service.js')
  const mocks = {
    ...actual,
    listAccountAds: vi.fn().mockResolvedValue({ rows: [], truncated: false }),
    getObjectStatus: vi.fn().mockResolvedValue({ status: 'ACTIVE', effective_status: 'ACTIVE' }),
    getMetaObject: vi.fn().mockResolvedValue({ id: 'x' }),
    getCampaignStatusesBatch: vi.fn().mockResolvedValue({}),
    getAdAccount: vi.fn().mockResolvedValue({ balance: '10.00', currency: 'INR', account_status: 1, disable_reason: null }),
    createAdCampaign: throwingMutation('createAdCampaign'),
    createAdSet: throwingMutation('createAdSet'),
    createAdCreative: throwingMutation('createAdCreative'),
    createAd: throwingMutation('createAd'),
    deleteAdCampaign: throwingMutation('deleteAdCampaign'),
    deleteAdSet: throwingMutation('deleteAdSet'),
    deleteAdCreative: throwingMutation('deleteAdCreative'),
    deleteAd: throwingMutation('deleteAd'),
    updateAdStatus: throwingMutation('updateAdStatus'),
  }
  metaMocks = mocks
  return mocks
})

const dateTag = Date.now()
let seq = 0
function tag(prefix) {
  seq += 1
  return `${prefix}_${seq}_${generateUuid()}`
}

const ISSUE_2875006 = {
  level: 'AD',
  error_code: 2875006,
  error_summary: 'Media not wide enough',
  error_message: "Media not wide enough: Your ad won't run on Instagram.",
  error_type: 'HARD_ERROR',
}

const ISSUE_OTHER = {
  level: 'AD',
  error_code: 9990001,
  error_summary: 'Some future problem',
  error_message: 'Something new.',
  error_type: 'HARD_ERROR',
}

function missingObjectError(objectId) {
  return new Error(`Graph API GET ${objectId} failed: ${JSON.stringify({ error: { message: '(#100) Object does not exist', code: 100, error_subcode: 33 } })}`)
}

let app
const campaignIds = []

describe('campaign execution repair', () => {
  let client
  let partner

  async function seedPair(suffix) {
    const campaign = await campaignService.createCampaign(client.id, { name: `RepairPair ${suffix}`, type: 'post' })
    campaignIds.push(campaign.id)
    await campaignRepo.createCreative(generateUuid(), campaign.id, { caption: 'repair', mediaUrl: 'https://example.com/r.jpg' })
    await campaignService.saveMetaSettings(client.id, campaign.id, {
      objective: 'OUTCOME_TRAFFIC',
      budgetAmount: 10000,
      targeting: { geo_locations: { countries: ['IN'] } },
      platformPlacement: { publisher_platforms: ['facebook', 'instagram'] },
    })
    const mk = async (ownerId, kind, sfx) => {
      const fb = `fb_rep_${sfx}`
      const adset = `adset_rep_${sfx}`
      const creative = `creative_rep_${sfx}`
      const ad = `ad_rep_${sfx}`
      await campaignRepo.createMetaObject(campaign.id, 'facebook_campaign', fb, null, 'ACTIVE', ownerId)
      await campaignRepo.createMetaObject(campaign.id, 'ad_set', adset, null, 'ACTIVE', ownerId)
      await campaignRepo.createMetaObject(campaign.id, 'ad_creative', creative, null, null, ownerId)
      await campaignRepo.createMetaObject(campaign.id, 'ad', ad, null, 'PAUSED', ownerId)
      const executionId = await execRepo.createExecution({
        campaignId: campaign.id, ownerUserId: ownerId, kind, status: 'creating',
        platformCampaignId: fb, platformAdsetId: adset, platformCreativeId: creative, platformAdId: ad,
      })
      await repoUpsertIssue(executionId, ad, creative, ISSUE_2875006)
      return { executionId, fb, adset, creative, ad }
    }
    const c = await mk(client.id, 'client', `${suffix}_c`)
    const p = await mk(partner.id, 'publisher', `${suffix}_p`)
    await campaignRepo.updateCampaignStatus(campaign.id, 'running')
    return { campaignId: campaign.id, client: c, publisher: p }
  }

  async function repoUpsertIssue(executionId, ad, creative, issue) {
    return campaignRepo.upsertMetaObjectIssue(executionId, {
      objectId: ad,
      creativeId: creative,
      level: issue.level,
      errorCode: String(issue.error_code),
      summary: issue.error_summary,
      message: issue.error_message,
      errorType: issue.error_type,
    })
  }

  async function makeAsset(ownerId, width = 800, height = 600, kind = 'image') {
    return mediaRepo.createMediaAsset(generateUuid(), ownerId, {
      name: `repair-${tag('a')}.png`,
      storagePath: `/uploads/posts/repair-${tag('a')}.png`,
      mimeType: kind === 'image' ? 'image/png' : 'video/mp4',
      mediaKind: kind,
      sizeBytes: 1024,
      width: kind === 'image' ? width : null,
      height: kind === 'image' ? height : null,
    })
  }

  beforeAll(async () => {
    process.env.META_SYSTEM_USER_TOKEN = 'test_system_user_token'
    process.env.META_AD_ACCOUNT_ID = 'act_test_account'
    client = await createTestUser({ email: `repair-${dateTag}@flowx-test.com`, password: 'Test@123', coins: 10000 })
    partner = await createTestUser({ email: `repair-partner-${dateTag}@flowx-test.com`, password: 'Test@123', coins: 10000 })
    const mod = await import('../../app.js')
    app = mod.default
    await query(
      `INSERT INTO app_config (id, config_key, config_value, is_public, description, version)
       VALUES (?, 'campaign_repair_rollout', '"admin_only"', 0, 'test', 1)
       ON DUPLICATE KEY UPDATE config_value = '"admin_only"', version = version + 1`,
      [uuidToBuffer(generateUuid())]
    )
  })

  afterAll(async () => {
    await query("DELETE FROM app_config WHERE config_key = 'campaign_repair_rollout'").catch(() => {})
    await query("DELETE FROM campaign_jobs WHERE job_type = 'execution_repair'").catch(() => {})
    for (const id of campaignIds) {
      await query('DELETE FROM campaigns WHERE id = ?', [uuidToBuffer(id)]).catch(() => {})
    }
  })

  describe('repair creation', () => {
    it('1. creates a repair for a valid issue with a deterministic run key', async () => {
      const seed = await seedPair(tag('s'))
      const asset = await makeAsset(client.id)
      const result = await repairService.requestRepair({
        campaignId: seed.campaignId, executionId: seed.client.executionId, actorId: null, mediaAssetId: asset.id,
      })
      expect(result.queued).toBe(true)
      expect(result.duplicate).toBe(false)
      expect(result.repair.status).toBe(REPAIR_STATUS.PENDING)
      expect(result.repair.objectId).toBe(seed.client.ad)
      expect(result.repair.errorCode).toBe('2875006')
      expect(result.repair.mediaWidth).toBe(800)
      expect(result.runKey).toBe(buildRepairRunKey(result.repair.id))
      expect(result.runKey.startsWith('repair:')).toBe(true)
      const jobs = await query(
        'SELECT id, status, payload FROM campaign_jobs WHERE job_type = ? AND run_key = ?',
        ['execution_repair', result.runKey]
      )
      expect(jobs).toHaveLength(1)
      expect(JSON.parse(jobs[0].payload).repairId).toBe(result.repair.id)
    })

    it('2. duplicate same-issue requests return the same repair without new rows or jobs', async () => {
      const seed = await seedPair(tag('s'))
      const asset = await makeAsset(client.id)
      const first = await repairService.requestRepair({
        campaignId: seed.campaignId, executionId: seed.client.executionId, actorId: null, mediaAssetId: asset.id,
      })
      const jobsBefore = await query('SELECT COUNT(*) AS n FROM campaign_jobs WHERE run_key = ?', [first.runKey])
      const second = await repairService.requestRepair({
        campaignId: seed.campaignId, executionId: seed.client.executionId, actorId: null, mediaAssetId: asset.id,
      })
      expect(second.duplicate).toBe(true)
      expect(second.queued).toBe(false)
      expect(second.repair.id).toBe(first.repair.id)
      expect(second.runKey).toBe(first.runKey)
      const rows = await repairRepo.listRepairsForExecution(seed.client.executionId)
      expect(rows).toHaveLength(1)
      const jobsAfter = await query('SELECT COUNT(*) AS n FROM campaign_jobs WHERE run_key = ?', [first.runKey])
      expect(Number(jobsAfter[0].n)).toBe(Number(jobsBefore[0].n))
    })

    it('3/16. client and publisher repairs for the same code are independent', async () => {
      const seed = await seedPair(tag('s'))
      const clientAsset = await makeAsset(client.id)
      const publisherAsset = await makeAsset(partner.id)
      const c = await repairService.requestRepair({
        campaignId: seed.campaignId, executionId: seed.client.executionId, actorId: null, mediaAssetId: clientAsset.id,
      })
      const p = await repairService.requestRepair({
        campaignId: seed.campaignId, executionId: seed.publisher.executionId, actorId: null, mediaAssetId: publisherAsset.id,
      })
      expect(c.repair.id).not.toBe(p.repair.id)
      expect(c.runKey).not.toBe(p.runKey)
      expect(c.repair.objectId).toBe(seed.client.ad)
      expect(p.repair.objectId).toBe(seed.publisher.ad)
    })

    it('4. rejects unauthorized callers at the admin endpoint', async () => {
      const seed = await seedPair(tag('s'))
      const asset = await makeAsset(client.id)
      const clientToken = await loginAgent(app, `repair-${dateTag}@flowx-test.com`, 'Test@123')
      const res = await supertest(app)
        .post(`/api/v1/admin/campaigns/${seed.campaignId}/executions/${seed.client.executionId}/repairs`)
        .set('Authorization', `Bearer ${clientToken}`)
        .send({ mediaAssetId: asset.id })
      expect(res.status).toBe(403)
      const anon = await supertest(app)
        .post(`/api/v1/admin/campaigns/${seed.campaignId}/executions/${seed.client.executionId}/repairs`)
        .send({ mediaAssetId: asset.id })
      expect(anon.status).toBe(401)
    })

    it('4b. accepts an admin caller with 202 and the repair contract', async () => {
      const seed = await seedPair(tag('s'))
      const asset = await makeAsset(client.id)
      const adminToken = await loginAgent(app, 'admin@flowx.com', 'Admin@123')
      const res = await supertest(app)
        .post(`/api/v1/admin/campaigns/${seed.campaignId}/executions/${seed.client.executionId}/repairs`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ mediaAssetId: asset.id })
      expect(res.status).toBe(202)
      expect(res.body.data).toMatchObject({ status: 'pending', queued: true })
      expect(res.body.data.repairId).toBeTruthy()
      expect(res.body.data.runKey).toMatch(/^repair:/)
    })

    it('5. rejects mismatched and missing execution scope', async () => {
      const seed = await seedPair(tag('s'))
      const other = await seedPair(tag('s'))
      const asset = await makeAsset(client.id)
      await expect(repairService.requestRepair({
        campaignId: other.campaignId, executionId: seed.client.executionId, actorId: null, mediaAssetId: asset.id,
      })).rejects.toThrow(/does not belong/i)
      await expect(repairService.requestRepair({
        campaignId: seed.campaignId, executionId: generateUuid(), actorId: null, mediaAssetId: asset.id,
      })).rejects.toThrow(/execution not found/i)
    })

    it('6. rejects unsupported issue categories without fabricating remediation', async () => {
      const seed = await seedPair(tag('s'))
      await campaignRepo.deactivateMissingMetaObjectIssues(seed.client.executionId, seed.client.ad, [])
      await repoUpsertIssue(seed.client.executionId, seed.client.ad, seed.client.creative, ISSUE_OTHER)
      const asset = await makeAsset(client.id)
      await expect(repairService.requestRepair({
        campaignId: seed.campaignId, executionId: seed.client.executionId, actorId: null, mediaAssetId: asset.id,
      })).rejects.toThrow(/not repairable/i)
    })

    it('7. rejects invalid media before any worker runs', async () => {
      const seed = await seedPair(tag('s'))
      await expect(repairService.requestRepair({
        campaignId: seed.campaignId, executionId: seed.client.executionId, actorId: null, mediaAssetId: generateUuid(),
      })).rejects.toThrow(/not found/i)
      const foreign = await makeAsset(partner.id)
      await expect(repairService.requestRepair({
        campaignId: seed.campaignId, executionId: seed.client.executionId, actorId: null, mediaAssetId: foreign.id,
      })).rejects.toThrow(/must belong to the execution owner/i)
      const video = await makeAsset(client.id, null, null, 'video')
      await expect(repairService.requestRepair({
        campaignId: seed.campaignId, executionId: seed.client.executionId, actorId: null, mediaAssetId: video.id,
      })).rejects.toThrow(/could not determine.*dimensions/i)
      const nodims = await mediaRepo.createMediaAsset(generateUuid(), client.id, {
        name: 'nodims.png', storagePath: '/uploads/posts/nodims.png', mimeType: 'image/png', mediaKind: 'image', sizeBytes: 10, width: null, height: null,
      })
      await expect(repairService.requestRepair({
        campaignId: seed.campaignId, executionId: seed.client.executionId, actorId: null, mediaAssetId: nodims.id,
      })).rejects.toThrow(/could not determine.*dimensions/i)
      const small = await makeAsset(client.id, 400, 400)
      await expect(repairService.requestRepair({
        campaignId: seed.campaignId, executionId: seed.client.executionId, actorId: null, mediaAssetId: small.id,
      })).rejects.toThrow(/500px/)
      expect(await repairRepo.listRepairsForExecution(seed.client.executionId)).toHaveLength(0)
    })
  })

  describe('state machine', () => {
    it('8/9. guarded transitions succeed on the current state and reject stale ones', async () => {
      const seed = await seedPair(tag('s'))
      const asset = await makeAsset(client.id)
      const { repair } = await repairService.requestRepair({
        campaignId: seed.campaignId, executionId: seed.client.executionId, actorId: null, mediaAssetId: asset.id,
      })
      expect(await repairRepo.updateRepairState(repair.id, ['superseded'], 'failed')).toBe(0)
      expect(await repairRepo.updateRepairState(repair.id, ['pending'], 'failed')).toBe(1)
      expect((await repairRepo.findRepairById(repair.id)).status).toBe('failed')
      expect(await repairRepo.updateRepairState(repair.id, ['pending'], 'ready_for_creation')).toBe(0)
    })

    it('10. concurrent transitions have exactly one winner', async () => {
      const seed = await seedPair(tag('s'))
      const asset = await makeAsset(client.id)
      const { repair } = await repairService.requestRepair({
        campaignId: seed.campaignId, executionId: seed.client.executionId, actorId: null, mediaAssetId: asset.id,
      })
      const outcomes = await Promise.all(
        Array.from({ length: 8 }, () => repairRepo.updateRepairState(repair.id, ['pending'], 'failed'))
      )
      expect(outcomes.reduce((sum, n) => sum + n, 0)).toBe(1)
    })

    it('11. FAILED repairs accept a fresh repair via re-arm on the same row', async () => {
      const seed = await seedPair(tag('s'))
      const asset = await makeAsset(client.id)
      const first = await repairService.requestRepair({
        campaignId: seed.campaignId, executionId: seed.client.executionId, actorId: null, mediaAssetId: asset.id,
      })
      await repairRepo.updateRepairState(first.repair.id, ['pending'], 'failed')
      const second = await repairService.requestRepair({
        campaignId: seed.campaignId, executionId: seed.client.executionId, actorId: null, mediaAssetId: asset.id,
      })
      expect(second.rearmed).toBe(true)
      expect(second.repair.id).toBe(first.repair.id)
      expect(second.repair.status).toBe('pending')
      expect(second.repair.attempts).toBe(0)
      expect(await repairRepo.listRepairsForExecution(seed.client.executionId)).toHaveLength(1)
    })

    it('12. UNKNOWN repairs neither duplicate nor blindly restart', async () => {
      const seed = await seedPair(tag('s'))
      const asset = await makeAsset(client.id)
      const first = await repairService.requestRepair({
        campaignId: seed.campaignId, executionId: seed.client.executionId, actorId: null, mediaAssetId: asset.id,
      })
      await repairRepo.updateRepairState(first.repair.id, ['pending'], 'unknown')
      const second = await repairService.requestRepair({
        campaignId: seed.campaignId, executionId: seed.client.executionId, actorId: null, mediaAssetId: asset.id,
      })
      expect(second.duplicate).toBe(true)
      expect(second.repair.id).toBe(first.repair.id)
      const out = await repairService.runRepairJob(first.repair.id)
      expect(out).toMatchObject({ done: true, ignored: 'repair-status-unknown' })
      expect((await repairRepo.findRepairById(first.repair.id)).status).toBe('unknown')
    })

    it('13. completed repairs are not replay-duplicated; cleared issues reject re-entry', async () => {
      const seed = await seedPair(tag('s'))
      const asset = await makeAsset(client.id)
      const first = await repairService.requestRepair({
        campaignId: seed.campaignId, executionId: seed.client.executionId, actorId: null, mediaAssetId: asset.id,
      })
      await repairRepo.updateRepairState(first.repair.id, ['pending'], 'completed')
      const second = await repairService.requestRepair({
        campaignId: seed.campaignId, executionId: seed.client.executionId, actorId: null, mediaAssetId: asset.id,
      })
      expect(second.repair.id).toBe(first.repair.id)
      expect(await repairRepo.listRepairsForExecution(seed.client.executionId)).toHaveLength(1)
      await campaignRepo.deactivateMissingMetaObjectIssues(seed.client.executionId, seed.client.ad, [])
      await expect(repairService.requestRepair({
        campaignId: seed.campaignId, executionId: seed.client.executionId, actorId: null, mediaAssetId: asset.id,
      })).rejects.toThrow(/no active meta issue/i)
    })
  })

  describe('concurrency', () => {
    it('14. concurrent requests on one execution converge on a single active repair', async () => {
      const seed = await seedPair(tag('s'))
      const asset = await makeAsset(client.id)
      const results = await Promise.all(
        Array.from({ length: 6 }, () => repairService.requestRepair({
          campaignId: seed.campaignId, executionId: seed.client.executionId, actorId: null, mediaAssetId: asset.id,
        }).catch((err) => ({ error: err.message })))
      )
      const ids = new Set(results.filter((r) => !r.error).map((r) => r.repair.id))
      expect(ids.size).toBe(1)
      expect(await repairRepo.listRepairsForExecution(seed.client.executionId)).toHaveLength(1)
    })

    it('15. different executions on one campaign repair independently', async () => {
      const seed = await seedPair(tag('s'))
      const clientAsset = await makeAsset(client.id)
      const publisherAsset = await makeAsset(partner.id)
      const [c, p] = await Promise.all([
        repairService.requestRepair({
          campaignId: seed.campaignId, executionId: seed.client.executionId, actorId: null, mediaAssetId: clientAsset.id,
        }),
        repairService.requestRepair({
          campaignId: seed.campaignId, executionId: seed.publisher.executionId, actorId: null, mediaAssetId: publisherAsset.id,
        }),
      ])
      expect(c.repair.id).not.toBe(p.repair.id)
      expect(c.queued).toBe(true)
      expect(p.queued).toBe(true)
      const cJobs = await query('SELECT id FROM campaign_jobs WHERE run_key = ?', [c.runKey])
      const pJobs = await query('SELECT id FROM campaign_jobs WHERE run_key = ?', [p.runKey])
      expect(cJobs).toHaveLength(1)
      expect(pJobs).toHaveLength(1)
    })
  })

  describe('issue preflight', () => {
    it('17/39. active issue advances to READY_FOR_CREATION via a read-only GET', async () => {
      const seed = await seedPair(tag('s'))
      const asset = await makeAsset(client.id)
      const { repair } = await repairService.requestRepair({
        campaignId: seed.campaignId, executionId: seed.client.executionId, actorId: null, mediaAssetId: asset.id,
      })
      metaMocks.getObjectStatus.mockClear()
      metaMocks.getObjectStatus.mockResolvedValue({
        status: 'PAUSED', effective_status: 'WITH_ISSUES', issues_info: [ISSUE_2875006],
      })
      const out = await repairService.runRepairJob(repair.id)
      expect(out).toMatchObject({ done: true, state: 'ready_for_creation' })
      const after = await repairRepo.findRepairById(repair.id)
      expect(after.status).toBe('ready_for_creation')
      expect(after.attempts).toBe(1)
      expect(metaMocks.getObjectStatus).toHaveBeenCalled()
      expect(metaMocks.getObjectStatus.mock.calls[0][0]).toBe(seed.client.ad)
      metaMocks.getObjectStatus.mockResolvedValue({ status: 'ACTIVE', effective_status: 'ACTIVE' })
    })

    it('18. cleared issue supersedes with zero mutations', async () => {
      const seed = await seedPair(tag('s'))
      const asset = await makeAsset(client.id)
      const { repair } = await repairService.requestRepair({
        campaignId: seed.campaignId, executionId: seed.client.executionId, actorId: null, mediaAssetId: asset.id,
      })
      const objectsBefore = await query('SELECT COUNT(*) AS n FROM campaign_meta_objects WHERE campaign_id = ?', [uuidToBuffer(seed.campaignId)])
      const gensBefore = await query(
        'SELECT COUNT(*) AS n FROM campaign_execution_generations g JOIN campaign_executions e ON e.id = g.campaign_execution_id WHERE e.campaign_id = ?',
        [uuidToBuffer(seed.campaignId)]
      )
      metaMocks.getObjectStatus.mockResolvedValue({ status: 'ACTIVE', effective_status: 'ACTIVE' })
      const out = await repairService.runRepairJob(repair.id)
      expect(out).toMatchObject({ done: true, state: 'superseded' })
      expect((await repairRepo.findRepairById(repair.id)).status).toBe('superseded')
      expect(await query('SELECT COUNT(*) AS n FROM campaign_meta_objects WHERE campaign_id = ?', [uuidToBuffer(seed.campaignId)])).toEqual(objectsBefore)
      expect(await query(
        'SELECT COUNT(*) AS n FROM campaign_execution_generations g JOIN campaign_executions e ON e.id = g.campaign_execution_id WHERE e.campaign_id = ?',
        [uuidToBuffer(seed.campaignId)]
      )).toEqual(gensBefore)
    })

    it('19. missing target ad becomes UNKNOWN for reconciliation', async () => {
      const seed = await seedPair(tag('s'))
      const asset = await makeAsset(client.id)
      const { repair } = await repairService.requestRepair({
        campaignId: seed.campaignId, executionId: seed.client.executionId, actorId: null, mediaAssetId: asset.id,
      })
      metaMocks.getObjectStatus.mockRejectedValueOnce(missingObjectError(seed.client.ad))
      const out = await repairService.runRepairJob(repair.id)
      expect(out).toMatchObject({ done: true, state: 'unknown' })
      expect((await repairRepo.findRepairById(repair.id)).status).toBe('unknown')
      metaMocks.getObjectStatus.mockResolvedValue({ status: 'ACTIVE', effective_status: 'ACTIVE' })
      metaMocks.getMetaObject.mockResolvedValue({ id: 'x' })
    })

    it('20. changed issue supersedes without stale assumptions', async () => {
      const seed = await seedPair(tag('s'))
      const asset = await makeAsset(client.id)
      const { repair } = await repairService.requestRepair({
        campaignId: seed.campaignId, executionId: seed.client.executionId, actorId: null, mediaAssetId: asset.id,
      })
      metaMocks.getObjectStatus.mockResolvedValue({
        status: 'PAUSED', effective_status: 'WITH_ISSUES', issues_info: [ISSUE_OTHER],
      })
      const out = await repairService.runRepairJob(repair.id)
      expect(out).toMatchObject({ done: true, state: 'superseded' })
      const after = await repairRepo.findRepairById(repair.id)
      expect(after.status).toBe('superseded')
      expect(after.error).toMatch(/9990001/)
      metaMocks.getObjectStatus.mockResolvedValue({ status: 'ACTIVE', effective_status: 'ACTIVE' })
    })

    it('23. timeouts throw transiently so the job backs off instead of recreating', async () => {
      const seed = await seedPair(tag('s'))
      const asset = await makeAsset(client.id)
      const { repair } = await repairService.requestRepair({
        campaignId: seed.campaignId, executionId: seed.client.executionId, actorId: null, mediaAssetId: asset.id,
      })
      metaMocks.getObjectStatus.mockRejectedValueOnce(new Error('socket hang up'))
      metaMocks.getMetaObject.mockRejectedValueOnce(new Error('socket hang up'))
      await expect(repairService.runRepairJob(repair.id)).rejects.toThrow(/preflight read failed/i)
      expect((await repairRepo.findRepairById(repair.id)).status).toBe('pending')
      metaMocks.getObjectStatus.mockResolvedValue({ status: 'ACTIVE', effective_status: 'ACTIVE' })
      metaMocks.getMetaObject.mockResolvedValue({ id: 'x' })
    })
  })

  describe('exact-ID reconciliation', () => {
    it('21. existing exact ID is adopted as present without creating anything', async () => {
      metaMocks.getMetaObject.mockResolvedValueOnce({ id: 'ad_exact_1', status: 'PAUSED', effective_status: 'WITH_ISSUES' })
      const probe = await repairService.reconcileExactMetaObject('ad_exact_1', 'token')
      expect(probe.outcome).toBe('present')
      expect(metaMocks.getMetaObject.mock.calls.at(-1)[0]).toBe('ad_exact_1')
    })

    it('22. missing exact ID classifies as missing', async () => {
      metaMocks.getMetaObject.mockRejectedValueOnce(missingObjectError('ad_gone_1'))
      const probe = await repairService.reconcileExactMetaObject('ad_gone_1', 'token')
      expect(probe).toMatchObject({ outcome: 'missing' })
    })

    it('24. identity is exact-ID only — no sibling listing is consulted', async () => {
      metaMocks.getMetaObject.mockResolvedValueOnce({ id: 'ad_target' })
      await repairService.reconcileExactMetaObject('ad_target', 'token')
      expect(metaMocks.listAccountAds).not.toHaveBeenCalled()
      const calls = metaMocks.getMetaObject.mock.calls.filter((c) => c[0] === 'ad_target')
      expect(calls.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('snapshot diff-guard', () => {
    const frozen = () => ({
      campaign: { id: 'c1', name: 'N', scheduledAt: null },
      creative: { caption: 'cap', textBody: null, mediaUrl: 'https://example.com/old.png', callToAction: null, headline: null, description: null, utmSource: null, utmMedium: null, utmCampaign: null, utmContent: null, utmTerm: null },
      settings: { budgetAmount: 100, budgetType: 'daily', bidStrategy: null, optimizationGoal: null, billingEvent: null, spendCap: null, endTime: null, targeting: { geo_locations: { countries: ['IN'] } }, platformPlacement: { publisher_platforms: ['facebook', 'instagram'] }, objective: 'OUTCOME_TRAFFIC' },
    })

    it('25/33. media-only change is accepted with a deterministic recalculated hash', async () => {
      const amendment = { mediaUrl: 'https://example.com/new.png' }
      const args = () => ({ frozenConfig: frozen(), liveConfig: frozen(), amendment })
      const first = diffSnapshotForMediaRepair(args())
      const second = diffSnapshotForMediaRepair(args())
      expect(first.ok).toBe(true)
      expect(first.config.creative.mediaUrl).toBe('https://example.com/new.png')
      expect(first.hash).toBe(second.hash)
      const { hashConfig } = await import('../../shared/services/snapshot.js')
      expect(first.hash).not.toBe(hashConfig({ config: frozen(), graphVersion: first.graphVersion }))
    })

    it('26-29. live drift outside the media field fails closed naming the subtree', () => {
      const amendment = { mediaUrl: 'https://example.com/new.png' }
      const drift = (mutate) => {
        const live = frozen()
        mutate(live)
        return diffSnapshotForMediaRepair({ frozenConfig: frozen(), liveConfig: live, amendment })
      }
      expect(drift((live) => { live.settings.targeting = { geo_locations: { countries: ['US'] } } }))
        .toMatchObject({ ok: false, reason: 'drift:settings' })
      expect(drift((live) => { live.settings.platformPlacement = { publisher_platforms: ['facebook'] } }))
        .toMatchObject({ ok: false, reason: 'drift:settings' })
      expect(drift((live) => { live.settings.budgetAmount = 200 }))
        .toMatchObject({ ok: false, reason: 'drift:settings' })
      expect(drift((live) => { live.settings.objective = 'OUTCOME_SALES' }))
        .toMatchObject({ ok: false, reason: 'drift:settings' })
      expect(drift((live) => { live.creative.caption = 'changed' }))
        .toMatchObject({ ok: false, reason: 'drift:creative' })
      expect(drift((live) => { live.creative.mediaUrl = 'https://example.com/someone-else.png' }))
        .toMatchObject({ ok: false, reason: 'drift:creative' })
      expect(drift((live) => { live.campaign.name = 'Other' }))
        .toMatchObject({ ok: false, reason: 'drift:campaign' })
    })

    it('30/31. page and account stay out of the snapshot by construction', () => {
      const out = diffSnapshotForMediaRepair({ frozenConfig: frozen(), liveConfig: frozen(), amendment: { mediaUrl: 'https://example.com/new.png' } })
      expect(out.ok).toBe(true)
      expect(out.config).not.toHaveProperty('pageId')
      expect(out.config).not.toHaveProperty('adAccountId')
      expect(JSON.stringify(out.config)).not.toMatch(/977503895454587|1390021406359848/)
    })

    it('32. stamps the live graph version, never a stale one', async () => {
      const out = diffSnapshotForMediaRepair({ frozenConfig: frozen(), liveConfig: frozen(), amendment: { mediaUrl: 'https://example.com/new.png' } })
      const { liveGraphVersion } = await import('../../src/modules/campaigns/campaign-execution.service.js')
      expect(out.ok).toBe(true)
      expect(out.graphVersion).toBe(liveGraphVersion())
    })

    it('rejects missing snapshots, live configs, and amendments', () => {
      expect(diffSnapshotForMediaRepair({ liveConfig: frozen(), amendment: { mediaUrl: 'https://example.com/new.png' } })).toMatchObject({ ok: false, reason: 'missing-frozen-snapshot' })
      expect(diffSnapshotForMediaRepair({ frozenConfig: frozen(), amendment: { mediaUrl: 'https://example.com/new.png' } })).toMatchObject({ ok: false, reason: 'missing-live-config' })
      expect(diffSnapshotForMediaRepair({ frozenConfig: frozen(), liveConfig: frozen(), amendment: {} })).toMatchObject({ ok: false, reason: 'missing-media-amendment' })
    })
  })

  describe('financial fence', () => {
    it('34-36. repair preparation writes no billing data, creates no executions, touches no settlement', async () => {
      const seed = await seedPair(tag('s'))
      const asset = await makeAsset(client.id)
      const billingBefore = await query('SELECT COUNT(*) AS n FROM campaign_billing_entries WHERE campaign_id = ?', [uuidToBuffer(seed.campaignId)])
      const executionsBefore = await query('SELECT COUNT(*) AS n FROM campaign_executions WHERE campaign_id = ?', [uuidToBuffer(seed.campaignId)])
      const campaignBefore = await campaignRepo.findCampaignById(seed.campaignId)
      const created = await repairService.requestRepair({
        campaignId: seed.campaignId, executionId: seed.client.executionId, actorId: null, mediaAssetId: asset.id,
      })
      metaMocks.getObjectStatus.mockResolvedValue({
        status: 'PAUSED', effective_status: 'WITH_ISSUES', issues_info: [ISSUE_2875006],
      })
      await repairService.runRepairJob(created.repair.id)
      expect(await query('SELECT COUNT(*) AS n FROM campaign_billing_entries WHERE campaign_id = ?', [uuidToBuffer(seed.campaignId)])).toEqual(billingBefore)
      expect(await query('SELECT COUNT(*) AS n FROM campaign_executions WHERE campaign_id = ?', [uuidToBuffer(seed.campaignId)])).toEqual(executionsBefore)
      const campaignAfter = await campaignRepo.findCampaignById(seed.campaignId)
      expect(campaignAfter.chargedAdBudgetPaise).toBe(campaignBefore.chargedAdBudgetPaise)
      expect(campaignAfter.settledAt).toBeNull()
      expect(await query("SELECT COUNT(*) AS n FROM campaign_jobs WHERE job_type = 'settle_campaign'")).toEqual(
        await query("SELECT COUNT(*) AS n FROM campaign_jobs WHERE job_type = 'settle_campaign'")
      )
      metaMocks.getObjectStatus.mockResolvedValue({ status: 'ACTIVE', effective_status: 'ACTIVE' })
    })

    it('repair modules never touch financial code paths', () => {
      for (const file of [
        '../../src/modules/campaigns/repair.service.js',
        '../../src/modules/campaigns/repair.repository.js',
        '../../src/modules/campaigns/repair.model.js',
        '../../src/modules/campaigns/repair.snapshot.js',
      ]) {
        const src = fs.readFileSync(new URL(file, import.meta.url), 'utf8')
        expect(src).not.toMatch(/coinService|insertBillingEntry|chargedAdBudgetPaise|claimCampaignSettlement|approveAndGoLive|confirmAndGoLive|consumeExecutionShare|refundExecutionShare|publisher payout|calculateAdBudget/)
      }
    })
  })

  describe('meta mutation safety', () => {
    it('37-38. ready-path worker invokes zero Meta mutation endpoints', async () => {
      mutationCalls.length = 0
      const seed = await seedPair(tag('s'))
      const asset = await makeAsset(client.id)
      const { repair } = await repairService.requestRepair({
        campaignId: seed.campaignId, executionId: seed.client.executionId, actorId: null, mediaAssetId: asset.id,
      })
      metaMocks.getObjectStatus.mockResolvedValue({
        status: 'PAUSED', effective_status: 'WITH_ISSUES', issues_info: [ISSUE_2875006],
      })
      await repairService.runRepairJob(repair.id)
      expect(mutationCalls).toEqual([])
      metaMocks.getObjectStatus.mockResolvedValue({ status: 'ACTIVE', effective_status: 'ACTIVE' })
    })
  })

  describe('A-5 class repairs', () => {
    it('40-44. paired repairs target the right ads with zero Meta or financial side effects', async () => {
      const seed = await seedPair(tag('s'))
      const objectsBefore = await query('SELECT COUNT(*) AS n FROM campaign_meta_objects WHERE campaign_id = ?', [uuidToBuffer(seed.campaignId)])
      const billingBefore = await query('SELECT COUNT(*) AS n FROM campaign_billing_entries WHERE campaign_id = ?', [uuidToBuffer(seed.campaignId)])
      const cAsset = await makeAsset(client.id)
      const pAsset = await makeAsset(partner.id)
      const c = await repairService.requestRepair({
        campaignId: seed.campaignId, executionId: seed.client.executionId, actorId: null, mediaAssetId: cAsset.id,
      })
      const p = await repairService.requestRepair({
        campaignId: seed.campaignId, executionId: seed.publisher.executionId, actorId: null, mediaAssetId: pAsset.id,
      })
      expect(c.repair.objectId).toBe(seed.client.ad)
      expect(p.repair.objectId).toBe(seed.publisher.ad)
      expect(c.repair.creativeId).toBe(seed.client.creative)
      expect(p.repair.creativeId).toBe(seed.publisher.creative)
      metaMocks.getObjectStatus.mockImplementation((adId) => Promise.resolve({
        status: 'PAUSED', effective_status: 'WITH_ISSUES', issues_info: [ISSUE_2875006],
      }))
      await repairService.runRepairJob(c.repair.id)
      await repairService.runRepairJob(p.repair.id)
      expect((await repairRepo.findRepairById(c.repair.id)).status).toBe('ready_for_creation')
      expect((await repairRepo.findRepairById(p.repair.id)).status).toBe('ready_for_creation')
      expect(await query('SELECT COUNT(*) AS n FROM campaign_meta_objects WHERE campaign_id = ?', [uuidToBuffer(seed.campaignId)])).toEqual(objectsBefore)
      expect(await query('SELECT COUNT(*) AS n FROM campaign_billing_entries WHERE campaign_id = ?', [uuidToBuffer(seed.campaignId)])).toEqual(billingBefore)
      const gensAfter = await query(
        'SELECT generation_no FROM campaign_execution_generations g JOIN campaign_executions e ON e.id = g.campaign_execution_id WHERE e.campaign_id = ?',
        [uuidToBuffer(seed.campaignId)]
      )
      expect(gensAfter.map((r) => Number(r.generation_no)).sort()).toEqual([0, 0])
      expect(mutationCalls).toEqual([])
      metaMocks.getObjectStatus.mockResolvedValue({ status: 'ACTIVE', effective_status: 'ACTIVE' })
    })
  })

  describe('repair target resolution', () => {
    it('resolves execution-scoped context without campaign-level signals', async () => {
      const seed = await seedPair(tag('s'))
      const ownerAsset = await makeAsset(partner.id)
      const { repair } = await repairService.requestRepair({
        campaignId: seed.campaignId, executionId: seed.publisher.executionId, actorId: null, mediaAssetId: ownerAsset.id,
      })
      const target = await repairService.resolveRepairTarget(repair.id)
      expect(target.ownerUserId).toBe(partner.id)
      expect(target.kind).toBe('publisher')
      expect(target.adId).toBe(seed.publisher.ad)
      expect(target.creativeId).toBe(seed.publisher.creative)
      expect(target.generation.platformAdId).toBe(seed.publisher.ad)
      await expect(repairService.resolveRepairTarget(generateUuid())).rejects.toThrow(/not found/i)
    })

    it('recovers durable context after a crash without restarting blindly', async () => {
      const seed = await seedPair(tag('s'))
      const asset = await makeAsset(client.id)
      const { repair } = await repairService.requestRepair({
        campaignId: seed.campaignId, executionId: seed.client.executionId, actorId: null, mediaAssetId: asset.id,
      })
      const ctx = await repairService.loadRepairContext(repair.id)
      expect(ctx.repair.id).toBe(repair.id)
      expect(ctx.execution.id).toBe(seed.client.executionId)
      expect(ctx.generation.platformAdId).toBe(seed.client.ad)
      expect(ctx.campaign.id).toBe(seed.campaignId)
      expect(await repairService.loadRepairContext(generateUuid())).toBeNull()
    })
  })
})
