import { describe, it, expect, beforeAll } from 'vitest'
import { query, queryOne } from '../../shared/database/connection.js'
import { generateUuid, uuidToBuffer, bufferToUuid } from '../../shared/utils/uuid.utils.js'
import { encrypt } from '../../shared/utils/crypto.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import * as campaignService from '../../src/modules/campaigns/campaign.service.js'
import * as campaignRepo from '../../src/modules/campaigns/campaign.repository.js'

const dateTag = Date.now()

async function addVerifiedPage(userId, platformUserId) {
  const platform = await queryOne("SELECT id FROM platforms WHERE code = 'facebook'")
  await query(
    `INSERT INTO user_platform_accounts (id, user_id, platform_id, profile_url, platform_user_id,
       platform_username, platform_display_name, token_type, access_token, token_expires_at, verification_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'page', ?, DATE_ADD(NOW(), INTERVAL 60 DAY), 'verified')`,
    [uuidToBuffer(generateUuid()), uuidToBuffer(userId), platform.id, `https://fb.com/${platformUserId}`,
      platformUserId, `user_${platformUserId}`, `Display ${platformUserId}`, encrypt('mock_token')]
  )
}

describe('campaign publisher hardening', () => {
  let client, publisher, publisher2, campaignId, requestId

  beforeAll(async () => {
    client = await createTestUser({ email: `camp-hard-client-${dateTag}@flowx-test.com`, password: 'Test@123', coins: 10000 })
    publisher = await createTestUser({ email: `camp-hard-pub-${dateTag}@flowx-test.com`, password: 'Test@123', role: 'publisher' })
    publisher2 = await createTestUser({ email: `camp-hard-pub2-${dateTag}@flowx-test.com`, password: 'Test@123', role: 'publisher' })
    await addVerifiedPage(publisher.id, 'camp_hard_pub1')
    await addVerifiedPage(publisher2.id, 'camp_hard_pub2')

    campaignId = generateUuid()
    await campaignRepo.createCampaign(campaignId, client.id, {
      name: `Camp Hard ${dateTag}`,
      type: 'post',
      publisherCount: 1,
      coinsPerPublisher: 50,
    })
    await campaignRepo.createCreative(generateUuid(), campaignId, { caption: 'Hardening', mediaUrl: 'https://example.com/img.jpg' })
    await campaignRepo.updateCampaign(campaignId, { status: 'awaiting_publishers' })
    await campaignRepo.createPublisherRequests(campaignId, [publisher.id, publisher2.id], 50)
    const requests = await campaignRepo.findPublisherRequestsByCampaignId(campaignId)
    requestId = requests.find(r => r.publisherId === publisher.id).id
  })

  it('blocks accepting without a verified Facebook page', async () => {
    const noPage = await createTestUser({ email: `camp-hard-nopage-${dateTag}@flowx-test.com`, password: 'Test@123', role: 'publisher' })
    const reqId = generateUuid()
    await query(
      `INSERT INTO campaign_publisher_requests (id, campaign_id, publisher_id, coins_offered, status)
       VALUES (?, ?, ?, 50, 'pending')`,
      [uuidToBuffer(reqId), uuidToBuffer(campaignId), uuidToBuffer(noPage.id)]
    )
    await expect(campaignService.acceptPublisherRequest(noPage.id, reqId)).rejects.toThrow('verified Facebook page')
  })

  it('blocks completing another publisher\'s request', async () => {
    await expect(campaignService.completePublisherRequest(publisher2.id, requestId)).rejects.toThrow('Not your request')
  })

  it('pays out exactly once on completion (status guarded)', async () => {
    // must be published first
    await query(
      'UPDATE campaign_publisher_requests SET status = ?, published_at = NOW() WHERE id = ?',
      ['published', uuidToBuffer(requestId)]
    )
    const before = await queryOne('SELECT coins FROM user_wallets WHERE user_id = ?', [uuidToBuffer(publisher.id)])
    if (!before) {
      await query(
        'INSERT INTO user_wallets (user_id, coins, total_purchased_coins) VALUES (?, 0, 0)',
        [uuidToBuffer(publisher.id)]
      )
    }
    const completed = await campaignService.completePublisherRequest(publisher.id, requestId)
    expect(completed.status).toBe('completed')
    const after = await queryOne('SELECT coins FROM user_wallets WHERE user_id = ?', [uuidToBuffer(publisher.id)])
    expect(Number(after.coins)).toBe((Number(before?.coins) || 0) + 50)

    // second completion must fail (no double payout)
    await expect(campaignService.completePublisherRequest(publisher.id, requestId)).rejects.toThrow('must be')
    const after2 = await queryOne('SELECT coins FROM user_wallets WHERE user_id = ?', [uuidToBuffer(publisher.id)])
    expect(Number(after2.coins)).toBe(Number(after.coins))
  })

  it('includes system review logs (null reviewer) in campaign detail', async () => {
    const other = generateUuid()
    await campaignRepo.createCampaign(other, client.id, { name: `SysLog ${dateTag}`, type: 'post' })
    await campaignRepo.createReviewLog(other, null, 'submitted', 'draft', 'system action')
    const logs = await campaignRepo.findReviewLogsByCampaignId(other)
    expect(logs.some(l => l.reviewerId === null && l.notes === 'system action')).toBe(true)
    expect(logs.some(l => l.reviewerEmail === null)).toBe(true)
  })
})
