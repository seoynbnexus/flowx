import * as permissionService from './permission.service.js';
import { sendSuccess } from '../../../shared/utils/response.utils.js';

export async function list(req, res, next) {
  try {
    const permissions = await permissionService.list();
    return sendSuccess(res, permissions);
  } catch (error) {
    next(error);
  }
}

export async function listModules(req, res, next) {
  try {
    const modules = await permissionService.listModules();
    return sendSuccess(res, modules);
  } catch (error) {
    next(error);
  }
}
