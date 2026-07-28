import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { query, queryOne } from '../../shared/database/connection.js'
import { generateUuid, uuidToBuffer } from '../../shared/utils/uuid.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import * as userService from '../../src/modules/users/user.service.js'

let testUser = { id: null, email: null }
const testEmail = `user-svc-${Date.now()}@flowx-test.com`
const testPassword = 'TestPass@123'

beforeAll(async () => {
  testUser = await createTestUser({ email: testEmail, password: testPassword, coins: 10000 })
})

describe('adminCreateUser', () => {
  const adminEmail = `admin-create-${Date.now()}@flowx-test.com`

  it('should create user with all related records', async () => {
    const user = await userService.adminCreateUser({
      email: adminEmail,
      password: testPassword,
      firstName: 'Admin',
      lastName: 'Created',
      role: 'client',
    })

    expect(user).toBeDefined()
    expect(user.email).toBe(adminEmail)

    const profile = await queryOne('SELECT * FROM user_profiles WHERE user_id = ?', [uuidToBuffer(user.id)])
    expect(profile).toBeDefined()
    expect(profile.first_name).toBe('Admin')

    const pw = await queryOne('SELECT * FROM user_passwords WHERE user_id = ?', [uuidToBuffer(user.id)])
    expect(pw).toBeDefined()

    const roles = await query(
      'SELECT r.code FROM roles r JOIN user_roles ur ON ur.role_id = r.id WHERE ur.user_id = ?',
      [uuidToBuffer(user.id)]
    )
    expect(roles.some(r => r.code === 'client')).toBe(true)

    const audit = await queryOne(
      "SELECT * FROM audit_logs WHERE entity_id = ? AND action = 'user.created_by_admin'",
      [uuidToBuffer(user.id)]
    )
    expect(audit).toBeDefined()
  })

  it('should reject duplicate emails', async () => {
    await expect(
      userService.adminCreateUser({
        email: adminEmail,
        password: testPassword,
        firstName: 'Dup',
        lastName: 'User',
        role: 'client',
      })
    ).rejects.toThrow('Email already registered')
  })
})

describe('updateProfile', () => {
  it('should update profile fields', async () => {
    const result = await userService.updateProfile(testUser.id, {
      firstName: 'Updated',
      lastName: 'Profile',
      countryCode: 'US',
    })

    expect(result.profile.first_name).toBe('Updated')
    expect(result.profile.last_name).toBe('Profile')
  })

  it('should update role when role is provided', async () => {
    const result = await userService.updateProfile(testUser.id, {
      role: 'publisher',
    })

    const roles = await query(
      'SELECT r.code FROM roles r JOIN user_roles ur ON ur.role_id = r.id WHERE ur.user_id = ?',
      [uuidToBuffer(testUser.id)]
    )
    expect(roles.some(r => r.code === 'publisher')).toBe(true)
  })

  it('should throw NotFoundError for non-existent user', async () => {
    await expect(
      userService.updateProfile(generateUuid(), { firstName: 'X' })
    ).rejects.toThrow('User not found')
  })
})

describe('updateUserStatus', () => {
  const statusUserEmail = `status-test-${Date.now()}@flowx-test.com`
  let statusUser

  beforeAll(async () => {
    statusUser = await createTestUser({ email: statusUserEmail, password: testPassword })
  })

  it('should change user status and create audit log', async () => {
    const updated = await userService.updateUserStatus(statusUser.id, 'blocked')
    expect(updated.status).toBe('blocked')

    const audit = await queryOne(
      "SELECT * FROM audit_logs WHERE entity_id = ? AND action = 'user.status_changed'",
      [uuidToBuffer(statusUser.id)]
    )
    expect(audit).toBeDefined()
    expect(audit.new_values).toContain('blocked')
  })

  it('should throw NotFoundError for deleted user', async () => {
    await expect(
      userService.updateUserStatus(generateUuid(), 'active')
    ).rejects.toThrow('User not found')
  })
})

describe('deleteUser', () => {
  const deleteUserEmail = `delete-test-${Date.now()}@flowx-test.com`
  let deleteUser

  beforeAll(async () => {
    deleteUser = await createTestUser({ email: deleteUserEmail, password: testPassword })
  })

  it('should soft delete user and create audit log', async () => {
    await userService.deleteUser(deleteUser.id)

    const user = await queryOne(
      'SELECT * FROM users WHERE id = ?',
      [uuidToBuffer(deleteUser.id)]
    )
    expect(user.deleted_at).not.toBeNull()
    expect(user.status).toBe('inactive')

    const audit = await queryOne(
      "SELECT * FROM audit_logs WHERE entity_id = ? AND action = 'user.deleted'",
      [uuidToBuffer(deleteUser.id)]
    )
    expect(audit).toBeDefined()
  })

  it('should throw NotFoundError for already deleted user', async () => {
    await expect(
      userService.deleteUser(deleteUser.id)
    ).rejects.toThrow('User not found')
  })
})

describe('changePassword', () => {
  it('should change password successfully', async () => {
    const newPassword = 'NewPass@456'
    await userService.changePassword(testUser.id, testPassword, newPassword)

    const pw = await queryOne(
      'SELECT * FROM user_passwords WHERE user_id = ?',
      [uuidToBuffer(testUser.id)]
    )
    const bcrypt = await import('bcryptjs')
    const valid = await bcrypt.compare(newPassword, pw.password_hash)
    expect(valid).toBe(true)

    const audit = await queryOne(
      "SELECT * FROM audit_logs WHERE entity_id = ? AND action = 'user.password_changed'",
      [uuidToBuffer(testUser.id)]
    )
    expect(audit).toBeDefined()
  })

  it('should reject wrong current password', async () => {
    await expect(
      userService.changePassword(testUser.id, 'WrongPassword@1', 'NewPass@789')
    ).rejects.toThrow('Current password is incorrect')
  })

  it('should throw NotFoundError for non-existent user', async () => {
    await expect(
      userService.changePassword(generateUuid(), 'x', 'y')
    ).rejects.toThrow('User not found')
  })
})
