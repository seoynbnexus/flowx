import dotenv from 'dotenv'
dotenv.config()

import path from 'path'
import { fileURLToPath } from 'url'
import pino from 'pino'
import { pinoHttp } from 'pino-http'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const isTest = process.env.NODE_ENV === 'test'
const level = process.env.LOG_LEVEL || 'info'
const logDir = process.env.LOG_DIR || path.resolve(__dirname, '../../logs')
const retentionDays = Number(process.env.LOG_RETENTION_DAYS) || 14

const SENSITIVE_PARAMS = ['access_token', 'code', 'state', 'refresh_token', 'token']

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

function createTransport() {
  if (isTest) return undefined
  const targets = [
    { target: 'pino/file', options: { destination: 1 } },
    {
      target: 'pino-roll',
      options: {
        file: path.join(logDir, 'app.log'),
        frequency: 'daily',
        dateFormat: 'yyyy-MM-dd',
        mkdir: true,
        keep: retentionDays,
        compress: true,
      },
    },
  ]
  return pino.transport({ targets })
}

const logger = pino({ level: isTest ? 'silent' : level }, createTransport())

const reqSerializer = (req) => ({
  id: req.id,
  method: req.method,
  url: sanitizeUrl(req.url),
})

const resSerializer = (res) => ({
  statusCode: res.statusCode,
})

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

export { logger, httpLogger, sanitizeUrl }
