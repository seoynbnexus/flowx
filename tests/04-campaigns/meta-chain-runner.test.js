import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  CHAIN_STEP_ORDER,
  validateStep,
  cleanupMetaChain,
  runValidatedAdChain,
  activateChain,
  classifyChainError,
} from '../../shared/services/meta-chain-runner.js'
import { ValidationError } from '../../shared/errors/AppError.js'

function makeSteps(overrides = {}) {
  return CHAIN_STEP_ORDER.map(key => ({
    key,
    validate: overrides[`validate_${key}`] || vi.fn().mockResolvedValue(undefined),
    create: overrides[`create_${key}`] || vi.fn().mockResolvedValue(`${key}_id_1`),
  }))
}

describe('meta-chain-runner (Phase 1 shared primitive)', () => {
  let deleted
  let deleteFns

  beforeEach(() => {
    deleted = []
    deleteFns = {
      ad: vi.fn().mockImplementation(async id => { deleted.push(['ad', id]) }),
      ad_creative: vi.fn().mockImplementation(async id => { deleted.push(['ad_creative', id]) }),
      ad_set: vi.fn().mockImplementation(async id => { deleted.push(['ad_set', id]) }),
      facebook_campaign: vi.fn().mockImplementation(async id => { deleted.push(['facebook_campaign', id]) }),
    }
  })

  it('validates then creates every step in order and persists each id immediately', async () => {
    const seen = []
    const steps = makeSteps()
    const result = await runValidatedAdChain(
      {},
      {
        steps,
        token: 'tok',
        deleteFns,
        onObjectCreated: async (type, id) => { seen.push([type, id]) },
        onCleanupDb: vi.fn(),
      }
    )
    expect(result.success).toBe(true)
    expect(Object.keys(result.objects)).toEqual(CHAIN_STEP_ORDER)
    expect(seen.map(([t]) => t)).toEqual(CHAIN_STEP_ORDER)
    expect(result.finalIds.facebook_campaign).toBe('facebook_campaign_id_1')
    for (const step of steps) {
      expect(step.validate).toHaveBeenCalledTimes(1)
      expect(step.create).toHaveBeenCalledTimes(1)
    }
  })

  it('fails closed on validate failure without creating later steps', async () => {
    const steps = makeSteps({
      validate_ad_set: vi.fn().mockRejectedValue(new Error('Graph API failed: {"error":{"error_user_msg":"bad geo"}}')),
    })
    const onCleanupDb = vi.fn()
    const result = await runValidatedAdChain({}, { steps, token: 'tok', deleteFns, onCleanupDb })
    expect(result.success).toBe(false)
    expect(result.failedStep).toBe('ad_set')
    expect(steps.find(s => s.key === 'ad').create).not.toHaveBeenCalled()
    expect(steps.find(s => s.key === 'ad_creative').create).not.toHaveBeenCalled()
    expect(onCleanupDb).not.toHaveBeenCalled()
  })

  it('cleans up in reverse order and nulls db state when a later create fails permanently', async () => {
    const steps = makeSteps({
      create_ad: vi.fn().mockRejectedValue(new Error('Graph API failed: {"error":{"error_user_msg":"no payment"}}')),
    })
    const onCleanupDb = vi.fn()
    const result = await runValidatedAdChain(
      {},
      { steps, token: 'tok', deleteFns, onCleanupDb, isTransient: () => false }
    )
    expect(result.success).toBe(false)
    expect(result.failedStep).toBe('ad')
    expect(deleted.map(([t]) => t)).toEqual(['ad_creative', 'ad_set', 'facebook_campaign'])
    expect(onCleanupDb).toHaveBeenCalledTimes(1)
  })

  it('routes transient failures to requeue without reporting permanent failure', async () => {
    const steps = makeSteps({
      create_ad_set: vi.fn().mockRejectedValue(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })),
    })
    const result = await runValidatedAdChain(
      {},
      { steps, token: 'tok', deleteFns, isTransient: err => err.code === 'ETIMEDOUT' }
    )
    expect(result.success).toBeUndefined()
    expect(result.transient).toBe(true)
    expect(result.requeueAfterSeconds).toBe(30)
    expect(deleted.map(([t]) => t)).toEqual(['facebook_campaign'])
  })

  it('cleanup never throws and reports per-step errors', async () => {
    deleteFns.ad_set.mockRejectedValue(new Error('gone'))
    const outcome = await cleanupMetaChain(
      { facebook_campaign: 'c1', ad_set: 's1', ad_creative: 'cr1', ad: 'a1' },
      { token: 'tok', deleteFns, onCleanupDb: async () => {} }
    )
    expect(outcome.cleaned).toEqual(['ad', 'ad_creative', 'facebook_campaign'])
    expect(outcome.errors).toHaveLength(1)
    expect(outcome.errors[0].step).toBe('ad_set')
  })

  it('validateStep extracts the Meta user message', async () => {
    const outcome = await validateStep('ad', async () => {
      throw new Error('Graph API failed: {"error":{"error_user_msg":"No payment method","code":100}}')
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toBe('No payment method')
    expect(outcome.code).toBe(100)
  })

  it('activateChain activates in order and reports partial failure', async () => {    const updateFn = vi.fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('paused by user'))
      .mockResolvedValue({})
    const marked = []
    const outcome = await activateChain(
      [
        { type: 'facebook_campaign', id: 'c1' },
        { type: 'ad_set', id: 's1' },
        { type: 'ad', id: 'a1' },
      ],
      'tok',
      { updateFn, markFn: async (type, id, status) => { marked.push([type, id, status]) } }
    )
    expect(outcome.allSuccess).toBe(false)
    expect(outcome.results).toHaveLength(3)
    expect(outcome.results[1]).toMatchObject({ type: 'ad_set', success: false })
    expect(updateFn).toHaveBeenCalledTimes(3)
    expect(updateFn.mock.calls[0]).toEqual(['c1', 'ACTIVE', 'tok'])
    expect(marked).toEqual([['facebook_campaign', 'c1', 'ACTIVE'], ['ad', 'a1', 'ACTIVE']])
  })
})

describe('classifyChainError (Step 12 shared taxonomy)', () => {
  it('treats AppError 4xx as permanent', async () => {
    expect(classifyChainError(new ValidationError('bad input')).kind).toBe('permanent')
  })

  it('treats 429 and 5xx as transient', async () => {
    const rateLimited = new Error('too many calls')
    rateLimited.statusCode = 429
    expect(classifyChainError(rateLimited).kind).toBe('transient')
    const serverError = new Error('Graph API POST x failed: {"error":{"code":2,"message":"busy"}}')
    serverError.statusCode = 500
    expect(classifyChainError(serverError).kind).toBe('transient')
  })

  it('treats Meta error bodies as permanent', async () => {
    const metaError = new Error('Graph API POST x failed: {"error":{"error_user_msg":"bad geo","code":100}}')
    metaError.statusCode = 400
    const classified = classifyChainError(metaError)
    expect(classified.kind).toBe('permanent')
    expect(classified.code).toBe(100)
  })

  it('treats timeouts, network failures and unknown outcomes as ambiguous', async () => {
    const timeout = new Error('Meta request timed out after 20000ms')
    timeout.code = 'ETIMEDOUT'
    expect(classifyChainError(timeout).kind).toBe('ambiguous')
    const reset = new Error('socket hang up')
    expect(classifyChainError(reset).kind).toBe('ambiguous')
    const unknown = new TypeError('Cannot read properties of undefined')
    expect(classifyChainError(unknown).kind).toBe('ambiguous')
  })
})
