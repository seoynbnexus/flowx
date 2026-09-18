import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import supertest from 'supertest'
import { query, queryOne } from '../../shared/database/connection.js'
import { generateUuid, uuidToBuffer } from '../../shared/utils/uuid.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import { loginAgent } from '../helpers/auth.js'

vi.mock('../../shared/services/meta-ads.service.js', async () => {
  const actual = await vi.importActual('../../shared/services/meta-ads.service.js')
  return { ...actual, getObjectRemoteState: vi.fn().mockResolvedValue({ state: 'visible' }) }
})

vi.mock('../../shared/services/meta-graph.service.js', async () => {
  const actual = await vi.importActual('../../shared/services/meta-graph.service.js')
  return { ...actual, getFacebookPages: vi.fn().mockResolvedValue([]), getInstagramAccounts: vi.fn().mockResolvedValue([]) }
})

let app
let adminAgent, clientAgent, publisherAgent
let adminId, clientId, publisherId
let postId1, postId2, targetId1, targetId2, targetId3
const pw = 'TestPass123!'

async function cleanup() {
  await query('SET FOREIGN_KEY_CHECKS = 0')
  await query('DELETE FROM campaign_jobs')
  await query('DELETE FROM post_review_log')
  await query('DELETE FROM post_targets')
  await query("DELETE FROM posts WHERE name LIKE 'FlagPost %'")
  await query("DELETE FROM user_platform_accounts WHERE platform_username LIKE 'flag\\_%'")
  await query('SET FOREIGN_KEY_CHECKS = 1')
}

beforeAll(async () => {
  app = (await import('../../app.js')).default
  await cleanup()

  const admin = await createTestUser({ email: `flag_admin_${Date.now()}@test.com`, password: pw, role: 'super_admin' })
  adminId = admin.id
  adminAgent = supertest.agent(app)
  const adminToken = await loginAgent(app, admin.email, pw)
  adminAgent.set('Authorization', `Bearer ${adminToken}`)

  const client = await createTestUser({ email: `flag_client_${Date.now()}@test.com`, password: pw, role: 'client' })
  clientId = client.id
  clientAgent = supertest.agent(app)
  const clientToken = await loginAgent(app, client.email, pw)
  clientAgent.set('Authorization', `Bearer ${clientToken}`)

  const publisher = await createTestUser({ email: `flag_pub_${Date.now()}@test.com`, password: pw, role: 'publisher' })
  publisherId = publisher.id
  publisherAgent = supertest.agent(app)
  const publisherToken = await loginAgent(app, publisher.email, pw)
  publisherAgent.set('Authorization', `Bearer ${publisherToken}`)

  const platformRow = await queryOne('SELECT id FROM platforms WHERE code = ?', ['facebook'])
  const platformRowIg = await queryOne('SELECT id FROM platforms WHERE code = ?', ['instagram'])

  async function makeAccount(slug, userId, platformId) {
    const accId = generateUuid()
    const sql = `INSERT INTO user_platform_accounts (id, user_id, platform_id, profile_url, platform_user_id, platform_username, platform_display_name, token_type, access_token, token_expires_at, verification_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'page', 'tok', DATE_ADD(NOW(), INTERVAL 60 DAY), 'verified')`
    const params = [uuidToBuffer(accId), uuidToBuffer(userId), platformId, `https://x.com/${slug}`, `${slug}_uid`, `${slug}_user`, `${slug} Display`]
    const { getPool } = await import('../../shared/database/connection.js')
    const pool = getPool()
    await pool.query(sql, params)
    return accId
  }

  const account1 = await makeAccount('flag_fb1', clientId, platformRow.id)
  const account2 = await makeAccount('flag_ig1', clientId, platformRowIg.id)
  const account3 = await makeAccount('flag_fb2', clientId, platformRow.id)

  postId1 = generateUuid()
  await query(
    `INSERT INTO posts (id, client_id, name, type, status, boost_enabled, caption, media_url, created_at, updated_at)
     VALUES (?, ?, 'FlagPost 1', 'post', 'completed', 0, 'cap', 'https://example.com/1.jpg', NOW(), NOW())`,
    [uuidToBuffer(postId1), uuidToBuffer(clientId)]
  )
  targetId1 = generateUuid()
  await query(
    `INSERT INTO post_targets (id, post_id, platform_account_id, status, meta_object_id, deletion_review_state, deletion_flagged_at, deletion_reason, created_at)
     VALUES (?, ?, ?, 'posted', 'obj1', 'flagged', NOW() - INTERVAL 2 HOUR, 'Content removed by platform', NOW())`,
    [uuidToBuffer(targetId1), uuidToBuffer(postId1), uuidToBuffer(account1)]
  )

  postId2 = generateUuid()
  await query(
    `INSERT INTO posts (id, client_id, name, type, status, boost_enabled, caption, media_url, created_at, updated_at)
     VALUES (?, ?, 'FlagPost 2', 'post', 'completed', 0, 'cap', 'https://example.com/2.jpg', NOW(), NOW())`,
    [uuidToBuffer(postId2), uuidToBuffer(clientId)]
  )
  targetId2 = generateUuid()
  await query(
    `INSERT INTO post_targets (id, post_id, platform_account_id, status, meta_object_id, deletion_review_state, deletion_flagged_at, deletion_reason, created_at)
     VALUES (?, ?, ?, 'posted', 'obj2', 'flagged', NOW() - INTERVAL 1 HOUR, 'Copyright claim', NOW())`,
    [uuidToBuffer(targetId2), uuidToBuffer(postId2), uuidToBuffer(account2)]
  )
  targetId3 = generateUuid()
  await query(
    `INSERT INTO post_targets (id, post_id, platform_account_id, status, meta_object_id, deletion_review_state, deletion_flagged_at, deletion_confirmed_at, deletion_reason, created_at)
     VALUES (?, ?, ?, 'posted', 'obj3', 'confirmed', NOW() - INTERVAL 3 DAY, NOW() - INTERVAL 1 DAY, 'Repeated violation', NOW())`,
    [uuidToBuffer(targetId3), uuidToBuffer(postId2), uuidToBuffer(account3)]
  )
})

