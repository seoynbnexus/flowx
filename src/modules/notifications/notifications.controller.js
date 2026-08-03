import * as service from './notifications.service.js'
import { sendSuccess, sendPaginated } from '../../../shared/utils/response.utils.js'

export async function getUnreadCount(req, res, next) {
  try {
    const count = await service.getUnreadCount(req.user.id)
    return sendSuccess(res, { count })
  } catch (error) {
    next(error)
  }
}

export async function listNotifications(req, res, next) {
  try {
    const result = await service.listNotifications(req.user.id, req.query)
    return sendPaginated(res, result.items, {
      page: result.page,
      limit: result.limit,
      total: result.total,
    })
  } catch (error) {
    next(error)
  }
}

export async function markRead(req, res, next) {
  try {
    const affected = await service.markAsRead(req.user.id, req.body)
    return sendSuccess(res, { marked: affected }, affected > 0 ? 'Marked as read' : 'Nothing to mark')
  } catch (error) {
    next(error)
  }
}
