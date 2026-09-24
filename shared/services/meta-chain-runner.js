import {
  deleteAd,
  deleteAdSet,
  deleteAdCreative,
  deleteAdCampaign,
  updateAdStatus,
  extractMetaError,
  isRateLimitError,
} from './meta-ads.service.js'

export const CHAIN_STEP_ORDER = ['facebook_campaign', 'ad_set', 'ad_creative', 'ad']

const DELETE_FNS = {
  ad: deleteAd,
  ad_creative: deleteAdCreative,
  ad_set: deleteAdSet,
  facebook_campaign: deleteAdCampaign,
}

export const TRANSIENT_REQUEUE_SECONDS = 30

export function classifyChainError(error) {
  const message = error?.message || String(error)
  let parsed = null
  try {
    parsed = extractMetaError(error)
  } catch {
    parsed = null
  }
  const statusCode = error?.statusCode ?? null
  if (statusCode === 429 || (parsed && isRateLimitError(error))) {
    return { kind: 'transient', message, code: parsed?.code ?? statusCode, subcode: parsed?.subcode ?? null }
  }
  if (typeof statusCode === 'number' && statusCode >= 500) {
    return { kind: 'transient', message, code: parsed?.code ?? statusCode, subcode: parsed?.subcode ?? null }
  }
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500 && !parsed) {
    return { kind: 'permanent', message, code: statusCode, subcode: null }
  }
  if (parsed) {
    return { kind: 'permanent', message: parsed.userMsg || message, code: parsed.code, subcode: parsed.subcode }
  }
  return { kind: 'ambiguous', message, code: null, subcode: null }
}

export async function validateStep(stepKey, fn, { log } = {}) {
  try {
    await fn()
    return { ok: true, step: stepKey }
  } catch (error) {
    const parsed = extractMetaError(error)
    const message = parsed?.userMsg || error?.message || String(error)
    if (log) log({ action: 'chain_validate_failed', step: stepKey, error: message })
    return { ok: false, step: stepKey, error: message, code: parsed?.code ?? null, subcode: parsed?.subcode ?? null }
  }
}

export async function cleanupMetaChain(created, { token, log, onCleanupDb, deleteFns = DELETE_FNS } = {}) {
  const cleaned = []
  const errors = []
  for (const stepKey of [...CHAIN_STEP_ORDER].reverse()) {
    const id = created?.[stepKey]
    if (!id) continue
    const deleteFn = deleteFns[stepKey]
    if (!deleteFn) continue
    try {
      await deleteFn(id, token)
      cleaned.push(stepKey)
    } catch (error) {
      errors.push({ step: stepKey, error: error?.message || String(error) })
      if (log) log({ action: 'chain_cleanup_error', step: stepKey, error: error?.message || String(error) })
    }
  }
  if (onCleanupDb) {
    try {
      await onCleanupDb()
    } catch (error) {
      errors.push({ step: 'db', error: error?.message || String(error) })
      if (log) log({ action: 'chain_cleanup_db_error', error: error?.message || String(error) })
    }
  }
  return { cleaned, errors }
}

export async function runValidatedAdChain({ log } = {}, { steps, onObjectCreated, onCleanupDb, isTransient = () => false, deleteFns = DELETE_FNS, token } = {}) {
  const objects = {}
  for (const step of steps) {
    const checked = await validateStep(step.key, step.validate, { log })
    if (!checked.ok) {
      return { success: false, error: checked.error, failedStep: step.key, code: checked.code, subcode: checked.subcode }
    }
    let id
    try {
      id = await step.create()
    } catch (error) {
      const parsed = extractMetaError(error)
      const message = parsed?.userMsg || error?.message || String(error)
      await cleanupMetaChain(objects, { token, log, onCleanupDb, deleteFns })
      if (isTransient(error)) {
        return { requeueAfterSeconds: TRANSIENT_REQUEUE_SECONDS, transient: true, error: message, failedStep: step.key }
      }
      return { success: false, error: message, failedStep: step.key, code: parsed?.code ?? null, subcode: parsed?.subcode ?? null }
    }
    objects[step.key] = id
    if (onObjectCreated) await onObjectCreated(step.key, id)
  }
  return { success: true, objects, finalIds: { ...objects } }
}

export async function activateChain(items, token, { updateFn = updateAdStatus, markFn = null, log } = {}) {
  const results = []
  for (const item of items) {
    try {
      await updateFn(item.id, 'ACTIVE', token)
      if (markFn) await markFn(item.type, item.id, 'ACTIVE')
      results.push({ type: item.type, id: item.id, success: true })
    } catch (error) {
      const message = error?.message || String(error)
      if (log) log({ action: 'chain_activate_failed', type: item.type, error: message })
      results.push({ type: item.type, id: item.id, success: false, error: message })
    }
  }
  return { results, allSuccess: results.every(r => r.success) }
}
