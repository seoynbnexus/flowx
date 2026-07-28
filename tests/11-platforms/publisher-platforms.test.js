import { describe, it, expect, beforeAll } from 'vitest'
import { generateUuid, uuidToBuffer, bufferToUuid } from '../../shared/utils/uuid.utils.js'
import { query, queryOne } from '../../shared/database/connection.js'
import { createTestUser } from '../helpers/create-user.js'
import * as publisherService from '../../src/modules/publisher-platforms/publisher.service.js'
import * as oauthService from '../../src/modules/publisher-platforms/oauth.service.js'

const dateTag = Date.now()

describe('publisher platforms', () => {
  let testUser, adminId, accountId, facebookPlatformId

  beforeAll(async () => {
    testUser = await createTestUser({
      email: `pub-user-${dateTag}@flowx-test.com`,
      password: 'Test@123',
      role: 'publisher',
    })
    const row = await queryOne("SELECT id FROM users WHERE email = 'admin@flowx.com'")
    adminId = row ? bufferToUuid(row.id) : null

    const fbPlat = await queryOne("SELECT id FROM platforms WHERE code = 'facebook'")
    facebookPlatformId = fbPlat ? bufferToUuid(fbPlat.id) : null
  })

  it('should list my accounts (empty initially)', async () => {
    const accounts = await publisherService.listMyAccounts(testUser.id)
    expect(Array.isArray(accounts)).toBe(true)
  })

  it('should report not connected for OAuth status', async () => {
    const status = await oauthService.getConnectionStatus(testUser.id, 'facebook')
    expect(status.connected).toBe(false)
  })

  it('should create an account directly in DB for testing', async () => {
    if (!facebookPlatformId) return
    accountId = generateUuid()
    await query(
      `INSERT INTO user_platform_accounts (id, user_id, platform_id, platform_user_id, profile_url, platform_username, token_type, token_status, verification_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuidToBuffer(accountId), uuidToBuffer(testUser.id), uuidToBuffer(facebookPlatformId), `test_fb_${dateTag}`, `https://facebook.com/test_${dateTag}`, `test_user_${dateTag}`, 'page', 'active', 'pending']
    )
    const accounts = await publisherService.listMyAccounts(testUser.id)
    expect(accounts.some(a => a.id === accountId)).toBe(true)
  })

  it('should remove own account', async () => {
    await publisherService.removeAccount(testUser.id, accountId)
    const accounts = await publisherService.listMyAccounts(testUser.id)
    expect(accounts.some(a => a.id === accountId)).toBe(false)
  })

  it('should reject removing non-existent account', async () => {
    await expect(publisherService.removeAccount(testUser.id, generateUuid())).rejects.toThrow(/not found/i)
  })

  it('should list all accounts as admin', async () => {
    const result = await publisherService.listAllAccounts({})
    expect(Array.isArray(result.accounts)).toBe(true)
    expect(typeof result.total).toBe('number')
  })

  it('should verify an account as admin', async () => {
    if (!adminId || !facebookPlatformId) return
    const newId = generateUuid()
    await query(
      `INSERT INTO user_platform_accounts (id, user_id, platform_id, platform_user_id, profile_url, platform_username, token_type, token_status, verification_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuidToBuffer(newId), uuidToBuffer(testUser.id), uuidToBuffer(facebookPlatformId), `verify_fb_${dateTag}`, 'https://facebook.com/verify', `verify_user`, 'page', 'active', 'pending']
    )
    const verified = await publisherService.verifyAccount(newId, 'verified', adminId)
    expect(verified.verificationStatus).toBe('verified')
  })

  it('should reject verification of non-existent account', async () => {
    await expect(publisherService.verifyAccount(generateUuid(), 'verified', adminId || testUser.id)).rejects.toThrow(/not found/i)
  })
})
