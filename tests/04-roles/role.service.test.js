import { describe, it, expect, beforeAll } from 'vitest'
import { generateUuid } from '../../shared/utils/uuid.utils.js'
import * as roleService from '../../src/modules/roles/role.service.js'
import * as roleRepo from '../../src/modules/roles/role.repository.js'

const dateTag = Date.now()

describe('role service', () => {
  let testRoleId
  let permIds = []

  beforeAll(async () => {
    const perms = await roleRepo.getPermissions(generateUuid())
    const rows = Array.isArray(perms) && perms.length > 0
      ? perms
      : []
    permIds = rows.slice(0, 2).map(p => p.id)
  })

  it('should list roles', async () => {
    const roles = await roleService.list()
    expect(Array.isArray(roles)).toBe(true)
    expect(roles.length).toBeGreaterThanOrEqual(5)
  })

  it('should create a role', async () => {
    const role = await roleService.create({
      code: `test_role_${dateTag}`,
      name: `Test Role ${dateTag}`,
      description: 'A test role',
    })
    expect(role.code).toBe(`test_role_${dateTag}`)
    expect(role.is_system).toBe(0)
    testRoleId = role.id
  })

  it('should reject duplicate role code', async () => {
    await expect(
      roleService.create({ code: `test_role_${dateTag}`, name: 'Duplicate' })
    ).rejects.toThrow(/already exists/i)
  })

  it('should get role by id', async () => {
    const role = await roleService.getById(testRoleId)
    expect(role.id).toBe(testRoleId)
    expect(role.code).toBe(`test_role_${dateTag}`)
  })

  it('should throw on non-existent role', async () => {
    await expect(roleService.getById(generateUuid())).rejects.toThrow(/not found/i)
  })

  it('should update a role', async () => {
    const updated = await roleService.update(testRoleId, { name: 'Updated Role' })
    expect(updated.name).toBe('Updated Role')
  })

  it('should reject updating system roles', async () => {
    const adminRole = await roleRepo.findByCode('admin')
    if (adminRole) {
      await expect(
        roleService.update(adminRole.id, { name: 'Hacked' })
      ).rejects.toThrow(/system/i)
    }
  })

  it('should assign and retrieve permissions', async () => {
    if (permIds.length < 2) return

    await roleService.assignPermissions(testRoleId, permIds)
    const perms = await roleService.getPermissions(testRoleId)
    expect(perms.length).toBe(permIds.length)
  })

  it('should delete a role', async () => {
    await roleService.remove(testRoleId)
    await expect(roleService.getById(testRoleId)).rejects.toThrow(/not found/i)
  })

  it('should reject deleting system roles', async () => {
    const adminRole = await roleRepo.findByCode('admin')
    if (adminRole) {
      await expect(roleService.remove(adminRole.id)).rejects.toThrow(/system/i)
    }
  })
})