afterAll(async () => {
  await cleanup()
})

describe('Flagged posts listing', () => {
  it('GET /admin/posts/flagged returns flagged posts grouped by post', async () => {
    const res = await adminAgent.get('/api/v1/admin/posts/flagged')
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data.length).toBeGreaterThanOrEqual(2)
    const post1 = res.body.data.find(p => p.postId === postId1)
    expect(post1).toBeDefined()
    expect(post1.flaggedCount).toBe(1)
    expect(post1.confirmedCount).toBe(0)
    expect(post1.latestReason).toBe('Content removed by platform')
    const post2 = res.body.data.find(p => p.postId === postId2)
    expect(post2).toBeDefined()
    expect(post2.flaggedCount).toBe(1)
    expect(post2.confirmedCount).toBe(1)
  })

  it('non-admin gets 403', async () => {
    const res = await clientAgent.get('/api/v1/admin/posts/flagged')
    expect(res.status).toBe(403)
  })
})

describe('Publisher violations', () => {
  it('GET /admin/posts/publishers/:publisherId/violations returns summary', async () => {
    const pubUserId = publisherId
    const platformAccountId = generateUuid()
    const platformRow = await queryOne('SELECT id FROM platforms WHERE code = ?', ['facebook'])
    await query(
      `INSERT INTO user_platform_accounts (id, user_id, platform_id, profile_url, platform_user_id, platform_username, platform_display_name, token_type, access_token, token_expires_at, verification_status)
       VALUES (?, ?, ?, 'https://fb.com/flag_pub', 'flag_pub_uid', 'flag_pub_user', 'Flag Pub', 'page', 'tok', DATE_ADD(NOW(), INTERVAL 60 DAY), 'verified')`,
      [uuidToBuffer(platformAccountId), uuidToBuffer(pubUserId), platformRow.id]
    )
    const pubPostId = generateUuid()
    await query(
      `INSERT INTO posts (id, client_id, name, type, status, boost_enabled, caption, media_url, created_at, updated_at)
       VALUES (?, ?, 'FlagPub Post', 'post', 'completed', 0, 'cap', 'https://example.com/pub.jpg', NOW(), NOW())`,
      [uuidToBuffer(pubPostId), uuidToBuffer(clientId)]
    )
    const pubTargetId = generateUuid()
    await query(
      `INSERT INTO post_targets (id, post_id, platform_account_id, status, meta_object_id, deletion_review_state, deletion_flagged_at, deletion_reason, created_at)
       VALUES (?, ?, ?, 'posted', 'pub_obj', 'flagged', NOW() - INTERVAL 1 HOUR, 'Policy violation', NOW())`,
      [uuidToBuffer(pubTargetId), uuidToBuffer(pubPostId), uuidToBuffer(platformAccountId)]
    )

    const res = await adminAgent.get(`/api/v1/admin/posts/publishers/${pubUserId}/violations`)
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data.targets.length).toBeGreaterThanOrEqual(1)
    expect(res.body.data.totals.totalViolations).toBeGreaterThanOrEqual(1)

    await query('DELETE FROM post_targets WHERE id = ?', [uuidToBuffer(pubTargetId)])
    await query('DELETE FROM posts WHERE id = ?', [uuidToBuffer(pubPostId)])
    await query('DELETE FROM user_platform_accounts WHERE id = ?', [uuidToBuffer(platformAccountId)])
  })
})

