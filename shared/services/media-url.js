import http from 'node:http'
import https from 'node:https'
import dns from 'node:dns/promises'
import net from 'node:net'

export const mediaFetchOptions = {
  timeoutMs: Number(process.env.POST_MEDIA_FETCH_TIMEOUT_MS) || 10000,
  maxRedirects: Number(process.env.POST_MEDIA_MAX_REDIRECTS) || 5,
  maxBodyBytes: Number(process.env.POST_MEDIA_MAX_BODY_BYTES) || 2 * 1024 * 1024,
  allowPrivate: process.env.POST_MEDIA_ALLOW_PRIVATE === '1',
  sizeHeadFallbackRange: true,
}

export function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, octet) => (acc << 8) | Number(octet), 0) >>> 0
}

export function isBlockedAddress(address) {
  if (!address) return true
  if (net.isIP(address) === 4) {
    const n = ipv4ToInt(address)
    const b1 = n >>> 24
    const b2 = (n >>> 16) & 0xff
    const b3 = (n >>> 8) & 0xff
    if (b1 === 0) return true
    if (b1 === 10) return true
    if (b1 === 127) return true
    if (b1 === 169 && b2 === 254) return true
    if (b1 === 172 && b2 >= 16 && b2 <= 31) return true
    if (b1 === 192 && b2 === 168) return true
    if (b1 === 100 && b2 >= 64 && b2 <= 127) return true
    if (b1 === 192 && b2 === 0 && b3 === 0) return true
    if (b1 === 192 && b2 === 0 && b3 === 2) return true
    if (b1 === 198 && (b2 === 18 || b2 === 19)) return true
    if (b1 === 198 && b2 === 51 && b3 === 100) return true
    if (b1 === 203 && b2 === 0 && b3 === 113) return true
    if (b1 >= 224) return true
    return false
  }
  if (net.isIP(address) === 6) {
    const lower = address.toLowerCase()
    if (lower === '::' || lower === '::1') return true
    if (lower.startsWith('::ffff:')) {
      const mapped = lower.slice('::ffff:'.length)
      if (mapped.includes(':')) return true
      return isBlockedAddress(mapped)
    }
    if (lower.startsWith('fe')) {
      const third = lower.charAt(2)
      if (/[89ab]/.test(third)) return true
    }
    if (/^f[cd]/.test(lower)) return true
    if (/^ff/.test(lower)) return true
    if (lower.startsWith('2001:db8')) return true
    return false
  }
  return true
}

export function isPublicHttpUrl(url) {
  if (!url || typeof url !== 'string') return false
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

export function buildLookup() {
  return (hostname, options, callback) => {
    const family = options?.family || 0
    dns
      .lookup(hostname, { all: true, family })
      .then((addresses) => {
        if (!addresses.length) {
          const err = new Error(`Could not resolve host: ${hostname}`)
          err.code = 'ENOTFOUND'
          err.hostname = hostname
          callback(err)
          return
        }
        if (!mediaFetchOptions.allowPrivate) {
          const blocked = addresses.filter((a) => isBlockedAddress(a.address))
          if (blocked.length) {
            const err = new Error(`Media URL host ${hostname} resolves to a blocked address (${blocked.map((a) => a.address).join(',')})`)
            err.code = 'MEDIA_SSRF_BLOCKED'
            err.hostname = hostname
            err.addresses = addresses.map((a) => a.address)
            callback(err)
            return
          }
        }
        if (options?.all) {
          callback(null, addresses)
          return
        }
        const first = addresses[0]
        callback(null, first.address, first.family)
      })
      .catch((err) => callback(err))
  }
}

export function resolveMediaHost(urlString) {
  const url = new URL(urlString)
  const hostname = url.hostname
  if (net.isIP(hostname)) {
    return Promise.resolve({
      hostname,
      addresses: [hostname],
      blocked: mediaFetchOptions.allowPrivate ? [] : [hostname].filter(isBlockedAddress),
    })
  }
  return dns.lookup(hostname, { all: true }).then((addresses) => ({
    hostname,
    addresses: addresses.map((a) => a.address),
    blocked: mediaFetchOptions.allowPrivate ? [] : addresses.map((a) => a.address).filter(isBlockedAddress),
  }))
}

async function safeRequest(urlString, { method = 'GET', headers = {}, timeoutMs = mediaFetchOptions.timeoutMs, signal } = {}) {
  const url = new URL(urlString)
  if (!isPublicHttpUrl(urlString)) {
    const err = new Error('Media URL must be http(s)')
    err.code = 'MEDIA_URL_INVALID'
    throw err
  }
  const mod = url.protocol === 'https:' ? https : http
  let currentUrl = url
  let redirects = 0

  for (;;) {
    if (!mediaFetchOptions.allowPrivate && net.isIP(currentUrl.hostname) && isBlockedAddress(currentUrl.hostname)) {
      const err = new Error(`Media URL host ${currentUrl.hostname} is a blocked address`)
      err.code = 'MEDIA_SSRF_BLOCKED'
      err.hostname = currentUrl.hostname
      throw err
    }
    const res = await new Promise((resolve, reject) => {
      const req = mod.request(
        currentUrl,
        {
          method,
          headers,
          lookup: buildLookup(),
          signal,
        },
        resolve
      )
      req.setTimeout(timeoutMs, () => {
        const err = new Error(`Request timed out after ${timeoutMs}ms`)
        err.code = 'ETIMEDOUT'
        req.destroy(err)
      })
      req.on('error', reject)
      req.end()
    })

    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume()
      redirects += 1
      if (redirects > mediaFetchOptions.maxRedirects) {
        const err = new Error('Too many redirects')
        err.code = 'MEDIA_TOO_MANY_REDIRECTS'
        throw err
      }
      currentUrl = new URL(res.headers.location, currentUrl)
      continue
    }
    return { res, finalUrl: currentUrl }
  }
}

