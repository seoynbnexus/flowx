import * as userService from './user.service.js';
import { sendSuccess, sendCreated, sendPaginated, sendNoContent } from '../../../shared/utils/response.utils.js';

export async function getProfile(req, res, next) {
  try {
    const userId = req.params.id || req.user.id;
    const user = await userService.getProfile(userId);
    return sendSuccess(res, user);
  } catch (error) {
    next(error);
  }
}

export async function updateProfile(req, res, next) {
  try {
    const userId = req.user.id;
    const user = await userService.updateProfile(userId, req.body);
    return sendSuccess(res, user, 'Profile updated');
  } catch (error) {
    next(error);
  }
}

export async function createUser(req, res, next) {
  try {
    const user = await userService.adminCreateUser(req.body);
    return sendCreated(res, user, 'User created');
  } catch (error) {
    next(error);
  }
}

export async function searchUsers(req, res, next) {
  try {
    const { q, limit } = req.query;
    const users = await userService.searchUsers(q, limit);
    return sendSuccess(res, users);
  } catch (error) {
    next(error);
  }
}

export async function listUsers(req, res, next) {
  try {
    const result = await userService.listUsers(req.query);
    return sendPaginated(res, result.users, {
      page: result.page,
      limit: result.limit,
      total: result.total,
      totalPages: Math.ceil(result.total / result.limit),
    });
  } catch (error) {
    next(error);
  }
}

export async function updateStatus(req, res, next) {
  try {
    const user = await userService.updateUserStatus(req.params.id, req.body.status);
    return sendSuccess(res, user, 'User status updated');
  } catch (error) {
    next(error);
  }
}

export async function deleteUser(req, res, next) {
  try {
    await userService.deleteUser(req.params.id);
    return sendNoContent(res);
  } catch (error) {
    next(error);
  }
}

export async function changePassword(req, res, next) {
  try {
    await userService.changePassword(req.user.id, req.body.currentPassword, req.body.newPassword);
    return sendSuccess(res, null, 'Password changed successfully');
  } catch (error) {
    next(error);
  }
}

export async function getUserRoles(req, res, next) {
  try {
    const roles = await userService.getUserRoles(req.params.id);
    return sendSuccess(res, roles);
  } catch (error) {
    next(error);
  }
}

export async function assignRole(req, res, next) {
  try {
    await userService.assignRoleToUser(req.params.id, req.body.roleId);
    return sendSuccess(res, null, 'Role assigned');
  } catch (error) {
    next(error);
  }
}

export async function removeRole(req, res, next) {
  try {
    await userService.removeRoleFromUser(req.params.id, req.params.roleId);
    return sendNoContent(res);
  } catch (error) {
    next(error);
  }
}
