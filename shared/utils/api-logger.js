import { logger, sanitizeUrl } from './logger.js'

const IS_DEV = process.env.NODE_ENV === 'development'
const successLevel = IS_DEV ? 'info' : 'debug'
// A hung outbound Meta call never resolves on its own — without a timeout it
// can pin a job "running" indefinitely, which is exactly what makes the
// campaign_jobs stale-reclaim (10 min) treat a still-alive worker as dead and
// double-dispatch the same job. A bounded timeout guarantees every call
// eventually fails and lets normal job backoff take over.
export const apiFetchTimeoutMs = Number(process.env.META_HTTP_TIMEOUT_MS) || 30000

export async function apiFetch(url, options = {}, { service, operation } = {}) {
  const start = Date.now()
  const fetchOptions = options.signal ? options : { ...options, signal: AbortSignal.timeout(apiFetchTimeoutMs) }

  try {
    const res = await fetch(url, fetchOptions)
    const ms = Date.now() - start
    const base = { service, operation, statusCode: res.status, ms, url: sanitizeUrl(url) }
    if (res.ok) {
      logger[successLevel](base, 'api call ok')
    } else {
      const clone = res.clone()
      const body = await clone.text().catch(() => '(empty)')
      logger.warn({ ...base, body: body.substring(0, 500) }, 'api call failed')
    }
    return res
  } catch (err) {
    const ms = Date.now() - start
    logger.error({ service, operation, ms, url: sanitizeUrl(url), message: err.message }, 'api call error')
    throw err
  }
}

export async function wrapSdkCall({ service, operation }, fn) {
  const start = Date.now()

  try {
    const result = await fn()
    const ms = Date.now() - start
    logger[successLevel]({ service, operation, ms }, 'api call ok')
    return result
  } catch (err) {
    const ms = Date.now() - start
    logger.error({ service, operation, ms, message: err.message }, 'api call error')
    throw err
  }
}

export function logTiming({ service, operation, ms, success = true, errorMessage }) {
  if (success) {
    logger[successLevel]({ service, operation, ms }, 'api call ok')
  } else {
    logger.error({ service, operation, ms, message: errorMessage }, 'api call error')
  }
}
