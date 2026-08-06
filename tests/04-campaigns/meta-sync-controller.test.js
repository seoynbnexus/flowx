import { describe, it, expect, vi, beforeEach } from 'vitest'
import { generateUuid } from '../../shared/utils/uuid.utils.js'
import * as campaignController from '../../src/modules/campaigns/campaign.controller.js'
import * as adminController from '../../src/modules/campaigns/admin.controller.js'

var serviceMocks
vi.mock('../../src/modules/campaigns/campaign.service.js', () => {
  serviceMocks = {
    getCampaignInsights: vi.fn(),
    getMetaSyncHealth: vi.fn(),
    forceSyncCampaign: vi.fn(),
    queueManualSettle: vi.fn(),
  }
  return serviceMocks
})

function mockRes() {
  const json = []
  const res = {
    status: vi.fn(() => res),
    json: (data) => { json.push(data); return res },
  }
  return { res, json }
}

describe('meta sync controllers', () => {
  beforeEach(() => {
    serviceMocks.getCampaignInsights.mockReset()
    serviceMocks.getMetaSyncHealth.mockReset()
    serviceMocks.forceSyncCampaign.mockReset()
    serviceMocks.queueManualSettle.mockReset()
  })

  describe('campaign insights controller', () => {
    it('passes (user.id, campaignId, req.query) and returns cached insights', async () => {
      const result = { cached: true, rows: [], totalSpendPaise: 0 }
      serviceMocks.getCampaignInsights.mockResolvedValue(result)

      const userId = generateUuid()
      const campaignId = generateUuid()
      const query = { from: '2026-07-01' }
      const { res, json } = mockRes()
      const next = vi.fn()

      await campaignController.getCampaignInsights({ user: { id: userId }, params: { id: campaignId }, query }, res, next)

      expect(serviceMocks.getCampaignInsights).toHaveBeenCalledWith(userId, campaignId, query)
      expect(next).not.toHaveBeenCalled()
      expect(json[0]).toMatchObject({ success: true, data: result })
    })

    it('forwards refresh requests unchanged', async () => {
      serviceMocks.getCampaignInsights.mockResolvedValue({ queued: true })
      const query = { refresh: 'true' }
      const { res, json } = mockRes()
      const next = vi.fn()

      await campaignController.getCampaignInsights(
        { user: { id: generateUuid() }, params: { id: generateUuid() }, query },
        res, next)

      expect(serviceMocks.getCampaignInsights).toHaveBeenCalledWith(expect.any(String), expect.any(String), query)
      expect(json[0]).toMatchObject({ success: true, data: { queued: true } })
    })
  })

  describe('admin meta sync controllers', () => {
    it('serves sync health when empty', async () => {
      const health = { runningCount: 0, staleCampaigns: [], failedJobs: {}, unsettledCount: 0 }
      serviceMocks.getMetaSyncHealth.mockResolvedValue(health)
      const { res, json } = mockRes()
      const next = vi.fn()

      await adminController.getMetaSyncHealth({}, res, next)

      expect(serviceMocks.getMetaSyncHealth).toHaveBeenCalledTimes(1)
      expect(next).not.toHaveBeenCalled()
      expect(json[0]).toMatchObject({ success: true, data: health })
    })

    it('sends 202 with queued result for manual force sync', async () => {
      const result = { queued: true, enqueued: true }
      serviceMocks.forceSyncCampaign.mockResolvedValue(result)
      const campaignId = generateUuid()
      const { res, json } = mockRes()
      const next = vi.fn()

      await adminController.syncCampaign({ params: { id: campaignId } }, res, next)

      expect(serviceMocks.forceSyncCampaign).toHaveBeenCalledWith(campaignId)
      expect(next).not.toHaveBeenCalled()
      expect(res.status).toHaveBeenCalledWith(202)
    })

    it('queues manual settlement with 202', async () => {
      const jobId = generateUuid()
      serviceMocks.queueManualSettle.mockResolvedValue({ queued: true, jobId })
      const campaignId = generateUuid()
      const { res, json } = mockRes()
      const next = vi.fn()

      await adminController.settleCampaign({ params: { id: campaignId } }, res, next)

      expect(serviceMocks.queueManualSettle).toHaveBeenCalledWith(campaignId)
      expect(next).not.toHaveBeenCalled()
      expect(res.status).toHaveBeenCalledWith(202)
      expect(json[0]).toMatchObject({ success: true, data: { jobId } })
    })

    it('reports already-settled campaigns as success without queuing', async () => {
      serviceMocks.queueManualSettle.mockResolvedValue({ queued: false, alreadySettled: true })
      const { res, json } = mockRes()
      const next = vi.fn()

      await adminController.settleCampaign({ params: { id: generateUuid() } }, res, next)

      expect(next).not.toHaveBeenCalled()
      expect(res.status).not.toHaveBeenCalledWith(202)
      expect(json[0]).toMatchObject({ success: true })
    })
  })
})