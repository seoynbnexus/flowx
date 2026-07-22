import { appendFile, mkdir } from 'fs/promises'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const LOG_DIR = join(__dirname, '..', '..', 'logs')
const LOG_FILE = join(LOG_DIR, 'meta-ads.log')

async function ensureLogDir() {
  try {
    await mkdir(LOG_DIR, { recursive: true })
  } catch {
    // directory already exists
  }
}

function sanitizeParams(params) {
  if (!params || typeof params !== 'object') return params
  const sanitized = { ...params }
  const secrets = ['access_token', 'accessToken', 'access.token']
  for (const key of secrets) {
    if (sanitized[key] !== undefined) {
      sanitized[key] = sanitized[key] ? '[REDACTED]' : null
    }
  }
  return sanitized
}

export async function logMetaEvent({
  campaignId,
  userId,
  action,
  objectType,
  objectId,
  params,
  response,
  error,
  durationMs,
}) {
  try {
    await ensureLogDir()
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      campaignId: campaignId || null,
      userId: userId || null,
      action: action || 'unknown',
      objectType: objectType || null,
      objectId: objectId || null,
      params: sanitizeParams(params) || null,
      response: response || null,
      error: error ? (typeof error === 'string' ? error : error.message || String(error)) : null,
      success: !error,
      durationMs: durationMs || null,
    })
    await appendFile(LOG_FILE, entry + '\n', 'utf-8')
  } catch (logErr) {
    console.error('Meta logger error:', logErr.message)
  }
}
