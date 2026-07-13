import * as repo from './oauth.repository.js';
import { generateOAuthUrl as buildAuthUrl, exchangeCodeForToken, exchangeForLongLivedToken, debugToken } from '../../../shared/services/meta-auth.service.js';
import { getFacebookPages, getInstagramBusinessAccount, getInstagramProfile, getPageDetails, getPageAccessToken, getMe, getUserBusinesses, getBusinessOwnedPages, getBusinessClientPages, getBusinessOwnedInstagramAccounts, getBusinessClientInstagramAccounts } from '../../../shared/services/meta-graph.service.js';
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

    if (!fbPlatform) {
      return { success: false, error: 'Facebook platform not found in database', errorType: 'system' }
    }

    // Store user-level token only — pages and IG are connected separately via discovery flow
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

    return {
      success: true,
      pendingSelection: true,
      platformCode: 'facebook',
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

  const allPages = new Map()

  if (fbPages) {
    for (const page of fbPages) {
      allPages.set(page.id, {
        id: page.id,
        name: page.name,
        picture: page.picture?.data?.url || null,
      })
    }
  }

  // Get already-connected active page IDs
  const existingAccounts = await repo.findAllByUserAndPlatform(userId, fbPlatform.id)
  const connectedPageIds = new Set(
    existingAccounts
      .filter(a => a.tokenType === 'page' && a.platformUserId)
      .map(a => a.platformUserId)
  )

  const available = Array.from(allPages.values())
    .filter(page => !connectedPageIds.has(page.id))

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
  if (existing) {
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

  const accessToken = userToken.accessToken

  // Get already-connected IG accounts
  const existingIgAccounts = await repo.findAllByUserAndPlatform(userId, igPlatform.id)
  const connectedIgIds = new Set(
    existingIgAccounts
      .filter(a => a.tokenType === 'page' && a.platformUserId)
      .map(a => a.platformUserId)
  )

  const available = new Map()

  // 1. Discover via Facebook Pages
  const allFbPages = await repo.findAllByUserAndPlatform(userId, fbPlatform.id)

  for (const page of allFbPages) {
    if (!page.accessToken) continue
    try {
      const igAccount = await getInstagramBusinessAccount(page.platformUserId, page.accessToken)
      if (!igAccount) continue
      if (connectedIgIds.has(igAccount.id)) continue
      const key = igAccount.id
      if (!available.has(key)) {
        available.set(key, {
          igBusinessAccountId: igAccount.id,
          igUsername: igAccount.username || null,
          igName: igAccount.name || null,
          igProfilePicture: igAccount.profile_picture_url || null,
          followersCount: igAccount.followers_count || 0,
          linkedFbPageId: page.platformUserId,
          linkedFbPageName: page.platformDisplayName || 'Facebook Page',
          source: 'page_linked',
        })
      }
    } catch {
      // page has no linked Instagram — skip
    }
  }

  // Also try from pages discovered via Business Portfolio (not yet connected)
  try {
    const businesses = await getUserBusinesses(accessToken)
    for (const business of businesses) {
      const ownedPages = await getBusinessOwnedPages(business.id, accessToken)
      for (const page of ownedPages) {
        if (!page.access_token) continue
        try {
          const igAccount = await getInstagramBusinessAccount(page.id, page.access_token)
          if (!igAccount) continue
          if (connectedIgIds.has(igAccount.id)) continue
          const key = igAccount.id
          if (!available.has(key)) {
            available.set(key, {
              igBusinessAccountId: igAccount.id,
              igUsername: igAccount.username || null,
              igName: igAccount.name || null,
              igProfilePicture: igAccount.profile_picture_url || null,
              followersCount: igAccount.followers_count || 0,
              linkedFbPageId: page.id,
              linkedFbPageName: page.name,
              source: 'business_page_linked',
            })
          }
        } catch {
          // skip
        }
      }
      // client pages too
      const clientPages = await getBusinessClientPages(business.id, accessToken)
      for (const page of clientPages) {
        if (!page.access_token) continue
        try {
          const igAccount = await getInstagramBusinessAccount(page.id, page.access_token)
          if (!igAccount) continue
          if (connectedIgIds.has(igAccount.id)) continue
          const key = igAccount.id
          if (!available.has(key)) {
            available.set(key, {
              igBusinessAccountId: igAccount.id,
              igUsername: igAccount.username || null,
              igName: igAccount.name || null,
              igProfilePicture: igAccount.profile_picture_url || null,
              followersCount: igAccount.followers_count || 0,
              linkedFbPageId: page.id,
              linkedFbPageName: page.name,
              source: 'business_page_linked',
            })
          }
        } catch {
          // skip
        }
      }
    }
  } catch {
    // Business Portfolio lookup failed — move on
  }

  // 2. Discover standalone Instagram accounts via Business Portfolio
  try {
    const businesses = await getUserBusinesses(accessToken)
    for (const business of businesses) {
      const ownedIg = await getBusinessOwnedInstagramAccounts(business.id, accessToken)
      for (const ig of ownedIg) {
        if (connectedIgIds.has(ig.id)) continue
        const key = ig.id
        if (!available.has(key)) {
          available.set(key, {
            igBusinessAccountId: ig.id,
            igUsername: ig.username || null,
            igName: ig.name || null,
            igProfilePicture: ig.profile_picture_url || null,
            followersCount: ig.followers_count || 0,
            linkedFbPageId: null,
            linkedFbPageName: null,
            source: 'business_portfolio',
          })
        }
      }
      const clientIg = await getBusinessClientInstagramAccounts(business.id, accessToken)
      for (const ig of clientIg) {
        if (connectedIgIds.has(ig.id)) continue
        const key = ig.id
        if (!available.has(key)) {
          available.set(key, {
            igBusinessAccountId: ig.id,
            igUsername: ig.username || null,
            igName: ig.name || null,
            igProfilePicture: ig.profile_picture_url || null,
            followersCount: ig.followers_count || 0,
            linkedFbPageId: null,
            linkedFbPageName: null,
            source: 'business_portfolio_client',
          })
        }
      }
    }
  } catch {
    // Business Portfolio Instagram lookup failed — move on
  }

  return { accounts: Array.from(available.values()) }
}

export async function addInstagramAccount(userId, igBusinessAccountId) {
  const fbPlatform = await repo.findPlatformByCode('facebook')
  const igPlatform = await repo.findPlatformByCode('instagram')
  if (!fbPlatform || !igPlatform) {
    throw new NotFoundError('Required platforms not found in database')
  }

  const userToken = await repo.findUserLevelToken(userId, fbPlatform.id)
  if (!userToken || !userToken.accessToken) {
    throw new NotFoundError('No Facebook user-level token found. Please reconnect your Facebook account.')
  }

  const accessToken = userToken.accessToken

  // Try 1: Find via already-connected FB pages
  let matchedPage = null
  let matchedIgAccount = null

  const fbPages = await repo.findAllByUserAndPlatform(userId, fbPlatform.id)
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

  // Try 2: Find via Business Portfolio pages (not yet connected)
  if (!matchedPage) {
    try {
      const businesses = await getUserBusinesses(accessToken)
      for (const business of businesses) {
        const ownedPages = await getBusinessOwnedPages(business.id, accessToken)
        for (const page of ownedPages) {
          if (!page.access_token) continue
          try {
            const igAccount = await getInstagramBusinessAccount(page.id, page.access_token)
            if (igAccount && igAccount.id === igBusinessAccountId) {
              matchedPage = { platformUserId: page.id, accessToken: page.access_token, platformDisplayName: page.name, tokenExpiresAt: userToken.tokenExpiresAt }
              matchedIgAccount = igAccount
              break
            }
          } catch { continue }
          if (matchedPage) break
        }
        if (!matchedPage) {
          const clientPages = await getBusinessClientPages(business.id, accessToken)
          for (const page of clientPages) {
            if (!page.access_token) continue
            try {
              const igAccount = await getInstagramBusinessAccount(page.id, page.access_token)
              if (igAccount && igAccount.id === igBusinessAccountId) {
                matchedPage = { platformUserId: page.id, accessToken: page.access_token, platformDisplayName: page.name, tokenExpiresAt: userToken.tokenExpiresAt }
                matchedIgAccount = igAccount
                break
              }
            } catch { continue }
            if (matchedPage) break
          }
        }
        if (matchedPage) break
      }
    } catch {
      // Business Portfolio lookup failed — move on
    }
  }

  if (!matchedPage || !matchedIgAccount) {
    throw new NotFoundError('No Facebook Page linked to this Instagram account was found.')
  }

  const existing = await repo.findExistingByUserAndPlatformUserId(userId, igPlatform.id, matchedIgAccount.id)
  if (existing) {
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
    tokenExpiresAt: matchedPage.tokenExpiresAt || userToken.tokenExpiresAt,
    tokenIssuedAt: new Date(),
  })

  return { account }
}

