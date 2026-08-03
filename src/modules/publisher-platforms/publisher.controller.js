import * as service from './publisher.service.js';
import { sendSuccess, sendCreated, sendPaginated } from '../../../shared/utils/response.utils.js';

export async function submitAccount(req, res, next) {
  try {
    const { platformCode, profileUrl } = req.body;
    const account = await service.submitAccount(req.user.id, platformCode, profileUrl);
    return sendCreated(res, account, 'Account submitted for verification');
  } catch (error) {
    next(error);
  }
}

export async function listMyAccounts(req, res, next) {
  try {
    const accounts = await service.listMyAccounts(req.user.id);
    return sendSuccess(res, accounts);
  } catch (error) {
    next(error);
  }
}

export async function removeAccount(req, res, next) {
  try {
    await service.removeAccount(req.user.id, req.params.id);
    return sendSuccess(res, null, 'Account removed');
  } catch (error) {
    next(error);
  }
}

export async function disconnectAll(req, res, next) {
  try {
    await service.disconnectAllAccounts(req.user.id);
    return sendSuccess(res, null, 'All accounts disconnected');
  } catch (error) {
    next(error);
  }
}

export async function listAllAccounts(req, res, next) {
  try {
    const result = await service.listAllAccounts({
      status: req.query.status,
      page: parseInt(req.query.page, 10) || 1,
      limit: Math.min(parseInt(req.query.limit, 10) || 20, 100),
    });
    return sendPaginated(res, result.accounts, { page: result.page, limit: result.limit, total: result.total });
  } catch (error) {
    next(error);
  }
}

export async function verifyAccount(req, res, next) {
  try {
    const account = await service.verifyAccount(req.params.id, req.body.status, req.user.id);
    return sendSuccess(res, account, `Account ${req.body.status}`);
  } catch (error) {
    next(error);
  }
}

export async function getInsights(req, res, next) {
  try {
    const data = await service.getAccountInsights(req.params.id);
    return sendSuccess(res, data);
  } catch (error) {
    next(error);
  }
}

export async function adminRemoveAccount(req, res, next) {
  try {
    await service.adminRemoveAccount(req.user.id, req.params.id);
    return sendSuccess(res, null, 'Account removed');
  } catch (error) {
    next(error);
  }
}
