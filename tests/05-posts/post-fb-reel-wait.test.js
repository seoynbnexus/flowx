import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  startPageReel,
  uploadPageReelMedia,
  getPageReelStatus,
  finishPageReel,
  resolvePageReelPostId,
  createPageVideoStory,
  fbVideoPoll,
} from '../../shared/services/meta-ads.service.js'

vi.mock('../../shared/utils/api-logger.js', () => ({
  apiFetch: vi.fn(),
  wrapSdkCall: vi.fn((_ctx, fn) => fn()),
  logTiming: vi.fn(),
}))

vi.mock('../../shared/services/media-url.js', () => ({
  fetchBoundedBytes: vi.fn(),
}))

import { apiFetch } from '../../shared/utils/api-logger.js'
import { fetchBoundedBytes } from '../../shared/services/media-url.js'

const okJson = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

async function withFastPolling(fn) {
  const interval = fbVideoPoll.intervalMs
  const timeout = fbVideoPoll.timeoutMs
  const publishTimeout = fbVideoPoll.publishTimeoutMs
  fbVideoPoll.intervalMs = 5
  fbVideoPoll.timeoutMs = 500
  fbVideoPoll.publishTimeoutMs = 500
  try {
    return await fn()
  } finally {
    fbVideoPoll.intervalMs = interval
    fbVideoPoll.timeoutMs = timeout
    fbVideoPoll.publishTimeoutMs = publishTimeout
  }
}

function stubGraph() {
  const calls = []
  const statuses = []
  apiFetch.mockImplementation(async (url, options = {}) => {
    calls.push({ url, options })
    const body = typeof options.body === 'string' ? options.body : ''
    if (body.includes('upload_phase=start')) {
      return okJson({ video_id: 'vid_1', upload_url: 'https://rupload.facebook.com/video_1' })
    }
    if (url === 'https://rupload.facebook.com/video_1') {
      return okJson({ success: true })
    }
    if (body.includes('upload_phase=finish')) {
      return okJson({ post_id: 'fb_post_55', success: true })
    }
    const status = statuses.length ? statuses.shift() : { video_status: 'ready' }
    return okJson({ status })
  })
  return { calls, pushStatus: s => statuses.push(s) }
}

