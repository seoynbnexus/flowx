import { sendError, sendSuccess } from '../../../shared/utils/response.utils.js'
import { verifyWebhookSignature, processMetaWebhookEvents } from './meta-webhook.service.js'

export async function webhookVerify(req, res) {
  const mode = req.query['hub.mode']
  const token = req.query['hub.verify_token']
  const challenge = req.query['hub.challenge']

  if (mode === 'subscribe' && token && token === process.env.META_WEBHOOK_VERIFY_TOKEN) {
    return res.send(challenge)
  }
  return sendError(res, 403, 'Verification token mismatch')
}

export async function webhookReceive(req, res, next) {
  try {
    const secret = process.env.META_WEBHOOK_APP_SECRET || process.env.META_APP_SECRET
    const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}))
    const signature = req.headers['x-hub-signature-256']

    if (!verifyWebhookSignature(rawBody, signature, secret)) {
      return sendError(res, 401, 'Invalid webhook signature')
    }

    let body = req.body
    if (!body || Object.keys(body).length === 0) {
      body = JSON.parse(rawBody.toString('utf8'))
    }

    const result = await processMetaWebhookEvents(body)
    return sendSuccess(res, result)
  } catch (error) {
    next(error)
  }
}