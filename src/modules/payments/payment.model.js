import { CURRENCY_CONFIG, toSubunit, fromSubunit, formatCurrency } from '../../../shared/utils/currency.utils.js'

export const PAYMENT_TYPES = {
  SUBSCRIPTION: 'subscription',
  TOPUP: 'topup',
}

export const PAYMENT_STATUS = {
  PENDING: 'pending',
  PAID: 'paid',
  FAILED: 'failed',
  REFUNDED: 'refunded',
}

export const BILLING_CYCLES = {
  MONTHLY: 'monthly',
  YEARLY: 'yearly',
}

export const SCHEDULE_STATUS = {
  ACTIVE: 'active',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
}

export const INVOICE_STATUS = {
  PENDING: 'pending',
  PAID: 'paid',
  FAILED: 'failed',
  REFUNDED: 'refunded',
}

export const PLAN_STATUS = {
  ACTIVE: 'active',
  TRIALING: 'trialing',
  CANCELED: 'canceled',
  EXPIRED: 'expired',
}

export const FEATURE_KEYS = {
  MONTHLY_COINS: 'monthly_coins',
}

export const COINS_PER_RUPEE = 10

export { CURRENCY_CONFIG, toSubunit, fromSubunit, formatCurrency }