export async function inspectMediaSize(urlString, { maxBytes = mediaFetchOptions.maxBodyBytes, timeoutMs = mediaFetchOptions.timeoutMs, signal } = {}) {
  try {
    const head = await safeRequest(urlString, { method: 'HEAD', timeoutMs, signal })
    const contentType = head.res.headers['content-type'] || null
    const contentLength = head.res.headers['content-length']
    head.res.resume()
    head.res.on('error', () => {})

    if (head.res.statusCode >= 200 && head.res.statusCode < 300 && contentLength != null) {
      const sizeBytes = Number(contentLength)
      return {
        status: sizeBytes <= maxBytes ? 'KNOWN_VALID' : 'KNOWN_TOO_LARGE',
        sizeBytes,
        contentType,
        method: 'HEAD',
        statusCode: head.res.statusCode,
      }
    }

    if (mediaFetchOptions.sizeHeadFallbackRange) {
      const range = await safeRequest(urlString, {
        method: 'GET',
        headers: { Range: 'bytes=0-0' },
        timeoutMs,
        signal,
      })
      const res = range.res
      const rangeContentType = res.headers['content-type'] || null
      if (res.statusCode === 206 && res.headers['content-range']) {
        const match = String(res.headers['content-range']).match(/\/(\d+)\s*$/)
        res.resume()
        res.on('error', () => {})
        if (match) {
          const sizeBytes = Number(match[1])
          return {
            status: sizeBytes <= maxBytes ? 'KNOWN_VALID' : 'KNOWN_TOO_LARGE',
            sizeBytes,
            contentType: rangeContentType,
            method: 'RANGE',
            statusCode: res.statusCode,
          }
        }
      }
      res.resume()
      res.on('error', () => {})
      return {
        status: 'UNKNOWN_SIZE',
        sizeBytes: null,
        contentType: rangeContentType,
        method: 'RANGE',
        statusCode: res.statusCode,
      }
    }

    return {
      status: head.res.statusCode === 200 ? 'UNKNOWN_SIZE' : 'UNAVAILABLE',
      sizeBytes: null,
      contentType,
      method: 'HEAD',
      statusCode: head.res.statusCode,
    }
  } catch (err) {
    if (err?.code === 'MEDIA_SSRF_BLOCKED' || err?.code === 'MEDIA_URL_INVALID') {
      throw err
    }
    return {
      status: 'UNAVAILABLE',
      sizeBytes: null,
      contentType: null,
      method: 'NONE',
      statusCode: null,
      reason: err?.message || String(err),
    }
  }
}

export async function fetchBoundedBytes(urlString, { maxBytes = mediaFetchOptions.maxBodyBytes, timeoutMs = mediaFetchOptions.timeoutMs, signal } = {}) {
  const { res, finalUrl } = await safeRequest(urlString, { method: 'GET', timeoutMs, signal })
  const contentType = res.headers['content-type'] || null

  return new Promise((resolve, reject) => {
    const chunks = []
    let received = 0
    let truncated = false
    let settled = false

    const finish = (err) => {
      if (settled) return
      settled = true
      if (err) return reject(err)
      resolve({
        bytes: Buffer.concat(chunks),
        truncated,
        contentType,
        statusCode: res.statusCode,
        finalUrl: finalUrl.href,
      })
    }

    res.on('data', (chunk) => {
      received += chunk.length
      if (received > maxBytes) {
        truncated = true
        res.destroy()
        return
      }
      chunks.push(chunk)
    })
    res.on('end', () => finish())
    res.on('close', () => finish())
    res.on('error', finish)
  })
}

export function sanitizeMediaUrl(urlString) {
  if (!urlString || typeof urlString !== 'string') return urlString
  try {
    const parsed = new URL(urlString)
    parsed.search = ''
    parsed.hash = ''
    return parsed.href
  } catch {
    return urlString.replace(/([?&#])[^#?&\s]*/g, '')
  }
}
