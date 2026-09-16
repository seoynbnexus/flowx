import * as postRepo from './post.repository.js'
import {
  validateBoostConfig as validateBoostCapability,
  resolveBoostTargetContext,
  BOOST_GRAPH_VERSION,
} from '../../../shared/services/boost-capabilities.js'
import { ValidationError } from '../../../shared/errors/AppError.js'

async function mediaTypeByTargetId(postId) {
  try {
    const rows = await postRepo.findPostEngagement(postId)
    const map = {}
    for (const row of rows) {
      if (row.targetId && row.mediaType && !map[row.targetId]) map[row.targetId] = row.mediaType
    }
    return map
  } catch { return {} }
}

export async function buildResolvedSnapshot({ postId, postType, targets, targeting, placement, objective, optimizationGoal }) {
  const mediaByTarget = postId ? await mediaTypeByTargetId(postId) : {}
  const snapshot = { targets: {}, platforms: {} }
  const failures = []
  let sharedObjective = null
  let sharedGoal = null
  for (const target of targets) {
    const result = resolveBoostTargetContext(targeting, placement, {
      platformCode: target.platformCode,
      postType,
      mediaType: mediaByTarget[target.id] || null,
      objective,
      optimizationGoal,
    })
    if (!result.ok) {
      failures.push({ targetId: target.id, platformCode: target.platformCode, errors: result.errors.map((e) => ({ field: e.path, message: e.message })) })
      continue
    }
    snapshot.targets[target.id] = result.resolved
    if (!snapshot.platforms[target.platformCode]) snapshot.platforms[target.platformCode] = result.resolved
    sharedObjective = result.resolved.objective
    sharedGoal = result.resolved.optimizationGoal
  }
  return { snapshot, failures, objective: sharedObjective, optimizationGoal: sharedGoal }
}

export async function validateBoostForTargets(args) {
  const { snapshot, failures, objective, optimizationGoal } = await buildResolvedSnapshot(args)
  if (failures.length) {
    throw new ValidationError('Boost configuration invalid for one or more targets', failures)
  }
  return { snapshot, objective, optimizationGoal }
}

export function snapshotColumns({ byTarget = {}, byPlatform = {}, objective, optimizationGoal }) {
  const pick = (entries, field) => Object.fromEntries(Object.entries(entries).map(([key, resolved]) => [key, resolved[field]]))
  return {
    resolvedTargeting: { targets: pick(byTarget, 'targeting'), platforms: pick(byPlatform, 'targeting'), objective, optimizationGoal },
    resolvedPlacement: { targets: pick(byTarget, 'placement'), platforms: pick(byPlatform, 'placement') },
    resolvedGraphVersion: BOOST_GRAPH_VERSION,
    resolvedAt: new Date(),
  }
}

export function readSnapshotSlice(promotion, postTargetId, platformCode) {
  const targetMap = promotion?.resolvedTargeting
  const placementMap = promotion?.resolvedPlacement
  if (!targetMap || !placementMap) return null
  if (promotion.resolvedGraphVersion !== BOOST_GRAPH_VERSION) return null
  const targeting = targetMap.targets?.[postTargetId] ?? targetMap.platforms?.[platformCode] ?? null
  const placement = placementMap.targets?.[postTargetId] ?? placementMap.platforms?.[platformCode] ?? null
  if (!targeting || !placement || !targetMap.objective || !targetMap.optimizationGoal) return null
  return { targeting, placement, objective: targetMap.objective, optimizationGoal: targetMap.optimizationGoal }
}

export async function buildResolvedSnapshotForPlatforms({ postType, platformCodes, targeting, placement, objective, optimizationGoal }) {
  const platforms = {}
  const failures = []
  for (const platformCode of platformCodes) {
    const result = resolveBoostTargetContext(targeting, placement, { platformCode, postType, mediaType: null, objective, optimizationGoal })
    if (!result.ok) {
      failures.push({ platformCode, errors: result.errors.map((e) => ({ field: e.path, message: e.message })) })
      continue
    }
    platforms[platformCode] = result.resolved
  }
  return { platforms, failures }
}

export async function validateBoostForPlatforms(args) {
  const { platforms, failures } = await buildResolvedSnapshotForPlatforms(args)
  if (failures.length) {
    throw new ValidationError('Boost configuration invalid for one or more platforms', failures)
  }
  return platforms
}

export { BOOST_GRAPH_VERSION }
