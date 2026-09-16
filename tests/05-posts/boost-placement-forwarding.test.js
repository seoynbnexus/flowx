import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import {
  createAdSet,
  isBoostPlacementFixEnabled,
} from '../../shared/services/meta-ads.service.js'
import { buildPostBoostPayloads } from '../../src/modules/posts/post.service.js'
import { generateUuid, uuidToBuffer } from '../../shared/utils/uuid.utils.js'
import { query } from '../../shared/database/connection.js'

vi.mock('../../shared/utils/api-logger.js', () => ({
  apiFetch: vi.fn(),
  wrapSdkCall: vi.fn((_ctx, fn) => fn()),
  logTiming: vi.fn(),
}))

import { apiFetch } from '../../shared/utils/api-logger.js'

const okJson = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

async function setFlag(key, value) {
  await query(
    `INSERT INTO app_config (id, config_key, config_value, is_public, description, version)
     VALUES (?, ?, ?, 0, 'test flag', 1)
     ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
    [uuidToBuffer(generateUuid()), key, JSON.stringify(value)]
  )
}

function sentParams() {
  const [, options] = apiFetch.mock.calls[0]
  return Object.fromEntries(new URLSearchParams(options.body))
}

const baseArgs = {
  adAccountId: 'act_9',
  campaignId: 'camp_12345678',
  targeting: { geo_locations: { countries: ['US'] } },
  budget: { budgetType: 'daily', budgetAmount: 100 },
  schedule: {},
  token: 'tok',
}

const snakePlacement = {
  publisher_platforms: ['facebook', 'messenger'],
  facebook_positions: ['feed', 'story'],
  instagram_positions: ['feed'],
  messenger_positions: ['messenger_home'],
  audience_network_positions: ['classic'],
}

describe('boost placement forwarding (Phase A)', () => {
  beforeEach(() => {
    apiFetch.mockReset()
    apiFetch.mockResolvedValue(okJson({ id: 'adset_1' }))
  })

  afterAll(async () => {
    await query("DELETE FROM app_config WHERE config_key = 'boost_placement_fix_enabled'")
  })

  it('flag defaults off when the app_config row is absent', async () => {
    await query("DELETE FROM app_config WHERE config_key = 'boost_placement_fix_enabled'")
    await expect(isBoostPlacementFixEnabled()).resolves.toBe(false)
  })

  it('flag off pins legacy behavior: camel read, top-level feed_positions write', async () => {
    await setFlag('boost_placement_fix_enabled', false)
    await createAdSet(baseArgs.adAccountId, baseArgs.campaignId, baseArgs.targeting, baseArgs.budget, baseArgs.schedule, { ...snakePlacement, publisherPlatforms: ['instagram'] }, baseArgs.token)
    const params = sentParams()
    const targeting = JSON.parse(params.targeting)
    expect(targeting.publisher_platforms).toEqual(['instagram'])
    expect(params.feed_positions).toBeUndefined()
    expect(params.instagram_positions).toBeUndefined()
    expect(targeting.facebook_positions).toBeUndefined()
  })

  it('flag on forwards snake_case client placement into targeting with correct field names', async () => {
    await setFlag('boost_placement_fix_enabled', true)
    await createAdSet(baseArgs.adAccountId, baseArgs.campaignId, baseArgs.targeting, baseArgs.budget, baseArgs.schedule, { ...snakePlacement }, baseArgs.token)
    const params = sentParams()
    const targeting = JSON.parse(params.targeting)
    expect(targeting.publisher_platforms).toEqual(['facebook', 'messenger'])
    expect(targeting.facebook_positions).toEqual(['feed', 'story'])
    expect(targeting.instagram_positions).toEqual(['feed'])
    expect(targeting.messenger_positions).toEqual(['messenger_home'])
    expect(targeting.audience_network_positions).toEqual(['classic'])
    expect(params.feed_positions).toBeUndefined()
    expect(params.instagram_positions).toBeUndefined()
    expect(params.publisher_platforms).toBeUndefined()
  })

  it('flag on accepts legacy camelCase placement identically (backward compat)', async () => {
    await setFlag('boost_placement_fix_enabled', true)
    const camel = { publisherPlatforms: ['facebook'], feedPositions: ['feed'], instagramPositions: ['story'] }
    await createAdSet(baseArgs.adAccountId, baseArgs.campaignId, baseArgs.targeting, baseArgs.budget, baseArgs.schedule, camel, baseArgs.token)
    const params = sentParams()
    const targeting = JSON.parse(params.targeting)
    expect(targeting.publisher_platforms).toEqual(['facebook'])
    expect(targeting.facebook_positions).toEqual(['feed'])
    expect(targeting.instagram_positions).toEqual(['story'])
    expect(params.feed_positions).toBeUndefined()
  })

  it('flag on with no placement selection keeps documented platform default and no positions', async () => {
    await setFlag('boost_placement_fix_enabled', true)
    await createAdSet(baseArgs.adAccountId, baseArgs.campaignId, baseArgs.targeting, baseArgs.budget, baseArgs.schedule, {}, baseArgs.token)
    const params = sentParams()
    const targeting = JSON.parse(params.targeting)
    expect(targeting.publisher_platforms).toEqual(['facebook', 'instagram'])
    expect(targeting.facebook_positions).toBeUndefined()
    expect(targeting.instagram_positions).toBeUndefined()
  })

  it('flag on passes ad_schedule and frequency_control_specs through unchanged', async () => {
    await setFlag('boost_placement_fix_enabled', true)
    const placement = { ...snakePlacement, adSchedule: [{ start_minute: 0, end_minute: 60 }], frequencyControl: [{ event: 'IMPRESSIONS', interval_days: 7, max_frequency: 2 }] }
    await createAdSet(baseArgs.adAccountId, baseArgs.campaignId, baseArgs.targeting, baseArgs.budget, baseArgs.schedule, placement, baseArgs.token)
    const params = sentParams()
    expect(JSON.parse(params.ad_schedule)).toEqual([{ start_minute: 0, end_minute: 60 }])
    expect(JSON.parse(params.frequency_control_specs)).toEqual([{ event: 'IMPRESSIONS', interval_days: 7, max_frequency: 2 }])
  })
})

describe('buildPostBoostPayloads geo (Phase A: no silent IN default)', () => {
  const post = { id: 'post_1', name: 't', boostBudgetType: 'daily', boostBudgetAmount: 1000, mediaUrl: 'https://x/y.jpg' }
  const target = { platformCode: 'facebook', platformUserId: '123' }

  it('empty geo yields geoError and injects no country', async () => {
    const payload = await buildPostBoostPayloads(
      { ...post, boostTargeting: { age_min: 18, age_max: 65, genders: [1, 2], geo_locations: { countries: [] } } },
      target, 1
    )
    expect(payload.geoError).toBeTruthy()
    expect(payload.targeting.geo_locations?.countries).not.toEqual(['IN'])
  })

  it('missing geo_locations object also yields geoError', async () => {
    const payload = await buildPostBoostPayloads({ ...post, boostTargeting: { age_min: 18 } }, target, 1)
    expect(payload.geoError).toBeTruthy()
  })

  it('regions-only selection is preserved (no silent wipe to IN)', async () => {
    const payload = await buildPostBoostPayloads(
      { ...post, boostTargeting: { geo_locations: { regions: [{ key: 'CA', name: 'California' }] } } },
      target, 1
    )
    expect(payload.geoError).toBeNull()
    expect(payload.targeting.geo_locations.regions).toEqual([{ key: 'CA', name: 'California' }])
    expect(payload.targeting.geo_locations.countries).toBeUndefined()
  })

  it('client-selected countries pass through unchanged', async () => {
    const payload = await buildPostBoostPayloads(
      { ...post, boostTargeting: { geo_locations: { countries: ['US', 'GB'] } } },
      target, 1
    )
    expect(payload.geoError).toBeNull()
    expect(payload.targeting.geo_locations.countries).toEqual(['US', 'GB'])
  })

  it('custom_locations-only selection satisfies the geo requirement', async () => {
    const payload = await buildPostBoostPayloads(
      { ...post, boostTargeting: { geo_locations: { custom_locations: [{ latitude: 1, longitude: 2, radius: 10 }] } } },
      target, 1
    )
    expect(payload.geoError).toBeNull()
  })
})
