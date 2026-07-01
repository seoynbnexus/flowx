import * as oauthService from './oauth.service.js';
import { sendSuccess, sendCreated } from '../../../shared/utils/response.utils.js';
import { isMetaConfigured } from '../../../shared/services/meta-oauth.config.js';

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

export async function getOAuthUrl(req, res, next) {
  try {
    if (!isMetaConfigured()) {
      return sendSuccess(res, { configured: false, url: null }, 'Meta OAuth not configured');
    }
    const { platformCode = 'instagram' } = req.query;
    const result = await oauthService.generateOAuthUrl(req.user.id, platformCode);
    return sendSuccess(res, { configured: true, url: result.url });
  } catch (error) {
    next(error);
  }
}

export async function handleCallback(req, res, next) {
  try {
    const { code, state: stateParam } = req.query;

    if (!code) {
      return res.redirect(`${FRONTEND_URL}/meta/callback?error=no_code`);
    }

    let stateData;
    try {
      stateData = JSON.parse(stateParam);
    } catch {
      stateData = {};
    }

    const result = await oauthService.handleOAuthCallback(code, stateData);

    if (result.success) {
      return res.redirect(`${FRONTEND_URL}/meta/callback?success=true&platform=${result.platformCode || 'instagram'}&accountId=${result.accountId}`);
    }
    return res.redirect(`${FRONTEND_URL}/meta/callback?error=${encodeURIComponent(result.error || 'unknown')}`);
  } catch (error) {
    const message = error.message || 'OAuth callback failed';
    return res.redirect(`${FRONTEND_URL}/meta/callback?error=${encodeURIComponent(message)}`);
  }
}

export async function getConnectionStatus(req, res, next) {
  try {
    const { platformCode = 'instagram' } = req.query;
    const status = await oauthService.getConnectionStatus(req.user.id, platformCode);
    return sendSuccess(res, status);
  } catch (error) {
    next(error);
  }
}
