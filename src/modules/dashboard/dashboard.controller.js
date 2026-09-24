import * as service from './dashboard.service.js'
import { sendSuccess } from '../../../shared/utils/response.utils.js'

export async function getClientDashboard(req, res, next) {
  try {
    const data = await service.getClientDashboard(req.user.id)
    return sendSuccess(res, data)
  } catch (error) { next(error) }
}

export async function getPublisherDashboard(req, res, next) {
  try {
    const data = await service.getPublisherDashboard(req.user.id)
    return sendSuccess(res, data)
  } catch (error) { next(error) }
}

export async function getAdminDashboard(req, res, next) {
  try {
    const data = await service.getAdminDashboard()
    return sendSuccess(res, data)
  } catch (error) { next(error) }
}

export async function getClientDashboardForAdmin(req, res, next) {
  try {
    const data = await service.getClientDashboard(req.params.id)
    return sendSuccess(res, data)
  } catch (error) { next(error) }
}

export async function getPublisherDashboardForAdmin(req, res, next) {
  try {
    const data = await service.getPublisherDashboard(req.params.id)
    return sendSuccess(res, data)
  } catch (error) { next(error) }
}
