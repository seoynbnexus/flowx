import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import supertest from 'supertest'
import { generateUuid, uuidToBuffer } from '../../shared/utils/uuid.utils.js'
import { encrypt } from '../../shared/utils/crypto.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import { loginAgent } from '../helpers/auth.js'
import { query, queryOne } from '../../shared/database/connection.js'
import * as promoRepo from '../../src/modules/posts/promotion.repository.js'
import * as repairRepo from '../../src/modules/posts/promotion-repair.repository.js'
import * as issueCatalog from '../../shared/services/meta-issue-catalog.js'
import { resolveBoostTargetContext, BOOST_GRAPH_VERSION } from '../../shared/services/boost-capabilities.js'

vi.mock('../../shared/services/meta-ads.service.js', async () => {
  const actual = await vi.importActual('../../shared/services/meta-ads.service.js')
  return {
    ...actual,
    getObjectStatus: vi.fn().mockResolvedValue({ status: 'ACTIVE', effective_status: 'ACTIVE', issues_info: [] }),
    getAdStatusesWithIssuesBatch: vi.fn().mockResolvedValue({}),
    createAdCampaign: vi.fn().mockResolvedValue({ id: `mockcampaign_${Date.now()}` }),
    createAdSet: vi.fn().mockResolvedValue({ id: `mockadset_${Date.now()}` }),
    createAdCreativeFromPost: vi.fn().mockResolvedValue({ id: `mockcreative_${Date.now()}` }),
    createAd: vi.fn().mockResolvedValue({ id: `mockad_${Date.now()}` }),
    updateAdStatus: vi.fn().mockResolvedValue({ success: true }),
    deleteAd: vi.fn().mockResolvedValue({ success: true }),
    deleteAdCreative: vi.fn().mockResolvedValue({ success: true }),
  }
})

let app
const dateTag = Date.now()
let idSeq = 0
function nextTestId(prefix) {
  idSeq += 1
  return `${prefix}${Date.now()}${idSeq}`
}

async function adminToken() {
  return loginAgent(app, 'admin@flowx.com', 'Admin@123')
}

async function setFlag(key, value) {
  await query(
    `INSERT INTO app_config (id, config_key, config_value, is_public, description, version)
     VALUES (?, ?, ?, 0, 'test flag', 1)
     ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
    [uuidToBuffer(generateUuid()), key, JSON.stringify(value)]
  )
}

async function insertAccount(userId, platform, slug) {
  const platformRow = await queryOne('SELECT id FROM platforms WHERE code = ?', [platform])
  const platformUserId = nextTestId(`bra_${slug}_`)
  const accountId = generateUuid()
  await query(
    `INSERT INTO user_platform_accounts (id, user_id, platform_id, profile_url, platform_user_id, platform_username, platform_display_name, token_type, access_token, token_expires_at, verification_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'page', ?, DATE_ADD(NOW(), INTERVAL 60 DAY), 'verified')`,
    [uuidToBuffer(accountId), uuidToBuffer(userId), platformRow.id, `https://fb.com/${platformUserId}`, platformUserId, platformUserId, `Display ${platformUserId}`, encrypt('mock_page_token')]
  )
  return accountId
}

async function insertPost(userId, name) {
  const postId = generateUuid()
  await query(
    `INSERT INTO posts (id, client_id, name, type, status, boost_enabled, caption, media_url, created_at, updated_at)
     VALUES (?, ?, ?, 'post', 'completed', 1, 'caption', 'https://example.com/img.jpg', NOW(), NOW())`,
    [uuidToBuffer(postId), uuidToBuffer(userId), name]
  )
  return postId
}

async function insertTarget(postId, accountId) {
  const targetId = generateUuid()
  const objectId = nextTestId('bra_obj_')
  await query(
    `INSERT INTO post_targets (id, post_id, platform_account_id, target_type, status, publish_state, meta_object_id, posted_at, created_at)
     VALUES (?, ?, ?, 'client', 'posted', 'published', ?, NOW(), NOW())`,
    [uuidToBuffer(targetId), uuidToBuffer(postId), uuidToBuffer(accountId), objectId]
  )
  return targetId
}

