import * as repo from './notifications.repository.js'
import { sendNewCampaignRequestEmail } from '../../../shared/mailer/mailer.js'

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000'

export async function createAndSend(userId, type, title, body, data = null, userEmail = null, userFirstName = null) {
  await repo.createNotification(userId, type, title, body, data)

  if (userEmail && type === 'new_campaign_request') {
    try {
      await sendNewCampaignRequestEmail(userEmail, userFirstName || '', data?.campaignName || 'Campaign', data?.coinsOffered || 0, FRONTEND_URL)
    } catch (err) {
      console.warn(`[notifications] Email send failed for ${userEmail}: ${err.message}`)
    }
  }
}

export async function getUnreadCount(userId) {
  return repo.getUnreadCount(userId)
}

export async function listNotifications(userId, queryParams) {
  const page = parseInt(queryParams.page, 10) || 1
  const limit = Math.min(parseInt(queryParams.limit, 10) || 20, 100)
  return repo.getNotifications(userId, page, limit)
}

export async function markAsRead(userId, body) {
  if (body.all) {
    return repo.markAllAsRead(userId)
  }
  if (body.ids && Array.isArray(body.ids) && body.ids.length > 0) {
    return repo.markAsRead(body.ids, userId)
  }
  return 0
}
