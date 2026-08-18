import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import { generateUuid, uuidToBuffer, bufferToUuid } from '../../shared/utils/uuid.utils.js'
import { encrypt } from '../../shared/utils/crypto.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import * as postService from '../../src/modules/posts/post.service.js'
import { queryOne, query } from '../../shared/database/connection.js'
import { drainCampaignJobs } from '../../src/modules/campaigns/campaign.jobs.js'
import {
  getContainerStatus,
  deleteInstagramContainer,
  createInstagramStory,
  extractMetaError,
} from '../../shared/services/meta-ads.service.js'

vi.mock('../../shared/utils/api-logger.js', () => ({
  apiFetch: vi.fn(),
  wrapSdkCall: vi.fn((_ctx, fn) => fn()),
  logTiming: vi.fn(),
}))

import { apiFetch } from '../../shared/utils/api-logger.js'

const okJson = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
const failJson = (body, status = 400) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const GRAPH_9004 = {
  error: {
    message: 'Invalid parameter',
    type: 'OAuthException',
    code: 9004,
    error_subcode: 2207052,
    error_user_title: 'Media download has failed',
    error_user_msg: 'Media download has failed. The media URI doesn\'t meet our requirements. Your image could not be fetched from this URI: https://example.com/img.jpg',
  },
}

describe('graph helpers throw tagged errors on non-2xx', () => {
  beforeEach(() => {
    apiFetch.mockReset()
  })

  it('graphPost failure throws with metaHttpStatus/metaErrorCode instead of returning', async () => {
    apiFetch.mockResolvedValueOnce(failJson(GRAPH_9004))
    const err = await createInstagramStory('17841411111111111', 'https://example.com/img.jpg', 'tok').catch(e => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.metaHttpStatus).toBe(400)
    expect(err.metaErrorCode).toBe(9004)
    expect(err.metaErrorSubcode).toBe(2207052)
    expect(err.metaAmbiguous).toBe(false)
    expect(err.message).toContain('9004')
    const meta = extractMetaError(err)
    expect(meta.userMsg).toContain('could not be fetched')
  })

  it('graphGet failure throws with tags instead of returning', async () => {
    apiFetch.mockResolvedValueOnce(failJson({ error: { message: 'Invalid parameter', code: 100, error_user_msg: 'Invalid container' } }))
    const err = await getContainerStatus('17900000000000000', 'tok').catch(e => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.metaHttpStatus).toBe(400)
    expect(err.metaErrorCode).toBe(100)
    expect(err.metaAmbiguous).toBe(false)
    expect(err.message).toContain('Invalid container')
  })

  it('graphDelete failure throws with tags instead of returning', async () => {
    apiFetch.mockResolvedValueOnce(failJson({ error: { message: 'Invalid parameter', code: 100, error_user_msg: 'Cannot delete' } }))
    const err = await deleteInstagramContainer('17900000000000000', 'tok').catch(e => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.metaHttpStatus).toBe(400)
    expect(err.metaErrorCode).toBe(100)
    expect(err.metaAmbiguous).toBe(false)
  })

  it('non-JSON 5xx failures throw as ambiguous with the http status', async () => {
    apiFetch.mockResolvedValueOnce(new Response('Internal Server Error', { status: 500 }))
    const err = await getContainerStatus('17900000000000000', 'tok').catch(e => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.metaHttpStatus).toBe(500)
    expect(err.metaAmbiguous).toBe(true)
    expect(err.metaErrorCode).toBeUndefined()
  })

  it('successful responses still resolve (happy path unchanged)', async () => {
    apiFetch.mockResolvedValueOnce(okJson({ status_code: 'FINISHED', status: 'OK' }))
    const result = await getContainerStatus('17900000000000000', 'tok')
    expect(result.status_code).toBe('FINISHED')
  })
})

describe('publish path turns Graph failures into loud target failures', () => {
  const dateTag = Date.now()
  let client, admin, igAccountId

  async function addIgAccount(userId, { platformUserId, igId }) {
    const platform = await queryOne('SELECT id FROM platforms WHERE code = ?', ['instagram'])
    const accountId = generateUuid()
    await query(
      `INSERT INTO user_platform_accounts (id, user_id, platform_id, profile_url, platform_user_id,
         platform_username, platform_display_name, instagram_business_account_id, token_type,
         access_token, token_expires_at, verification_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'page', ?, DATE_ADD(NOW(), INTERVAL 60 DAY), 'verified')`,
      [
        uuidToBuffer(accountId),
        uuidToBuffer(userId),
        platform.id,
        `https://ig.com/${platformUserId}`,
        platformUserId,
        `user_${platformUserId}`,
        `Display ${platformUserId}`,
        igId,
        encrypt('mock_ig_page_token'),
      ]
    )
    return accountId
  }

  beforeAll(async () => {
    client = await createTestUser({ email: `post-graph-throw-${dateTag}@flowx-test.com`, password: 'Test@123' })
    igAccountId = await addIgAccount(client.id, { platformUserId: 'ig_throw_acct_1', igId: '17841422222222222' })
    const adminRow = await queryOne("SELECT id FROM users WHERE email = 'admin@flowx.com'")
    admin = { id: adminRow ? bufferToUuid(adminRow.id) : null }
  })

  beforeEach(() => {
    postService.postMediaProbe.enabled = false
    apiFetch.mockReset()
    apiFetch.mockResolvedValue(failJson(GRAPH_9004))
  })

  it('9004 media fetch failure marks the IG target failed, never posted, and never calls media_publish', async () => {
    const post = await postService.createPost(client.id, {
      name: `IG story 9004 ${generateUuid()}`,
      type: 'story',
      mediaUrl: 'https://example.com/story.jpg',
      targetAccountIds: [igAccountId],
    })
    await postService.submitPost(client.id, post.id)
    await postService.approvePost(admin.id, post.id, {})
    await expect(drainCampaignJobs({ timeoutMs: 4000, pollMs: 50 })).rejects.toThrow(/timed out/i)

    const detail = await postService.getPost(client.id, post.id)
    const target = detail.targets[0]
    expect(target.status).toBe('failed')
    expect(target.publishState).toBe('permanent_failure')
    expect(target.error).toContain('9004')
    expect(target.metaObjectId).toBeNull()
    expect(apiFetch).toHaveBeenCalledTimes(1)
    expect(apiFetch.mock.calls[0][1].method).toBe('POST')
    expect(apiFetch.mock.calls[0][0]).toContain('/media')

    await query('DELETE FROM campaign_jobs WHERE campaign_id = ?', [uuidToBuffer(post.id)])
  })
})