async function insertActiveBoostTarget(postId, userId, postTargetId) {
  const promotionId = generateUuid()
  await promoRepo.createPromotion(promotionId, postId, userId, {
    status: 'active', budgetType: 'daily', budgetAmount: 500, chargedPaise: 50000,
    endAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  })
  const resolved = resolveBoostTargetContext(
    { geo_locations: { countries: ['IN'] } },
    { publisher_platforms: ['facebook'] },
    { platformCode: 'facebook', postType: 'post', objective: 'OUTCOME_ENGAGEMENT' }
  )
  await promoRepo.updatePromotion(promotionId, {
    resolvedTargeting: { targets: { [postTargetId]: resolved.resolved.targeting }, platforms: { facebook: resolved.resolved.targeting }, objective: resolved.resolved.objective, optimizationGoal: resolved.resolved.optimizationGoal },
    resolvedPlacement: { targets: { [postTargetId]: resolved.resolved.placement }, platforms: { facebook: resolved.resolved.placement } },
    resolvedGraphVersion: BOOST_GRAPH_VERSION,
  })
  const ptgtId = generateUuid()
  await promoRepo.createPromotionTarget(ptgtId, promotionId, postTargetId, 'facebook', null)
  await promoRepo.updatePromotionTarget(ptgtId, {
    status: 'active',
    platformCampaignId: nextTestId('bra_camp_'),
    platformAdsetId: nextTestId('bra_adset_'),
    platformCreativeId: nextTestId('bra_creative_'),
    platformAdId: nextTestId('bra_ad_'),
  })
  return { promotionId, ptgtId }
}

beforeAll(async () => {
  const mod = await import('../../app.js')
  app = mod.default
  await setFlag('boost_repair_rollout', 'admin_only')
  await setFlag('boost_repair_execution_enabled', false)
  await setFlag('boost_repair_killed', false)
})

afterAll(async () => {
  await setFlag('boost_repair_rollout', 'off')
  await setFlag('boost_repair_execution_enabled', false)
  await setFlag('boost_repair_killed', false)
})

