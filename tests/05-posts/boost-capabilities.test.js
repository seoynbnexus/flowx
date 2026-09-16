import { describe, it, expect } from 'vitest'
import {
  BOOST_GRAPH_VERSION,
  assertBoostRegistryVersion,
  getBoostCapabilities,
  resolveBoostTargetContext,
  validateBoostConfig,
} from '../../shared/services/boost-capabilities.js'
import { META_CONFIG } from '../../shared/services/meta-oauth.config.js'
import { ValidationError } from '../../shared/errors/AppError.js'

const fbCtx = { platformCode: 'facebook', postType: 'post', mediaType: null, objective: 'OUTCOME_ENGAGEMENT', optimizationGoal: 'REACH' }
const geoIn = { geo_locations: { countries: ['IN'] } }

describe('boost capability registry (Phase B)', () => {
  it('registry version matches the configured Meta Graph version', () => {
    expect(META_CONFIG.graphVersion).toBe(BOOST_GRAPH_VERSION)
    expect(() => assertBoostRegistryVersion()).not.toThrow()
  })

  it('exposes only Meta-verified objectives and goals (no AWARENESS, IMPRESSIONS, or THRUPLAY)', () => {
    const caps = getBoostCapabilities()
    expect(Object.keys(caps.objectives).sort()).toEqual(['OUTCOME_ENGAGEMENT', 'OUTCOME_TRAFFIC'])
    expect(caps.objectives.OUTCOME_ENGAGEMENT.goals).toEqual(['POST_ENGAGEMENT', 'REACH'])
    expect(caps.objectives.OUTCOME_TRAFFIC.goals).toEqual(['LINK_CLICKS', 'LANDING_PAGE_VIEWS'])
    const offered = JSON.stringify({ objectives: caps.objectives, contexts: caps.contexts, positions: caps.positions })
    expect(offered).not.toContain('IMPRESSIONS')
    expect(offered).not.toContain('THRUPLAY')
    expect(offered).not.toContain('OUTCOME_AWARENESS')
  })

  it('exposes verified platforms and v25 position values', () => {
    const caps = getBoostCapabilities()
    expect(caps.contexts.facebook.platforms).toEqual(['facebook', 'instagram', 'messenger', 'audience_network'])
    expect(caps.contexts.instagram.platforms).toEqual(['facebook', 'instagram'])
    expect(caps.positions.facebook).toEqual(['feed', 'story', 'marketplace', 'search'])
    expect(caps.positions.instagram).toEqual(['stream', 'story', 'explore', 'reels'])
    expect(caps.positions.messenger).toEqual(['messenger_home'])
    expect(caps.positions.audience_network).toEqual(['classic', 'rewarded_video'])
  })

  it('resolves a valid client config with targeting byte-identical and placement normalized', () => {
    const targeting = {
      age_min: 18, age_max: 65, genders: [1, 2],
      geo_locations: { countries: ['US'], regions: [{ key: 'CA' }] },
      interests: [{ id: '1', name: 'x' }],
      device_platforms: ['mobile'],
    }
    const placement = {
      publisher_platforms: ['facebook', 'messenger'],
      facebook_positions: ['feed'],
      messenger_positions: ['messenger_home'],
      adSchedule: [{ start_minute: 0 }],
    }
    const result = resolveBoostTargetContext(targeting, placement, fbCtx)
    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.resolved.targeting).toEqual(targeting)
    expect(result.resolved.placement.publisher_platforms).toEqual(['facebook', 'messenger'])
    expect(result.resolved.placement.facebook_positions).toEqual(['feed'])
    expect(result.resolved.placement.messenger_positions).toEqual(['messenger_home'])
    expect(result.resolved.placement.adSchedule).toEqual([{ start_minute: 0 }])
    expect(result.resolved.objective).toBe('OUTCOME_ENGAGEMENT')
    expect(result.resolved.optimizationGoal).toBe('REACH')
  })

  it('normalizes camelCase placement identically to snake_case', () => {
    const snake = resolveBoostTargetContext(geoIn, { publisher_platforms: ['facebook'], facebook_positions: ['feed'], instagram_positions: ['stream'] }, fbCtx)
    const camel = resolveBoostTargetContext(geoIn, { publisherPlatforms: ['facebook'], feedPositions: ['feed'], instagramPositions: ['stream'] }, fbCtx)
    expect(snake.ok).toBe(true)
    expect(camel.ok).toBe(true)
    expect(camel.resolved.placement).toEqual(snake.resolved.placement)
  })

  it('applies explicit documented defaults for absent goal and platforms', () => {
    const fb = resolveBoostTargetContext(geoIn, {}, { ...fbCtx, optimizationGoal: null })
    expect(fb.ok).toBe(true)
    expect(fb.resolved.optimizationGoal).toBe('REACH')
    expect(fb.resolved.placement.publisher_platforms).toEqual(['facebook', 'instagram'])
    const ig = resolveBoostTargetContext(geoIn, {}, { ...fbCtx, platformCode: 'instagram', optimizationGoal: null })
    expect(ig.ok).toBe(true)
    expect(ig.resolved.placement.publisher_platforms).toEqual(['instagram'])
  })

  it('translates documented legacy objective aliases without error', () => {
    const result = resolveBoostTargetContext(geoIn, {}, { ...fbCtx, objective: 'REACH', optimizationGoal: null })
    expect(result.ok).toBe(true)
    expect(result.resolved.objective).toBe('OUTCOME_ENGAGEMENT')
  })

  it.each([
    ['awareness objective', { ...fbCtx, objective: 'OUTCOME_AWARENESS' }, geoIn, {}, 'objective'],
    ['impressions goal', { ...fbCtx, optimizationGoal: 'IMPRESSIONS' }, geoIn, {}, 'optimizationGoal'],
    ['thruplay goal', { ...fbCtx, optimizationGoal: 'THRUPLAY' }, geoIn, {}, 'optimizationGoal'],
    ['unknown objective', { ...fbCtx, objective: 'OUTCOME_SALES' }, geoIn, {}, 'objective'],
    ['unknown goal', { ...fbCtx, optimizationGoal: 'NOPE' }, geoIn, {}, 'optimizationGoal'],
    ['story post type', { ...fbCtx, postType: 'story' }, geoIn, {}, 'postType'],
    ['unknown platform', { ...fbCtx, platformCode: 'tiktok' }, geoIn, {}, 'platformCode'],
    ['no geo selection', fbCtx, { age_min: 18 }, {}, 'targeting.geo_locations'],
    ['empty countries only', fbCtx, { geo_locations: { countries: [] } }, {}, 'targeting.geo_locations'],
    ['messenger platform for instagram target', { ...fbCtx, platformCode: 'instagram' }, geoIn, { publisher_platforms: ['messenger'] }, 'placement.publisher_platforms'],
    ['facebook reels position', fbCtx, geoIn, { facebook_positions: ['reels'] }, 'placement.facebook_positions'],
    ['instagram feed position (use stream)', fbCtx, geoIn, { instagram_positions: ['feed'] }, 'placement.instagram_positions'],
    ['messenger story position (deprecated)', fbCtx, geoIn, { messenger_positions: ['story'] }, 'placement.messenger_positions'],
    ['unknown targeting key', fbCtx, { ...geoIn, custom_audiences: ['x'] }, {}, 'targeting.custom_audiences'],
    ['unknown placement key', fbCtx, geoIn, { threads_positions: ['x'] }, 'placement.threads_positions'],
    ['inverted age range', fbCtx, { ...geoIn, age_min: 65, age_max: 18 }, {}, 'targeting.age'],
    ['empty genders', fbCtx, { ...geoIn, genders: [] }, {}, 'targeting.genders'],
    ['bad device platform', fbCtx, { ...geoIn, device_platforms: ['tv'] }, {}, 'targeting.device_platforms'],
  ])('rejects %s', (_label, ctx, targeting, placement, path) => {
    const result = resolveBoostTargetContext(targeting, placement, ctx)
    expect(result.ok).toBe(false)
    expect(result.resolved).toBeNull()
    expect(result.errors.map((e) => e.path)).toContain(path)
  })

  it('accepts regions-only geo (no country required) and strips undocumented location_types', () => {
    const result = resolveBoostTargetContext(
      { geo_locations: { regions: [{ key: 'CA' }], location_types: ['home'] } },
      {},
      fbCtx
    )
    expect(result.ok).toBe(true)
    expect(result.resolved.targeting.geo_locations.regions).toEqual([{ key: 'CA' }])
    expect(result.resolved.targeting.geo_locations.location_types).toBeUndefined()
  })

  it('validateBoostConfig throws ValidationError with named field errors', () => {
    try {
      validateBoostConfig(geoIn, {}, { ...fbCtx, objective: 'OUTCOME_AWARENESS' })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError)
      expect(err.errors[0].field).toBe('objective')
    }
  })

  it('validateBoostConfig returns the resolved snapshot for valid input', () => {
    const resolved = validateBoostConfig(geoIn, { publisher_platforms: ['facebook'] }, fbCtx)
    expect(resolved.objective).toBe('OUTCOME_ENGAGEMENT')
    expect(resolved.placement.publisher_platforms).toEqual(['facebook'])
  })
})
