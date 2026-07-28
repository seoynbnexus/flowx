import { describe, it, expect, beforeAll } from 'vitest'
import { generateUuid } from '../../shared/utils/uuid.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import * as aiService from '../../src/modules/ai/ai.service.js'
import * as aiRepo from '../../src/modules/ai/ai.repository.js'
import * as subRepo from '../../src/modules/subscriptions/subscription.repository.js'

const dateTag = Date.now()

async function ensurePlan(userId) {
  const sub = await subRepo.findUserSubscription(userId)
  if (sub) return
  const freePlan = await subRepo.findPlanBySlug('free')
  if (freePlan) {
    await subRepo.upsertUserSubscription(userId, freePlan.id, {
      status: 'active',
      billingCycle: 'monthly',
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    })
  }
}

describe('AI content CRUD', () => {
  let testUser, contentId

  beforeAll(async () => {
    testUser = await createTestUser({
      email: `ai-user-${dateTag}@flowx-test.com`,
      password: 'Test@123',
      coins: 5000,
    })
    await ensurePlan(testUser.id)
  })

  it('should save generated content', async () => {
    const saved = await aiService.saveContent(testUser.id, 'Test prompt', 'caption', 'Generated content text', {
      model: 'test-model',
      provider: 'test',
      tone: 'professional',
      language: 'en',
      promptTokens: 10,
      completionTokens: 20,
    })
    expect(saved.generated_content).toBe('Generated content text')
    expect(saved.metadata.model).toBe('test-model')
    contentId = saved.id
  })

  it('should get content history', async () => {
    const history = await aiService.getHistory(testUser.id, { page: 1, limit: 10 })
    expect(history.items.length).toBeGreaterThanOrEqual(1)
    expect(history.items.some(h => h.id === contentId)).toBe(true)
  })

  it('should delete content', async () => {
    await aiService.saveContent(testUser.id, 'Another prompt', 'hashtags', 'More text', {})
    const before = await aiService.getHistory(testUser.id, { page: 1, limit: 100 })
    const toDelete = before.items[before.items.length - 1].id
    await aiService.deleteContent(toDelete, testUser.id)
    const after = await aiService.getHistory(testUser.id, { page: 1, limit: 100 })
    expect(after.items.some(h => h.id === toDelete)).toBe(false)
  })

  it('should return user wallet', async () => {
    const wallet = await aiService.getUserWallet(testUser.id)
    expect(wallet).toHaveProperty('balance')
    expect(wallet).toHaveProperty('monthlyRemaining')
    expect(wallet).toHaveProperty('topupBalance')
    expect(typeof wallet.balance).toBe('number')
  })

  it('should save an image via repo', async () => {
    const saved = await aiRepo.createGeneratedImage(
      testUser.id,
      'Test image prompt',
      '/ai_user_image/test/test.png',
      'realistic',
      '1024x1024',
      0,
      {}
    )
    expect(saved).toHaveProperty('id')
    expect(saved.style).toBe('realistic')
  })

  it('should list images', async () => {
    const images = await aiService.getImages(testUser.id, { page: 1, limit: 10 })
    expect(Array.isArray(images.items)).toBe(true)
  })

  it('should delete an image', async () => {
    const before = await aiService.getImages(testUser.id, { page: 1, limit: 100 })
    const toDelete = before.items[0]
    if (toDelete) {
      await aiService.deleteImage(toDelete.id, testUser.id)
      const after = await aiService.getImages(testUser.id, { page: 1, limit: 100 })
      expect(after.items.some(img => img.id === toDelete.id)).toBe(false)
    }
  })

  it('should perform admin coin operations', async () => {
    const walletBefore = await aiService.getUserWallet(testUser.id)
    const transactionId = generateUuid()

    await aiRepo.addCoins(testUser.id, 1000)
    await aiRepo.createTransaction(transactionId, testUser.id, 'Admin add', 1000, 'credit', 'admin_add')

    const walletAfter = await aiService.getUserWallet(testUser.id)
    expect(walletAfter.topupBalance).toBe(walletBefore.topupBalance + 1000)
  })
})
