import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import supertest from 'supertest'
import jwt from 'jsonwebtoken'

import { createTestUser } from '../helpers/create-user.js'
import { query, queryOne } from '../../shared/database/connection.js'
import { generateUuid, uuidToBuffer, bufferToUuid } from '../../shared/utils/uuid.utils.js'
import { hashToken } from '../../shared/utils/crypto.utils.js'
import { sendOtpEmail, sendPasswordResetEmail } from '../../shared/mailer/mailer.js'

let app
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret'
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'fallback-refresh-secret'

let standardUser, blockedUser, inactiveUser, oauthUser
const standardEmail = `sess-std-${Date.now()}@flowx-test.com`
const blockedEmail = `sess-blk-${Date.now()}@flowx-test.com`
const inactiveEmail = `sess-inact-${Date.now()}@flowx-test.com`
const oauthEmail = `sess-oauth-${Date.now()}@flowx-test.com`
const nonExistentEmail = `no-such-${Date.now()}@flowx-test.com`

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

  standardUser = await createTestUser({ email: standardEmail, password: 'Test@123' })
  blockedUser = await createTestUser({ email: blockedEmail, password: 'Test@123', status: 'blocked' })
  inactiveUser = await createTestUser({ email: inactiveEmail, password: 'Test@123', status: 'inactive' })

  const oauthUserId = generateUuid()
  const oauthProfileId = generateUuid()
  await query(
    'INSERT INTO users (id, email, status, email_verified_at) VALUES (?, ?, ?, NOW())',
    [uuidToBuffer(oauthUserId), oauthEmail, 'active']
  )
  await query(
    'INSERT INTO user_profiles (id, user_id, first_name, last_name) VALUES (?, ?, ?, ?)',
    [uuidToBuffer(oauthProfileId), uuidToBuffer(oauthUserId), 'OAuth', 'Only']
  )
  const provider = await queryOne("SELECT id FROM oauth_providers WHERE code = 'google'")
  await query(
    'INSERT INTO oauth_accounts (id, user_id, provider_id, provider_user_id, provider_email) VALUES (?, ?, ?, ?, ?)',
    [uuidToBuffer(generateUuid()), uuidToBuffer(oauthUserId), provider.id, 'google_sub_123', oauthEmail]
  )
  oauthUser = { id: oauthUserId, email: oauthEmail }
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('login', () => {
  it('should login successfully and return tokens', async () => {
    const { login } = await import('../../src/modules/auth/auth.service.js')

    const result = await login(standardEmail, 'Test@123', 'test-device', '127.0.0.1', 'test-agent')

    expect(result.user).toBeDefined()
    expect(result.user.email).toBe(standardEmail)
    expect(result.accessToken).toBeTruthy()
    expect(result.refreshToken).toBeTruthy()

    const decoded = jwt.verify(result.accessToken, JWT_SECRET)
    expect(decoded.sub).toBe(standardUser.id)

    const userDb = await queryOne('SELECT last_login_at FROM users WHERE email = ?', [standardEmail])
    expect(userDb.last_login_at).toBeTruthy()

    const history = await query(
      'SELECT * FROM auth_login_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 1',
      [uuidToBuffer(standardUser.id)]
    )
    expect(history.length).toBeGreaterThan(0)
    expect(history[0].success).toBe(1)
    expect(history[0].login_method).toBe('email_password')

    const session = await queryOne(
      'SELECT * FROM user_sessions WHERE user_id = ?',
      [uuidToBuffer(standardUser.id)]
    )
    expect(session).toBeTruthy()
    expect(session.device_name).toBe('test-device')
  })

  it('should reject wrong password', async () => {
    const { login } = await import('../../src/modules/auth/auth.service.js')

    await expect(
      login(standardEmail, 'WrongPass1', null, '127.0.0.1', 'test-agent')
    ).rejects.toThrow('Invalid email or password')

    const pwRecord = await queryOne(
      'SELECT failed_attempts FROM user_passwords WHERE user_id = ?',
      [uuidToBuffer(standardUser.id)]
    )
    expect(Number(pwRecord.failed_attempts)).toBeGreaterThanOrEqual(1)

    const history = await query(
      'SELECT * FROM auth_login_history WHERE user_id = ? AND success = 0 ORDER BY created_at DESC LIMIT 1',
      [uuidToBuffer(standardUser.id)]
    )
    expect(history.length).toBeGreaterThan(0)
  })

  it('should lock account after 5 failed attempts', async () => {
    const lockEmail = `lockout-${Date.now()}@flowx-test.com`
    const lockUser = await createTestUser({ email: lockEmail, password: 'Test@123' })

    const { login } = await import('../../src/modules/auth/auth.service.js')

    for (let i = 0; i < 5; i++) {
      try {
        await login(lockEmail, 'WrongPass1', null, '127.0.0.1', 'test-agent')
      } catch {
        // expected for each attempt
      }
    }

    await expect(
      login(lockEmail, 'Test@123', null, '127.0.0.1', 'test-agent')
    ).rejects.toThrow('temporarily locked')

    const pwRecord = await queryOne(
      'SELECT locked_until FROM user_passwords WHERE user_id = ?',
      [uuidToBuffer(lockUser.id)]
    )
    expect(new Date(pwRecord.locked_until).getTime()).toBeGreaterThan(Date.now())
  })

  it('should reject blocked account', async () => {
    const { login } = await import('../../src/modules/auth/auth.service.js')

    await expect(
      login(blockedEmail, 'Test@123', null, '127.0.0.1', 'test-agent')
    ).rejects.toThrow('blocked')
  })

  it('should reject inactive account', async () => {
    const { login } = await import('../../src/modules/auth/auth.service.js')

    await expect(
      login(inactiveEmail, 'Test@123', null, '127.0.0.1', 'test-agent')
    ).rejects.toThrow('inactive')
  })

  it('should throw MethodMismatchError for OAuth-only account', async () => {
    const { login } = await import('../../src/modules/auth/auth.service.js')

    await expect(
      login(oauthEmail, 'Test@123', null, '127.0.0.1', 'test-agent')
    ).rejects.toThrow('Sign-In')
  })

  it('should reject non-existent email', async () => {
    const { login } = await import('../../src/modules/auth/auth.service.js')

    await expect(
      login(nonExistentEmail, 'Test@123', null, '127.0.0.1', 'test-agent')
    ).rejects.toThrow('Invalid email or password')

    const history = await query(
      'SELECT * FROM auth_login_history WHERE user_id IS NULL AND login_method = ? AND success = 0 ORDER BY created_at DESC LIMIT 1',
      ['email_password']
    )
    expect(history.length).toBeGreaterThan(0)
    expect(history[0].ip_address).toBe('127.0.0.1')
  })

  it('should validate credentials via route', async () => {
    const res = await supertest(app)
      .post('/api/v1/auth/login')
      .send({ email: standardEmail, password: 'WrongPass1' })
    expect(res.status).toBe(401)
  })

  it('should login successfully via route', async () => {
    const freshEmail = `route-login-${Date.now()}@flowx-test.com`
    await createTestUser({ email: freshEmail, password: 'RoutePass1' })

    const res = await supertest(app)
      .post('/api/v1/auth/login')
      .send({ email: freshEmail, password: 'RoutePass1' })

    expect(res.status).toBe(200)
    expect(res.body.data.accessToken).toBeTruthy()
    expect(res.body.data.user.email).toBe(freshEmail)
    expect(res.headers['set-cookie']).toBeDefined()
  })
})