describe('facebook reel publish primitives (durable pipeline)', () => {
  beforeEach(() => {
    apiFetch.mockReset()
    fetchBoundedBytes.mockReset()
  })

  it('startPageReel calls START without sending file_url', async () => {
    const { calls } = stubGraph()
    const result = await startPageReel('page_1', 'tok')
    expect(result).toEqual({ video_id: 'vid_1', upload_url: 'https://rupload.facebook.com/video_1' })
    const startCall = calls.find(c => String(c.options.body || '').includes('upload_phase=start'))
    expect(startCall.options.body).toBe('upload_phase=start')
    expect(startCall.options.body).not.toContain('file_url')
    expect(startCall.url).toContain('access_token=tok')
  })

  it('startPageReel throws a tagged error when Meta returns no upload_url', async () => {
    apiFetch.mockImplementation(async () => okJson({ video_id: 'vid_1' }))
    await expect(startPageReel('page_1', 'tok')).rejects.toMatchObject({
      metaAmbiguous: false,
      message: expect.stringContaining('upload_url'),
    })
  })

  it('startPageReel propagates a Meta rejection', async () => {
    apiFetch.mockImplementation(async () => new Response(JSON.stringify({ error: { code: 100, message: 'no page access' } }), { status: 400 }))
    await expect(startPageReel('page_1', 'tok')).rejects.toMatchObject({
      metaHttpStatus: 400,
      metaAmbiguous: false,
      message: expect.stringContaining('no page access'),
    })
  })

  it('uploadPageReelMedia uses the file_url header for the hosted transfer', async () => {
    const uploadCalls = []
    apiFetch.mockImplementation(async (url, options = {}) => {
      uploadCalls.push({ url, headers: options.headers, body: options.body })
      return okJson({ success: true })
    })
    await uploadPageReelMedia('https://rupload.facebook.com/video_1', 'https://cdn.example.com/ree.mp4', 'tok')
    const call = uploadCalls.find(c => c.url === 'https://rupload.facebook.com/video_1')
    expect(call.headers['file_url']).toBe('https://cdn.example.com/ree.mp4')
    expect(call.headers['Authorization']).toBe('OAuth tok')
    expect(call.body).toBeUndefined()
    expect(fetchBoundedBytes).not.toHaveBeenCalled()
  })

  it('uploadPageReelMedia falls back to a binary upload when the hosted transfer is blocked', async () => {
    const uploadCalls = []
    apiFetch.mockImplementation(async (url, options = {}) => {
      uploadCalls.push({ url, headers: options.headers, isBinary: Buffer.isBuffer(options.body) })
      if (url === 'https://rupload.facebook.com/video_1') {
        if (Buffer.isBuffer(options.body)) return okJson({ success: true })
        return new Response(JSON.stringify({ error: { message: 'Unable to fetch media from URL' } }), { status: 422 })
      }
      return okJson({ success: true })
    })
    fetchBoundedBytes.mockResolvedValue({ bytes: Buffer.from('mockmp4'), truncated: false, contentType: 'video/mp4' })

    await uploadPageReelMedia('https://rupload.facebook.com/video_1', 'https://cdn.example.com/ree.mp4', 'tok')

    expect(fetchBoundedBytes).toHaveBeenCalledWith('https://cdn.example.com/ree.mp4', expect.objectContaining({ maxBytes: 512 * 1024 * 1024 }))
    const binaryCall = uploadCalls.find(c => c.isBinary)
    expect(binaryCall).toBeTruthy()
    expect(binaryCall.headers['offset']).toBe('0')
    expect(binaryCall.headers['file_size']).toBe('7')
    expect(binaryCall.headers['Content-Type']).toBe('application/octet-stream')
  })

  it('uploadPageReelMedia rejects with both upload attempts when hosted and binary both fail', async () => {
    apiFetch.mockImplementation(async (url, options = {}) => {
      if (url === 'https://rupload.facebook.com/video_1') {
        return new Response(JSON.stringify({ error: { message: 'blocked' } }), { status: 422 })
      }
      return okJson({ success: true })
    })
    fetchBoundedBytes.mockResolvedValue({ bytes: Buffer.from('mockmp4'), truncated: false })

    await expect(uploadPageReelMedia('https://rupload.facebook.com/video_1', 'https://cdn.example.com/ree.mp4', 'tok'))
      .rejects.toMatchObject({ metaAmbiguous: false, message: expect.stringContaining('hosted') })
  })

  it('getPageReelStatus returns the status object for a video id', async () => {
    apiFetch.mockImplementation(async () => okJson({ status: { video_status: 'ready', processing_phase: { status: 'processing_finished' } } }))
    const status = await getPageReelStatus('vid_1', 'tok')
    expect(status.video_status).toBe('ready')
    expect(status.processing_phase.status).toBe('processing_finished')
  })

  it('finishPageReel sends FINISH with video_state PUBLISHED and the description', async () => {
    const { calls } = stubGraph()
    const result = await finishPageReel('page_1', 'tok', { videoId: 'vid_1', description: 'hello reel' })
    expect(result).toEqual({ post_id: 'fb_post_55', success: true })
    const finishCall = calls.find(c => String(c.options.body || '').includes('upload_phase=finish'))
    expect(finishCall.options.body).toContain('video_state=PUBLISHED')
    expect(finishCall.options.body).toContain('video_id=vid_1')
    expect(finishCall.options.body).toContain('description=hello+reel')
  })

  it('finishPageReel throws when Meta returns an error object', async () => {
    apiFetch.mockImplementation(async () => okJson({ error: { message: 'Reel upload rejected by Meta' } }))
    await expect(finishPageReel('page_1', 'tok', { videoId: 'vid_1', description: 'x' }))
      .rejects.toMatchObject({ metaAmbiguous: false, message: expect.stringContaining('Reel upload rejected by Meta') })
  })

  it('finishPageReel propagates a raw Graph rejection', async () => {
    apiFetch.mockImplementation(async () => new Response(JSON.stringify({ error: { code: 100, message: 'bad' } }), { status: 400 }))
    await expect(finishPageReel('page_1', 'tok', { videoId: 'vid_1', description: 'x' })).rejects.toMatchObject({ metaHttpStatus: 400 })
  })
})

