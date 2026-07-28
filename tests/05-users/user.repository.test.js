import { describe, it, expect, beforeAll } from 'vitest'
import { query, queryOne } from '../../shared/database/connection.js'
import { generateUuid, uuidToBuffer } from '../../shared/utils/uuid.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import * as userRepo from '../../src/modules/users/user.repository.js'

let testUser = { id: null, email: null }
const testEmail = `user-repo-${Date.now()}@flowx-test.com`
const testPassword = 'TestPass@123'

beforeAll(async () => {
  testUser = await createTestUser({ email: testEmail, password: testPassword, coins: 10000 })
})

describe('updateProfile (repository)', () => {
  it('should update profile fields only', async () => {
    const updated = await userRepo.updateProfile(testUser.id, {
      firstName: 'RepoFirst',
      lastName: 'RepoLast',
      countryCode: 'IN',
      city: 'Mumbai',
    })

    expect(updated.first_name).toBe('RepoFirst')
    expect(updated.last_name).toBe('RepoLast')
    expect(updated.city).toBe('Mumbai')
  })

  it('should update phone on users table when provided', async () => {
    await userRepo.updateProfile(testUser.id, { phone: '9999999999' })

    const user = await queryOne('SELECT * FROM users WHERE id = ?', [uuidToBuffer(testUser.id)])
    expect(user.phone).toBe('9999999999')
  })

  it('should update both profile and phone together', async () => {
    await userRepo.updateProfile(testUser.id, {
      firstName: 'Both',
      phone: '8888888888',
    })

    const profile = await userRepo.findProfileByUserId(testUser.id)
    expect(profile.first_name).toBe('Both')

    const user = await queryOne('SELECT * FROM users WHERE id = ?', [uuidToBuffer(testUser.id)])
    expect(user.phone).toBe('8888888888')
  })

  it('should handle empty data without errors', async () => {
    const result = await userRepo.updateProfile(testUser.id, {})
    expect(result).toBeDefined()
  })
})

describe('updateUserRole', () => {
  it('should replace existing role with new role', async () => {
    await userRepo.updateUserRole(testUser.id, 'admin')

    const roles = await query(
      'SELECT r.code FROM roles r JOIN user_roles ur ON ur.role_id = r.id WHERE ur.user_id = ?',
      [uuidToBuffer(testUser.id)]
    )
    expect(roles).toHaveLength(1)
    expect(roles[0].code).toBe('admin')
  })

  it('should throw error for non-existent role code', async () => {
    await expect(
      userRepo.updateUserRole(testUser.id, 'nonexistent_role')
    ).rejects.toThrow('Role not found')
  })
})
