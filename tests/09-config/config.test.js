import { describe, it, expect, beforeAll } from 'vitest'
import { createTestUser } from '../helpers/create-user.js'
import * as configService from '../../src/modules/config/config.service.js'

const dateTag = Date.now()

describe('config', () => {
  it('should return public config without auth', async () => {
    const config = await configService.getPublicConfig()
    expect(config).toHaveProperty('dropdownOptions')
    expect(config).toHaveProperty('countryCodes')
    expect(Array.isArray(config.countryCodes)).toBe(true)
    expect(config.dropdownOptions.documentTypes.length).toBeGreaterThanOrEqual(2)
  })

  it('should return full config for authenticated user', async () => {
    const user = await createTestUser({
      email: `cfg-user-${dateTag}@flowx-test.com`,
      password: 'Test@123',
    })
    const config = await configService.getFullConfig(user.id)
    expect(config.user).not.toBeNull()
    expect(config.user.id).toBe(user.id)
    expect(config).toHaveProperty('subscription')
    expect(config).toHaveProperty('ai')
  })

  it('should return user:null for non-existent user', async () => {
    const config = await configService.getFullConfig('00000000-0000-0000-0000-000000000000')
    expect(config.user).toBeNull()
  })
})
