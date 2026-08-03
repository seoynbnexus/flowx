import { describe, it, expect, vi, beforeEach } from 'vitest'
import { generateUuid } from '../../shared/utils/uuid.utils.js'
import * as adminController from '../../src/modules/campaigns/admin.controller.js'
import * as campaignController from '../../src/modules/campaigns/campaign.controller.js'

var adminMocks
vi.mock('../../src/modules/campaigns/campaign.service.js', () => {
  adminMocks = {
    approveCampaign: vi.fn(),
    rejectCampaign: vi.fn(),
    queueRetryMeta: vi.fn(),
    queueForceGoLive: vi.fn(),
    confirmAdjustments: vi.fn(),
  }
  return adminMocks
})

function mockRes() {
  let statusCode = null
  let body = null
  const res = {
    status: (code) => { statusCode = code; return res },
    json: (data) => { body = data; return res },
    send: () => res,
  }
  return { res, getStatus: () => statusCode, getBody: () => body }
}

describe('campaign async controllers (202)', () => {
  beforeEach(() => {
    for (const fn of Object.values(adminMocks)) fn.mockReset()
  })

  it('approveCampaign returns 202 with jobId when queued', async () => {
    const jobId = generateUuid()
    adminMocks.approveCampaign.mockResolvedValue({ queued: true, jobId })

    const { res, getStatus, getBody } = mockRes()
    await adminController.approveCampaign(
      { user: { id: generateUuid() }, params: { id: generateUuid() }, body: {} },
      res, vi.fn()
    )

    expect(getStatus()).toBe(202)
    expect(getBody()).toMatchObject({ success: true, data: { jobId } })
  })

  it('approveCampaign returns 200 when the fast path applied', async () => {
    adminMocks.approveCampaign.mockResolvedValue({ status: 'awaiting_publishers' })

    const { res, getStatus } = mockRes()
    await adminController.approveCampaign(
      { user: { id: generateUuid() }, params: { id: generateUuid() }, body: { publisherCount: 3 } },
      res, vi.fn()
    )

    expect(getStatus()).toBe(200)
  })

  it('forceGoLive returns 202 with jobId', async () => {
    const jobId = generateUuid()
    adminMocks.queueForceGoLive.mockResolvedValue({ queued: true, jobId })

    const { res, getStatus, getBody } = mockRes()
    await adminController.forceGoLive({ user: { id: generateUuid() }, params: { id: generateUuid() } }, res, vi.fn())

    expect(getStatus()).toBe(202)
    expect(getBody().data.jobId).toBe(jobId)
  })

  it('retryCampaignMeta returns 202 with jobId', async () => {
    const jobId = generateUuid()
    adminMocks.queueRetryMeta.mockResolvedValue({ queued: true, jobId })

    const { res, getStatus, getBody } = mockRes()
    await adminController.retryCampaignMeta({ params: { id: generateUuid() } }, res, vi.fn())

    expect(getStatus()).toBe(202)
    expect(getBody().data.jobId).toBe(jobId)
  })

  it('confirmAdjustments returns 202 with jobId when queued', async () => {
    const jobId = generateUuid()
    adminMocks.confirmAdjustments.mockResolvedValue({ queued: true, jobId })

    const { res, getStatus, getBody } = mockRes()
    await campaignController.confirmAdjustments({ user: { id: generateUuid() }, params: { id: generateUuid() } }, res, vi.fn())

    expect(getStatus()).toBe(202)
    expect(getBody().data.jobId).toBe(jobId)
  })

  it('confirmAdjustments returns 200 for the publisher fast path', async () => {
    adminMocks.confirmAdjustments.mockResolvedValue({ status: 'awaiting_publishers' })

    const { res, getStatus } = mockRes()
    await campaignController.confirmAdjustments({ user: { id: generateUuid() }, params: { id: generateUuid() } }, res, vi.fn())

    expect(getStatus()).toBe(200)
  })

  it('forwards service errors to next()', async () => {
    const error = new Error('Campaign not found')
    adminMocks.queueForceGoLive.mockRejectedValue(error)

    const { res } = mockRes()
    const next = vi.fn()
    await adminController.forceGoLive({ user: { id: generateUuid() }, params: { id: generateUuid() } }, res, next)

    expect(next).toHaveBeenCalledWith(error)
  })
})
