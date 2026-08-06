import { Router } from 'express'
import { webhookVerify, webhookReceive } from './meta-webhook.controller.js'

const router = Router()

router.get('/', webhookVerify)
router.post('/', webhookReceive)

export default router