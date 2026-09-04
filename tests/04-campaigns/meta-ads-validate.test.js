import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  extractMetaError,
  createAdCampaign,
  createAdSet,
  createAdCreative,
  createAdCreativeFromInstagramPost,
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
