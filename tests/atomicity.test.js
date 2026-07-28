import { describe, it, expect, beforeAll } from 'vitest'
import { transaction } from '../shared/database/connection.js'
import * as aiRepo from '../src/modules/ai/ai.repository.js'
import { createTestUser } from './helpers/create-user.js'

let testUser = { id: null, email: null }
const testEmail = `atomicity-${Date.now()}@flowx-test.com`

beforeAll(async () => {
  testUser = await createTestUser({ email: testEmail, password: 'Test@123', coins: 10000 })
})

describe('Transaction atomicity', () => {
  it('should roll back when a crash occurs inside transaction()', async () => {
    const userId = testUser.id
    const before = await aiRepo.findUserWalletCoins(userId)
    expect(before).toBeGreaterThan(0)

    try {
      await transaction(async () => {
        await aiRepo.deductCoins(userId, 500)
        throw new Error('Simulated crash after deduct')
      })
    } catch (e) {
      expect(e.message).toBe('Simulated crash after deduct')
    }

    const after = await aiRepo.findUserWalletCoins(userId)
    expect(after).toBe(before)
  })

  it('should roll back nested transaction when inner throws', async () => {
    const userId = testUser.id
    const before = await aiRepo.findUserWalletCoins(userId)
    expect(before).toBeGreaterThan(0)

    try {
      await transaction(async () => {
        await transaction(async () => {
          await aiRepo.deductCoins(userId, 300)
          throw new Error('Inner crash')
        })
      })
    } catch (e) {
      expect(e.message).toBe('Inner crash')
    }

    const after = await aiRepo.findUserWalletCoins(userId)
    expect(after).toBe(before)
  })

  it('should not affect outer balance when inner transaction succeeds and outer crashes', async () => {
    const userId = testUser.id
    const before = await aiRepo.findUserWalletCoins(userId)
    expect(before).toBeGreaterThan(0)

    try {
      await transaction(async () => {
        await aiRepo.deductCoins(userId, 100)
        await transaction(async () => {
          await aiRepo.deductCoins(userId, 200)
        })
        throw new Error('Outer crash after inner succeeds')
      })
    } catch (e) {
      expect(e.message).toBe('Outer crash after inner succeeds')
    }

    const after = await aiRepo.findUserWalletCoins(userId)
    expect(after).toBe(before)
  })

  it('should commit successfully when no crash occurs', async () => {
    const userId = testUser.id
    const before = await aiRepo.findUserWalletCoins(userId)
    expect(before).toBeGreaterThan(0)

    await transaction(async () => {
      await aiRepo.deductCoins(userId, 50)
    })

    const after = await aiRepo.findUserWalletCoins(userId)
    expect(after).toBe(before - 50)
  })
})