export async function getDiscoveredAssets(userId) {
  const fbPlatform = await repo.findPlatformByCode('facebook')
  const igPlatform = await repo.findPlatformByCode('instagram')
  if (!fbPlatform) {
    throw new NotFoundError('Required platforms not found in database')
  }

  const userToken = await repo.findUserLevelToken(userId, fbPlatform.id)
  if (!userToken || !userToken.accessToken) {
    throw new NotFoundError('No Facebook user-level token found. Please reconnect your Facebook account.')
  }

  const accessToken = userToken.accessToken

  // Discover pages from all sources
  const allPages = new Map()

  // 1. Direct-role pages from /me/accounts
  try {
    const directPages = await getFacebookPages(accessToken)
    for (const page of directPages) {
      allPages.set(page.id, {
        id: page.id,
        name: page.name,
        picture: page.picture?.data?.url || null,
        pageToken: page.access_token,
        source: 'direct',
        businessName: null,
      })
    }
  } catch (err) {
    console.warn(`[Discover] /me/accounts failed: ${err.message}`)
  }

  // 2. Business Portfolio pages
  try {
    const businesses = await getUserBusinesses(accessToken)
    for (const business of businesses) {
      const ownedPages = await getBusinessOwnedPages(business.id, accessToken)
      for (const page of ownedPages) {
        if (!allPages.has(page.id)) {
          allPages.set(page.id, {
            id: page.id,
            name: page.name,
            picture: page.picture?.data?.url || null,
            pageToken: page.access_token,
            source: 'business',
            businessName: business.name,
          })
        }
      }
      const clientPages = await getBusinessClientPages(business.id, accessToken)
      for (const page of clientPages) {
        if (!allPages.has(page.id)) {
          allPages.set(page.id, {
            id: page.id,
            name: page.name,
            picture: page.picture?.data?.url || null,
            pageToken: page.access_token,
            source: 'business',
            businessName: business.name,
          })
        }
      }
    }
  } catch (err) {
    console.warn(`[Discover] Business pages failed: ${err.message}`)
  }

  const existingFbAccounts = await repo.findAllByUserAndPlatform(userId, fbPlatform.id)
  const connectedPageIds = new Set(
    existingFbAccounts
      .filter(a => a.tokenType === 'page' && a.platformUserId)
      .map(a => a.platformUserId)
  )

  const existingIgAccounts = await repo.findAllByUserAndPlatform(userId, igPlatform?.id || '')
  const connectedIgIds = new Set(
    existingIgAccounts
      .filter(a => a.tokenType === 'page' && a.platformUserId)
      .map(a => a.platformUserId)
  )

  // Discover Instagram via linked pages (from all page sources)
  const allInstagram = new Map()

  for (const [, page] of allPages) {
    if (!page.pageToken) continue
    try {
      const igAccount = await getInstagramBusinessAccount(page.id, page.pageToken)
      if (!igAccount) continue
      const key = igAccount.id
      if (!allInstagram.has(key) && !connectedIgIds.has(key)) {
        allInstagram.set(key, {
          igBusinessAccountId: igAccount.id,
          igUsername: igAccount.username || null,
          igName: igAccount.name || null,
          igProfilePicture: igAccount.profile_picture_url || null,
          followersCount: igAccount.followers_count || 0,
          linkedFbPageId: page.id,
          linkedFbPageName: page.name,
        })
      }
    } catch {
      // page has no linked Instagram — skip
    }
  }

  // Discover standalone Instagram accounts via Business Portfolio
  try {
    const businesses = await getUserBusinesses(accessToken)
    for (const business of businesses) {
      const ownedIg = await getBusinessOwnedInstagramAccounts(business.id, accessToken)
      for (const ig of ownedIg) {
        if (connectedIgIds.has(ig.id)) continue
        const key = ig.id
        if (!allInstagram.has(key)) {
          allInstagram.set(key, {
            igBusinessAccountId: ig.id,
            igUsername: ig.username || null,
            igName: ig.name || null,
            igProfilePicture: ig.profile_picture_url || null,
            followersCount: ig.followers_count || 0,
            linkedFbPageId: null,
            linkedFbPageName: null,
          })
        }
      }
      const clientIg = await getBusinessClientInstagramAccounts(business.id, accessToken)
      for (const ig of clientIg) {
        if (connectedIgIds.has(ig.id)) continue
        const key = ig.id
        if (!allInstagram.has(key)) {
          allInstagram.set(key, {
            igBusinessAccountId: ig.id,
            igUsername: ig.username || null,
            igName: ig.name || null,
            igProfilePicture: ig.profile_picture_url || null,
            followersCount: ig.followers_count || 0,
            linkedFbPageId: null,
            linkedFbPageName: null,
          })
        }
      }
    }
  } catch (err) {
    console.warn(`[Discover] Business Portfolio Instagram failed: ${err.message}`)
  }

  // Build response — pages not yet connected
  const pages = Array.from(allPages.values())
    .filter(p => !connectedPageIds.has(p.id))
    .map(p => ({
      id: p.id,
      name: p.name,
      picture: p.picture,
      source: p.source,
      businessName: p.businessName,
    }))

  return {
    assets: {
      pages,
      instagramAccounts: Array.from(allInstagram.values()),
    },
  }
}

