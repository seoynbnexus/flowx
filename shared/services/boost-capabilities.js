import { META_CONFIG } from './meta-oauth.config.js'
import { ValidationError } from '../errors/AppError.js'

export const BOOST_GRAPH_VERSION = 'v25.0'

export function assertBoostRegistryVersion() {
  if (META_CONFIG.graphVersion !== BOOST_GRAPH_VERSION) {
    throw new Error(`boost-capabilities registry is pinned to ${BOOST_GRAPH_VERSION} but META_CONFIG.graphVersion is ${META_CONFIG.graphVersion} — review docs/boost-capability-evidence.md before bumping`)
  }
}

const REGISTRY = {
  graphVersion: BOOST_GRAPH_VERSION,
  evidence: 'docs/boost-capability-evidence.md',
  objectives: {
    OUTCOME_ENGAGEMENT: { goals: ['POST_ENGAGEMENT', 'REACH'], defaultGoal: 'REACH' },
    OUTCOME_TRAFFIC: { goals: ['LINK_CLICKS', 'LANDING_PAGE_VIEWS'], defaultGoal: 'LINK_CLICKS' },
  },
  contexts: {
    facebook: {
      platforms: ['facebook', 'instagram', 'messenger', 'audience_network'],
      defaultPlatforms: ['facebook', 'instagram'],
      boostablePostTypes: ['post', 'reel'],
    },
    instagram: {
      platforms: ['facebook', 'instagram'],
      defaultPlatforms: ['instagram'],
      boostablePostTypes: ['post', 'reel'],
      note: 'instagram-only is the product default; facebook delivery verified at adset level (E2) and left to client choice',
    },
  },
  positions: {
    facebook: ['feed', 'story', 'marketplace', 'search'],
    instagram: ['stream', 'story', 'explore', 'reels'],
    messenger: ['messenger_home'],
    audience_network: ['classic', 'rewarded_video'],
  },
  devicePlatforms: ['mobile', 'desktop'],
  notes: [
    'OUTCOME_AWARENESS excluded for ON_POST: Meta 100/1815715 (E10)',
    'THRUPLAY excluded for ON_POST: Meta 100/2490408 under ENGAGEMENT, unreachable under AWARENESS (E4/E4b/E5)',
    'IMPRESSIONS goal excluded: Meta 100/3858327 deprecation enforced (E9)',
    'facebook reels + video_feeds positions excluded: Meta 100/1815433 + 100/2490562 (E13a/E13b)',
    'instagram feed/search positions excluded, use stream: Meta 100/1815508 (E13c/E13d)',
    'stories not boostable via object_story_id creative: Meta #100 Invalid post_id (E6)',
    'LINK_CLICKS bills LINK_CLICKS which new-business accounts may lack (E11 100/2446404) — goal stays allowed, execution validate_only remains the final check',
  ],
}

const LEGACY_OBJECTIVE_MAP = {
  POST_ENGAGEMENT: 'OUTCOME_ENGAGEMENT',
  VIDEO_VIEWS: 'OUTCOME_ENGAGEMENT',
  MESSAGES: 'OUTCOME_ENGAGEMENT',
  PAGE_LIKES: 'OUTCOME_ENGAGEMENT',
  REACH: 'OUTCOME_ENGAGEMENT',
  IMPRESSIONS: 'OUTCOME_ENGAGEMENT',
  BRAND_AWARENESS: 'OUTCOME_ENGAGEMENT',
  LINK_CLICKS: 'OUTCOME_TRAFFIC',
}

const KNOWN_TARGETING_KEYS = new Set([
  'age_min', 'age_max', 'genders', 'geo_locations', 'excluded_geo_locations',
  'interests', 'behaviors', 'languages', 'device_platforms',
])

const KNOWN_PLACEMENT_KEYS = new Set([
  'publisher_platforms', 'publisherPlatforms',
  'facebook_positions', 'facebookPositions', 'feedPositions', 'feed_positions',
  'instagram_positions', 'instagramPositions',
  'messenger_positions', 'messengerPositions',
  'audience_network_positions', 'audienceNetworkPositions',
  'adSchedule', 'frequencyControl',
])

const POSITION_FIELD_BY_PLATFORM = {
  facebook: 'facebook_positions',
  instagram: 'instagram_positions',
  messenger: 'messenger_positions',
  audience_network: 'audience_network_positions',
}

export function getBoostCapabilities() {
  return JSON.parse(JSON.stringify(REGISTRY))
}

function err(path, message) {
  return { path, message }
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function pickFirstDefined(obj, keys) {
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) return obj[key]
  }
  return undefined
}

