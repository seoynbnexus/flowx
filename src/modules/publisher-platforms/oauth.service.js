import * as repo from './oauth.repository.js';
import { generateOAuthUrl as buildAuthUrl, exchangeCodeForToken, exchangeForLongLivedToken, debugToken } from '../../../shared/services/meta-auth.service.js';
import { getFacebookPages, getInstagramBusinessAccount, getInstagramProfile, getPageDetails, getPageAccessToken, getMe } from '../../../shared/services/meta-graph.service.js';
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

async function upsertUserLevelToken(userId, platform, data) {
  const existing = await repo.findUserLevelToken(userId, platform.id)

  const payload = {
    profileUrl: data.profileUrl || '',
    username: data.username || null,
    displayName: data.displayName || null,
    avatarUrl: data.avatarUrl || null,
    followersCount: data.followersCount || 0,
    platformUserId: data.platformUserId || null,
    accessToken: data.accessToken,
    refreshToken: data.refreshToken || null,
    tokenExpiresAt: data.tokenExpiresAt,
    tokenIssuedAt: data.tokenIssuedAt,
    tokenStatus: data.tokenStatus || 'active',
    tokenType: 'user',
    verificationStatus: 'verified',
  }

  if (existing) {
    payload.isActive = true
    return repo.updateOAuthAccount(existing.id, payload)
  }

  return repo.createOAuthAccount({
    id: generateUuid(),
    userId,
    platformId: platform.id,
    oauthProvider: 'meta',
    ...payload,
  })
}

async function upsertPageAccount(userId, platform, data) {
  const existing = await repo.findExistingByUserAndPlatformUserId(userId, platform.id, data.platformUserId)

  const payload = {
    profileUrl: data.profileUrl || '',
    username: data.username || null,
    displayName: data.displayName || null,
    avatarUrl: data.avatarUrl || null,
    followersCount: data.followersCount || 0,
    platformUserId: data.platformUserId,
    accessToken: data.accessToken,
    refreshToken: data.refreshToken || null,
    tokenExpiresAt: data.tokenExpiresAt,
    tokenIssuedAt: data.tokenIssuedAt,
    tokenStatus: data.tokenStatus || 'active',
    tokenType: 'page',
    verificationStatus: data.verificationStatus || 'pending',
  }

  if (existing) {
    payload.verificationStatus = existing.verificationStatus
    payload.isActive = true
    return repo.updateOAuthAccount(existing.id, payload)
  }

  return repo.createOAuthAccount({
    id: generateUuid(),
    userId,
    platformId: platform.id,
    oauthProvider: 'meta',
    ...payload,
  })
}

