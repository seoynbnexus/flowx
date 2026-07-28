import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import supertest from 'supertest'
import jwt from 'jsonwebtoken'

import { createTestUser } from '../helpers/create-user.js'
import { query, queryOne } from '../../shared/database/connection.js'
import { uuidToBuffer, bufferToUuid } from '../../shared/utils/uuid.utils.js'
import { hashToken } from '../../shared/utils/crypto.utils.js'
import { sendOtpEmail } from '../../shared/mailer/mailer.js'

let app
let testUser
const testEmail = `auth-register-${Date.now()}@flowx-test.com`
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret'

beforeAll(async () => {
  const mod = await import('../../app.js')
  app = mod.default
  testUser = await createTestUser({ email: `auth-pre-${Date.now()}@flowx-test.com`, password: 'Test@123' })
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('sendRegistrationOtp', () => {
  it('should send OTP successfully', async () => {
    const email = `send-otp-${Date.now()}@flowx-test.com`
    const { sendRegistrationOtp } = await import('../../src/modules/auth/auth.service.js')

    await sendRegistrationOtp(email)

    expect(sendOtpEmail).toHaveBeenCalledWith(email, expect.any(String))
    const otp = sendOtpEmail.mock.calls[0][1]

    const record = await queryOne(
      'SELECT * FROM email_otps WHERE email = ? AND purpose = ? AND used_at IS NULL',
      [email, 'registration']
    )
    expect(record).toBeTruthy()
    expect(record.otp_hash).toBe(hashToken(otp))
    expect(new Date(record.expires_at).getTime()).toBeGreaterThan(Date.now())
  })

  it('should reject disposable email', async () => {
    const { sendRegistrationOtp } = await import('../../src/modules/auth/auth.service.js')

    await expect(
      sendRegistrationOtp('test@tempmail.com')
    ).rejects.toThrow('Disposable email')
  })

  it('should reject already registered email', async () => {
    const email = `already-reg-${Date.now()}@flowx-test.com`
    await createTestUser({ email, password: 'Test@123' })

    const { sendRegistrationOtp } = await import('../../src/modules/auth/auth.service.js')

    await expect(sendRegistrationOtp(email)).rejects.toThrow('already registered')
  })

  it('should validate email format via route', async () => {
    const res = await supertest(app)
      .post('/api/v1/auth/send-registration-otp')
      .send({ email: 'not-an-email' })
    expect(res.status).toBe(422)
  })
})

describe('verifyRegistrationOtp', () => {
  it('should verify OTP and return verification token', async () => {
    const email = `verify-otp-${Date.now()}@flowx-test.com`
    const { sendRegistrationOtp, verifyRegistrationOtp } = await import('../../src/modules/auth/auth.service.js')

    await sendRegistrationOtp(email)
    const otp = sendOtpEmail.mock.calls[0][1]

    const result = await verifyRegistrationOtp(email, otp)

    expect(result.verificationToken).toBeTruthy()

    const decoded = jwt.verify(result.verificationToken, JWT_SECRET)
    expect(decoded.sub).toBe(email)
    expect(decoded.purpose).toBe('registration')
  })

  it('should reject invalid OTP', async () => {
    const email = `bad-otp-${Date.now()}@flowx-test.com`
    const { sendRegistrationOtp, verifyRegistrationOtp } = await import('../../src/modules/auth/auth.service.js')

    await sendRegistrationOtp(email)

    await expect(verifyRegistrationOtp(email, '999999')).rejects.toThrow('Invalid OTP')
  })

  it('should reject expired OTP', async () => {
    const email = `expired-otp-${Date.now()}@flowx-test.com`
    const { sendRegistrationOtp, verifyRegistrationOtp } = await import('../../src/modules/auth/auth.service.js')

    await sendRegistrationOtp(email)

    await query(
      'UPDATE email_otps SET expires_at = ? WHERE email = ? AND purpose = ?',
      [new Date(Date.now() - 60000), email, 'registration']
    )

    await expect(verifyRegistrationOtp(email, '123456')).rejects.toThrow('expired')
  })

  it('should reject too many attempts', async () => {
    const email = `max-attempts-${Date.now()}@flowx-test.com`
    const { sendRegistrationOtp, verifyRegistrationOtp } = await import('../../src/modules/auth/auth.service.js')

    await sendRegistrationOtp(email)

    await query(
      'UPDATE email_otps SET attempts = 5 WHERE email = ? AND purpose = ?',
      [email, 'registration']
    )

    await expect(verifyRegistrationOtp(email, '123456')).rejects.toThrow('Too many attempts')
  })

  it('should reject when no OTP found', async () => {
    const { verifyRegistrationOtp } = await import('../../src/modules/auth/auth.service.js')

    await expect(
      verifyRegistrationOtp(`no-otp-${Date.now()}@flowx-test.com`, '123456')
    ).rejects.toThrow('No OTP found')
  })
})

describe('register', () => {
  it('should register a publisher user successfully', async () => {
    const email = `register-pub-${Date.now()}@flowx-test.com`
    const verificationToken = jwt.sign(
      { sub: email, purpose: 'registration' },
      JWT_SECRET,
      { expiresIn: '15m' }
    )

    const { register } = await import('../../src/modules/auth/auth.service.js')
    const result = await register(
      { verificationToken, password: 'StrongPass1', firstName: 'John', lastName: 'Doe', role: 'publisher' },
      '127.0.0.1',
      'test-agent'
    )

    expect(result.user).toBeDefined()
    expect(result.user.email).toBe(email)
    expect(result.accessToken).toBeTruthy()
    expect(result.refreshToken).toBeTruthy()
    expect(result.user).not.toHaveProperty('deleted_at')

    const dbUser = await queryOne('SELECT * FROM users WHERE email = ?', [email])
    expect(dbUser).toBeTruthy()
    expect(bufferToUuid(dbUser.id)).toBe(result.user.id)

    const roles = await query(
      'SELECT r.code FROM roles r JOIN user_roles ur ON ur.role_id = r.id WHERE ur.user_id = ?',
      [uuidToBuffer(result.user.id)]
    )
    expect(roles.map(r => r.code)).toContain('publisher')

    const profile = await queryOne('SELECT * FROM user_profiles WHERE user_id = ?', [uuidToBuffer(result.user.id)])
    expect(profile).toBeTruthy()
    expect(profile.first_name).toBe('John')

    const wallet = await queryOne('SELECT * FROM user_wallets WHERE user_id = ?', [uuidToBuffer(result.user.id)])
    expect(wallet).toBeFalsy()
  })

  it('should register a client user with wallet bonus', async () => {
    const email = `register-client-${Date.now()}@flowx-test.com`
    const verificationToken = jwt.sign(
      { sub: email, purpose: 'registration' },
      JWT_SECRET,
      { expiresIn: '15m' }
    )

    const { register } = await import('../../src/modules/auth/auth.service.js')
    const result = await register(
      { verificationToken, password: 'StrongPass1', firstName: 'Client', lastName: 'User', role: 'client' },
      '127.0.0.1',
      'test-agent'
    )

    expect(result.user).toBeDefined()

    const wallet = await queryOne('SELECT * FROM user_wallets WHERE user_id = ?', [uuidToBuffer(result.user.id)])
    expect(wallet).toBeTruthy()
    expect(Number(wallet.coins)).toBe(10000)
  })

  it('should reject expired verification token', async () => {
    const email = `expired-token-${Date.now()}@flowx-test.com`
    const verificationToken = jwt.sign(
      { sub: email, purpose: 'registration' },
      JWT_SECRET,
      { expiresIn: '0s' }
    )

    const { register } = await import('../../src/modules/auth/auth.service.js')

    await expect(
      register(
        { verificationToken, password: 'StrongPass1' },
        '127.0.0.1',
        'test-agent'
      )
    ).rejects.toThrow('Invalid or expired verification token')
  })

  it('should reject wrong purpose token', async () => {
    const email = `wrong-purpose-${Date.now()}@flowx-test.com`
    const verificationToken = jwt.sign(
      { sub: email, purpose: 'password_reset' },
      JWT_SECRET,
      { expiresIn: '15m' }
    )

    const { register } = await import('../../src/modules/auth/auth.service.js')

    await expect(
      register(
        { verificationToken, password: 'StrongPass1' },
        '127.0.0.1',
        'test-agent'
      )
    ).rejects.toThrow('Invalid verification token')
  })

  it('should reject duplicate email', async () => {
    const email = `duplicate-reg-${Date.now()}@flowx-test.com`
    await createTestUser({ email, password: 'Test@123' })

    const verificationToken = jwt.sign(
      { sub: email, purpose: 'registration' },
      JWT_SECRET,
      { expiresIn: '15m' }
    )

    const { register } = await import('../../src/modules/auth/auth.service.js')

    await expect(
      register(
        { verificationToken, password: 'StrongPass1' },
        '127.0.0.1',
        'test-agent'
      )
    ).rejects.toThrow('already registered')
  })

  it('should reject unauthenticated API access', async () => {
    const res = await supertest(app)
      .post('/api/v1/auth/register')
      .send({ verificationToken: 'any', password: 'Test@123' })
    expect(res.status).toBe(401)
  })

  it('should validate password requirements via route', async () => {
    const res = await supertest(app)
      .post('/api/v1/auth/register')
      .send({ verificationToken: 'any', password: 'weak' })
    expect(res.status).toBe(422)
  })

  it('should roll back on failure (no partial user created)', async () => {
    const email = `rollback-${Date.now()}@flowx-test.com`
    const verificationToken = jwt.sign(
      { sub: email, purpose: 'registration' },
      JWT_SECRET,
      { expiresIn: '15m' }
    )

    const createUserSpy = vi.spyOn(
      await import('../../src/modules/auth/auth.repository.js'),
      'createUser'
    )
    createUserSpy.mockRejectedValueOnce(new Error('DB insert failed'))

    const { register } = await import('../../src/modules/auth/auth.service.js')

    await expect(
      register(
        { verificationToken, password: 'StrongPass1', firstName: 'Rollback', role: 'publisher' },
        '127.0.0.1',
        'test-agent'
      )
    ).rejects.toThrow('DB insert failed')

    const dbUser = await queryOne('SELECT * FROM users WHERE email = ?', [email])
    expect(dbUser).toBeFalsy()
  })
})
