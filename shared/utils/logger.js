import dotenv from 'dotenv'
dotenv.config()

import path from 'path'
import { fileURLToPath } from 'url'
import pino from 'pino'
import { pinoHttp } from 'pino-http'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const isTest = process.env.NODE_ENV === 'test'
const isDev = process.env.NODE_ENV === 'development'
const level = process.env.LOG_LEVEL || 'info'
const logDir = process.env.LOG_DIR || path.resolve(__dirname, '../../logs')
const retentionDays = Number(process.env.LOG_RETENTION_DAYS) || 14

const SENSITIVE_PARAMS = ['access_token', 'code', 'state', 'refresh_token', 'token']
const SENSITIVE_KEYS = new Set([
  'password',
  'token',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'otp',
  'secret',
  'authorization',
  'cookie',
  'setCookie',
])

const BODY_LIMIT = 2048

function sanitizeUrl(url) {
  try {
    const u = new URL(url, 'http://localhost')
    for (const key of SENSITIVE_PARAMS) {
      if (u.searchParams.has(key)) u.searchParams.set(key, '[REDACTED]')
    }
    return u.pathname + u.search
  } catch {
    return url
  }
}

export function redactSensitive(value, seen = new Set()) {
  if (value == null) return value
  if (typeof value !== 'object') return value
  if (seen.has(value)) return '[CIRCULAR]'
  seen.add(value)
  if (Array.isArray(value)) return value.map(item => redactSensitive(item, seen))
  const out = {}
  for (const [key, val] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(key)) {
      out[key] = '[REDACTED]'
    } else {
      out[key] = redactSensitive(val, seen)
    }
  }
  return out
}

export function truncateBody(value) {
  if (value == null) return value
  if (typeof value !== 'string') return value
  if (value.length <= BODY_LIMIT) return value
  return `${value.slice(0, BODY_LIMIT)}…[truncated ${value.length - BODY_LIMIT} chars]`
}

function safeBody(value) {
  if (value == null) return undefined
  try {
    return truncateBody(JSON.stringify(redactSensitive(value)))
  } catch {
    return '[unserializable]'
  }
}

function createTransport() {
  if (isTest) return undefined
  const targets = []
  if (isDev) {
    targets.push({
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
        singleLine: true,
        ignore: 'pid,hostname',
      },
    })
  } else {
    targets.push({ target: 'pino/file', options: { destination: 1 } })
  }
  targets.push({
    target: 'pino-roll',
    options: {
      file: path.join(logDir, 'app.log'),
      frequency: 'daily',
      dateFormat: 'yyyy-MM-dd',
      mkdir: true,
      keep: retentionDays,
      compress: true,
    },
  })
  return pino.transport({ targets })
}

const logger = pino({ level: isTest ? 'silent' : level }, createTransport())

const reqSerializer = (req) => {
  const raw = req.raw || req
  const base = {
    id: req.id,
    method: req.method,
    url: sanitizeUrl(req.url),
  }
  if (raw.user?.id) base.userId = raw.user.id
  if (raw.ip) base.ip = raw.ip
  const hasBody = ['POST', 'PUT', 'PATCH'].includes(raw.method)
  if (hasBody && raw.body && typeof raw.body === 'object' && !Buffer.isBuffer(raw.body)) {
    base.body = safeBody(raw.body)
  }
  return base
}

const resSerializer = (res) => {
  const raw = res.raw || res
  const base = {
    statusCode: res.statusCode ?? raw.statusCode,
  }
  if (raw.getHeader?.('content-type')) base.contentType = raw.getHeader('content-type')
  if (raw.getHeader?.('content-length')) base.contentLength = raw.getHeader('content-length')
  const body = raw.locals?._logBody
  if (body != null && typeof body === 'string') {
    base.body = truncateBody(body)
  }
  return base
}

const httpLogger = pinoHttp({
  logger,
  serializers: {
    req: reqSerializer,
    res: resSerializer,
  },
  customLogLevel: (req, res, err) => {
    if (err || res.statusCode >= 500) return 'error'
    if (res.statusCode >= 400) return 'warn'
    return 'info'
  },
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
    censor: '[REDACTED]',
  },
})

export { logger, httpLogger, sanitizeUrl, safeBody }
