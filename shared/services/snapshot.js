export function stableStringify(value) {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function hashConfig(config) {
  let hash = 5381
  const text = stableStringify(config ?? null)
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

export function freezeSnapshot({ resolved, graphVersion }) {
  return {
    resolved: resolved ?? null,
    graphVersion: graphVersion ?? null,
    resolvedAt: new Date(),
    configHash: hashConfig(resolved ?? null),
  }
}

export function readSnapshot(snapshot, { expectedGraphVersion } = {}) {
  if (!snapshot || snapshot.resolved === null || snapshot.resolved === undefined) return null
  if (expectedGraphVersion !== undefined && snapshot.graphVersion !== expectedGraphVersion) return null
  return snapshot.resolved
}

export function isSnapshotStale(snapshot, liveConfig) {
  if (!snapshot || !snapshot.resolvedAt) return true
  return hashConfig(liveConfig ?? null) !== snapshot.configHash
}
