import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  extractMetaError,
  createAdCampaign,
  createAdSet,
  createAdCreative,
  createAdCreativeFromInstagramPost,
  createAdCreativeFromPost,
  getConnectedFacebookPage,
  createAd,
  listAccountAds,
  getMediaEngagement,
} from '../../shared/services/meta-ads.service.js'

vi.mock('../../shared/utils/api-logger.js', () => ({
  apiFetch: vi.fn(),
  wrapSdkCall: vi.fn((_ctx, fn) => fn()),
  logTiming: vi.fn(),
}))

import { apiFetch } from '../../shared/utils/api-logger.js'

const okJson = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
const errJson = (code, msg) => new Response(JSON.stringify({ error: { code, message: msg } }), { status: 400, headers: { 'content-type': 'application/json' } })

describe('meta ads validate_only support', () => {
  beforeEach(() => {
    apiFetch.mockReset()
    apiFetch.mockResolvedValue(okJson({ success: true }))
  })

  it('should append execution_options validate_only when createAdCampaign runs in validate mode', async () => {
    await createAdCampaign('act_1', 'C', 'OUTCOME_TRAFFIC', 'PAUSED', 'tok', { spendCap: 500000 }, true)
    expect(apiFetch).toHaveBeenCalledTimes(1)
    const [, options] = apiFetch.mock.calls[0]
    expect(options.body).toContain('execution_options')
    expect(options.body).toContain('validate_only')
  })

  it('should not append execution_options for real createAdCampaign', async () => {
    await createAdCampaign('act_1', 'C', 'OUTCOME_TRAFFIC', 'PAUSED', 'tok', {})
    const [, options] = apiFetch.mock.calls[0]
    expect(options.body).not.toContain('execution_options')
  })

  it('should append execution_options validate_only when createAdSet runs in validate mode', async () => {
    await createAdSet('act_1', 'camp_1', { geo_locations: { countries: ['IN'] } }, { budgetType: 'daily', budgetAmount: 100 }, {}, {}, 'tok', true)
    const [, options] = apiFetch.mock.calls[0]
    expect(options.body).toContain('execution_options')
    expect(options.body).toContain('validate_only')
  })

  it('should place publisher_platforms inside targeting (not top-level) for createAdSet', async () => {
    await createAdSet('act_1', 'camp_1', { geo_locations: { countries: ['IN'] } }, { budgetType: 'daily', budgetAmount: 100 }, {}, { publisherPlatforms: ['instagram'] }, 'tok', false, 'ON_POST')
    const [, options] = apiFetch.mock.calls[0]
    const params = Object.fromEntries(new URLSearchParams(options.body))
    const targeting = JSON.parse(params.targeting)
    expect(targeting.publisher_platforms).toEqual(['instagram'])
    expect(params.publisher_platforms).toBeUndefined()
    expect(params.destination_type).toBe('ON_POST')
  })

  it('should append execution_options validate_only when createAdCreative runs in validate mode', async () => {
    await createAdCreative('act_1', 'page_1', 'msg', 'https://example.com/img.jpg', 'OPEN_LINK', 'tok', { headline: 'H' }, true)
    const [, options] = apiFetch.mock.calls[0]
    expect(options.body).toContain('execution_options')
    expect(options.body).toContain('validate_only')
  })

  it('should send link_data (not video_data) for a plain image/link creative', async () => {
    await createAdCreative('act_1', 'page_1', 'msg', 'https://example.com/img.jpg', 'OPEN_LINK', 'tok', {})
    const [, options] = apiFetch.mock.calls[0]
    const params = Object.fromEntries(new URLSearchParams(options.body))
    const spec = JSON.parse(params.object_story_spec)
    expect(spec.link_data).toBeTruthy()
    expect(spec.link_data.link).toBe('https://example.com/img.jpg')
    expect(spec.video_data).toBeUndefined()
  })

  it('should send link_data.picture for a plain image creative (not just link)', async () => {
    // Regression: "link" is documented as the CTA click-through destination,
    // not a field Meta crawls for a creative image. Relying on link alone
    // produced a live "Please specify the media to run with this ad." error
    // even though a valid, reachable image URL was set — Meta had nothing
    // explicit to use as the ad's picture. "picture" is Meta's documented
    // field for supplying the creative image directly.
    await createAdCreative('act_1', 'page_1', 'msg', 'https://example.com/img.jpg', 'OPEN_LINK', 'tok', {})
    const [, options] = apiFetch.mock.calls[0]
    const params = Object.fromEntries(new URLSearchParams(options.body))
    const spec = JSON.parse(params.object_story_spec)
    expect(spec.link_data.picture).toBe('https://example.com/img.jpg')
  })

  it('should send image_hash instead of picture when extra.imageHash is provided (Meta forbids both)', async () => {
    await createAdCreative('act_1', 'page_1', 'msg', 'https://example.com/img.jpg', 'OPEN_LINK', 'tok', { imageHash: 'abc123hash' })
    const [, options] = apiFetch.mock.calls[0]
    const params = Object.fromEntries(new URLSearchParams(options.body))
    const spec = JSON.parse(params.object_story_spec)
    expect(spec.link_data.image_hash).toBe('abc123hash')
    expect(spec.link_data.picture).toBeUndefined()
  })

  it('should send video_data (not link_data) when extra.video.videoId is provided, even if mediaUrl is also set', async () => {
    // Regression: object_story_spec must never carry both link_data and
    // video_data — Meta treats a raw video URL passed as link_data.link as a
    // webpage to scrape for a link-preview thumbnail (producing a tiny/broken
    // fallback image), which is the root cause of a live "media not wide
    // enough" delivery rejection for otherwise-valid, correctly-sized videos.
    await createAdCreative('act_1', 'page_1', 'msg', 'https://example.com/video.mp4', 'OPEN_LINK', 'tok', { video: { videoId: 'vid_123' } })
    const [, options] = apiFetch.mock.calls[0]
    const params = Object.fromEntries(new URLSearchParams(options.body))
    const spec = JSON.parse(params.object_story_spec)
    expect(spec.video_data).toBeTruthy()
    expect(spec.video_data.video_id).toBe('vid_123')
    expect(spec.link_data).toBeUndefined()
  })

  it('should send video_data with no mediaUrl at all (the campaign video-upload path)', async () => {
    await createAdCreative('act_1', 'page_1', 'msg', null, 'OPEN_LINK', 'tok', { video: { videoId: 'vid_456' } })
    const [, options] = apiFetch.mock.calls[0]
    const params = Object.fromEntries(new URLSearchParams(options.body))
    const spec = JSON.parse(params.object_story_spec)
    expect(spec.video_data.video_id).toBe('vid_456')
    expect(spec.link_data).toBeUndefined()
  })

  it('should append execution_options validate_only when createAd runs in validate mode', async () => {
    await createAd('act_1', 'adset_1', 'creative_1', 'Ad', 'tok', 'PAUSED', {}, true)
    const [, options] = apiFetch.mock.calls[0]
    expect(options.body).toContain('execution_options')
    expect(options.body).toContain('validate_only')
  })

  it('should not append execution_options for real createAd', async () => {
    await createAd('act_1', 'adset_1', 'creative_1', 'Ad', 'tok', 'PAUSED', {})
    const [, options] = apiFetch.mock.calls[0]
    expect(options.body).not.toContain('execution_options')
  })
})

