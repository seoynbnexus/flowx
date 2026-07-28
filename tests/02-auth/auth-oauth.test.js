import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import supertest from 'supertest'

import { createTestUser } from '../helpers/create-user.js'
import { query, queryOne } from '../../shared/database/connection.js'
import { generateUuid, uuidToBuffer, bufferToUuid } from '../../shared/utils/uuid.utils.js'
import { mockGoogleVerifyIdToken } from '../setup-mocks.js'

let app

beforeAll(async () => {
  const mod = await import('../../app.js')
  app = mod.default

  const existingProvider = await queryOne("SELECT id FROM oauth_providers WHERE code = 'google'")
  if (!existingProvider) {
    await query(
      "INSERT INTO oauth_providers (id, code, name) VALUES (?, 'google', 'Google')",
      [uuidToBuffer(generateUuid())]
    )
  }
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('googleLogin', () => {
  it('should register a new client user with wallet bonus', async () => {
    const testEmail = `oauth-new-${Date.now()}@test.com`
    mockGoogleVerifyIdToken.mockResolvedValueOnce({
      getPayload: () => ({
        email: testEmail,
        name: 'New OAuth User',
        sub: `sub_${Date.now()}`,
        email_verified: true,
      }),
    })

    const { googleLogin } = await import('../../src/modules/auth/auth.service.js')
    const result = await googleLogin('fake-token', '127.0.0.1', 'test-agent', 'client')

    expect(result.user).toBeDefined()
    expect(result.user.email).toBe(testEmail)
    expect(result.accessToken).toBeTruthy()
    expect(result.refreshToken).toBeTruthy()

    const dbUser = await queryOne('SELECT * FROM users WHERE email = ?', [testEmail])
    expect(dbUser).toBeTruthy()

    const wallet = await queryOne('SELECT * FROM user_wallets WHERE user_id = ?', [dbUser.id])
    expect(wallet).toBeTruthy()
    expect(Number(wallet.coins)).toBe(10000)
  })

  it('should link OAuth account for existing user without password', async () => {
    const testEmail = `oauth-link-${Date.now()}@test.com`

    const userId = generateUuid()
    await query('INSERT INTO users (id, email, status, email_verified_at) VALUES (?, ?, ?, NOW())',
      [uuidToBuffer(userId), testEmail, 'active']
    )
    await query('INSERT INTO user_profiles (id, user_id, first_name, last_name) VALUES (?, ?, ?, ?)',
      [uuidToBuffer(generateUuid()), uuidToBuffer(userId), 'Existing', 'User']
    )

    mockGoogleVerifyIdToken.mockResolvedValueOnce({
      getPayload: () => ({
        email: testEmail,
        name: 'Existing OAuth User',
        sub: `sub_link_${Date.now()}`,
        email_verified: true,
      }),
    })

    const { googleLogin } = await import('../../src/modules/auth/auth.service.js')
    const result = await googleLogin('fake-token', '127.0.0.1', 'test-agent', 'client')

    expect(result.user).toBeDefined()
    expect(result.user.id).toBe(userId)

    const provider = await queryOne("SELECT id FROM oauth_providers WHERE code = 'google'")
    const oauthAccount = await queryOne(
      'SELECT * FROM oauth_accounts WHERE user_id = ? AND provider_id = ?',
      [uuidToBuffer(userId), provider.id]
    )
    expect(oauthAccount).toBeTruthy()
  })

  it('should throw ConflictError for existing user with password', async () => {
    const testEmail = `oauth-conflict-${Date.now()}@test.com`
    await createTestUser({ email: testEmail, password: 'Test@123' })

    mockGoogleVerifyIdToken.mockResolvedValueOnce({
      getPayload: () => ({
        email: testEmail,
        name: 'Conflict User',
        sub: `sub_conflict_${Date.now()}`,
        email_verified: true,
      }),
    })

    const { googleLogin } = await import('../../src/modules/auth/auth.service.js')

    await expect(
      googleLogin('fake-token', '127.0.0.1', 'test-agent', 'client')
    ).rejects.toThrow('already exists')
  })

  it('should reject invalid Google token', async () => {
    mockGoogleVerifyIdToken.mockRejectedValueOnce(new Error('Invalid token'))

    const { googleLogin } = await import('../../src/modules/auth/auth.service.js')

    await expect(
      googleLogin('bad-token', '127.0.0.1', 'test-agent', 'client')
    ).rejects.toThrow()
  })
})

describe('POST /auth/oauth/google', () => {
  it('should authenticate via API', async () => {
    const res = await supertest(app)
      .post('/api/v1/auth/oauth/google')
      .send({ accessToken: 'fake-google-token' })

    expect(res.status).toBe(200)
    expect(res.body.data.accessToken).toBeTruthy()
    expect(res.body.data.user.email).toBe('google-test@example.com')
  })

  it('should reject missing access token', async () => {
    const res = await supertest(app)
      .post('/api/v1/auth/oauth/google')
      .send({})
    expect(res.status).toBe(422)
  })
})
