import { describe, it, expect } from 'vitest'
import * as analyticsController from '../../src/modules/analytics/admin.controller.js'

function mockReqRes(overrides = {}) {
  const json = []
  const res = { json: (data) => { json.push(data); return res }, status: () => res }
  return { req: { query: {}, ...overrides }, res, json }
}

describe('analytics admin', () => {
  it('should return overview stats', async () => {
    const { req, res, json } = mockReqRes()
    await analyticsController.getOverview(req, res)
    const data = json[0].data
    expect(data).toHaveProperty('totalUsers')
    expect(typeof data.totalUsers).toBe('number')
    expect(data.totalUsers).toBeGreaterThanOrEqual(1)
    expect(data).toHaveProperty('totalAiGenerations')
    expect(data).toHaveProperty('totalAiCoinsSpent')
  })

  it('should return user analytics', async () => {
    const { req, res, json } = mockReqRes({ query: { page: '1', limit: '10', sort: 'created_at', order: 'desc' } })
    await analyticsController.getUsers(req, res)
    const data = json[0].data
    expect(Array.isArray(data.items)).toBe(true)
    expect(data.items.length).toBeGreaterThanOrEqual(1)
    expect(data.items[0]).toHaveProperty('email')
  })

  it('should return login analytics', async () => {
    const { req, res, json } = mockReqRes({ query: { days: '30' } })
    await analyticsController.getLogins(req, res)
    const data = json[0].data
    expect(Array.isArray(data.dailyLogins)).toBe(true)
    expect(Array.isArray(data.loginMethods)).toBe(true)
  })

  it('should return AI usage analytics', async () => {
    const { req, res, json } = mockReqRes({ query: { days: '30' } })
    await analyticsController.getAiUsage(req, res)
    const data = json[0].data
    expect(Array.isArray(data.dailyUsage)).toBe(true)
    expect(Array.isArray(data.typeBreakdown)).toBe(true)
  })

  it('should return economy stats', async () => {
    const { req, res, json } = mockReqRes()
    await analyticsController.getEconomy(req, res)
    const data = json[0].data
    expect(data).toHaveProperty('totalWallets')
    expect(data).toHaveProperty('totalCoinsInSystem')
  })
})
