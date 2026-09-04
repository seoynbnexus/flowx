import { Router } from 'express'
import { authenticate, requirePermission } from '../../../shared/middleware/auth.middleware.js'
import { resubscribeAllWebhooks } from './meta-webhook.service.js'
import { sendSuccess } from '../../../shared/utils/response.utils.js'

const router = Router()

router.use(authenticate, requirePermission('webhooks.manage', 'ai.admin'))

router.post('/webhooks/resubscribe', async (req, res, next) => {
  try {
    const result = await resubscribeAllWebhooks()
    return sendSuccess(res, result)
  } catch (err) {
    next(err)
  }
})

router.get('/webhooks/health', async (req, res, next) => {
  try {
    const { getWebhookInboxStats } = await import('./campaign.repository.js')
    const stats = await getWebhookInboxStats()
    return sendSuccess(res, stats)
  } catch (err) {
    next(err)
  }
})

router.get('/webhooks', async (req, res, next) => {
  try {
    const { query } = await import('../../../shared/database/connection.js')
    const status = String(req.query.status || 'dead')
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20))
    const allowed = new Set(['dead', 'retryable', 'received', 'processing', 'processed', 'ignored'])
    const filter = allowed.has(status) ? status : 'dead'
    const rows = await query(
      `SELECT id, provider_event_key, object_type, platform, event_type, external_object_id, event_time, processing_status, attempts, last_error, created_at, received_at, processed_at
       FROM meta_webhook_events WHERE processing_status = ? ORDER BY created_at DESC LIMIT ?`,
      [filter, String(limit)]
    )
    return sendSuccess(res, { status: filter, limit, items: rows })
  } catch (err) {
    next(err)
  }
})

router.post('/webhooks/:id/replay', async (req, res, next) => {
  try {
    const { query } = await import('../../../shared/database/connection.js')
    const { requeueAutoJob } = await import('./campaign.repository.js')
    const { CAMPAIGN_JOB_TYPES } = await import('./campaign.model.js')
    const id = req.params.id
    const row = await query('SELECT id, provider_event_key, processing_status FROM meta_webhook_events WHERE id = ? LIMIT 1', [id])
    if (!row.length) return res.status(404).json({ success: false, message: 'Webhook event not found' })
    const providerKey = row[0].provider_event_key
    await query("UPDATE meta_webhook_events SET processing_status = 'retryable', next_attempt_at = NOW(), attempts = 0, last_error = NULL WHERE id = ?", [id])
    const runKey = providerKey ? `webhook:${providerKey.slice(0, 32)}` : `webhook:${id}`
    await requeueAutoJob(null, CAMPAIGN_JOB_TYPES.META_WEBHOOK, { eventId: id, providerEventKey: providerKey }, {
      runKey,
      entityType: 'system',
    })
    return sendSuccess(res, { replayed: true, id })
  } catch (err) {
    next(err)
  }
})

export default router