describe('listAccountAds pagination', () => {
  const ad = (i) => ({ id: `120249${String(i).padStart(10, '0')}`, status: 'PAUSED', effective_status: 'PAUSED' })

  it('should mark truncated when a full page is followed by an empty ghost page', async () => {
    const full = { data: Array.from({ length: 100 }, (_, i) => ad(i)), paging: { cursors: { after: 'cursor-2' } } }
    const ghost = { data: [] }
    apiFetch
      .mockResolvedValueOnce(okJson(full))
      .mockResolvedValueOnce(okJson(ghost))
    const result = await listAccountAds('1390021406359848', 'tok')
    expect(result.rows).toHaveLength(100)
    expect(result.truncated).toBe(true)
  })

  it('should NOT mark truncated when a partial page is followed by an empty ghost page', async () => {
    const partial = { data: Array.from({ length: 34 }, (_, i) => ad(i)), paging: { cursors: { after: 'cursor-2' } } }
    const ghost = { data: [] }
    apiFetch
      .mockResolvedValueOnce(okJson(partial))
      .mockResolvedValueOnce(okJson(ghost))
    const result = await listAccountAds('1390021406359848', 'tok')
    expect(result.rows).toHaveLength(34)
    expect(result.truncated).toBe(false)
  })

  it('should NOT mark truncated on a clean multi-page end with a partial last page', async () => {
    const first = { data: Array.from({ length: 100 }, (_, i) => ad(i)), paging: { cursors: { after: 'cursor-2' } } }
    const second = { data: Array.from({ length: 50 }, (_, i) => ad(100 + i)) }
    apiFetch
      .mockResolvedValueOnce(okJson(first))
      .mockResolvedValueOnce(okJson(second))
    const result = await listAccountAds('1390021406359848', 'tok')
    expect(result.rows).toHaveLength(150)
    expect(result.truncated).toBe(false)
  })

  it('should mark truncated when a full page ends without a next cursor', async () => {
    const full = { data: Array.from({ length: 100 }, (_, i) => ad(i)) }
    apiFetch.mockResolvedValueOnce(okJson(full))
    const result = await listAccountAds('1390021406359848', 'tok')
    expect(result.rows).toHaveLength(100)
    expect(result.truncated).toBe(true)
  })
})