export async function handleOAuthCallback(code, stateData) {
  const stateId = stateData?.state;
  const platformCode = stateData?.platformCode || 'instagram';

  if (!stateId || !STATE_MAP.has(stateId)) {
    return { success: false, error: 'Invalid or expired state parameter', errorType: 'oauth' };
  }

  const stateInfo = STATE_MAP.get(stateId);
  STATE_MAP.delete(stateId);

  if (Date.now() - stateInfo.createdAt > 600000) {
    return { success: false, error: 'OAuth session expired. Please try again.', errorType: 'oauth' };
  }

  const userId = stateInfo.userId;

  try {
    const tokenData = await exchangeCodeForToken(code);
    const userAccessToken = tokenData.access_token;

    if (!userAccessToken) {
      return { success: false, error: 'No access token received from Meta', errorType: 'oauth' };
    }

    const longLivedData = await exchangeForLongLivedToken(userAccessToken);
    const accessToken = longLivedData.access_token || userAccessToken;
    const expiresIn = longLivedData.expires_in || tokenData.expires_in || 60 * 24 * 60 * 60;

    const tokenExpiresAt = new Date(Date.now() + expiresIn * 1000);
    const tokenIssuedAt = new Date();

    const fbPlatform = await repo.findPlatformByCode('facebook')
    const igPlatform = await repo.findPlatformByCode('instagram')

    if (!fbPlatform) {
      return { success: false, error: 'Facebook platform not found in database', errorType: 'system' }
    }

    // Store user-level token for future page discovery
    const fbUser = await getMe(accessToken)
    await upsertUserLevelToken(userId, fbPlatform, {
      profileUrl: `https://facebook.com/${fbUser.id}`,
      username: fbUser.name || null,
      displayName: fbUser.name || 'Facebook User',
      avatarUrl: fbUser.picture?.data?.url || null,
      platformUserId: fbUser.id,
      accessToken,
      tokenExpiresAt,
      tokenIssuedAt,
      tokenStatus: 'active',
    })

    const fbPages = await getFacebookPages(accessToken);

    if (!fbPages || fbPages.length === 0) {
      return { success: false, error: 'No Facebook Pages found. Please create a Facebook Page first.', errorType: 'oauth' }
    }

    let storedAccounts = []
    let igConnected = false

    for (const page of fbPages) {
      const pageToken = page.access_token
      let pageDetails
      try {
        pageDetails = await getPageDetails(page.id, pageToken)
      } catch {
        continue
      }

      // Store each page individually
      await upsertPageAccount(userId, fbPlatform, {
        profileUrl: `https://facebook.com/${page.id}`,
        username: pageDetails.username || null,
        displayName: pageDetails.name || page.name,
        avatarUrl: pageDetails.picture?.data?.url || page.picture?.data?.url || null,
        followersCount: pageDetails.followers_count || 0,
        platformUserId: page.id,
        accessToken: pageToken,
        tokenExpiresAt,
        tokenIssuedAt,
      })
      storedAccounts.push({ platformCode: 'facebook', accountId: page.id })

      // Check for Instagram — try each page until one succeeds
      if (!igConnected && igPlatform) {
        try {
          const igAccount = await getInstagramBusinessAccount(page.id, pageToken)
          if (!igAccount) continue
          const igProfile = await getInstagramProfile(igAccount.id, pageToken)
          await upsertPageAccount(userId, igPlatform, {
            profileUrl: `https://instagram.com/${igProfile.username}`,
            username: igProfile.username,
            displayName: igProfile.name || igProfile.username,
            avatarUrl: igProfile.profile_picture_url,
            followersCount: igProfile.followers_count,
            platformUserId: igProfile.id,
            igAccountType: 'business',
            igBusinessAccountId: igAccount.id,
            accessToken: pageToken,
            tokenExpiresAt,
            tokenIssuedAt,
          })
          igConnected = true
          storedAccounts.push({ platformCode: 'instagram', accountId: igAccount.id })
        } catch (err) {
          console.warn(`[Instagram] Skipping page ${page.id}: ${err.message}`)
        }
      }
    }

    if (storedAccounts.length === 0) {
      return {
        success: false,
        error: 'No Facebook Pages or Instagram Business accounts could be stored. Please ensure you have a Facebook Page, and optionally an Instagram Business or Creator account linked to it.',
        errorType: 'oauth',
      }
    }

    return {
      success: true,
      accounts: storedAccounts,
      platformCode: storedAccounts[0]?.platformCode || platformCode,
      accountId: storedAccounts[0]?.accountId || null,
    }
  } catch (error) {
    return { success: false, error: error.message || 'OAuth callback processing failed', errorType: 'system' };
  }
}

export async function getAvailablePages(userId) {
  const fbPlatform = await repo.findPlatformByCode('facebook')
  if (!fbPlatform) {
    throw new NotFoundError('Facebook platform not found in database')
  }

  const userToken = await repo.findUserLevelToken(userId, fbPlatform.id)
  if (!userToken || !userToken.accessToken) {
    throw new NotFoundError('No Facebook user-level token found. Please reconnect your Facebook account.')
  }

  const fbPages = await getFacebookPages(userToken.accessToken)
  if (!fbPages || fbPages.length === 0) {
    return { pages: [] }
  }

  // Get already-connected page IDs
  const existingAccounts = await repo.findAllByUserAndPlatform(userId, fbPlatform.id)
  const connectedPageIds = new Set(
    existingAccounts
      .filter(a => a.tokenType === 'page' && a.platformUserId)
      .map(a => a.platformUserId)
  )

  const available = fbPages
    .filter(page => !connectedPageIds.has(page.id))
    .map(page => ({
      id: page.id,
      name: page.name,
      picture: page.picture?.data?.url || null,
    }))

  return { pages: available }
}

