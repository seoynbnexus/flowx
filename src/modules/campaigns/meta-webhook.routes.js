import { Router } from 'express'
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import { webhookVerify, webhookReceive } from './meta-webhook.controller.js'

const webhookIpLimiter = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.META_WEBHOOK_RPM) || 120,
  keyGenerator: (req) => ipKeyGenerator(req.ip || req.headers['x-forwarded-for'] || 'unknown'),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ success: false, message: 'Too many webhook requests' }),
})

const webhookGlobalLimiter = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.META_WEBHOOK_GLOBAL_RPM) || 600,
  keyGenerator: () => 'global',
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ success: false, message: 'Webhook global rate limit exceeded' }),
})

const router = Router()

router.get('/', webhookVerify)
router.post('/', webhookGlobalLimiter, webhookIpLimiter, webhookReceive)

export default router