describe('extractMetaError', () => {
  it('should parse user message and subcode from thrown Graph error', () => {
    const error = new Error('Graph API POST act_1/adsets failed: {"error":{"message":"Invalid parameter","code":100,"error_subcode":1885272,"error_user_title":"Budget is too low","error_user_msg":"Your ad set budget must be more than ₹95.81 or your ads may not be delivered."}}')
    const parsed = extractMetaError(error)
    expect(parsed.userMsg).toBe('Your ad set budget must be more than ₹95.81 or your ads may not be delivered.')
    expect(parsed.userTitle).toBe('Budget is too low')
    expect(parsed.code).toBe(100)
    expect(parsed.subcode).toBe(1885272)
  })

  it('should return null for errors without embedded Graph JSON', () => {
    expect(extractMetaError(new Error('network error'))).toBeNull()
  })

  it('should return null for non-Error input', () => {
    expect(extractMetaError('plain string')).toBeNull()
  })
})

describe('getFacebookMediaEngagement hybrid token handling', () => {
  const videoObject = {
    id: 'vid1',
    permalink_url: 'https://www.facebook.com/reel/1051217994554694/',
    created_time: '2026-08-19T13:06:30+0000',
    likes: { data: [], summary: { total_count: 5 } },
    comments: { data: [], summary: { total_count: 2 } },
  }
  const postObject = {
    id: '123_page_123',
    permalink_url: 'https://www.facebook.com/reel/1051217994554694/',
    message: 'hello',
    created_time: '2026-08-19T13:06:30+0000',
    likes: { data: [], summary: { total_count: 3 } },
    comments: { data: [], summary: { total_count: 1 } },
    shares: { count: 4 },
  }

  it('falls back to the system token for video insights when the owner token lacks read_insights', async () => {
    process.env.META_SYSTEM_USER_TOKEN = 'sys_token'
    apiFetch.mockReset()
    apiFetch.mockResolvedValueOnce(okJson(videoObject)) // classify video
      .mockResolvedValueOnce(errJson(200, 'read_insights permission missing')) // owner video_insights
      .mockResolvedValueOnce(okJson({ data: [{ name: 'total_video_views', values: [{ value: 340 }] }] })) // sys retry
      .mockResolvedValueOnce(okJson({ data: [] })) // comments
    const result = await getMediaEngagement('vid1', 'owner_token', { platform: 'facebook' })
    expect(result.mediaType).toBe('video')
    expect(result.likeCount).toBe(5)
    expect(result.commentsCount).toBe(2)
    expect(result.insights.views).toBe(340)
    delete process.env.META_SYSTEM_USER_TOKEN
  })

  it('records a base row without metrics when the system-token retry also fails for a post node', async () => {
    process.env.META_SYSTEM_USER_TOKEN = 'sys_token'
    apiFetch.mockReset()
    apiFetch.mockResolvedValueOnce(errJson(100, 'not a video object')) // video fields fail
      .mockResolvedValueOnce(errJson(100, 'not a photo object')) // photo fields fail
      .mockResolvedValueOnce(okJson(postObject)) // post fields succeed
      .mockResolvedValueOnce(errJson(200, 'read_insights permission missing')) // owner post insights
      .mockResolvedValueOnce(errJson(10, 'pages_read_engagement')) // sys retry fails — must not throw
      .mockResolvedValueOnce(okJson({ data: [] })) // comments
    const result = await getMediaEngagement('page_123', 'owner_token', { platform: 'facebook' })
    expect(result.permalink).toBe(postObject.permalink_url)
    expect(result.likeCount).toBe(3)
    expect(result.commentsCount).toBe(1)
    expect(result.insights).toEqual({})
    delete process.env.META_SYSTEM_USER_TOKEN
  })

  it('surfaces the last underlying error when classifying fails for every field set', async () => {
    apiFetch.mockReset()
    apiFetch.mockImplementation(() => Promise.resolve(errJson(12, 'singular statuses API is deprecated')))
    const err = await getMediaEngagement('122122687238927287', 'owner_token', { platform: 'facebook' }).catch(e => e)
    expect(err.message).toMatch(/unsupported Facebook object/)
    expect(err.message).toMatch(/singular statuses API is deprecated/)
  })

  it('fetches story insights with the story metric set for IG stories', async () => {
    apiFetch.mockReset()
    apiFetch.mockResolvedValueOnce(okJson({ media_type: 'IMAGE', timestamp: '2026-08-19T13:06:30+0000', permalink: 'https://instagram.com/stories/x/123/' }))
      .mockResolvedValueOnce(okJson({ data: [
        { name: 'impressions', values: [{ value: 100 }] },
        { name: 'reach', values: [{ value: 80 }] },
        { name: 'views', values: [{ value: 90 }] },
        { name: 'taps_forward', values: [{ value: 12 }] },
        { name: 'taps_back', values: [{ value: 3 }] },
        { name: 'exits', values: [{ value: 7 }] },
        { name: 'replies', values: [{ value: 5 }] },
      ] }))
    const result = await getMediaEngagement('ig_story_1', 'sys_token', { mediaKind: 'story', platform: 'instagram' })
    expect(result.insights.impressions).toBe(100)
    expect(result.insights.reach).toBe(80)
    expect(result.insights.views).toBe(90)
    expect(result.insights.taps_forward).toBe(12)
    expect(result.insights.taps_back).toBe(3)
    expect(result.insights.exits).toBe(7)
    expect(result.insights.replies).toBe(5)
    expect(apiFetch).toHaveBeenCalledTimes(2)
  })

  it('returns a clean base row instead of throwing when IG story insights fail (values under 5)', async () => {
    apiFetch.mockReset()
    apiFetch.mockResolvedValueOnce(okJson({ media_type: 'VIDEO', timestamp: '2026-08-19T13:06:30+0000', permalink: 'https://instagram.com/stories/x/123/' }))
      .mockImplementation(() => Promise.resolve(errJson(100, 'story insights require at least 5 viewers')))
    const result = await getMediaEngagement('ig_story_2', 'sys_token', { mediaKind: 'story', platform: 'instagram' })
    expect(result.permalink).toBe('https://instagram.com/stories/x/123/')
    expect(result.insights).toEqual({})
    expect(result.storyInsightError).toMatch(/at least 5 viewers/)
  })

  it('returns a clean base row instead of throwing when a FB story node is not queryable', async () => {
    apiFetch.mockReset()
    apiFetch.mockImplementation(() => Promise.resolve(errJson(100, 'unsupported get request')))
    const result = await getMediaEngagement('fb_story_1', 'owner_token', { mediaKind: 'story', platform: 'facebook' })
    expect(result.mediaType).toBeNull()
    expect(result.insights).toEqual({})
    expect(result.storyInsightError).toMatch(/unsupported story object/)
  })

  it('still reads FB video story insights via the video node', async () => {
    process.env.META_SYSTEM_USER_TOKEN = 'sys_token'
    apiFetch.mockReset()
    apiFetch.mockResolvedValueOnce(okJson({ id: 'fb_story_video_1', permalink_url: 'https://www.facebook.com/reel/1051217994554694/', created_time: '2026-08-19T13:06:30+0000', likes: { data: [], summary: { total_count: 9 } }, comments: { data: [], summary: { total_count: 2 } } })) // classify video
      .mockResolvedValueOnce(okJson({ data: [{ name: 'total_video_views', values: [{ value: 500 }] }] })) // video_insights
      .mockResolvedValueOnce(okJson({ data: [] })) // comments
    const result = await getMediaEngagement('fb_story_video_1', 'owner_token', { mediaKind: 'story', platform: 'facebook' })
    expect(result.mediaType).toBe('video')
    expect(result.insights.views).toBe(500)
    expect(result.likeCount).toBe(9)
    expect(result.commentsCount).toBe(2)
    expect(result.storyInsightError).toBeUndefined()
    delete process.env.META_SYSTEM_USER_TOKEN
  })

  it('returns a base row without a system-token retry when /insights rejects the metric set (code 100)', async () => {
    process.env.META_SYSTEM_USER_TOKEN = 'sys_token'
    apiFetch.mockReset()
    apiFetch.mockResolvedValueOnce(errJson(100, 'some video fields missing')) // video fields fail
      .mockResolvedValueOnce(errJson(100, 'some photo fields missing')) // photo fields fail
      .mockResolvedValueOnce(okJson(postObject)) // post fields succeed → kind = 'post'
      .mockResolvedValueOnce(errJson(100, '(#100) The value must be a valid insights metric')) // insights: metric unsupported for this object
      .mockResolvedValueOnce(okJson({ data: [{ id: 'c1', message: 'nice', from: { name: 'Bob' }, created_time: '2026-08-19T13:00:00+0000' }] })) // comments still attempted
    const result = await getMediaEngagement('page_123', 'owner_token', { platform: 'facebook' })
    expect(result.mediaType).toBe('post')
    expect(result.permalink).toBe(postObject.permalink_url)
    expect(result.likeCount).toBe(3)
    expect(result.commentsCount).toBe(1)
    expect(result.insights).toEqual({})
    expect(result.insightsUnsupported).toBe(true)
    expect(result.comments).toHaveLength(1)
    expect(result.comments[0].text).toBe('nice')
    delete process.env.META_SYSTEM_USER_TOKEN
  })

  it('makes exactly 5 API calls for the invalid-metric path — no sixth system-token insights request', async () => {
    process.env.META_SYSTEM_USER_TOKEN = 'sys_token'
    apiFetch.mockReset()
    apiFetch.mockResolvedValueOnce(errJson(100, 'some video fields missing')) // 1: video classify fail
      .mockResolvedValueOnce(errJson(100, 'some photo fields missing')) // 2: photo classify fail
      .mockResolvedValueOnce(okJson(postObject)) // 3: post classify success
      .mockResolvedValueOnce(errJson(100, '(#100) The value must be a valid insights metric')) // 4: insights invalid metric
      .mockResolvedValueOnce(okJson({ data: [] })) // 5: comments
    await getMediaEngagement('page_123', 'owner_token', { platform: 'facebook' })
    expect(apiFetch).toHaveBeenCalledTimes(5)
    const insightsUrls = apiFetch.mock.calls.map(c => String(c[0])).filter(u => u.includes('/insights'))
    expect(insightsUrls).toHaveLength(1)
    expect(insightsUrls[0]).toContain('access_token=owner_token')
    delete process.env.META_SYSTEM_USER_TOKEN
  })

  it('returns classifyKind alongside mediaType so the caller can cache the confirmed classification', async () => {
    apiFetch.mockReset()
    apiFetch.mockResolvedValueOnce(errJson(100, 'video fields fail')) // video fails
      .mockResolvedValueOnce(okJson({ id: 'photo1', permalink_url: 'https://facebook.com/photo.php?fbid=1' })) // photo succeeds
      .mockResolvedValueOnce(okJson({ data: [] })) // comments
    const result = await getMediaEngagement('photo1', 'owner_token', { platform: 'facebook' })
    expect(result.mediaType).toBe('photo')
    expect(result.classifyKind).toBe('photo')
  })

  it('a cached knownKind is tried first — a photo target costs exactly one classify call instead of two', async () => {
    apiFetch.mockReset()
    apiFetch.mockResolvedValueOnce(okJson({ id: 'photo1', permalink_url: 'https://facebook.com/photo.php?fbid=1' })) // photo succeeds on the FIRST attempt
      .mockResolvedValueOnce(okJson({ data: [] })) // comments
    const result = await getMediaEngagement('photo1', 'owner_token', { platform: 'facebook', knownKind: 'photo' })
    expect(result.mediaType).toBe('photo')
    // exactly 2 calls total (classify + comments) — no wasted video-fields
    // attempt, unlike the no-hint path which costs a guaranteed-failing
    // video attempt before photo succeeds
    expect(apiFetch).toHaveBeenCalledTimes(2)
    // FB_VIDEO_FIELDS uniquely includes 'length' — its absence here proves
    // the video-fields attempt was skipped, not just that it happened to fail
    const classifyCall = apiFetch.mock.calls[0]
    expect(String(classifyCall[0])).not.toContain('length')
  })

  it('a stale/wrong knownKind self-heals by falling through to the full classify loop', async () => {
    apiFetch.mockReset()
    // knownKind says 'video' but the object is actually a post — the video
    // attempt (tried first per the hint) fails, then photo fails, then post
    // succeeds, exactly like having no hint at all.
    apiFetch.mockResolvedValueOnce(errJson(100, 'not a video')) // hinted video attempt fails
      .mockResolvedValueOnce(errJson(100, 'not a photo')) // photo fails
      .mockResolvedValueOnce(okJson(postObject)) // post succeeds
      .mockResolvedValueOnce(errJson(100, 'insights unsupported'))
      .mockResolvedValueOnce(okJson({ data: [] }))
    const result = await getMediaEngagement('page_123', 'owner_token', { platform: 'facebook', knownKind: 'video' })
    expect(result.mediaType).toBe('post')
    expect(result.classifyKind).toBe('post')
  })
})

