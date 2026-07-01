import * as repo from './oauth.repository.js';
import { generateOAuthUrl as buildAuthUrl, exchangeCodeForToken, exchangeForLongLivedToken, debugToken } from '../../../shared/services/meta-auth.service.js';
import { getFacebookPages, getInstagramBusinessAccount, getInstagramProfile, getMe } from '../../../shared/services/meta-graph.service.js';
import { generateUuid } from '../../../shared/utils/uuid.utils.js';
import { isMetaConfigured } from '../../../shared/services/meta-oauth.config.js';
import { NotFoundError } from '../../../shared/errors/AppError.js';

const STATE_MAP = new Map();

export async function generateOAuthUrl(userId, platformCode = 'instagram') {
  if (!isMetaConfigured()) {
    throw new NotFoundError('Meta OAuth is not configured. Contact the administrator.');
  }

  const stateId = generateUuid();
  STATE_MAP.set(stateId, { userId, platformCode, createdAt: Date.now() });

  const url = buildAuthUrl(stateId, platformCode);
  return { url };
}

export async function handleOAuthCallback(code, stateData) {
  const stateId = stateData?.state;
  const platformCode = stateData?.platformCode || 'instagram';

  if (!stateId || !STATE_MAP.has(stateId)) {
    return { success: false, error: 'Invalid or expired state parameter' };
  }

  const stateInfo = STATE_MAP.get(stateId);
  STATE_MAP.delete(stateId);

  if (Date.now() - stateInfo.createdAt > 600000) {
    return { success: false, error: 'OAuth session expired. Please try again.' };
  }

  const userId = stateInfo.userId;

  try {
    const tokenData = await exchangeCodeForToken(code);
    const userAccessToken = tokenData.access_token;

    if (!userAccessToken) {
      return { success: false, error: 'No access token received from Meta' };
    }

    const longLivedData = await exchangeForLongLivedToken(userAccessToken);
    const accessToken = longLivedData.access_token || userAccessToken;
    const expiresIn = longLivedData.expires_in || tokenData.expires_in || 60 * 24 * 60 * 60;

    const tokenExpiresAt = new Date(Date.now() + expiresIn * 1000);
    const tokenIssuedAt = new Date();

    const fbPages = await getFacebookPages(accessToken);
    let igBusinessAccount = null;
    let pageToken = null;
    let pageId = null;

    for (const page of fbPages) {
      const igAccount = await getInstagramBusinessAccount(page.id, page.access_token);
      if (igAccount) {
        igBusinessAccount = igAccount;
        pageToken = page.access_token;
        pageId = page.id;
        break;
      }
    }

    if (!igBusinessAccount) {
      const me = await getMe(accessToken);
      return {
        success: false,
        error: 'No Instagram Business or Creator account found. Please ensure your Instagram account is converted to a Business or Creator account and linked to a Facebook Page.',
      };
    }

    const igProfile = await getInstagramProfile(igBusinessAccount.id, pageToken || accessToken);

    const platform = await repo.findPlatformByCode(platformCode);
    if (!platform) {
      return { success: false, error: 'Platform not found' };
    }

    const existing = await repo.findExistingByUserAndPlatform(userId, platform.id);

    let account;
    if (existing) {
      account = await repo.updateOAuthAccount(existing.id, {
        profileUrl: `https://instagram.com/${igProfile.username}`,
        username: igProfile.username,
        displayName: igProfile.name || igProfile.username,
        avatarUrl: igProfile.profile_picture_url,
        followersCount: igProfile.followers_count,
        platformUserId: igProfile.id,
        igAccountType: 'business',
        igBusinessAccountId: igBusinessAccount.id,
        accessToken,
        refreshToken: null,
        tokenExpiresAt,
        tokenIssuedAt,
        tokenStatus: 'active',
        verificationStatus: 'pending',
      });
    } else {
      account = await repo.createOAuthAccount({
        id: generateUuid(),
        userId,
        platformId: platform.id,
        profileUrl: `https://instagram.com/${igProfile.username}`,
        username: igProfile.username,
        displayName: igProfile.name || igProfile.username,
        avatarUrl: igProfile.profile_picture_url,
        followersCount: igProfile.followers_count,
        platformUserId: igProfile.id,
        igAccountType: 'business',
        igBusinessAccountId: igBusinessAccount.id,
        accessToken,
        refreshToken: null,
        tokenExpiresAt,
        tokenIssuedAt,
        oauthProvider: 'meta',
      });
    }

    return {
      success: true,
      accountId: account.id,
      platformCode,
    };
  } catch (error) {
    return { success: false, error: error.message || 'OAuth callback processing failed' };
  }
}

export async function getConnectionStatus(userId, platformCode = 'instagram') {
  const platform = await repo.findPlatformByCode(platformCode);
  if (!platform) {
    return { connected: false, account: null };
  }

  const existing = await repo.findExistingByUserAndPlatform(userId, platform.id);
  if (!existing) {
    return { connected: false, account: null };
  }

  return {
    connected: true,
    account: {
      id: existing.id,
      platformUsername: existing.platformUsername,
      platformDisplayName: existing.platformDisplayName,
      avatarUrl: existing.avatarUrl,
      followersCount: existing.followersCount,
      verificationStatus: existing.verificationStatus,
      tokenStatus: existing.tokenStatus,
      instagramAccountType: existing.instagramAccountType,
      profileUrl: existing.profileUrl,
      createdAt: existing.createdAt,
    },
  };
}