describe('forgotPassword', () => {
  it('should create reset token and send email', async () => {
    const email = `forgot-${Date.now()}@flowx-test.com`
    await createTestUser({ email, password: 'Test@123' })

    const { forgotPassword } = await import('../../src/modules/auth/auth.service.js')
    await forgotPassword(email)

    expect(sendPasswordResetEmail).toHaveBeenCalledWith(email, expect.any(String))

    const token = sendPasswordResetEmail.mock.calls[0][1]
    const tokenHash = hashToken(token)

    const userRow = await queryOne('SELECT id FROM users WHERE email = ?', [email])
    const record = await queryOne(
      'SELECT * FROM password_resets WHERE user_id = ? AND used_at IS NULL',
      [userRow.id]
    )
    expect(record).toBeTruthy()
    expect(record.token_hash).toBe(tokenHash)
    expect(new Date(record.expires_at).getTime()).toBeGreaterThan(Date.now())
  })

  it('should silently return for non-existent email', async () => {
    const { forgotPassword } = await import('../../src/modules/auth/auth.service.js')

    await expect(
      forgotPassword(`no-such-${Date.now()}@flowx-test.com`)
    ).resolves.not.toThrow()

    expect(sendPasswordResetEmail).not.toHaveBeenCalled()
  })
})

