import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as controller from '../../src/modules/campaigns/campaign.controller.js'

var mocks
vi.mock('../../src/modules/campaigns/campaign.service.js', () => {
  mocks = {
    checkCampaignMedia: vi.fn(),
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

describe('campaign media check controller', () => {
  beforeEach(() => {
    mocks.checkCampaignMedia.mockReset()
  })

  it('passes the request body through to the service and returns its result', async () => {
    const result = { ok: true, errorCode: null, message: null }
    mocks.checkCampaignMedia.mockResolvedValue(result)

    const body = { mediaUrl: 'https://example.com/img.png', platformPlacement: { publisher_platforms: ['facebook'] } }
    const { res, json } = mockRes()
    const next = vi.fn()

    await controller.checkCampaignMedia({ user: { id: 'u1' }, body }, res, next)

    expect(mocks.checkCampaignMedia).toHaveBeenCalledTimes(1)
    expect(mocks.checkCampaignMedia).toHaveBeenCalledWith(body)
    expect(next).not.toHaveBeenCalled()
    expect(json[0]).toMatchObject({ success: true, data: result })
  })

  it('forwards service errors to next()', async () => {
    const error = new Error('boom')
    mocks.checkCampaignMedia.mockRejectedValue(error)

    const { res } = mockRes()
    const next = vi.fn()

    await controller.checkCampaignMedia({ user: { id: 'u1' }, body: { mediaUrl: 'https://example.com/img.png' } }, res, next)

    expect(next).toHaveBeenCalledWith(error)
  })
})
