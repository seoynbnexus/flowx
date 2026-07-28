import { describe, it, expect, beforeAll } from 'vitest'
import { query, queryOne } from '../../shared/database/connection.js'
import { generateUuid, uuidToBuffer } from '../../shared/utils/uuid.utils.js'
import * as roleRepo from '../../src/modules/roles/role.repository.js'
import * as permissionRepo from '../../src/modules/permissions/permission.repository.js'

let testRole, testPermissions

beforeAll(async () => {
  testRole = await roleRepo.create({ code: `test-role-${Date.now()}`, name: 'Test Role' })
  const perms = await permissionRepo.findAll()
  testPermissions = perms.slice(0, 2)
})

describe('remove', () => {
  it('should delete role and all related records', async () => {
    const role = await roleRepo.create({ code: `del-role-${Date.now()}`, name: 'Delete Role' })
    await roleRepo.setPermissions(role.id, testPermissions.map(p => p.id))

    await roleRepo.remove(role.id)

    const deleted = await roleRepo.findById(role.id)
    expect(deleted).toBeNull()

    const rp = await query(
      'SELECT * FROM role_permissions WHERE role_id = ?',
      [uuidToBuffer(role.id)]
    )
    expect(rp).toHaveLength(0)
  })

  it('should throw when removing non-existent role', async () => {
    await expect(roleRepo.remove(generateUuid())).resolves.not.toThrow()
  })
})

describe('setPermissions', () => {
  it('should replace existing permissions with new ones', async () => {
    const role = await roleRepo.create({ code: `perm-role-${Date.now()}`, name: 'Permissions Role' })

    await roleRepo.setPermissions(role.id, testPermissions.map(p => p.id))

    const perms1 = await roleRepo.getPermissions(role.id)
    expect(perms1).toHaveLength(testPermissions.length)

    await roleRepo.setPermissions(role.id, [])

    const perms2 = await roleRepo.getPermissions(role.id)
    expect(perms2).toHaveLength(0)
  })

  it('should handle empty permission list', async () => {
    const role = await roleRepo.create({ code: `empty-perm-${Date.now()}`, name: 'Empty Perm' })

    await roleRepo.setPermissions(role.id, [])
    const perms = await roleRepo.getPermissions(role.id)
    expect(perms).toHaveLength(0)
  })
})