export function resolveBoostTargetContext(rawTargeting, rawPlacement, context) {
  const errors = []
  const { platformCode, postType, objective: rawObjective, optimizationGoal: rawGoal } = context || {}

  const ctx = REGISTRY.contexts[platformCode]
  if (!ctx) {
    return { ok: false, errors: [err('platformCode', `Boost not supported for platform ${platformCode}`)], resolved: null }
  }
  if (!ctx.boostablePostTypes.includes(postType)) {
    return { ok: false, errors: [err('postType', `${postType} posts cannot be promoted on ${platformCode} — only feed posts and reels`)], resolved: null }
  }

  let objective = String(rawObjective || 'OUTCOME_ENGAGEMENT').toUpperCase().trim()
  if (LEGACY_OBJECTIVE_MAP[objective]) objective = LEGACY_OBJECTIVE_MAP[objective]
  const objectiveConfig = REGISTRY.objectives[objective]
  if (!objectiveConfig) {
    return { ok: false, errors: [err('objective', `Objective ${rawObjective} is not valid for boosted organic posts (valid: ${Object.keys(REGISTRY.objectives).join(', ')})`)], resolved: null }
  }

  let optimizationGoal = null
  if (rawGoal !== undefined && rawGoal !== null && String(rawGoal).trim() !== '') {
    const v = String(rawGoal).toUpperCase().trim()
    if (!objectiveConfig.goals.includes(v)) {
      errors.push(err('optimizationGoal', `Goal ${rawGoal} is not valid for ${objective} on boosted organic posts (valid: ${objectiveConfig.goals.join(', ')})`))
    } else {
      optimizationGoal = v
    }
  } else {
    optimizationGoal = objectiveConfig.defaultGoal
  }

  const targeting = (rawTargeting && typeof rawTargeting === 'object' && !Array.isArray(rawTargeting)) ? { ...rawTargeting } : {}
  for (const key of Object.keys(targeting)) {
    if (!KNOWN_TARGETING_KEYS.has(key)) errors.push(err(`targeting.${key}`, `Unsupported targeting field ${key}`))
  }
  delete targeting.age
  delete targeting.gender
  delete targeting.country
  if (targeting.geo_locations && typeof targeting.geo_locations === 'object') delete targeting.geo_locations.location_types

  const geo = targeting.geo_locations
  const hasGeo = !!(geo?.countries?.length || geo?.regions?.length || geo?.cities?.length || geo?.zips?.length || geo?.custom_locations?.length)
  if (!hasGeo) errors.push(err('targeting.geo_locations', 'Select at least one location for boost targeting'))

  if (targeting.age_min !== undefined || targeting.age_max !== undefined) {
    const min = Number(targeting.age_min)
    const max = Number(targeting.age_max)
    if (!Number.isInteger(min) || !Number.isInteger(max) || min <= 0 || max <= 0 || min > max) {
      errors.push(err('targeting.age', 'age_min/age_max must be positive integers with age_min <= age_max'))
    }
  }
  if (targeting.genders !== undefined) {
    const genders = asArray(targeting.genders)
    if (!genders.length || !genders.every((g) => g === 1 || g === 2)) {
      errors.push(err('targeting.genders', 'genders must be a non-empty subset of [1, 2]'))
    }
  }
  if (targeting.device_platforms !== undefined) {
    const devices = asArray(targeting.device_platforms)
    if (!devices.length || !devices.every((d) => REGISTRY.devicePlatforms.includes(d))) {
      errors.push(err('targeting.device_platforms', `device_platforms must be a non-empty subset of [${REGISTRY.devicePlatforms.join(', ')}]`))
    }
  }

  const placement = (rawPlacement && typeof rawPlacement === 'object' && !Array.isArray(rawPlacement)) ? { ...rawPlacement } : {}
  for (const key of Object.keys(placement)) {
    if (!KNOWN_PLACEMENT_KEYS.has(key)) errors.push(err(`placement.${key}`, `Unsupported placement field ${key}`))
  }

  let platforms = pickFirstDefined(placement, ['publisher_platforms', 'publisherPlatforms'])
  if (platforms === undefined) {
    platforms = [...ctx.defaultPlatforms]
  } else if (!Array.isArray(platforms) || !platforms.length) {
    errors.push(err('placement.publisher_platforms', 'Select at least one publisher platform'))
    platforms = []
  } else {
    const unknown = platforms.filter((p) => !ctx.platforms.includes(p))
    if (unknown.length) errors.push(err('placement.publisher_platforms', `Platforms not valid for ${platformCode} boosts: ${unknown.join(', ')} (valid: ${ctx.platforms.join(', ')})`))
  }

  const normalizedPlacement = { publisher_platforms: platforms }
  for (const [platform, field] of Object.entries(POSITION_FIELD_BY_PLATFORM)) {
    const values = pickFirstDefined(placement, [field, `${platform}Positions`, ...(platform === 'facebook' ? ['feedPositions', 'feed_positions'] : [])])
    if (values === undefined) continue
    if (!Array.isArray(values) || !values.length) {
      errors.push(err(`placement.${field}`, `${field} must be a non-empty array when present`))
      continue
    }
    const allowed = REGISTRY.positions[platform]
    const invalid = values.filter((v) => !allowed.includes(v))
    if (invalid.length) {
      errors.push(err(`placement.${field}`, `Invalid ${platform} positions: ${invalid.join(', ')} (valid: ${allowed.join(', ')})`))
    } else {
      normalizedPlacement[field] = [...values]
    }
  }
  for (const key of ['adSchedule', 'frequencyControl']) {
    if (placement[key] !== undefined) normalizedPlacement[key] = placement[key]
  }

  if (errors.length) return { ok: false, errors, resolved: null }
  return { ok: true, errors: [], resolved: { targeting, placement: normalizedPlacement, objective, optimizationGoal } }
}

export function validateBoostConfig(rawTargeting, rawPlacement, context) {
  const result = resolveBoostTargetContext(rawTargeting, rawPlacement, context)
  if (!result.ok) {
    throw new ValidationError('Invalid boost configuration', result.errors.map((e) => ({ field: e.path, message: e.message })))
  }
  return result.resolved
}