describe('resetPassword', () => {
  it('should reset password and revoke sessions', async () => {
    const email = `reset-ok-${Date.now()}@flowx-test.com`
    const user = await createTestUser({ email, password: 'OldPass1' })

    const { login, forgotPassword, resetPassword } = await import('../../src/modules/auth/auth.service.js')

    await forgotPassword(email)
    const token = sendPasswordResetEmail.mock.calls[0][1]

    await resetPassword(token, 'NewPass1')

    const pwRecord = await queryOne(
      'SELECT * FROM user_passwords WHERE user_id = ?',
      [uuidToBuffer(user.id)]
    )
    expect(pwRecord.password_changed_at).toBeTruthy()

    const sessions = await query(
      'SELECT * FROM user_sessions WHERE user_id = ?',
      [uuidToBuffer(user.id)]
    )
    expect(sessions.length).toBe(0)

    const audit = await query(
      "SELECT * FROM audit_logs WHERE actor_id = ? AND action = 'user.password_reset'",
      [uuidToBuffer(user.id)]
    )
    expect(audit.length).toBeGreaterThan(0)

    await expect(
      login(email, 'NewPass1', null, '127.0.0.1', 'test-agent')
    ).resolves.toBeDefined()
  })

  it('should reject invalid reset token', async () => {
    const { resetPassword } = await import('../../src/modules/auth/auth.service.js')

    await expect(
      resetPassword('invalid-token-that-does-not-exist', 'NewPass1')
    ).rejects.toThrow('Invalid or expired reset token')
  })

  it('should reject expired reset token', async () => {
    const email = `reset-exp-${Date.now()}@flowx-test.com`
    const user = await createTestUser({ email, password: 'Test@123' })

    const { forgotPassword, resetPassword } = await import('../../src/modules/auth/auth.service.js')

    await forgotPassword(email)
    const token = sendPasswordResetEmail.mock.calls[0][1]
    const userRow = await queryOne('SELECT id FROM users WHERE email = ?', [email])

    await query(
      'UPDATE password_resets SET expires_at = ? WHERE user_id = ?',
      [new Date(Date.now() - 3600000), userRow.id]
    )

    await expect(
      resetPassword(token, 'NewPass1')
    ).rejects.toThrow('expired')
  })
})

