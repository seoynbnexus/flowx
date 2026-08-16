import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  mediaFetchOptions,
  ipv4ToInt,
  isBlockedAddress,
  isPublicHttpUrl,
  resolveMediaHost,
  inspectMediaSize,
  fetchBoundedBytes,
  sanitizeMediaUrl,
  buildLookup,
} from '../../shared/services/media-url.js'
import dns from 'node:dns/promises'

afterEach(() => {
  mediaFetchOptions.allowPrivate = false
})

describe('ipv4ToInt', () => {
  it('converts dotted-quad to an integer', () => {
    expect(ipv4ToInt('127.0.0.1')).toBe(0x7f000001)
    expect(ipv4ToInt('10.0.0.1')).toBe(0x0a000001)
    expect(ipv4ToInt('192.168.1.1')).toBe(0xc0a80101)
    expect(ipv4ToInt('8.8.8.8')).toBe(0x08080808)
  })
})

describe('isBlockedAddress', () => {
  it('blocks the loopback range', () => {
    expect(isBlockedAddress('127.0.0.1')).toBe(true)
    expect(isBlockedAddress('127.255.255.255')).toBe(true)
  })

  it('blocks private IPv4 ranges', () => {
    expect(isBlockedAddress('10.0.0.0')).toBe(true)
    expect(isBlockedAddress('10.255.255.255')).toBe(true)
    expect(isBlockedAddress('172.16.0.0')).toBe(true)
    expect(isBlockedAddress('172.31.255.255')).toBe(true)
    expect(isBlockedAddress('192.168.0.1')).toBe(true)
    expect(isBlockedAddress('192.168.255.254')).toBe(true)
  })

  it('blocks link-local and carrier-grade NAT ranges', () => {
    expect(isBlockedAddress('169.254.0.1')).toBe(true)
    expect(isBlockedAddress('169.254.255.254')).toBe(true)
    expect(isBlockedAddress('100.64.0.1')).toBe(true)
    expect(isBlockedAddress('100.127.255.254')).toBe(true)
  })

  it('blocks reserved / documentation ranges', () => {
    expect(isBlockedAddress('192.0.0.1')).toBe(true)
    expect(isBlockedAddress('192.0.2.1')).toBe(true)
    expect(isBlockedAddress('198.51.100.7')).toBe(true)
    expect(isBlockedAddress('203.0.113.9')).toBe(true)
  })

  it('blocks the zero and multicast/experimental ranges', () => {
    expect(isBlockedAddress('0.0.0.0')).toBe(true)
    expect(isBlockedAddress('0.1.2.3')).toBe(true)
    expect(isBlockedAddress('224.0.0.1')).toBe(true)
    expect(isBlockedAddress('240.0.0.1')).toBe(true)
    expect(isBlockedAddress('255.255.255.255')).toBe(true)
  })

  it('allows public IPv4 addresses', () => {
    expect(isBlockedAddress('8.8.8.8')).toBe(false)
    expect(isBlockedAddress('1.1.1.1')).toBe(false)
    expect(isBlockedAddress('13.107.42.14')).toBe(false)
  })

  it('blocks loopback and unspecified IPv6', () => {
    expect(isBlockedAddress('::')).toBe(true)
    expect(isBlockedAddress('::1')).toBe(true)
  })

  it('blocks IPv4-mapped IPv6 addresses', () => {
    expect(isBlockedAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isBlockedAddress('::ffff:10.0.0.1')).toBe(true)
    expect(isBlockedAddress('::ffff:192.168.1.1')).toBe(true)
    expect(isBlockedAddress('::ffff:8.8.8.8')).toBe(false)
  })

  it('blocks unique local / link-local / multicast / documentation IPv6', () => {
    expect(isBlockedAddress('fc00::1')).toBe(true)
    expect(isBlockedAddress('fd12:3456::1')).toBe(true)
    expect(isBlockedAddress('fe80::1')).toBe(true)
    expect(isBlockedAddress('febf::1')).toBe(true)
    expect(isBlockedAddress('ff02::1')).toBe(true)
    expect(isBlockedAddress('2001:db8::1')).toBe(true)
  })

  it('allows public IPv6 addresses', () => {
    expect(isBlockedAddress('2606:4700:4700::1111')).toBe(false)
  })

  it('blocks falsy / unknown input', () => {
    expect(isBlockedAddress(null)).toBe(true)
    expect(isBlockedAddress('')).toBe(true)
    expect(isBlockedAddress('not-an-ip')).toBe(true)
  })
})

