import { describe, it, expect, vi } from 'vitest'
import { getBoostCapabilities } from '../../src/modules/posts/post.controller.js'

function mockRes() {
  let statusCode = null
  let body = null
  const res = {
    status: (code) => { statusCode = code; return res },
    json: (data) => { body = data; return res },
  }
  return { res, getStatus: () => statusCode, getBody: () => body }
}

describe('GET /posts/boost-capabilities', () => {
  it('returns 200 with the versioned registry and no unverified options', async () => {
    const { res, getStatus, getBody } = mockRes()
    await getBoostCapabilities({}, res, vi.fn())
    expect(getStatus()).toBe(200)
    const caps = getBody().data
    expect(caps.graphVersion).toBe('v25.0')
    expect(Object.keys(caps.objectives).sort()).toEqual(['OUTCOME_ENGAGEMENT', 'OUTCOME_TRAFFIC'])
    const offered = JSON.stringify({ objectives: caps.objectives, contexts: caps.contexts, positions: caps.positions })
    expect(offered).not.toContain('OUTCOME_AWARENESS')
    expect(offered).not.toContain('IMPRESSIONS')
    expect(offered).not.toContain('THRUPLAY')
  })

  it('forwards controller errors to next', async () => {
    const next = vi.fn()
    const broken = { status: () => { throw new Error('res down') }, json: () => {} }
    await getBoostCapabilities({}, broken, next)
    expect(next).toHaveBeenCalled()
  })
})