describe('refresh', () => {
  async function loginAndGetRefresh(email, password) {
    const { login } = await import('../../src/modules/auth/auth.service.js')
    return login(email, password, null, '127.0.0.1', 'test-agent')
  }

  it('should rotate tokens on refresh', async () => {
    const email = `refresh-ok-${Date.now()}@flowx-test.com`
    await createTestUser({ email, password: 'Test@123' })

    const loginResult = await loginAndGetRefresh(email, 'Test@123')

    const userRow = await queryOne('SELECT id FROM users WHERE email = ?', [email])

    const sessionsBefore = await query(
      'SELECT * FROM user_sessions WHERE user_id = ?',
      [userRow.id]
    )
    expect(sessionsBefore.length).toBe(1)
    const oldSessionBuf = sessionsBefore[0].id

    const { refresh } = await import('../../src/modules/auth/auth.service.js')
    const refreshResult = await refresh(loginResult.refreshToken)

    expect(refreshResult.accessToken).toBeTruthy()
    expect(refreshResult.refreshToken).toBeTruthy()
    expect(refreshResult.user).toBeDefined()

    // Old token should no longer work — reuse detection revokes the session
    await expect(refresh(loginResult.refreshToken)).rejects.toThrow()

    const sessionsAfter = await query(
      'SELECT * FROM user_sessions WHERE user_id = ?',
      [userRow.id]
    )
    expect(sessionsAfter.length).toBe(0)
  })

  it('should reject invalid refresh token', async () => {
    const { refresh } = await import('../../src/modules/auth/auth.service.js')

    await expect(
      refresh('completely-invalid-token')
    ).rejects.toThrow('Invalid or expired refresh token')
  })

  it('should reject expired session', async () => {
    const email = `refresh-exp-${Date.now()}@flowx-test.com`
    await createTestUser({ email, password: 'Test@123' })

    const loginResult = await loginAndGetRefresh(email, 'Test@123')
    const userRow = await queryOne('SELECT id FROM users WHERE email = ?', [email])

    await query(
      'UPDATE user_sessions SET expires_at = ? WHERE user_id = ?',
      [new Date(Date.now() - 3600000), userRow.id]
    )

    const { refresh } = await import('../../src/modules/auth/auth.service.js')

    await expect(
      refresh(loginResult.refreshToken)
    ).rejects.toThrow('Refresh token expired')

    const sessions = await query(
      'SELECT * FROM user_sessions WHERE user_id = ?',
      [userRow.id]
    )
    expect(sessions.length).toBe(0)
  })

  it('should reject revoked refresh token', async () => {
    const email = `refresh-rev-${Date.now()}@flowx-test.com`
    await createTestUser({ email, password: 'Test@123' })

    const loginResult = await loginAndGetRefresh(email, 'Test@123')

    const payload = jwt.verify(loginResult.refreshToken, JWT_REFRESH_SECRET)

    await query(
      'UPDATE user_sessions SET refresh_token_hash = ? WHERE id = ?',
      [hashToken('tampered-hash'), uuidToBuffer(payload.sid)]
    )

    const { refresh } = await import('../../src/modules/auth/auth.service.js')

    await expect(
      refresh(loginResult.refreshToken)
    ).rejects.toThrow('revoked')

    const sessions = await query(
      'SELECT * FROM user_sessions WHERE id = ?',
      [uuidToBuffer(payload.sid)]
    )
    expect(sessions.length).toBe(0)
  })

  it('should reject refresh for inactive user', async () => {
    const email = `refresh-inact-${Date.now()}@flowx-test.com`
    await createTestUser({ email, password: 'Test@123' })

    const loginResult = await loginAndGetRefresh(email, 'Test@123')
    const userRow = await queryOne('SELECT id FROM users WHERE email = ?', [email])

    await query('UPDATE users SET status = ? WHERE id = ?', ['inactive', userRow.id])

    const { refresh } = await import('../../src/modules/auth/auth.service.js')

    await expect(
      refresh(loginResult.refreshToken)
    ).rejects.toThrow('not active')

    const sessions = await query(
      'SELECT * FROM user_sessions WHERE user_id = ?',
      [userRow.id]
    )
    expect(sessions.length).toBe(0)

    await query('UPDATE users SET status = ? WHERE id = ?', ['active', userRow.id])
  })
})

describe('logout', () => {
  it('should delete session on logout', async () => {
    const email = `logout-ok-${Date.now()}@flowx-test.com`
    await createTestUser({ email, password: 'Test@123' })

    const { login } = await import('../../src/modules/auth/auth.service.js')
    const loginResult = await login(email, 'Test@123', null, '127.0.0.1', 'test-agent')

    const { logout } = await import('../../src/modules/auth/auth.service.js')
    await logout(loginResult.refreshToken)

    const userRow = await queryOne('SELECT id FROM users WHERE email = ?', [email])
    const sessions = await query(
      'SELECT * FROM user_sessions WHERE user_id = ?',
      [userRow.id]
    )
    expect(sessions.length).toBe(0)
  })

  it('should not throw for missing token', async () => {
    const { logout } = await import('../../src/modules/auth/auth.service.js')

    await expect(logout(null)).resolves.not.toThrow()
    await expect(logout('')).resolves.not.toThrow()
  })
})
