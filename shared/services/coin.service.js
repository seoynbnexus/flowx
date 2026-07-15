import * as subService from '../../src/modules/subscriptions/subscription.service.js'
import * as aiRepo from '../../src/modules/ai/ai.repository.js'
import { ValidationError } from '../errors/AppError.js'
import { generateUuid } from '../utils/uuid.utils.js'

export async function getAvailable(userId) {
  const monthlyUsage = await subService.getUsage(userId, 'monthly_coins')
  const topupBalance = await aiRepo.findUserWalletCoins(userId)

  const monthlyRemaining = monthlyUsage.remaining
  const total = monthlyRemaining === null
    ? topupBalance
    : monthlyRemaining + topupBalance

  return {
    monthlyRemaining,
    topupBalance,
    total,
    limit: monthlyUsage.limit,
    used: monthlyUsage.used,
    periodStart: monthlyUsage.periodStart,
    periodEnd: monthlyUsage.periodEnd,
  }
}

export async function spend(userId, amount, resourceType, resourceId, notes) {
  const monthlyUsage = await subService.getUsage(userId, 'monthly_coins')
  const topupBalance = await aiRepo.findUserWalletCoins(userId)
  const monthlyRemaining = monthlyUsage.remaining

  const total = monthlyRemaining === null ? topupBalance : monthlyRemaining + topupBalance
  if (total < amount) {
    throw new ValidationError(
      `Insufficient coins. Need ${amount}, available: ${total}.`,
      null,
      'INSUFFICIENT_COINS'
    )
  }

  let remaining = amount

  if (monthlyRemaining !== null && monthlyRemaining > 0) {
    const fromMonthly = Math.min(remaining, monthlyRemaining)
    await subService.consumeUsage(userId, 'monthly_coins', resourceType || 'spend', resourceId || null, notes || null, fromMonthly)
    remaining -= fromMonthly
  }

  if (remaining > 0) {
    await aiRepo.deductCoins(userId, remaining)
    await aiRepo.createTransaction(generateUuid(), userId, notes || 'Coin spend', remaining, 'debit', resourceType || 'spend', resourceId || null)
  }
}

export async function refund(userId, amount, resourceType, resourceId, notes) {
  await subService.refundUsage(userId, 'monthly_coins', resourceType || 'spend', resourceId || null, notes || null, amount)
}