describe('boost repair: admin surface', () => {
  it('GET /admin/posts/promotions/:id is reachable (regression — was previously dead/unwired code)', async () => {
    const user = await createTestUser({ email: `bra-reach-${dateTag}@flowx-test.com`, password: 'Test@123' })
    const accountId = await insertAccount(user.id, 'facebook', 'reach')
    const postId = await insertPost(user.id, 'Reach Test')
    const targetId = await insertTarget(postId, accountId)
    const { promotionId, ptgtId } = await insertActiveBoostTarget(postId, user.id, targetId)

    const token = await adminToken()
    const res = await supertest(app)
      .get(`/api/v1/admin/posts/promotions/${promotionId}`)
      .set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body.data.id).toBe(promotionId)
    const target = res.body.data.targets.find((t) => t.id === ptgtId)
    expect(target).toBeTruthy()
    expect(target).toHaveProperty('issues')
    expect(target).toHaveProperty('activeRepair')
  })

  it('rejects a client (non-admin) with 403 on the promotion detail route', async () => {
    const client = await createTestUser({ email: `bra-client-${dateTag}@flowx-test.com`, password: 'Test@123' })
    const accountId = await insertAccount(client.id, 'facebook', 'client')
    const postId = await insertPost(client.id, 'Client Test')
    const targetId = await insertTarget(postId, accountId)
    const { promotionId } = await insertActiveBoostTarget(postId, client.id, targetId)

    const token = await loginAgent(app, `bra-client-${dateTag}@flowx-test.com`, 'Test@123')
    const res = await supertest(app)
      .get(`/api/v1/admin/posts/promotions/${promotionId}`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(403)
  })

  it('GET repair-status returns eligibility reasons for a target with no active issue', async () => {
    const user = await createTestUser({ email: `bra-status-${dateTag}@flowx-test.com`, password: 'Test@123' })
    const accountId = await insertAccount(user.id, 'facebook', 'status')
    const postId = await insertPost(user.id, 'Status Test')
    const targetId = await insertTarget(postId, accountId)
    const { ptgtId } = await insertActiveBoostTarget(postId, user.id, targetId)

    const token = await adminToken()
    const res = await supertest(app)
      .get(`/api/v1/admin/posts/promotions/x/targets/${ptgtId}/repair-status`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.eligible).toBe(false)
    expect(res.body.data.reasons).toContain('no-active-issue')
  })

  it('POST repair requires posts.manage — a role with only posts.review is rejected', async () => {
    const user = await createTestUser({ email: `bra-manage-${dateTag}@flowx-test.com`, password: 'Test@123' })
    const accountId = await insertAccount(user.id, 'facebook', 'manage')
    const postId = await insertPost(user.id, 'Manage Test')
    const targetId = await insertTarget(postId, accountId)
    const { ptgtId } = await insertActiveBoostTarget(postId, user.id, targetId)

    // support_agent role exists in seed with no posts.manage grant.
    const supportAgent = await createTestUser({ email: `bra-support-${dateTag}@flowx-test.com`, password: 'Test@123', role: 'support_agent' })
    const token = await loginAgent(app, `bra-support-${dateTag}@flowx-test.com`, 'Test@123')
    const res = await supertest(app)
      .post(`/api/v1/admin/posts/promotions/x/targets/${ptgtId}/repair`)
      .set('Authorization', `Bearer ${token}`)
      .send({ callToAction: 'SHOP_NOW' })
    expect([401, 403]).toContain(res.status)
  })

  it('POST repair end-to-end via the real HTTP route (admin, category enabled) returns 202 with the queued shape', async () => {
    const TEST_CODE = '999902'
    issueCatalog.VIDEO_DIMENSION_ISSUE_CODES.push(TEST_CODE)
    issueCatalog.BOOST_SUPPORTED_REPAIR_CATEGORIES.push('VIDEO_DIMENSION')
    await setFlag('boost_repair_category_video_dimension', true)
    try {
      const user = await createTestUser({ email: `bra-e2e-${dateTag}@flowx-test.com`, password: 'Test@123' })
      const accountId = await insertAccount(user.id, 'facebook', 'e2e')
      const postId = await insertPost(user.id, 'E2E Test')
      const targetId = await insertTarget(postId, accountId)
      const { ptgtId } = await insertActiveBoostTarget(postId, user.id, targetId)
      const ptgt = await promoRepo.findPromotionTargetById(ptgtId)
      await repairRepo.upsertPromotionTargetIssue(ptgtId, { objectId: ptgt.platformAdId, errorCode: TEST_CODE, level: 'AD', summary: 's', message: 'm', errorType: 'HARD_ERROR' })

      const token = await adminToken()
      const res = await supertest(app)
        .post(`/api/v1/admin/posts/promotions/x/targets/${ptgtId}/repair`)
        .set('Authorization', `Bearer ${token}`)
        .send({ callToAction: 'SHOP_NOW', issueCode: TEST_CODE })

      expect(res.status).toBe(202)
      expect(res.body.data.queued).toBe(true)
      expect(res.body.data.repairId).toBeTruthy()

      const claimed = await promoRepo.findPromotionTargetById(ptgtId)
      expect(claimed.status).toBe('needs_repair')
    } finally {
      issueCatalog.VIDEO_DIMENSION_ISSUE_CODES.length = 0
      issueCatalog.BOOST_SUPPORTED_REPAIR_CATEGORIES.length = 0
      await setFlag('boost_repair_category_video_dimension', false)
    }
  })
})
