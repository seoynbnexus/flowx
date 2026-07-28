import { describe, it, expect, beforeAll, vi } from 'vitest'
import { createTestUser } from '../helpers/create-user.js'
import { transaction } from '../../shared/database/connection.js'
import { generateUuid, uuidToBuffer, bufferToUuid } from '../../shared/utils/uuid.utils.js'
import * as aiRepo from '../../src/modules/ai/ai.repository.js'
import * as coinService from '../../shared/services/coin.service.js'

let testUser
let monthlyAllowance
const testEmail = `coin-spend-${Date.now()}@flowx-test.com`

beforeAll(async () => {
  testUser = await createTestUser({ email: testEmail, password: 'Test@123', coins: 5000 })
  const usage = await coinService.getAvailable(testUser.id)
  monthlyAllowance = usage.monthlyRemaining
})

describe('coin spend flow via coinService', () => {
  it('should spend from monthly allowance first, then wallet', async () => {
    const usage = await coinService.getAvailable(testUser.id)
    const remainingMonthly = usage.monthlyRemaining
    const beforeWallet = await aiRepo.findUserWalletCoins(testUser.id)

    const spendFromMonthly = Math.min(100, remainingMonthly)
    const spendFromWallet = 100 - spendFromMonthly

    await coinService.spend(testUser.id, 100, 'test_resource', null, 'Test coin spend')

    const afterWallet = await aiRepo.findUserWalletCoins(testUser.id)
    const walletDiff = Number(beforeWallet) - Number(afterWallet)
    expect(walletDiff).toBe(spendFromWallet)
  })

  it('should throw INSUFFICIENT_COINS when total balance is too low', async () => {
    const usage = await coinService.getAvailable(testUser.id)
    const total = usage.total

    await expect(
      coinService.spend(testUser.id, total + 1, 'test_resource', null, 'Insufficient test')
    ).rejects.toThrow(/insufficient coins/i)
  })

  it('should not spend when amount is zero', async () => {
    const beforeWallet = await aiRepo.findUserWalletCoins(testUser.id)

    await coinService.spend(testUser.id, 0, 'test_resource', null, 'Zero spend')

    const afterWallet = await aiRepo.findUserWalletCoins(testUser.id)
    expect(Number(afterWallet)).toBe(Number(beforeWallet))
  })
})

describe('admin coin operations', () => {
  it('should add coins via repository', async () => {
    const before = await aiRepo.findUserWalletCoins(testUser.id)

    await aiRepo.addCoins(testUser.id, 250)

    const after = await aiRepo.findUserWalletCoins(testUser.id)
    expect(Number(after)).toBe(Number(before) + 250)
  })

  it('should deduct coins via repository', async () => {
    const before = await aiRepo.findUserWalletCoins(testUser.id)

    await aiRepo.deductCoins(testUser.id, 100)

    const after = await aiRepo.findUserWalletCoins(testUser.id)
    expect(Number(after)).toBe(Number(before) - 100)
  })

  it('should create a coin transaction record', async () => {
    await aiRepo.createTransaction(
      generateUuid(),
      testUser.id,
      'Test transaction',
      500,
      'credit',
      'test',
      null
    )
  })
})

describe('coin atomicity - repository level', () => {
  it('should roll back deductCoins when wrapped in a failing transaction', async () => {
    const userId = testUser.id
    const before = await aiRepo.findUserWalletCoins(userId)
    expect(before).toBeGreaterThan(0)

    try {
      await transaction(async () => {
        await aiRepo.deductCoins(userId, 500)
        throw new Error('Simulated failure after deduct')
      })
    } catch (e) {
      expect(e.message).toBe('Simulated failure after deduct')
    }

    const after = await aiRepo.findUserWalletCoins(userId)
    expect(Number(after)).toBe(Number(before))
  })
})
