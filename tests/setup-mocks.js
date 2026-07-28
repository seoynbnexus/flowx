import { vi } from 'vitest'

vi.mock('../shared/mailer/mailer.js', () => ({
  sendOtpEmail: vi.fn().mockResolvedValue(true),
  sendPasswordResetEmail: vi.fn().mockResolvedValue(true),
}))

vi.mock('disposable-email-domains/index.js', () => ({
  default: ['tempmail.com', 'throwaway.com', 'mailinator.com'],
}))

const mockGoogleVerifyIdToken = vi.fn().mockResolvedValue({
  getPayload: () => ({
    email: 'google-test@example.com',
    name: 'Google Test',
    sub: 'google_sub_123',
    email_verified: true,
  }),
})

vi.mock('google-auth-library', () => ({
  OAuth2Client: vi.fn(function() {
    return { verifyIdToken: mockGoogleVerifyIdToken }
  }),
}))

export { mockGoogleVerifyIdToken }