describe('Publisher suspension', () => {
  it('suspend + unsuspend + idempotent', async () => {
    const res1 = await adminAgent.post(`/api/v1/admin/posts/publishers/${publisherId}/suspend`)
    expect(res1.status).toBe(200)
    expect(res1.body.data.suspended).toBe(true)
    const user1 = await queryOne('SELECT publisher_suspended FROM users WHERE id = ?', [uuidToBuffer(publisherId)])
    expect(user1.publisher_suspended).toBe(1)

    const res2 = await adminAgent.post(`/api/v1/admin/posts/publishers/${publisherId}/suspend`)
    expect(res2.status).toBe(200)

    const res3 = await adminAgent.post(`/api/v1/admin/posts/publishers/${publisherId}/unsuspend`)
    expect(res3.status).toBe(200)
    expect(res3.body.data.suspended).toBe(false)
    const user2 = await queryOne('SELECT publisher_suspended FROM users WHERE id = ?', [uuidToBuffer(publisherId)])
    expect(user2.publisher_suspended).toBe(0)
  })

  it('non-admin cannot suspend', async () => {
    const res = await clientAgent.post(`/api/v1/admin/posts/publishers/${publisherId}/suspend`)
    expect(res.status).toBe(403)
  })
})

describe('Publisher warning', () => {
  it('sends warning notification', async () => {
    const res = await adminAgent.post(`/api/v1/admin/posts/publishers/${publisherId}/warn`).send({ message: 'Test warning' })
    expect(res.status).toBe(200)
    expect(res.body.data.warned).toBe(true)
    const notif = await queryOne('SELECT * FROM notifications WHERE user_id = ? AND type = ? ORDER BY created_at DESC LIMIT 1', [uuidToBuffer(publisherId), 'violation_warning'])
    expect(notif).not.toBeNull()
    expect(notif.body).toContain('Test warning')
  })
})

describe('Eligibility filter', () => {
  it('suspended publisher not in eligible list', async () => {
    const suspUser = await createTestUser({ email: `flag_elig_${Date.now()}@test.com`, password: pw, role: 'publisher' })
    const pubId = suspUser.id
    const platformRow = await queryOne('SELECT id FROM platforms WHERE code = ?', ['facebook'])
    await query('UPDATE users SET publisher_suspended = 1 WHERE id = ?', [uuidToBuffer(pubId)])
    const accId = generateUuid()
    const { getPool } = await import('../../shared/database/connection.js')
    const pool = getPool()
    await pool.query(
      `INSERT INTO user_platform_accounts (id, user_id, platform_id, profile_url, platform_user_id, platform_username, platform_display_name, token_type, access_token, token_expires_at, verification_status)
       VALUES (?, ?, ?, 'https://fb.com/susp', 'susp_uid', ?, 'Susp Pub', 'page', 'tok', DATE_ADD(NOW(), INTERVAL 60 DAY), 'verified')`,
      [uuidToBuffer(accId), uuidToBuffer(pubId), platformRow.id, `susp_${Date.now()}`]
    )

    const { findEligiblePublishersForPost } = await import('../../src/modules/posts/post.repository.js')
    const eligible = await findEligiblePublishersForPost('facebook', [accId])
    expect(eligible.some(e => e.userId === pubId)).toBe(false)

    await query('DELETE FROM user_platform_accounts WHERE id = ?', [uuidToBuffer(accId)])
    await query('DELETE FROM user_passwords WHERE user_id = ?', [uuidToBuffer(pubId)])
    await query('DELETE FROM user_profiles WHERE user_id = ?', [uuidToBuffer(pubId)])
    await query('DELETE FROM user_roles WHERE user_id = ?', [uuidToBuffer(pubId)])
    await query('DELETE FROM users WHERE id = ?', [uuidToBuffer(pubId)])
  })
})
