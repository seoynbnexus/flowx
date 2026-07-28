import { describe, it, expect, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import { AuthError } from '../../shared/errors/AppError.js'

const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret'

function mockReq(headers = {}, user = null) {
  return { headers: { authorization: headers.authorization }, user }
}

function mockRes() {
  return {}
}

function mockNext() {
  return vi.fn()
}

describe('authenticate', () => {
  it('should set req.user and call next() for valid token', async () => {
    const { authenticate } = await import('../../shared/middleware/auth.middleware.js')

    const token = jwt.sign(
      { sub: 'user-123', email: 'test@test.com', roles: ['client'], permissions: ['users.read'] },
      JWT_SECRET,
      { expiresIn: '15m' }
    )

    const req = mockReq({ authorization: `Bearer ${token}` })
    const next = mockNext()

    authenticate(req, mockRes(), next)

    expect(next).toHaveBeenCalledWith()
    expect(req.user).toBeDefined()
    expect(req.user.id).toBe('user-123')
    expect(req.user.email).toBe('test@test.com')
    expect(req.user.roles).toContain('client')
    expect(req.user.permissions).toContain('users.read')
  })

  it('should reject missing token', async () => {
    const { authenticate } = await import('../../shared/middleware/auth.middleware.js')

    const req = mockReq({})
    const next = mockNext()

    authenticate(req, mockRes(), next)

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'Access token is required' }))
  })

  it('should reject non-Bearer token', async () => {
    const { authenticate } = await import('../../shared/middleware/auth.middleware.js')

    const req = mockReq({ authorization: 'Basic token123' })
    const next = mockNext()

    authenticate(req, mockRes(), next)

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'Access token is required' }))
  })

  it('should reject expired token', async () => {
    const { authenticate } = await import('../../shared/middleware/auth.middleware.js')

    const token = jwt.sign(
      { sub: 'user-123' },
      JWT_SECRET,
      { expiresIn: '-1m' }
    )

    const req = mockReq({ authorization: `Bearer ${token}` })
    const next = mockNext()

    authenticate(req, mockRes(), next)

    expect(next).toHaveBeenCalled()
    expect(next.mock.calls[0][0]).toBeInstanceOf(AuthError)
    expect(next.mock.calls[0][0].message).toContain('expired')
  })

  it('should reject malformed token', async () => {
    const { authenticate } = await import('../../shared/middleware/auth.middleware.js')

    const req = mockReq({ authorization: 'Bearer not-a-valid-jwt' })
    const next = mockNext()

    authenticate(req, mockRes(), next)

    expect(next).toHaveBeenCalled()
    expect(next.mock.calls[0][0].message).toContain('Invalid access token')
  })
})

describe('optionalAuth', () => {
  it('should set user null when no token', async () => {
    const { optionalAuth } = await import('../../shared/middleware/auth.middleware.js')

    const req = mockReq({})
    const next = mockNext()

    optionalAuth(req, mockRes(), next)

    expect(next).toHaveBeenCalledWith()
    expect(req.user).toBeNull()
    expect(req.tokenProvided).toBe(false)
  })

  it('should set req.user for valid token', async () => {
    const { optionalAuth } = await import('../../shared/middleware/auth.middleware.js')

    const token = jwt.sign({ sub: 'user-456', email: 'auth@test.com' }, JWT_SECRET, { expiresIn: '15m' })

    const req = mockReq({ authorization: `Bearer ${token}` })
    const next = mockNext()

    optionalAuth(req, mockRes(), next)

    expect(next).toHaveBeenCalledWith()
    expect(req.tokenProvided).toBe(true)
  })

  it('should set user null for invalid token but mark provided', async () => {
    const { optionalAuth } = await import('../../shared/middleware/auth.middleware.js')

    const req = mockReq({ authorization: 'Bearer invalid-token-here' })
    const next = mockNext()

    optionalAuth(req, mockRes(), next)

    expect(next).toHaveBeenCalledWith()
    expect(req.user).toBeNull()
    expect(req.tokenProvided).toBe(true)
  })
})

describe('requireRole', () => {
  it('should pass for user with required role', async () => {
    const { requireRole } = await import('../../shared/middleware/auth.middleware.js')

    const req = { user: { roles: ['admin', 'publisher'] } }
    const next = mockNext()

    requireRole('admin', 'super_admin')(req, mockRes(), next)

    expect(next).toHaveBeenCalledWith()
  })

  it('should reject user without required role', async () => {
    const { requireRole } = await import('../../shared/middleware/auth.middleware.js')

    const req = { user: { roles: ['client'] } }
    const next = mockNext()

    requireRole('admin')(req, mockRes(), next)

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'Insufficient role permissions' }))
  })

  it('should reject unauthenticated request', async () => {
    const { requireRole } = await import('../../shared/middleware/auth.middleware.js')

    const req = { user: null }
    const next = mockNext()

    requireRole('admin')(req, mockRes(), next)

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'Authentication required' }))
  })
})

describe('requirePermission', () => {
  it('should pass for user with required permission', async () => {
    const { requirePermission } = await import('../../shared/middleware/auth.middleware.js')

    const req = { user: { roles: ['publisher'], permissions: ['campaigns.create'] } }
    const next = mockNext()

    requirePermission('campaigns.create')(req, mockRes(), next)

    expect(next).toHaveBeenCalledWith()
  })

  it('should reject user without required permission', async () => {
    const { requirePermission } = await import('../../shared/middleware/auth.middleware.js')

    const req = { user: { roles: ['client'], permissions: ['users.read'] } }
    const next = mockNext()

    requirePermission('admin.access')(req, mockRes(), next)

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'Insufficient permissions' }))
  })

  it('should bypass for super_admin', async () => {
    const { requirePermission } = await import('../../shared/middleware/auth.middleware.js')

    const req = { user: { roles: ['super_admin'], permissions: [] } }
    const next = mockNext()

    requirePermission('some.obscure.permission')(req, mockRes(), next)

    expect(next).toHaveBeenCalledWith()
  })

  it('should reject unauthenticated request', async () => {
    const { requirePermission } = await import('../../shared/middleware/auth.middleware.js')

    const req = { user: null }
    const next = mockNext()

    requirePermission('users.read')(req, mockRes(), next)

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'Authentication required' }))
  })
})
