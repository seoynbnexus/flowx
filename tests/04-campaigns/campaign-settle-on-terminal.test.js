import { describe, it, expect, beforeAll } from 'vitest'
import * as repo from '../../src/modules/campaigns/campaign.repository.js'
import * as service from '../../src/modules/campaigns/campaign.service.js'
import * as coinService from '../../shared/services/coin.service.js'
import { drainCampaignJobs } from '../../src/modules/campaigns/campaign.jobs.js'
import { generateUuid } from '../../shared/utils/uuid.utils.js'
import { createTestUser } from '../helpers/create-user.js'

const dateTag = Date.now()
let userCounter = 0

// escrowAmount is deliberately left at 0 here: a real escrow refund requires
// a matching prior consumeUsage() against monthly coins, which is orthogonal
// to what this file tests (the ad-budget charge refund — the actual C2 fix).
// The escrow-refund path itself is already covered by other suites.
async function seedChargedAwaitingCampaign(overrides = {}) {
  userCounter += 1
  const client = await createTestUser({ email: `settle-${dateTag}-${userCounter}@flowx-test.com`, password: 'Test@123', coins: 5000 })
  const campaign = await service.createCampaign(client.id, {
    name: `Settle ${generateUuid().substring(0, 8)}`,
    type: 'post',
    publisherCount: 1,
    coinsPerPublisher: 100,
  })
  await repo.createCreative(generateUuid(), campaign.id, { caption: 'settle test', mediaUrl: 'https://example.com/img.jpg' })
  await repo.updateCampaign(campaign.id, {
    status: 'awaiting_publishers',
    chargedAdBudgetPaise: 50000,
    ...overrides,
  })
  return { client, campaign: await repo.findCampaignById(campaign.id) }
}

describe('ad-budget settlement on terminal failure paths (C2 fix)', () => {
  beforeAll(async () => {
    process.env.META_SYSTEM_USER_TOKEN = process.env.META_SYSTEM_USER_TOKEN || 'test_system_user_token'
    process.env.META_AD_ACCOUNT_ID = process.env.META_AD_ACCOUNT_ID || 'act_test_account'
  })

  it('handleExpiredAwaitingCampaigns refunds the charged ad budget on deadline expiry', async () => {
    const { client, campaign } = await seedChargedAwaitingCampaign({
      publisherResponseDeadlineAt: new Date(Date.now() - 60000).toISOString().slice(0, 19).replace('T', ' '),
    })
    const before = await coinService.getAvailable(client.id)

    const results = await service.handleExpiredAwaitingCampaigns()
    const mine = results.find(r => r.campaignId === campaign.id)
    expect(mine?.success).toBe(true)
    await drainCampaignJobs()

    const updated = await repo.findCampaignById(campaign.id)
    expect(updated.status).toBe('failed')
    expect(updated.settledAt).toBeTruthy()

    const after = await coinService.getAvailable(client.id)
    // Full ad-budget refund: 50000 paise at rate 1 coin/rupee = 500 coins
    expect(after.total - before.total).toBe(500)
  })

  it('forceCancelCampaign refunds the charged ad budget on admin cancellation', async () => {
    const { client, campaign } = await seedChargedAwaitingCampaign()
    const before = await coinService.getAvailable(client.id)

    await service.forceCancelCampaign(null, campaign.id)
    await drainCampaignJobs()

    const updated = await repo.findCampaignById(campaign.id)
    expect(updated.status).toBe('cancelled')
    expect(updated.settledAt).toBeTruthy()

    const after = await coinService.getAvailable(client.id)
    expect(after.total - before.total).toBe(500)
  })

  it('settlement is idempotent — draining twice never double-refunds', async () => {
    const { client, campaign } = await seedChargedAwaitingCampaign()
    const before = await coinService.getAvailable(client.id)

    await service.forceCancelCampaign(null, campaign.id)
    await drainCampaignJobs()
    const afterFirst = await coinService.getAvailable(client.id)

    // A second settle attempt on an already-settled campaign must be a no-op.
    const second = await service.settleCampaignJob(campaign.id)
    expect(second.alreadySettled).toBe(true)
    const afterSecond = await coinService.getAvailable(client.id)

    expect(afterFirst.total - before.total).toBe(500)
    expect(afterSecond.total).toBe(afterFirst.total)
  })
})
