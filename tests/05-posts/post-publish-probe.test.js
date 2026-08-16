import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { generateUuid, uuidToBuffer, bufferToUuid } from '../../shared/utils/uuid.utils.js'
import { encrypt } from '../../shared/utils/crypto.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import * as postService from '../../src/modules/posts/post.service.js'
import * as postRepo from '../../src/modules/posts/post.repository.js'
import { queryOne, query } from '../../shared/database/connection.js'
import { POST_TARGET_PUBLISH_STATE, POST_TARGET_STATUS } from '../../src/modules/posts/post.model.js'

var metaMocks
vi.mock('../../shared/services/meta-ads.service.js', async () => {
  const actual = await vi.importActual('../../shared/services/meta-ads.service.js')
  const mocks = {
    ...actual,
    createPagePhotoPost: vi.fn().mockResolvedValue({ id: 'mock_fb_post_1' }),
    createPageVideoPost: vi.fn().mockResolvedValue({ id: 'mock_fb_video_1' }),
    createFeedPost: vi.fn().mockResolvedValue({ id: 'mock_fb_link_1' }),
    createInstagramMedia: vi.fn().mockResolvedValue({ id: 'mock_ig_container_1' }),
    publishInstagramMedia: vi.fn().mockResolvedValue({ id: 'mock_ig_post_1' }),
    createInstagramStory: vi.fn().mockResolvedValue({ id: 'mock_ig_story_1' }),
    getContainerStatus: vi.fn().mockResolvedValue({ status_code: 'FINISHED' }),
  }
  metaMocks = mocks
  return mocks
})

vi.mock('../../shared/services/media-url.js', () => ({
  mediaFetchOptions: { timeoutMs: 1000, maxRedirects: 5, maxBodyBytes: 1024 * 1024, allowPrivate: false, sizeHeadFallbackRange: true },
  ipv4ToInt: (ip) => ip.split('.').reduce((acc, o) => (acc << 8) | Number(o), 0) >>> 0,
  isBlockedAddress: () => false,
  isPublicHttpUrl: (u) => /^https?:\/\//.test(u || ''),
  resolveMediaHost: vi.fn(),
  inspectMediaSize: vi.fn(),
  fetchBoundedBytes: vi.fn(),
  sanitizeMediaUrl: (u) => u,
}))

vi.mock('../../shared/services/media-probe.js', () => ({
  probeMedia: vi.fn(),
  probeWithFfprobe: vi.fn(),
}))

const dateTag = Date.now()

