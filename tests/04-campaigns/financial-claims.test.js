import { describe, it, expect } from 'vitest'
import {
  canConsume,
  canRefund,
  computeLeftover,
  computeSpendRefund,
  assertNoDoubleRefund,
  splitProRata,
  splitReservationShares,
} from '../../shared/services/financial-claims.js'

describe('financial-claims (Phase 1 shared primitive)', () => {
  it('consume and refund are mutually exclusive (exactly one disposition)', async () => {
    expect(canConsume({ consumedPaise: 0, refundedPaise: 0 })).toBe(true)
    expect(canRefund({ consumedPaise: 0, refundedPaise: 0 })).toBe(true)
    expect(canConsume({ consumedPaise: 100, refundedPaise: 0 })).toBe(false)
    expect(canRefund({ consumedPaise: 100, refundedPaise: 0 })).toBe(false)
    expect(canConsume({ consumedPaise: 0, refundedPaise: 100 })).toBe(false)
    expect(canRefund({ consumedPaise: 0, refundedPaise: 100 })).toBe(false)
  })

  it('leftover equals charged minus consumed minus refunded, floored at zero', async () => {
    expect(computeLeftover({ chargedPaise: 900, consumedPaise: 300, refundedPaise: 300 })).toBe(300)
    expect(computeLeftover({ chargedPaise: 900, consumedPaise: 900, refundedPaise: 0 })).toBe(0)
    expect(computeLeftover({ chargedPaise: 100, consumedPaise: 200, refundedPaise: 0 })).toBe(0)
  })

  it('spend refund subtracts already-refunded reservation shares (anti-double-refund)', async () => {
    expect(computeSpendRefund({ chargedPaise: 900, alreadyRefundedPaise: 300, actualSpendPaise: 500 })).toBe(100)
    expect(computeSpendRefund({ chargedPaise: 900, alreadyRefundedPaise: 0, actualSpendPaise: 500 })).toBe(400)
    expect(computeSpendRefund({ chargedPaise: 900, alreadyRefundedPaise: 900, actualSpendPaise: 0 })).toBe(0)
    expect(computeSpendRefund({ chargedPaise: 100, alreadyRefundedPaise: 80, actualSpendPaise: 50 })).toBe(0)
  })

  it('assertNoDoubleRefund throws when refunded + actual + refund exceeds charged', async () => {
    expect(() => assertNoDoubleRefund({ chargedPaise: 900, alreadyRefundedPaise: 300, actualSpendPaise: 500, refundPaise: 100 })).not.toThrow()
    expect(() => assertNoDoubleRefund({ chargedPaise: 900, alreadyRefundedPaise: 300, actualSpendPaise: 500, refundPaise: 101 })).toThrow(/Double-refund/)
  })

  it('pro-rata split preserves the total across monthly and wallet shares', async () => {
    const split = splitProRata(6000, 60, 40)
    expect(split.fromMonthlyPaise + split.fromWalletPaise).toBe(6000)
    expect(split.fromMonthlyPaise).toBe(3600)
    expect(splitProRata(0, 60, 40)).toEqual({ fromMonthlyPaise: 0, fromWalletPaise: 0 })
    expect(splitProRata(6000, 0, 0)).toEqual({ fromMonthlyPaise: 0, fromWalletPaise: 0 })
  })

  it('D2: reservation remainder rounds to the client execution in whole paise', async () => {
    const holders = [
      { key: 'client', kind: 'client' },
      { key: 'pub-a', kind: 'publisher' },
      { key: 'pub-b', kind: 'publisher' },
    ]
    const shares = splitReservationShares(1000, holders)
    expect(shares).toEqual([
      { key: 'client', kind: 'client', sharePaise: 334 },
      { key: 'pub-a', kind: 'publisher', sharePaise: 333 },
      { key: 'pub-b', kind: 'publisher', sharePaise: 333 },
    ])
    expect(shares.reduce((sum, s) => sum + s.sharePaise, 0)).toBe(1000)
    expect(Number.isInteger(shares[0].sharePaise)).toBe(true)
    const single = splitReservationShares(999, [{ key: 'only', kind: 'publisher' }])
    expect(single).toEqual([{ key: 'only', kind: 'publisher', sharePaise: 999 }])
    expect(() => splitReservationShares(100, [])).toThrow(/at least one holder/)
    expect(() => splitReservationShares(-5, holders)).toThrow(/non-negative integer/)
    expect(() => splitReservationShares(10.5, holders)).toThrow(/non-negative integer/)
  })
})
