import * as repo from './oauth.repository.js';
import { generateOAuthUrl as buildAuthUrl, exchangeCodeForToken, exchangeForLongLivedToken, debugToken } from '../../../shared/services/meta-auth.service.js';
import { getFacebookPages, getInstagramBusinessAccount, getInstagramProfile, getPageDetails, getPageAccessToken, getMe, getUserBusinesses, getBusinessOwnedPages, getBusinessClientPages, getBusinessOwnedInstagramAccounts, getBusinessClientInstagramAccounts } from '../../../shared/services/meta-graph.service.js';
import { generateUuid } from '../../../shared/utils/uuid.utils.js';
import { isMetaConfigured } from '../../../shared/services/meta-oauth.config.js';
import { NotFoundError, ConflictError } from '../../../shared/errors/AppError.js';

const STATE_MAP = new Map();

export async function generateOAuthUrl(userId, platformCode = 'instagram', extra = {}) {
  if (!isMetaConfigured()) {
    throw new NotFoundError('Meta OAuth is not configured. Contact the administrator.');
  }

  const stateId = generateUuid();
  STATE_MAP.set(stateId, { userId, platformCode, createdAt: Date.now(), ...extra });

  const url = buildAuthUrl(stateId, platformCode);
  return { url };
}

export async function generateReauthUrl(userId) {
  return generateOAuthUrl(userId, 'all', { reauthAll: true })
}

export async function reauthAllForUser(userId, freshUserToken, freshExpiresAt) {
  const { query } = await import('../../../shared/database/connection.js')
  const { uuidToBuffer } = await import('../../../shared/utils/uuid.utils.js')
  const { encrypt } = await import('../../../shared/utils/crypto.utils.js')
  const { getPageAccessToken } = await import('../../../shared/services/meta-graph.service.js')
  const fbPlatform = await repo.findPlatformByCode('facebook')
  const igPlatform = await repo.findPlatformByCode('instagram')
  const pages = await query(
    `SELECT upa.*, p.code as platform_code FROM user_platform_accounts upa
     JOIN platforms p ON p.id = upa.platform_id
     WHERE upa.user_id = ? AND upa.token_type = 'page'`,
    [uuidToBuffer(userId)]
  )
  let refreshed = 0
  let failed = 0
  for (const row of pages) {
    try {
      let newToken = freshUserToken
      let viaPageId = row.platform_user_id
      if (row.platform_code === 'facebook') {
        newToken = await getPageAccessToken(row.platform_user_id, freshUserToken)
      } else if (row.platform_code === 'instagram') {
        const igId = row.instagram_business_account_id || row.platform_user_id
        let found = false
        try {
          const { getFacebookPages, getInstagramBusinessAccount } = await import('../../../shared/services/meta-graph.service.js')
          const fbPages = await getFacebookPages(freshUserToken).catch(() => [])
          for (const pg of fbPages) {
            try {
              const tok = await getPageAccessToken(pg.id, freshUserToken)
              const ig = await getInstagramBusinessAccount(pg.id, tok)
              if (ig && ig.id === igId) {
                newToken = tok
                viaPageId = pg.id
                found = true
                break
              }
            } catch {}
          }
          if (!found) {
            const allPages = await query(
              `SELECT platform_user_id FROM user_platform_accounts WHERE user_id = ? AND token_type = 'page' AND platform_id = (SELECT id FROM platforms WHERE code='facebook')`,
              [uuidToBuffer(userId)]
            )
            for (const pr of allPages) {
              try {
                const tok = await getPageAccessToken(pr.platform_user_id, freshUserToken)
                const ig = await getInstagramBusinessAccount(pr.platform_user_id, tok)
                if (ig && ig.id === igId) { newToken = tok; viaPageId = pr.platform_user_id; found = true; break }
              } catch {}
            }
          }
          if (!found) {
            try {
              newToken = await getPageAccessToken(igId, freshUserToken)
              viaPageId = igId
              found = true
            } catch {}
          }
        } catch {}
        if (!found) {
          newToken = freshUserToken
        }
      }
      if (!newToken) throw new Error('No fresh token for reauth')
      await query(
        `UPDATE user_platform_accounts SET access_token = ?, token_expires_at = ?, token_issued_at = NOW(), webhook_last_checked_at = NOW() WHERE id = ?`,
        [encrypt(newToken), freshExpiresAt, row.id]
      )
      refreshed++
      try {
        const { subscribePage, subscribeInstagram } = await import('../../../shared/services/meta-graph.service.js')
        if (row.platform_code === 'facebook') {
          await subscribePage(row.platform_user_id, newToken, ['feed'])
          await query("UPDATE user_platform_accounts SET webhook_status='active', webhook_fields=?, webhook_subscribed_at=NOW(), webhook_last_error=NULL WHERE id=?", [JSON.stringify(['feed']), row.id])
        } else if (row.platform_code === 'instagram') {
          const igSubscribeId = row.instagram_business_account_id || row.platform_user_id
          await subscribeInstagram(igSubscribeId, newToken, ['comments','story_insights','mentions'])
          await query("UPDATE user_platform_accounts SET webhook_status='active', webhook_fields=?, webhook_subscribed_at=NOW(), webhook_last_error=NULL WHERE id=?", [JSON.stringify(['comments','story_insights','mentions']), row.id])
        }
      } catch (e) {
        await query("UPDATE user_platform_accounts SET webhook_status='failed', webhook_last_error=? WHERE id=?", [String(e.message).slice(0,1000), row.id])
      }
    } catch (e) {
      failed++
      try {
        await query("UPDATE user_platform_accounts SET webhook_status='failed', webhook_last_error=? WHERE id=?", [String(e.message).slice(0,1000), row.id])
      } catch {}
    }
  }
  try {
    const fbRows = pages.filter(r => r.platform_code === 'facebook')
    if (fbRows.length) {
      const { query: q2 } = await import('../../../shared/database/connection.js')
      const userLevelRows = await q2(`SELECT id FROM user_platform_accounts WHERE user_id = ? AND token_type='user' LIMIT 1`, [uuidToBuffer(userId)])
      if (userLevelRows.length) {
        const { encrypt: enc2 } = await import('../../../shared/utils/crypto.utils.js')
        await q2(`UPDATE user_platform_accounts SET access_token=?, token_expires_at=?, token_issued_at=NOW() WHERE id=?`, [enc2(freshUserToken), freshExpiresAt, userLevelRows[0].id])
      }
    }
  } catch {}
  return { refreshed, failed, total: pages.length }
}

