import { queryOne } from '../database/connection.js'

export const PLATFORM_FEE_KEY = 'platform_fee_pct'
export const PLATFORM_FEE_DEFAULT_PCT = 10
export const PLATFORM_FEE_MAX_PCT = 100
export const PLATFORM_FEE_MAX_DECIMALS = 2

let cachedPct = null

export function sanitizePlatformFeePct(value) {
  const pct = Number(value)
  if (!Number.isFinite(pct) || pct < 0 || pct > PLATFORM_FEE_MAX_PCT) return PLATFORM_FEE_DEFAULT_PCT
  const factor = 10 ** PLATFORM_FEE_MAX_DECIMALS
  return Math.round(pct * factor) / factor
}

export function validatePlatformFeePct(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'platformFeePct must be a number'
  if (value < 0 || value > PLATFORM_FEE_MAX_PCT) return 'platformFeePct must be between 0 and 100'
  const factor = 10 ** PLATFORM_FEE_MAX_DECIMALS
  if (Math.round(value * factor) !== value * factor) return 'platformFeePct allows at most 2 decimal places'
  return null
}

export async function readPlatformFeePct() {
  try {
    const row = await queryOne('SELECT config_value FROM app_config WHERE config_key = ?', [PLATFORM_FEE_KEY])
    if (!row) return PLATFORM_FEE_DEFAULT_PCT
    const value = typeof row.config_value === 'string' ? JSON.parse(row.config_value) : row.config_value
    return sanitizePlatformFeePct(value)
  } catch {
    return PLATFORM_FEE_DEFAULT_PCT
  }
}

export function getPlatformFeePct() {
  if (cachedPct !== null) return cachedPct
  return PLATFORM_FEE_DEFAULT_PCT
}

export async function loadPlatformFeePct() {
  cachedPct = await readPlatformFeePct()
  return cachedPct
}

export function setPlatformFeePct(pct) {
  cachedPct = sanitizePlatformFeePct(pct)
  return cachedPct
}

export function invalidatePlatformFeeCache() {
  cachedPct = null
}

export function platformFeeFor(publisherCost, pct = getPlatformFeePct()) {
  const cost = Number(publisherCost) || 0
  const basisPoints = Math.round(Number(pct) * 100)
  return Math.round((cost * basisPoints) / 10000)
}

export function withPlatformFee(publisherCost, pct = getPlatformFeePct()) {
  const cost = Number(publisherCost) || 0
  return cost + platformFeeFor(cost, pct)
}