describe('isPublicHttpUrl', () => {
  it('accepts http and https', () => {
    expect(isPublicHttpUrl('https://example.com/a.jpg')).toBe(true)
    expect(isPublicHttpUrl('http://example.com/a.jpg')).toBe(true)
  })

  it('rejects non-http schemes and malformed urls', () => {
    expect(isPublicHttpUrl('ftp://example.com/a.jpg')).toBe(false)
    expect(isPublicHttpUrl('file:///etc/passwd')).toBe(false)
    expect(isPublicHttpUrl('javascript:alert(1)')).toBe(false)
    expect(isPublicHttpUrl('not a url')).toBe(false)
    expect(isPublicHttpUrl('')).toBe(false)
    expect(isPublicHttpUrl(null)).toBe(false)
  })
})

describe('resolveMediaHost', () => {
  it('returns a blocked marker for a literal IP that is private', async () => {
    const res = await resolveMediaHost('http://127.0.0.1/x.jpg')
    expect(res.hostname).toBe('127.0.0.1')
    expect(res.blocked).toContain('127.0.0.1')
  })

  it('returns no blocked marker for a public literal IP', async () => {
    const res = await resolveMediaHost('http://8.8.8.8/x.jpg')
    expect(res.blocked).toHaveLength(0)
  })

  it('resolves a hostname through DNS and flags blocked addresses', async () => {
    const lookup = vi.spyOn(dns, 'lookup').mockResolvedValueOnce([
      { address: '127.0.0.1', family: 4 },
      { address: '8.8.8.8', family: 4 },
    ])
    const res = await resolveMediaHost('http://example.com/x.jpg')
    expect(res.hostname).toBe('example.com')
    expect(res.blocked).toContain('127.0.0.1')
    expect(res.blocked).not.toContain('8.8.8.8')
    lookup.mockRestore()
  })

  it('treats allowPrivate=true as non-blocking', async () => {
    mediaFetchOptions.allowPrivate = true
    const res = await resolveMediaHost('http://10.0.0.1/x.jpg')
    expect(res.blocked).toHaveLength(0)
  })
})

describe('buildLookup', () => {
  it('forwards all addresses as an array when Node requests the all-form', async () => {
    mediaFetchOptions.allowPrivate = false
    const lookup = vi.spyOn(dns, 'lookup').mockResolvedValueOnce([
      { address: '104.18.40.96', family: 4 },
      { address: '172.64.147.160', family: 4 },
    ])
    const nodeLookup = buildLookup()
    const received = await new Promise((resolve, reject) => {
      nodeLookup('cdn.pixabay.com', { all: true }, (err, ...args) => {
        if (err) return reject(err)
        resolve(args)
      })
    })
    expect(lookup).toHaveBeenCalledWith('cdn.pixabay.com', { all: true, family: 0 })
    expect(received[0]).toEqual([
      { address: '104.18.40.96', family: 4 },
      { address: '172.64.147.160', family: 4 },
    ])
    expect(received[1]).toBeUndefined()
    lookup.mockRestore()
  })

  it('falls back to single-address form when all is not requested', async () => {
    mediaFetchOptions.allowPrivate = false
    const lookup = vi.spyOn(dns, 'lookup').mockResolvedValueOnce([
      { address: '104.18.40.96', family: 4 },
    ])
    const nodeLookup = buildLookup()
    const received = await new Promise((resolve, reject) => {
      nodeLookup('cdn.pixabay.com', {}, (err, address, family) => {
        if (err) return reject(err)
        resolve([address, family])
      })
    })
    expect(received).toEqual(['104.18.40.96', 4])
    lookup.mockRestore()
  })

  it('rejects with MEDIA_SSRF_BLOCKED when every resolved address is private', async () => {
    mediaFetchOptions.allowPrivate = false
    const lookup = vi.spyOn(dns, 'lookup').mockResolvedValueOnce([
      { address: '10.0.0.1', family: 4 },
    ])
    const nodeLookup = buildLookup()
    const err = await new Promise((resolve, reject) => {
      nodeLookup('private.example', { all: true }, (e) => (e ? resolve(e) : reject(new Error('expected error'))))
    })
    expect(err.code).toBe('MEDIA_SSRF_BLOCKED')
    lookup.mockRestore()
  })

  it('rejects with ENOTFOUND when no addresses resolve', async () => {
    const lookup = vi.spyOn(dns, 'lookup').mockResolvedValueOnce([])
    const nodeLookup = buildLookup()
    const err = await new Promise((resolve, reject) => {
      nodeLookup('missing.example', { all: true }, (e) => (e ? resolve(e) : reject(new Error('expected error'))))
    })
    expect(err.code).toBe('ENOTFOUND')
    lookup.mockRestore()
  })
})

