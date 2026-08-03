import { describe, it, expect, vi, beforeEach } from 'vitest'
import { generateUuid } from '../../shared/utils/uuid.utils.js'
import * as controller from '../../src/modules/campaigns/campaign.controller.js'

var mocks
vi.mock('../../src/modules/campaigns/campaign.service.js', () => {
  mocks = {
    validateCampaignDraft: vi.fn(),
  }
  return mocks
})

function mockRes() {
  const json = []
  const res = {
    status: () => res,
    json: (data) => { json.push(data); return res },
  }
  return { res, json }
}

describe('campaign validate controller', () => {
  beforeEach(() => {
    mocks.validateCampaignDraft.mockReset()
  })

  it('passes (req.user.id, req.params.id) in the correct order', async () => {
    const result = { valid: true, checks: [{ object: 'creative', ok: true }] }
    mocks.validateCampaignDraft.mockResolvedValue(result)

    const userId = generateUuid()
    const campaignId = generateUuid()
    const { res, json } = mockRes()
    const next = vi.fn()

    await controller.validateCampaign({ user: { id: userId }, params: { id: campaignId } }, res, next)

    expect(mocks.validateCampaignDraft).toHaveBeenCalledTimes(1)
    expect(mocks.validateCampaignDraft).toHaveBeenCalledWith(userId, campaignId)
    expect(next).not.toHaveBeenCalled()
    expect(json[0]).toMatchObject({ success: true, data: result })
  })

  it('forwards service errors to next()', async () => {
    const error = new Error('Campaign not found')
    mocks.validateCampaignDraft.mockRejectedValue(error)

    const { res } = mockRes()
    const next = vi.fn()

    await controller.validateCampaign({ user: { id: generateUuid() }, params: { id: generateUuid() } }, res, next)

    expect(next).toHaveBeenCalledWith(error)
  })
})
