const IS_DEV = process.env.NODE_ENV === 'development'

function sanitizeUrl(url) {
  try {
    const u = new URL(url)
    if (u.searchParams.has('access_token')) {
      u.searchParams.set('access_token', '***')
    }
    return u.toString()
  } catch {
    return url
  }
}

export async function apiFetch(url, options = {}, { service, operation } = {}) {
  if (!IS_DEV) return fetch(url, options)

  const start = Date.now()
  const label = `[API] ${service}.${operation}`
  const safeUrl = sanitizeUrl(url)

  try {
    const res = await fetch(url, options)
    const ms = Date.now() - start
    console.log(`${label} → ${res.status} (${ms}ms) ${safeUrl}`)
    if (!res.ok) {
      const clone = res.clone()
      const body = await clone.text().catch(() => '(empty)')
      console.warn(`${label} body:`, body.substring(0, 500))
    }
    return res
  } catch (err) {
    const ms = Date.now() - start
    console.error(`${label} → ERROR (${ms}ms): ${err.message} ${safeUrl}`)
    throw err
  }
}

export async function wrapSdkCall({ service, operation }, fn) {
  if (!IS_DEV) return fn()

  const start = Date.now()
  const label = `[API] ${service}.${operation}`

  try {
    const result = await fn()
    const ms = Date.now() - start
    console.log(`${label} ✓ (${ms}ms)`)
    return result
  } catch (err) {
    const ms = Date.now() - start
    console.error(`${label} ✗ (${ms}ms): ${err.message}`)
    throw err
  }
}

export function logTiming({ service, operation, ms, success = true, errorMessage }) {
  if (!IS_DEV) return
  const label = `[API] ${service}.${operation}`
  if (success) {
    console.log(`${label} ✓ (${ms}ms)`)
  } else {
    console.error(`${label} ✗ (${ms}ms): ${errorMessage}`)
  }
}