describe('createAdCreativeFromInstagramPost minimal-first behavior', () => {
  beforeEach(() => {
    apiFetch.mockReset()
  })

  it('should return validate_only success after exactly one Graph call (never falls through to fallback)', async () => {
    apiFetch.mockResolvedValueOnce(okJson({ success: true }))
    const result = await createAdCreativeFromInstagramPost('act_1', 'ig_media_1', 'ig_actor_1', 'page_1', 'Boost', 'tok', true)
    expect(apiFetch).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ success: true })
    const [url] = apiFetch.mock.calls[0]
    expect(String(url)).toContain('act_act_1/adcreatives')
    const [, options] = apiFetch.mock.calls[0]
    expect(options.body).toContain('source_instagram_media_id')
    expect(options.body).not.toContain('object_story_spec')
    expect(options.body).toContain('validate_only')
  })

  it('should return the created id after exactly one Graph call on real create success', async () => {
    apiFetch.mockResolvedValueOnce(okJson({ id: 'creative_1' }))
    const result = await createAdCreativeFromInstagramPost('act_1', 'ig_media_1', 'ig_actor_1', 'page_1', 'Boost', 'tok', false)
    expect(apiFetch).toHaveBeenCalledTimes(1)
    expect(result.id).toBe('creative_1')
    expect(apiFetch.mock.calls[0][1].body).not.toContain('object_story_spec')
  })

  it('should fall back to object_story_spec only on 1443120 Invalid Page ID rejection', async () => {
    apiFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'Invalid Page ID in object story spec', code: 100, error_subcode: 1443120 } }), { status: 400, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(okJson({ id: 'creative_fb_1' }))
    const result = await createAdCreativeFromInstagramPost('act_1', 'ig_media_1', 'ig_actor_1', 'page_1', 'Boost', 'tok', false)
    expect(apiFetch).toHaveBeenCalledTimes(2)
    expect(result.id).toBe('creative_fb_1')
    const [, fallbackOptions] = apiFetch.mock.calls[1]
    expect(fallbackOptions.body).toContain('object_story_spec')
    expect(fallbackOptions.body).toContain('page_1')
    expect(fallbackOptions.body).toContain('ig_actor_1')
  })

  it('should throw ValidationError when minimal is rejected with 1443120 and no owning page is resolved', async () => {
    apiFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'Invalid Page ID in object story spec', code: 100, error_subcode: 1443120 } }), { status: 400, headers: { 'content-type': 'application/json' } }))
    await expect(createAdCreativeFromInstagramPost('act_1', 'ig_media_1', 'ig_actor_1', null, 'Boost', 'tok', false)).rejects.toThrow('owning Facebook Page')
    expect(apiFetch).toHaveBeenCalledTimes(1)
  })

  it('should propagate non-1443120 errors without fallback', async () => {
    apiFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'Unsupported post type', code: 100, error_subcode: 1487472 } }), { status: 400, headers: { 'content-type': 'application/json' } }))
    await expect(createAdCreativeFromInstagramPost('act_1', 'ig_media_1', 'ig_actor_1', 'page_1', 'Boost', 'tok', false)).rejects.toThrow()
    expect(apiFetch).toHaveBeenCalledTimes(1)
  })

  it('should include call_to_action_type at the top level when provided (minimal path)', async () => {
    apiFetch.mockResolvedValueOnce(okJson({ id: 'creative_1' }))
    await createAdCreativeFromInstagramPost('act_1', 'ig_media_1', 'ig_actor_1', 'page_1', 'Boost', 'tok', false, 'SHOP_NOW')
    expect(apiFetch.mock.calls[0][1].body).toContain('call_to_action_type')
    expect(apiFetch.mock.calls[0][1].body).toContain('SHOP_NOW')
  })

  it('should omit call_to_action_type when not provided', async () => {
    apiFetch.mockResolvedValueOnce(okJson({ id: 'creative_1' }))
    await createAdCreativeFromInstagramPost('act_1', 'ig_media_1', 'ig_actor_1', 'page_1', 'Boost', 'tok', false)
    expect(apiFetch.mock.calls[0][1].body).not.toContain('call_to_action_type')
  })
})