describe('inspectMediaSize', () => {
  it('re-throws SSRF-blocked errors (private addresses never probed)', async () => {
    await expect(inspectMediaSize('http://127.0.0.1:1/x.jpg', { maxBytes: 100 })).rejects.toMatchObject({
      code: 'MEDIA_SSRF_BLOCKED',
    })
  })
})

describe('sanitizeMediaUrl', () => {
  it('strips query string and fragment', () => {
    expect(sanitizeMediaUrl('https://cdn.example.com/a.jpg?token=abc&x=1#frag'))
      .toBe('https://cdn.example.com/a.jpg')
  })

  it('returns non-parseable input unchanged', () => {
    expect(sanitizeMediaUrl('')).toBe('')
    expect(sanitizeMediaUrl(null)).toBe(null)
    expect(sanitizeMediaUrl(42)).toBe(42)
  })
})

describe('fetchBoundedBytes', () => {
  it('rejects private addresses before making a request', async () => {
    await expect(fetchBoundedBytes('http://127.0.0.1:1/a.jpg')).rejects.toMatchObject({
      code: 'MEDIA_SSRF_BLOCKED',
    })
  })

  it('rejects non-http urls', async () => {
    await expect(fetchBoundedBytes('file:///etc/passwd')).rejects.toMatchObject({
      code: 'MEDIA_URL_INVALID',
    })
  })

  it('resolves with truncated=true when the body exceeds maxBytes (does not hang)', async () => {
    const http = await import('node:http')
    mediaFetchOptions.allowPrivate = true
    const body = Buffer.alloc(3 * 1024 * 1024, 0x61)
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
      res.end(body)
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()
    try {
      const result = await Promise.race([
        fetchBoundedBytes(`http://127.0.0.1:${port}/big.bin`, { maxBytes: 1024 * 1024, timeoutMs: 5000 }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('fetchBoundedBytes hung')), 10000)),
      ])
      expect(result.truncated).toBe(true)
      expect(result.bytes.length).toBeLessThanOrEqual(1024 * 1024)
      expect(result.statusCode).toBe(200)
    } finally {
      server.close()
      mediaFetchOptions.allowPrivate = false
    }
  })

  it('resolves without truncation when the body fits within maxBytes', async () => {
    const http = await import('node:http')
    mediaFetchOptions.allowPrivate = true
    const body = Buffer.from('small-body')
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
      res.end(body)
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()
    try {
      const result = await fetchBoundedBytes(`http://127.0.0.1:${port}/small.bin`, { maxBytes: 1024 * 1024, timeoutMs: 5000 })
      expect(result.truncated).toBe(false)
      expect(result.bytes.toString()).toBe('small-body')
    } finally {
      server.close()
      mediaFetchOptions.allowPrivate = false
    }
  })
})
