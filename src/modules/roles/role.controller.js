import * as roleService from './role.service.js';
import { sendSuccess, sendCreated, sendNoContent } from '../../../shared/utils/response.utils.js';

export async function list(req, res, next) {
  try {
    const roles = await roleService.list();
    return sendSuccess(res, roles);
  } catch (error) {
    next(error);
  }
}

export async function getById(req, res, next) {
  try {
    const role = await roleService.getById(req.params.id);
    return sendSuccess(res, role);
  } catch (error) {
    next(error);
  }
}

export async function create(req, res, next) {
  try {
    const role = await roleService.create(req.body);
    return sendCreated(res, role, 'Role created');
  } catch (error) {
    next(error);
  }
}

export async function update(req, res, next) {
  try {
    const role = await roleService.update(req.params.id, req.body);
    return sendSuccess(res, role, 'Role updated');
  } catch (error) {
    next(error);
  }
}

export async function remove(req, res, next) {
  try {
    await roleService.remove(req.params.id);
    return sendNoContent(res);
  } catch (error) {
    next(error);
  }
}

export async function getPermissions(req, res, next) {
  try {
    const permissions = await roleService.getPermissions(req.params.id);
    return sendSuccess(res, permissions);
  } catch (error) {
    next(error);
  }
}

export async function assignPermissions(req, res, next) {
  try {
    await roleService.assignPermissions(req.params.id, req.body.permissionIds);
    return sendSuccess(res, null, 'Permissions assigned');
  } catch (error) {
    next(error);
  }
}