describe('resolvePageReelPostId (correlation-safe FINISH resolution)', () => {
  beforeEach(() => {
    apiFetch.mockReset()
  })

  function stubReels(reels) {
    apiFetch.mockImplementation(async () => okJson({ data: reels }))
  }

  const nowIso = new Date().toISOString()
  const oldIso = new Date(Date.now() - 3600 * 1000).toISOString()

  it('resolves the single reel with an exact description match and fresh updated_time', async () => {
    stubReels([{ id: 'fb_post_1', description: 'exact caption', updated_time: nowIso }])
    const { postId, ambiguous } = await resolvePageReelPostId('page_1', 'tok', {
      message: 'exact caption',
      since: Date.now() - 60000,
    })
    expect(postId).toBe('fb_post_1')
    expect(ambiguous).toBe(false)
  })

  it('returns null (not ambiguous) when no reel matches the description', async () => {
    stubReels([{ id: 'fb_post_1', description: 'other caption', updated_time: nowIso }])
    const { postId, ambiguous } = await resolvePageReelPostId('page_1', 'tok', {
      message: 'exact caption',
      since: Date.now() - 60000,
    })
    expect(postId).toBeNull()
    expect(ambiguous).toBe(false)
  })

  it('returns ambiguous when multiple reels match the exact description', async () => {
    stubReels([
      { id: 'fb_post_1', description: 'exact caption', updated_time: nowIso },
      { id: 'fb_post_2', description: 'exact caption', updated_time: nowIso },
    ])
    const { postId, ambiguous } = await resolvePageReelPostId('page_1', 'tok', {
      message: 'exact caption',
      since: Date.now() - 60000,
    })
    expect(postId).toBeNull()
    expect(ambiguous).toBe(true)
  })

  it('never resolves a reel whose updated_time predates the publish window', async () => {
    stubReels([{ id: 'fb_post_old', description: 'exact caption', updated_time: oldIso }])
    const { postId, ambiguous } = await resolvePageReelPostId('page_1', 'tok', {
      message: 'exact caption',
      since: Date.now() - 60000,
    })
    expect(postId).toBeNull()
    expect(ambiguous).toBe(false)
  })

  it('falls back to any fresh reel when no message is supplied', async () => {
    stubReels([{ id: 'fb_post_any', description: 'anything', updated_time: nowIso }])
    const { postId, ambiguous } = await resolvePageReelPostId('page_1', 'tok', { since: Date.now() - 60000 })
    expect(postId).toBe('fb_post_any')
    expect(ambiguous).toBe(false)
  })
})

describe('createPageVideoStory finishes immediately after upload', () => {
  beforeEach(() => {
    apiFetch.mockReset()
    fetchBoundedBytes.mockReset()
  })

  it('starts, uploads, then finishes the story without polling status first, returning the post_id', async () => {
    const calls = []
    apiFetch.mockImplementation(async (url, options = {}) => {
      calls.push({ url, options })
      const body = typeof options.body === 'string' ? options.body : ''
      if (body.includes('upload_phase=start')) {
        return okJson({ video_id: 'vid_s1', upload_url: 'https://rupload.facebook.com/video_s1' })
      }
      if (url === 'https://rupload.facebook.com/video_s1') return okJson({ success: true })
      if (body.includes('upload_phase=finish')) {
        return okJson({ post_id: 'fb_story_9', success: true })
      }
      return okJson({ status: { video_status: 'ready' } })
    })

    const result = await createPageVideoStory('page_1', 'tok', { url: 'https://cdn.example.com/s.mp4' })

    expect(result).toEqual({ id: 'fb_story_9', videoId: 'vid_s1' })
    const finishIndex = calls.findIndex(c => String(c.options.body || '').includes('upload_phase=finish'))
    expect(finishIndex).toBeGreaterThan(-1)
    const statusPolledBeforeFinish = calls.slice(0, finishIndex).some(c => String(c.url).includes('fields=status'))
    expect(statusPolledBeforeFinish).toBe(false)
    const finishCall = calls[finishIndex]
    expect(finishCall.options.body).toContain('video_state=PUBLISHED')
    expect(finishCall.options.body).toContain('video_id=vid_s1')
  })

  it('waits for the publishing phase after finish when finish returns no post_id', async () => {
    const now = Math.floor(Date.now() / 1000) + 5
    const statuses = [
      { video_status: 'processing', publishing_phase: { publish_status: 'pending' } },
      { video_status: 'processing', publishing_phase: { publish_status: 'published' } },
    ]
    apiFetch.mockImplementation(async (url, options = {}) => {
      const body = typeof options.body === 'string' ? options.body : ''
      if (body.includes('upload_phase=start')) {
        return okJson({ video_id: 'vid_s2', upload_url: 'https://rupload.facebook.com/video_s2' })
      }
      if (url === 'https://rupload.facebook.com/video_s2') return okJson({ success: true })
      if (body.includes('upload_phase=finish')) return okJson({ success: true })
      if (String(url).includes('/page_1/stories')) {
        return okJson({ data: [{ post_id: 'fb_story_resolved', status: 'PUBLISHED', creation_time: now }] })
      }
      return okJson({ status: statuses.length ? statuses.shift() : { video_status: 'ready' } })
    })

    const result = await withFastPolling(() =>
      createPageVideoStory('page_1', 'tok', { url: 'https://cdn.example.com/s.mp4' })
    )

    expect(result.id).toBe('fb_story_resolved')
  })
})
