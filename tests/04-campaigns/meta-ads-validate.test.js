import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  extractMetaError,
  createAdCampaign,
  createAdSet,
  createAdCreative,
  createAd,
} from '../../shared/services/meta-ads.service.js'

vi.mock('../../shared/utils/api-logger.js', () => ({
  apiFetch: vi.fn(),
  wrapSdkCall: vi.fn((_ctx, fn) => fn()),
  logTiming: vi.fn(),
}))

import { apiFetch } from '../../shared/utils/api-logger.js'

const okJson = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

describe('meta ads validate_only support', () => {
  beforeEach(() => {
    apiFetch.mockReset()
    apiFetch.mockResolvedValue(okJson({ success: true }))
  })

  it('should append execution_options validate_only when createAdCampaign runs in validate mode', async () => {
    await createAdCampaign('act_1', 'C', 'OUTCOME_TRAFFIC', 'PAUSED', 'tok', { spendCap: 500000 }, true)
    expect(apiFetch).toHaveBeenCalledTimes(1)
    const [, options] = apiFetch.mock.calls[0]
    expect(options.body).toContain('execution_options')
    expect(options.body).toContain('validate_only')
  })

  it('should not append execution_options for real createAdCampaign', async () => {
    await createAdCampaign('act_1', 'C', 'OUTCOME_TRAFFIC', 'PAUSED', 'tok', {})
    const [, options] = apiFetch.mock.calls[0]
    expect(options.body).not.toContain('execution_options')
  })

  it('should append execution_options validate_only when createAdSet runs in validate mode', async () => {
    await createAdSet('act_1', 'camp_1', { geo_locations: { countries: ['IN'] } }, { budgetType: 'daily', budgetAmount: 100 }, {}, {}, 'tok', true)
    const [, options] = apiFetch.mock.calls[0]
    expect(options.body).toContain('execution_options')
    expect(options.body).toContain('validate_only')
  })

  it('should append execution_options validate_only when createAdCreative runs in validate mode', async () => {
    await createAdCreative('act_1', 'page_1', 'msg', 'https://example.com/img.jpg', 'OPEN_LINK', 'tok', { headline: 'H' }, true)
    const [, options] = apiFetch.mock.calls[0]
    expect(options.body).toContain('execution_options')
    expect(options.body).toContain('validate_only')
  })

  it('should append execution_options validate_only when createAd runs in validate mode', async () => {
    await createAd('act_1', 'adset_1', 'creative_1', 'Ad', 'tok', 'PAUSED', {}, true)
    const [, options] = apiFetch.mock.calls[0]
    expect(options.body).toContain('execution_options')
    expect(options.body).toContain('validate_only')
  })

  it('should not append execution_options for real createAd', async () => {
    await createAd('act_1', 'adset_1', 'creative_1', 'Ad', 'tok', 'PAUSED', {})
    const [, options] = apiFetch.mock.calls[0]
    expect(options.body).not.toContain('execution_options')
  })
})

describe('extractMetaError', () => {
  it('should parse user message and subcode from thrown Graph error', () => {
    const error = new Error('Graph API POST act_1/adsets failed: {"error":{"message":"Invalid parameter","code":100,"error_subcode":1885272,"error_user_title":"Budget is too low","error_user_msg":"Your ad set budget must be more than ₹95.81 or your ads may not be delivered."}}')
    const parsed = extractMetaError(error)
    expect(parsed.userMsg).toBe('Your ad set budget must be more than ₹95.81 or your ads may not be delivered.')
    expect(parsed.userTitle).toBe('Budget is too low')
    expect(parsed.code).toBe(100)
    expect(parsed.subcode).toBe(1885272)
  })

  it('should return null for errors without embedded Graph JSON', () => {
    expect(extractMetaError(new Error('network error'))).toBeNull()
  })

  it('should return null for non-Error input', () => {
    expect(extractMetaError('plain string')).toBeNull()
  })
})