export async function addPage(userId, platformUserId) {
  const fbPlatform = await repo.findPlatformByCode('facebook')
  if (!fbPlatform) {
    throw new NotFoundError('Facebook platform not found in database')
  }

  const userToken = await repo.findUserLevelToken(userId, fbPlatform.id)
  if (!userToken || !userToken.accessToken) {
    throw new NotFoundError('No Facebook user-level token found. Please reconnect your Facebook account.')
  }

  // Check not already connected
  const existing = await repo.findExistingByUserAndPlatformUserId(userId, fbPlatform.id, platformUserId)
  if (existing && existing.isActive) {
    throw new NotFoundError('This page is already connected.')
  }

  const pageToken = await getPageAccessToken(platformUserId, userToken.accessToken)
  if (!pageToken) {
    throw new NotFoundError('Could not get access token for this page.')
  }

  const pageDetails = await getPageDetails(platformUserId, pageToken)

  const account = await upsertPageAccount(userId, fbPlatform, {
    profileUrl: `https://facebook.com/${platformUserId}`,
    username: pageDetails.username || null,
    displayName: pageDetails.name || 'Facebook Page',
    avatarUrl: pageDetails.picture?.data?.url || null,
    followersCount: pageDetails.followers_count || 0,
    platformUserId,
    accessToken: pageToken,
    tokenExpiresAt: userToken.tokenExpiresAt,
    tokenIssuedAt: new Date(),
  })

  return { account }
}

export async function getAvailableInstagramAccounts(userId) {
  const fbPlatform = await repo.findPlatformByCode('facebook')
  const igPlatform = await repo.findPlatformByCode('instagram')
  if (!fbPlatform || !igPlatform) {
    throw new NotFoundError('Required platforms not found in database')
  }

  const userToken = await repo.findUserLevelToken(userId, fbPlatform.id)
  if (!userToken || !userToken.accessToken) {
    throw new NotFoundError('No Facebook user-level token found. Please reconnect your Facebook account.')
  }

  const fbPages = await repo.findAllByUserAndPlatform(userId, fbPlatform.id)
  if (fbPages.length === 0) {
    return { accounts: [] }
  }

  const existingIgAccounts = await repo.findAllByUserAndPlatform(userId, igPlatform.id)
  const connectedIgIds = new Set(
    existingIgAccounts
      .filter(a => a.tokenType === 'page' && a.platformUserId)
      .map(a => a.platformUserId)
  )

  const available = []

  for (const page of fbPages) {
    if (!page.accessToken) continue
    try {
      const igAccount = await getInstagramBusinessAccount(page.platformUserId, page.accessToken)
      if (!igAccount) continue
      if (connectedIgIds.has(igAccount.id)) continue

      available.push({
        igBusinessAccountId: igAccount.id,
        igUsername: igAccount.username || null,
        igName: igAccount.name || null,
        igProfilePicture: igAccount.profile_picture_url || null,
        followersCount: igAccount.followers_count || 0,
        linkedFbPageId: page.platformUserId,
        linkedFbPageName: page.platformDisplayName || 'Facebook Page',
      })
    } catch {
      // page has no linked Instagram — skip
    }
  }

  return { accounts: available }
}

export async function addInstagramAccount(userId, igBusinessAccountId) {
  const fbPlatform = await repo.findPlatformByCode('facebook')
  const igPlatform = await repo.findPlatformByCode('instagram')
  if (!fbPlatform || !igPlatform) {
    throw new NotFoundError('Required platforms not found in database')
  }

  const fbPages = await repo.findAllByUserAndPlatform(userId, fbPlatform.id)
  if (fbPages.length === 0) {
    throw new NotFoundError('No Facebook Pages found. Please connect a Facebook page first.')
  }

  let matchedPage = null
  let matchedIgAccount = null

  for (const page of fbPages) {
    if (!page.accessToken) continue
    try {
      const igAccount = await getInstagramBusinessAccount(page.platformUserId, page.accessToken)
      if (igAccount && igAccount.id === igBusinessAccountId) {
        matchedPage = page
        matchedIgAccount = igAccount
        break
      }
    } catch {
      continue
    }
  }

  if (!matchedPage || !matchedIgAccount) {
    throw new NotFoundError('No Facebook Page linked to this Instagram account was found.')
  }

  const existing = await repo.findExistingByUserAndPlatformUserId(userId, igPlatform.id, matchedIgAccount.id)
  if (existing && existing.isActive) {
    throw new NotFoundError('This Instagram account is already connected.')
  }

  const igProfile = await getInstagramProfile(matchedIgAccount.id, matchedPage.accessToken)

  const account = await upsertPageAccount(userId, igPlatform, {
    profileUrl: `https://instagram.com/${igProfile.username}`,
    username: igProfile.username,
    displayName: igProfile.name || igProfile.username,
    avatarUrl: igProfile.profile_picture_url,
    followersCount: igProfile.followers_count,
    platformUserId: igProfile.id,
    igAccountType: 'business',
    igBusinessAccountId: matchedIgAccount.id,
    accessToken: matchedPage.accessToken,
    tokenExpiresAt: matchedPage.tokenExpiresAt,
    tokenIssuedAt: new Date(),
  })

  return { account }
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