export async function connectSelectedAssets(userId, pageIds, igBusinessAccountIds) {
  const fbPlatform = await repo.findPlatformByCode('facebook')
  const igPlatform = await repo.findPlatformByCode('instagram')
  if (!fbPlatform) {
    throw new NotFoundError('Required platforms not found in database')
  }

  const userToken = await repo.findUserLevelToken(userId, fbPlatform.id)
  if (!userToken || !userToken.accessToken) {
    throw new NotFoundError('No Facebook user-level token found. Please reconnect your Facebook account.')
  }

  const storedAccounts = []

  // Connect selected pages
  for (const pageId of pageIds) {
    const existing = await repo.findExistingByUserAndPlatformUserId(userId, fbPlatform.id, pageId)
    if (existing) continue

    let pageToken
    let pageDetails

    try {
      pageToken = await getPageAccessToken(pageId, userToken.accessToken)
      if (!pageToken) continue
      pageDetails = await getPageDetails(pageId, pageToken)
    } catch {
      continue
    }

    const account = await upsertPageAccount(userId, fbPlatform, {
      profileUrl: `https://facebook.com/${pageId}`,
      username: pageDetails.username || null,
      displayName: pageDetails.name || 'Facebook Page',
      avatarUrl: pageDetails.picture?.data?.url || null,
      followersCount: pageDetails.followers_count || 0,
      platformUserId: pageId,
      accessToken: pageToken,
      tokenExpiresAt: userToken.tokenExpiresAt,
      tokenIssuedAt: new Date(),
    })
    storedAccounts.push(account)
  }

  // Connect selected Instagram accounts
  if (igPlatform) {
    for (const igId of igBusinessAccountIds) {
      const existing = await repo.findExistingByUserAndPlatformUserId(userId, igPlatform.id, igId)
      if (existing) continue

      // Try 1: Find which FB page has this Instagram linked (connected + newly stored)
      let matchedPage = null
      let matchedIgAccount = null

      const allFbPages = await repo.findAllByUserAndPlatform(userId, fbPlatform.id)
      for (const page of [...allFbPages, ...storedAccounts]) {
        if (!page.accessToken) continue
        try {
          const igAcct = await getInstagramBusinessAccount(page.platformUserId || page.id, page.accessToken)
          if (igAcct && igAcct.id === igId) {
            matchedPage = page
            matchedIgAccount = igAcct
            break
          }
        } catch {
          continue
        }
      }

      // Try 2: Fresh token from pages being connected
      if (!matchedPage) {
        for (const pageId of pageIds) {
          try {
            const pageToken = await getPageAccessToken(pageId, userToken.accessToken)
            if (!pageToken) continue
            const igAcct = await getInstagramBusinessAccount(pageId, pageToken)
            if (igAcct && igAcct.id === igId) {
              matchedPage = { id: pageId, accessToken: pageToken, platformDisplayName: 'Facebook Page' }
              matchedIgAccount = igAcct
              break
            }
          } catch {
            continue
          }
        }
      }

      // Try 3: Business Portfolio pages
      if (!matchedPage) {
        try {
          const businesses = await getUserBusinesses(userToken.accessToken)
          for (const business of businesses) {
            const ownedPages = await getBusinessOwnedPages(business.id, userToken.accessToken)
            for (const page of ownedPages) {
              if (!page.access_token) continue
              try {
                const igAcct = await getInstagramBusinessAccount(page.id, page.access_token)
                if (igAcct && igAcct.id === igId) {
                  matchedPage = { id: page.id, accessToken: page.access_token, platformDisplayName: page.name }
                  matchedIgAccount = igAcct
                  break
                }
              } catch { continue }
              if (matchedPage) break
            }
            if (!matchedPage) {
              const clientPages = await getBusinessClientPages(business.id, userToken.accessToken)
              for (const page of clientPages) {
                if (!page.access_token) continue
                try {
                  const igAcct = await getInstagramBusinessAccount(page.id, page.access_token)
                  if (igAcct && igAcct.id === igId) {
                    matchedPage = { id: page.id, accessToken: page.access_token, platformDisplayName: page.name }
                    matchedIgAccount = igAcct
                    break
                  }
                } catch { continue }
                if (matchedPage) break
              }
            }
            if (matchedPage) break
          }
        } catch {
          // Business Portfolio lookup failed
        }
      }

      // Try 4: Standalone Instagram account in Business Portfolio (no linked page)
      if (!matchedPage) {
        try {
          const igProfile = await getInstagramProfile(igId, userToken.accessToken)
          if (igProfile && igProfile.id) {
            const account = await upsertPageAccount(userId, igPlatform, {
              profileUrl: `https://instagram.com/${igProfile.username}`,
              username: igProfile.username,
              displayName: igProfile.name || igProfile.username,
              avatarUrl: igProfile.profile_picture_url,
              followersCount: igProfile.followers_count,
              platformUserId: igProfile.id,
              igAccountType: 'business',
              igBusinessAccountId: igProfile.id,
              accessToken: userToken.accessToken,
              tokenExpiresAt: userToken.tokenExpiresAt,
              tokenIssuedAt: new Date(),
            })
            storedAccounts.push(account)
          }
        } catch {
          // Standalone IG not found — skip
        }
        continue
      }

      try {
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
          tokenExpiresAt: userToken.tokenExpiresAt,
          tokenIssuedAt: new Date(),
        })
        storedAccounts.push(account)
      } catch {
        continue
      }
    }
  }

  return { accounts: storedAccounts }
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
