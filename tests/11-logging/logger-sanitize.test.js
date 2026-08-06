import { describe, it, expect } from 'vitest'
import { sanitizeUrl } from '../../shared/utils/logger.js'

describe('logger sanitizeUrl', () => {
  it('redacts sensitive query params', () => {
    const url = sanitizeUrl('/api/v1/meta/webhook?hub.verify_token=abc&hub.mode=subscribe&access_token=SECRET&code=XYZ&state=ST')
    expect(url).not.toContain('SECRET')
    expect(url).not.toContain('XYZ')
    expect(url).not.toContain('ST')
    expect(url).toContain('REDACTED')
  })

  it('redacts access_token in absolute Graph API urls', () => {
    const url = sanitizeUrl('https://graph.facebook.com/v25.0/act_1/ads?access_token=EAAsecret&fields=id')
    expect(url).not.toContain('EAAsecret')
    expect(url).toContain('REDACTED')
  })

  it('leaves non-sensitive urls untouched', () => {
    const url = sanitizeUrl('/api/v1/campaigns?page=1&limit=20')
    expect(url).toBe('/api/v1/campaigns?page=1&limit=20')
  })
})
