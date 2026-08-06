import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  extractMetaError,
  createAdCampaign,
  createAdSet,
  createAdCreative,
  createAd,
  listAccountAds,
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

describe('listAccountAds pagination', () => {
  const ad = (i) => ({ id: `120249${String(i).padStart(10, '0')}`, status: 'PAUSED', effective_status: 'PAUSED' })

  it('should mark truncated when a full page is followed by an empty ghost page', async () => {
    const full = { data: Array.from({ length: 100 }, (_, i) => ad(i)), paging: { cursors: { after: 'cursor-2' } } }
    const ghost = { data: [] }
    apiFetch
      .mockResolvedValueOnce(okJson(full))
      .mockResolvedValueOnce(okJson(ghost))
    const result = await listAccountAds('1390021406359848', 'tok')
    expect(result.rows).toHaveLength(100)
    expect(result.truncated).toBe(true)
  })

  it('should NOT mark truncated when a partial page is followed by an empty ghost page', async () => {
    const partial = { data: Array.from({ length: 34 }, (_, i) => ad(i)), paging: { cursors: { after: 'cursor-2' } } }
    const ghost = { data: [] }
    apiFetch
      .mockResolvedValueOnce(okJson(partial))
      .mockResolvedValueOnce(okJson(ghost))
    const result = await listAccountAds('1390021406359848', 'tok')
    expect(result.rows).toHaveLength(34)
    expect(result.truncated).toBe(false)
  })

  it('should NOT mark truncated on a clean multi-page end with a partial last page', async () => {
    const first = { data: Array.from({ length: 100 }, (_, i) => ad(i)), paging: { cursors: { after: 'cursor-2' } } }
    const second = { data: Array.from({ length: 50 }, (_, i) => ad(100 + i)) }
    apiFetch
      .mockResolvedValueOnce(okJson(first))
      .mockResolvedValueOnce(okJson(second))
    const result = await listAccountAds('1390021406359848', 'tok')
    expect(result.rows).toHaveLength(150)
    expect(result.truncated).toBe(false)
  })

  it('should mark truncated when a full page ends without a next cursor', async () => {
    const full = { data: Array.from({ length: 100 }, (_, i) => ad(i)) }
    apiFetch.mockResolvedValueOnce(okJson(full))
    const result = await listAccountAds('1390021406359848', 'tok')
    expect(result.rows).toHaveLength(100)
    expect(result.truncated).toBe(true)
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