describe('createAdCreativeFromPost call_to_action_type forwarding (existing-post boost, no link/headline/description override)', () => {
  beforeEach(() => {
    apiFetch.mockReset()
  })

  it('should include call_to_action_type alongside object_story_id when provided', async () => {
    apiFetch.mockResolvedValueOnce(okJson({ id: 'creative_1' }))
    await createAdCreativeFromPost('act_1', 'page_1_post_1', 'Boost', 'tok', false, 'LEARN_MORE')
    const [, options] = apiFetch.mock.calls[0]
    expect(options.body).toContain('object_story_id')
    expect(options.body).toContain('call_to_action_type')
    expect(options.body).toContain('LEARN_MORE')
  })

  it('should omit call_to_action_type when not provided', async () => {
    apiFetch.mockResolvedValueOnce(okJson({ id: 'creative_1' }))
    await createAdCreativeFromPost('act_1', 'page_1_post_1', 'Boost', 'tok', false)
    expect(apiFetch.mock.calls[0][1].body).not.toContain('call_to_action_type')
  })
})

describe('getConnectedFacebookPage', () => {
  beforeEach(() => {
    apiFetch.mockReset()
  })

  it('should return the connected Facebook page id on success', async () => {
    apiFetch.mockResolvedValueOnce(okJson({ connected_facebook_page: '122094864657401982' }))
    const pageId = await getConnectedFacebookPage('ig_actor_1', 'tok')
    expect(pageId).toBe('122094864657401982')
    const [url] = apiFetch.mock.calls[0]
    expect(String(url)).toContain('ig_actor_1')
    expect(String(url)).toContain('connected_facebook_page')
  })

  it('should return null when the field is missing', async () => {
    apiFetch.mockResolvedValueOnce(okJson({ id: 'ig_actor_1' }))
    expect(await getConnectedFacebookPage('ig_actor_1', 'tok')).toBeNull()
  })

  it('should return null on Graph errors (best-effort)', async () => {
    apiFetch.mockResolvedValueOnce(errJson(190, 'Invalid OAuth access token'))
    expect(await getConnectedFacebookPage('ig_actor_1', 'bad_tok')).toBeNull()
  })
})
