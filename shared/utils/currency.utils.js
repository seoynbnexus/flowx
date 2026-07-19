export const CURRENCY_CONFIG = {
  INR: { symbol: '\u20b9', subunitMultiplier: 100, decimalPlaces: 2 },
  USD: { symbol: '$', subunitMultiplier: 100, decimalPlaces: 2 },
  EUR: { symbol: '\u20ac', subunitMultiplier: 100, decimalPlaces: 2 },
  GBP: { symbol: '\u00a3', subunitMultiplier: 100, decimalPlaces: 2 },
  JPY: { symbol: '\u00a5', subunitMultiplier: 1, decimalPlaces: 0 },
  KWD: { symbol: 'KD', subunitMultiplier: 1000, decimalPlaces: 3 },
  AED: { symbol: 'AED', subunitMultiplier: 100, decimalPlaces: 2 },
  SAR: { symbol: 'SAR', subunitMultiplier: 100, decimalPlaces: 2 },
}

const DEFAULT_CURRENCY = 'INR'

function getConfig(currency) {
  const c = currency ? currency.toUpperCase() : DEFAULT_CURRENCY
  return CURRENCY_CONFIG[c] || CURRENCY_CONFIG[DEFAULT_CURRENCY]
}

export function toSubunit(amount, currency) {
  const config = getConfig(currency)
  return Math.round(amount * config.subunitMultiplier)
}

export function fromSubunit(amount, currency) {
  const config = getConfig(currency)
  return amount / config.subunitMultiplier
}

export function formatCurrency(amount, currency) {
  const config = getConfig(currency)
  return `${config.symbol}${Number(amount).toFixed(config.decimalPlaces)}`
}