describe('publish-mode media probing wiring', () => {
  let client, fbAccountId

  beforeAll(async () => {
    client = await createTestUser({ email: `post-probe-client-${dateTag}@flowx-test.com`, password: 'Test@123' })
    const platform = await queryOne("SELECT id FROM platforms WHERE code = ?", ['facebook'])
    const accountId = generateUuid()
    await query(
      `INSERT INTO user_platform_accounts (id, user_id, platform_id, profile_url, platform_user_id,
         platform_username, platform_display_name, token_type,
         access_token, token_expires_at, verification_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'page', ?, DATE_ADD(NOW(), INTERVAL 60 DAY), 'verified')`,
      [
        uuidToBuffer(accountId),
        uuidToBuffer(client.id),
        platform.id,
        'https://fb.com/probe_page',
        'probe_fb_page_1',
        'probe_fb_page_1',
        'Probe Page',
        encrypt('mock_page_token'),
      ]
    )
    fbAccountId = accountId
  })

  beforeEach(() => {
    metaMocks.createPagePhotoPost.mockReset().mockResolvedValue({ id: 'mock_fb_post_1' })
    postService.postMediaProbe.enabled = false
  })

  async function approvedPost(mediaUrl) {
    const post = await postService.createPost(client.id, {
      name: `Probe Post ${generateUuid()}`,
      type: 'post',
      caption: 'Probe me',
      mediaUrl,
      targetAccountIds: [fbAccountId],
    })
    await postService.submitPost(client.id, post.id)
    const adminRow = await queryOne("SELECT id FROM users WHERE email = 'admin@flowx.com'")
    await postService.approvePost(bufferToUuid(adminRow.id), post.id, {})
    return post.id
  }

  it('marks targets permanently failed when the media probe reports invalid content', async () => {
    const { resolveMediaHost, inspectMediaSize, fetchBoundedBytes } = await import('../../shared/services/media-url.js')
    const { probeMedia } = await import('../../shared/services/media-probe.js')
    resolveMediaHost.mockResolvedValue({ hostname: 'cdn.example.com', addresses: ['93.184.216.34'], blocked: [] })
    inspectMediaSize.mockResolvedValue({ status: 'KNOWN_VALID', sizeBytes: 1000, contentType: 'image/jpeg' })
    fetchBoundedBytes.mockResolvedValue({ bytes: Buffer.from('not-really-a-jpeg'), truncated: false, contentType: 'image/jpeg', statusCode: 200 })
    probeMedia.mockReturnValue({ status: 'invalid', kind: null, reason: 'no frame header (SOF)' })

    postService.postMediaProbe.enabled = true
    const postId = await approvedPost('https://cdn.example.com/broken.jpg')
    await postService.publishPostJob(postId)

    const targets = await postRepo.findPostTargetsByPostId(postId)
    expect(targets[0].status).toBe(POST_TARGET_STATUS.FAILED)
    expect(targets[0].publishState).toBe(POST_TARGET_PUBLISH_STATE.PERMANENT_FAILURE)
    expect(targets[0].error).toContain('MEDIA_INVALID')
    expect(metaMocks.createPagePhotoPost).not.toHaveBeenCalled()
  })

  it('blocks media that resolves to a private address (SSRF)', async () => {
    const { resolveMediaHost } = await import('../../shared/services/media-url.js')
    resolveMediaHost.mockResolvedValue({ hostname: '10.0.0.5', addresses: ['10.0.0.5'], blocked: ['10.0.0.5'] })

    postService.postMediaProbe.enabled = true
    const postId = await approvedPost('http://10.0.0.5/secret.jpg')
    await postService.publishPostJob(postId)

    const targets = await postRepo.findPostTargetsByPostId(postId)
    expect(targets[0].status).toBe(POST_TARGET_STATUS.FAILED)
    expect(targets[0].publishState).toBe(POST_TARGET_PUBLISH_STATE.PERMANENT_FAILURE)
    expect(targets[0].error).toContain('MEDIA_SSRF_BLOCKED')
    expect(metaMocks.createPagePhotoPost).not.toHaveBeenCalled()
  })

  it('publishes normally when the probe is valid', async () => {
    const { resolveMediaHost, inspectMediaSize, fetchBoundedBytes } = await import('../../shared/services/media-url.js')
    const { probeMedia } = await import('../../shared/services/media-probe.js')
    resolveMediaHost.mockResolvedValue({ hostname: 'cdn.example.com', addresses: ['93.184.216.34'], blocked: [] })
    inspectMediaSize.mockResolvedValue({ status: 'KNOWN_VALID', sizeBytes: 200000, contentType: 'image/jpeg' })
    fetchBoundedBytes.mockResolvedValue({ bytes: Buffer.from('ffd8ff'), truncated: false, contentType: 'image/jpeg', statusCode: 200 })
    probeMedia.mockReturnValue({ status: 'valid', kind: 'image', mediaType: 'jpeg', width: 1080, height: 1350, aspect: 0.8, orientation: 1, sizeBytes: 200000 })

    postService.postMediaProbe.enabled = true
    const postId = await approvedPost('https://cdn.example.com/ok.jpg')
    await postService.publishPostJob(postId)

    const targets = await postRepo.findPostTargetsByPostId(postId)
    expect(targets[0].status).toBe(POST_TARGET_STATUS.POSTED)
    expect(targets[0].publishState).toBe(POST_TARGET_PUBLISH_STATE.PUBLISHED)
    expect(metaMocks.createPagePhotoPost).toHaveBeenCalledTimes(1)
  })

  it('publishes media larger than the probe cap but within the platform size limit', async () => {
    const { resolveMediaHost, inspectMediaSize, fetchBoundedBytes } = await import('../../shared/services/media-url.js')
    const { probeMedia } = await import('../../shared/services/media-probe.js')
    resolveMediaHost.mockResolvedValue({ hostname: 'cdn.example.com', addresses: ['93.184.216.34'], blocked: [] })
    inspectMediaSize.mockResolvedValue({ status: 'KNOWN_TOO_LARGE', sizeBytes: 6 * 1024 * 1024, contentType: 'image/jpeg' })
    fetchBoundedBytes.mockResolvedValue({ bytes: Buffer.from('ffd8ff'), truncated: true, contentType: 'image/jpeg', statusCode: 200 })
    probeMedia.mockReturnValue({ status: 'valid', kind: 'image', mediaType: 'jpeg', width: 1080, height: 1350, aspect: 0.8, orientation: 1, sizeBytes: 6 * 1024 * 1024 })

    postService.postMediaProbe.enabled = true
    const postId = await approvedPost('https://cdn.example.com/big-but-ok.jpg')
    await postService.publishPostJob(postId)

    const targets = await postRepo.findPostTargetsByPostId(postId)
    expect(targets[0].status).toBe(POST_TARGET_STATUS.POSTED)
    expect(targets[0].publishState).toBe(POST_TARGET_PUBLISH_STATE.PUBLISHED)
    expect(targets[0].error).toBeNull()
    expect(metaMocks.createPagePhotoPost).toHaveBeenCalledTimes(1)
  })

  it('publishes media truncated at the probe cap with unknown size', async () => {
    const { resolveMediaHost, inspectMediaSize, fetchBoundedBytes } = await import('../../shared/services/media-url.js')
    const { probeMedia } = await import('../../shared/services/media-probe.js')
    resolveMediaHost.mockResolvedValue({ hostname: 'cdn.example.com', addresses: ['93.184.216.34'], blocked: [] })
    inspectMediaSize.mockResolvedValue({ status: 'KNOWN_TOO_LARGE', sizeBytes: null, contentType: 'image/jpeg' })
    fetchBoundedBytes.mockResolvedValue({ bytes: Buffer.from('ffd8ff'), truncated: true, contentType: 'image/jpeg', statusCode: 200 })
    probeMedia.mockReturnValue({ status: 'unknown', kind: null })

    postService.postMediaProbe.enabled = true
    const postId = await approvedPost('https://cdn.example.com/unknown-size.jpg')
    await postService.publishPostJob(postId)

    const targets = await postRepo.findPostTargetsByPostId(postId)
    expect(targets[0].status).toBe(POST_TARGET_STATUS.POSTED)
    expect(metaMocks.createPagePhotoPost).toHaveBeenCalledTimes(1)
  })

  it('publishes media with too-small dimensions (validation is non-blocking)', async () => {
    const { resolveMediaHost, inspectMediaSize, fetchBoundedBytes } = await import('../../shared/services/media-url.js')
    const { probeMedia } = await import('../../shared/services/media-probe.js')
    resolveMediaHost.mockResolvedValue({ hostname: 'cdn.example.com', addresses: ['93.184.216.34'], blocked: [] })
    inspectMediaSize.mockResolvedValue({ status: 'KNOWN_VALID', sizeBytes: 1000, contentType: 'video/mp4' })
    fetchBoundedBytes.mockResolvedValue({ bytes: Buffer.from('mp4'), truncated: false, contentType: 'video/mp4', statusCode: 200 })
    probeMedia.mockReturnValue({ status: 'valid', kind: 'video', mediaType: 'mp4', width: 320, height: 480, durationSeconds: 30, codecs: ['avc1'], sizeBytes: 1000 })

    postService.postMediaProbe.enabled = true
    const postId = await approvedPost('https://cdn.example.com/too-small.mp4')
    await postService.publishPostJob(postId)

    const targets = await postRepo.findPostTargetsByPostId(postId)
    expect(targets[0].status).toBe(POST_TARGET_STATUS.POSTED)
    expect(targets[0].publishState).toBe(POST_TARGET_PUBLISH_STATE.PUBLISHED)
    expect(metaMocks.createPageVideoPost).toHaveBeenCalledTimes(1)
  })

  it('does not probe when probing is disabled', async () => {
    const { resolveMediaHost } = await import('../../shared/services/media-url.js')
    resolveMediaHost.mockClear()

    postService.postMediaProbe.enabled = false
    const postId = await approvedPost('https://cdn.example.com/ok.jpg')
    await postService.publishPostJob(postId)

    const targets = await postRepo.findPostTargetsByPostId(postId)
    expect(targets[0].status).toBe(POST_TARGET_STATUS.POSTED)
    expect(resolveMediaHost).not.toHaveBeenCalled()
  })
})