async function upsertUserLevelToken(userId, platform, data) {
  const globalExisting = await repo.findByPlatformUserIdGlobally(platform.id, data.platformUserId)
  if (globalExisting && globalExisting.userId !== userId) {
    throw new ConflictError('This Facebook account is already connected to another user. Please use a different Facebook account.')
  }

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
  const globalExisting = await repo.findByPlatformUserIdGlobally(platform.id, data.platformUserId)
  if (globalExisting && globalExisting.userId !== userId) {
    const label = platform.code === 'instagram' ? 'Instagram account' : 'Facebook Page'
    throw new ConflictError(`This ${label} is already connected to another user.`)
  }

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
  const reauthAll = !!stateInfo?.reauthAll;

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

    // Check globally if this Meta account is already linked to another user
    const globalUserToken = await repo.findByPlatformUserIdGlobally(fbPlatform.id, fbUser.id)
    if (globalUserToken && globalUserToken.userId !== userId) {
      return { success: false, error: 'This Facebook account is already connected to another user. Please use a different Facebook account.', errorType: 'conflict' }
    }

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

    if (reauthAll) {
      const reauthResult = await reauthAllForUser(userId, accessToken, tokenExpiresAt)
      return {
        success: true,
        reauthAll: true,
        refreshed: reauthResult.refreshed,
        failed: reauthResult.failed,
        total: reauthResult.total,
        platformCode: 'facebook',
      }
    }

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

  // Get globally connected page IDs
  const globallyConnectedPageIds = new Set(
    await repo.findAllPlatformUserIdsByPlatform(fbPlatform.id, 'page')
  )

  const available = Array.from(allPages.values())
    .filter(page => !globallyConnectedPageIds.has(page.id))

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

  // Check not already connected globally
  const globalExisting = await repo.findByPlatformUserIdGlobally(fbPlatform.id, platformUserId)
  if (globalExisting) {
    if (globalExisting.userId !== userId) {
      throw new ConflictError('This Facebook Page is already connected to another user.')
    }
    throw new ConflictError('This page is already connected.')
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

  try {
    const { subscribePage } = await import('../../../shared/services/meta-graph.service.js')
    await subscribePage(platformUserId, pageToken, ['feed'])
    const { query } = await import('../../../shared/database/connection.js')
    const { uuidToBuffer } = await import('../../../shared/utils/uuid.utils.js')
    await query("UPDATE user_platform_accounts SET webhook_status = 'active', webhook_fields = ?, webhook_subscribed_at = NOW(), webhook_last_checked_at = NOW(), webhook_last_error = NULL WHERE id = ?", [JSON.stringify(['feed']), uuidToBuffer(account.id)])
  } catch (e) {
    try {
      const { query } = await import('../../../shared/database/connection.js')
      const { uuidToBuffer } = await import('../../../shared/utils/uuid.utils.js')
      await query("UPDATE user_platform_accounts SET webhook_status = 'failed', webhook_last_error = ?, webhook_last_checked_at = NOW() WHERE id = ?", [String(e.message).slice(0, 1000), uuidToBuffer(account.id)])
    } catch {}
  }

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

  // Get globally connected IG account IDs
  const globallyConnectedIgIds = new Set(
    await repo.findAllPlatformUserIdsByPlatform(igPlatform.id, 'page')
  )

  const available = new Map()

  // 1. Discover via Facebook Pages
  const allFbPages = await repo.findAllByUserAndPlatform(userId, fbPlatform.id)

  for (const page of allFbPages) {
    if (!page.accessToken) continue
    try {
      const igAccount = await getInstagramBusinessAccount(page.platformUserId, page.accessToken)
      if (!igAccount) continue
      if (globallyConnectedIgIds.has(igAccount.id)) continue
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
          if (globallyConnectedIgIds.has(igAccount.id)) continue
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
          if (globallyConnectedIgIds.has(igAccount.id)) continue
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
        if (globallyConnectedIgIds.has(ig.id)) continue
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
        if (globallyConnectedIgIds.has(ig.id)) continue
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

  const globalIgExisting = await repo.findByPlatformUserIdGlobally(igPlatform.id, matchedIgAccount.id)
  if (globalIgExisting) {
    if (globalIgExisting.userId !== userId) {
      throw new ConflictError('This Instagram account is already connected to another user.')
    }
    throw new ConflictError('This Instagram account is already connected.')
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

  try {
    const { subscribeInstagram } = await import('../../../shared/services/meta-graph.service.js')
    await subscribeInstagram(matchedIgAccount.id, matchedPage.accessToken, ['comments', 'story_insights', 'mentions'])
    const { query } = await import('../../../shared/database/connection.js')
    const { uuidToBuffer } = await import('../../../shared/utils/uuid.utils.js')
    await query("UPDATE user_platform_accounts SET webhook_status = 'active', webhook_fields = ?, webhook_subscribed_at = NOW(), webhook_last_checked_at = NOW(), webhook_last_error = NULL WHERE id = ?", [JSON.stringify(['comments','story_insights','mentions']), uuidToBuffer(account.id)])
  } catch (e) {
    try {
      const { query } = await import('../../../shared/database/connection.js')
      const { uuidToBuffer } = await import('../../../shared/utils/uuid.utils.js')
      await query("UPDATE user_platform_accounts SET webhook_status = 'failed', webhook_last_error = ?, webhook_last_checked_at = NOW() WHERE id = ?", [String(e.message).slice(0, 1000), uuidToBuffer(account.id)])
    } catch {}
  }

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

  const connectedPageIds = new Set(
    await repo.findAllPlatformUserIdsByPlatform(fbPlatform.id, 'page')
  )

  const connectedIgIds = new Set(
    igPlatform ? await repo.findAllPlatformUserIdsByPlatform(igPlatform.id, 'page') : []
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

  // Pre-validate global uniqueness for all selected assets
  const conflicts = []

  for (const pageId of pageIds) {
    const globalExisting = await repo.findByPlatformUserIdGlobally(fbPlatform.id, pageId)
    if (globalExisting && globalExisting.userId !== userId) {
      conflicts.push(`Facebook page "${globalExisting.platformDisplayName || pageId}"`)
    }
  }

  if (igPlatform) {
    for (const igId of igBusinessAccountIds) {
      const globalExisting = await repo.findByPlatformUserIdGlobally(igPlatform.id, igId)
      if (globalExisting && globalExisting.userId !== userId) {
        conflicts.push(`Instagram account "${globalExisting.platformDisplayName || igId}"`)
      }
    }
  }

  if (conflicts.length > 0) {
    throw new ConflictError(`The following assets are already connected to another user: ${conflicts.join(', ')}`)
  }

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
