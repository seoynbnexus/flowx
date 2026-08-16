import { describe, it, expect } from 'vitest'
import { redactSensitive, truncateBody, sanitizeUrl } from '../../shared/utils/logger.js'
import { responseLogger } from '../../shared/middleware/response-log.middleware.js'

describe('redactSensitive', () => {
  it('redacts known sensitive keys at the top level', () => {
    const out = redactSensitive({ password: 'p', token: 't', name: 'ok' })
    expect(out).toEqual({ password: '[REDACTED]', token: '[REDACTED]', name: 'ok' })
  })

  it('redacts nested and array values', () => {
    const out = redactSensitive({
      user: { refreshToken: 'r', profile: { bio: 'hi' } },
      items: [{ secret: 's', id: 1 }],
    })
    expect(out.user.refreshToken).toBe('[REDACTED]')
    expect(out.user.profile.bio).toBe('hi')
    expect(out.items[0].secret).toBe('[REDACTED]')
    expect(out.items[0].id).toBe(1)
  })

  it('handles null and primitives', () => {
    expect(redactSensitive(null)).toBe(null)
    expect(redactSensitive('str')).toBe('str')
    expect(redactSensitive(42)).toBe(42)
  })

  it('handles circular references without infinite recursion', () => {
    const obj = { name: 'a' }
    obj.self = obj
    const out = redactSensitive(obj)
    expect(out.name).toBe('a')
    expect(out.self).toBe('[CIRCULAR]')
  })
})

describe('truncateBody', () => {
  it('returns short strings unchanged', () => {
    expect(truncateBody('hello')).toBe('hello')
  })

  it('truncates long strings with a marker', () => {
    const long = 'x'.repeat(5000)
    const out = truncateBody(long)
    expect(out.length).toBeLessThan(2100)
    expect(out).toContain('[truncated')
  })

  it('passes through non-strings', () => {
    expect(truncateBody(undefined)).toBe(undefined)
    expect(truncateBody(null)).toBe(null)
    expect(truncateBody(7)).toBe(7)
  })
})

describe('responseLogger', () => {
  function fakeRes() {
    const res = { locals: {}, statusCode: 200 }
    res.status = (code) => { res.statusCode = code; return res }
    res.json = (body) => { res.jsonBody = body; return res }
    res.send = (body) => { res.sendBody = body; return res }
    return res
  }

  it('captures res.json payload onto locals._logBody', () => {
    const res = fakeRes()
    const req = {}
    responseLogger(req, res, () => {})
    res.json({ success: true, data: { token: 'x' } })
    expect(res.locals._logBody).toBe('{"success":true,"data":{"token":"x"}}')
    expect(res.jsonBody).toEqual({ success: true, data: { token: 'x' } })
  })

  it('captures object res.send payloads', () => {
    const res = fakeRes()
    const req = {}
    responseLogger(req, res, () => {})
    res.send({ success: true })
    expect(res.locals._logBody).toBe('{"success":true}')
    expect(res.sendBody).toEqual({ success: true })
  })

  it('skips Buffer payloads from res.send', () => {
    const res = fakeRes()
    const req = {}
    responseLogger(req, res, () => {})
    const buf = Buffer.from('file-bytes')
    res.send(buf)
    expect(res.locals._logBody).toBeUndefined()
    expect(res.sendBody).toBe(buf)
  })
})

describe('sanitizeUrl', () => {
  it('still redacts sensitive query params', () => {
    const url = sanitizeUrl('/api/v1/oauth?code=abc&state=xyz')
    expect(url).not.toContain('abc')
    expect(url).not.toContain('xyz')
    expect(url).toContain('REDACTED')
  })
})
