import { describe, it, expect } from 'vitest'
import {
  stableStringify,
  hashConfig,
  freezeSnapshot,
  readSnapshot,
  isSnapshotStale,
} from '../../shared/services/snapshot.js'

describe('snapshot primitive (Phase 1 shared mechanics)', () => {
  it('stable stringify is key-order independent', async () => {
    expect(stableStringify({ b: 1, a: { d: 4, c: 3 } })).toBe(stableStringify({ a: { c: 3, d: 4 }, b: 1 }))
    expect(hashConfig({ b: 1, a: 2 })).toBe(hashConfig({ a: 2, b: 1 }))
  })

  it('frozen snapshot wins over later live edits', async () => {
    const frozen = freezeSnapshot({ resolved: { placement: { a: 1 } }, graphVersion: 'v25.0' })
    expect(readSnapshot(frozen, { expectedGraphVersion: 'v25.0' })).toEqual({ placement: { a: 1 } })
    expect(isSnapshotStale(frozen, { placement: { a: 2 } })).toBe(true)
    expect(isSnapshotStale(frozen, { placement: { a: 1 } })).toBe(false)
  })

  it('version mismatch fails closed instead of reinterpreting', async () => {
    const frozen = freezeSnapshot({ resolved: { placement: { a: 1 } }, graphVersion: 'v25.0' })
    expect(readSnapshot(frozen, { expectedGraphVersion: 'v26.0' })).toBeNull()
  })

  it('missing snapshot reads as null, never throws', async () => {
    expect(readSnapshot(null, { expectedGraphVersion: 'v25.0' })).toBeNull()
    expect(readSnapshot(undefined, {})).toBeNull()
    expect(readSnapshot({ resolved: null, graphVersion: 'v25.0' }, {})).toBeNull()
    expect(isSnapshotStale(null, { a: 1 })).toBe(true)
  })
})
