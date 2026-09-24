export function canConsume({ consumedPaise = 0, refundedPaise = 0 } = {}) {
  return Number(consumedPaise) === 0 && Number(refundedPaise) === 0
}

export function canRefund({ consumedPaise = 0, refundedPaise = 0 } = {}) {
  return Number(consumedPaise) === 0 && Number(refundedPaise) === 0
}

export function computeLeftover({ chargedPaise = 0, consumedPaise = 0, refundedPaise = 0 } = {}) {
  return Math.max(0, Number(chargedPaise) - Number(consumedPaise) - Number(refundedPaise))
}

export function computeSpendRefund({ chargedPaise = 0, alreadyRefundedPaise = 0, actualSpendPaise = 0 } = {}) {
  return Math.max(0, Number(chargedPaise) - Number(alreadyRefundedPaise) - Number(actualSpendPaise))
}

export function assertNoDoubleRefund({ chargedPaise = 0, alreadyRefundedPaise = 0, actualSpendPaise = 0, refundPaise = 0 } = {}) {
  const total = Number(alreadyRefundedPaise) + Number(actualSpendPaise) + Number(refundPaise)
  if (total > Number(chargedPaise)) {
    throw new Error(
      `Double-refund guard: alreadyRefunded(${alreadyRefundedPaise}) + actual(${actualSpendPaise}) + refund(${refundPaise}) exceeds charged(${chargedPaise})`
    )
  }
  return true
}

export function splitProRata(amountPaise, paidFromMonthlyCoins, paidFromWalletCoins) {
  const totalCoins = Number(paidFromMonthlyCoins) + Number(paidFromWalletCoins)
  if (totalCoins <= 0 || Number(amountPaise) <= 0) return { fromMonthlyPaise: 0, fromWalletPaise: 0 }
  const fromMonthlyPaise = Math.round((Number(amountPaise) * Number(paidFromMonthlyCoins)) / totalCoins)
  return { fromMonthlyPaise, fromWalletPaise: Number(amountPaise) - fromMonthlyPaise }
}

export function splitReservationShares(totalPaise, holders) {
  if (!Number.isInteger(totalPaise) || totalPaise < 0) {
    throw new Error('Reservation total must be a non-negative integer number of paise')
  }
  if (!Array.isArray(holders) || holders.length === 0) {
    throw new Error('Reservation split requires at least one holder')
  }
  const base = Math.floor(totalPaise / holders.length)
  const remainder = totalPaise - base * holders.length
  const clientIndex = Math.max(0, holders.findIndex(h => h && h.kind === 'client'))
  return holders.map((holder, index) => ({
    key: holder.key,
    kind: holder.kind,
    sharePaise: base + (index === clientIndex ? remainder : 0),
  }))
}
