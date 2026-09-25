import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import supertest from 'supertest'
import { generateUuid, uuidToBuffer } from '../../shared/utils/uuid.utils.js'
import { loginAgent } from '../helpers/auth.js'
import {
  PLATFORM_FEE_DEFAULT_PCT,
  sanitizePlatformFeePct,
  validatePlatformFeePct,
  getPlatformFeePct,
  setPlatformFeePct,
  invalidatePlatformFeeCache,
  loadPlatformFeePct,
  platformFeeFor,
  withPlatformFee,
} from '../../shared/services/platform-fee.js'
import { calculateTotalEscrow } from '../../src/modules/campaigns/campaign.service.js'
import { calculatePublisherEscrow } from '../../src/modules/posts/post.service.js'
import { query } from '../../shared/database/connection.js'

let app

async function writeFeeRow(value) {
  await query(
    `INSERT INTO app_config (id, config_key, config_value, is_public, description, version)
     VALUES (?, 'platform_fee_pct', ?, 0, 'test', 1)
     ON DUPLICATE KEY UPDATE config_value = VALUES(config_value), version = version + 1`,
    [uuidToBuffer(generateUuid()), JSON.stringify(value)]
  )
}

describe('platform fee (dynamic, decimal percent)', () => {
  beforeAll(async () => {
    const mod = await import('../../app.js')
    app = mod.default
    await writeFeeRow(10)
    setPlatformFeePct(10)
  })

  afterAll(async () => {
    await writeFeeRow(10)
    setPlatformFeePct(10)
    await query("DELETE FROM campaign_jobs WHERE job_type = 'execution_repair'").catch(() => {})
  })

  it('sanitizes stored values to a safe default', () => {
    expect(sanitizePlatformFeePct(10)).toBe(10)
    expect(sanitizePlatformFeePct(7.5)).toBe(7.5)
    expect(sanitizePlatformFeePct(0)).toBe(0)
    expect(sanitizePlatformFeePct(100)).toBe(100)
    expect(sanitizePlatformFeePct(-1)).toBe(PLATFORM_FEE_DEFAULT_PCT)
    expect(sanitizePlatformFeePct(101)).toBe(PLATFORM_FEE_DEFAULT_PCT)
    expect(sanitizePlatformFeePct(Number.NaN)).toBe(PLATFORM_FEE_DEFAULT_PCT)
    expect(sanitizePlatformFeePct('abc')).toBe(PLATFORM_FEE_DEFAULT_PCT)
    expect(sanitizePlatformFeePct(7.555)).toBe(7.56)
  })

  it('validates admin input with decimal support', () => {
    expect(validatePlatformFeePct(10)).toBeNull()
    expect(validatePlatformFeePct(7.5)).toBeNull()
    expect(validatePlatformFeePct(0)).toBeNull()
    expect(validatePlatformFeePct(100)).toBeNull()
    expect(validatePlatformFeePct(7.55)).toBeNull()
    expect(validatePlatformFeePct(-1)).toMatch(/between 0 and 100/)
    expect(validatePlatformFeePct(101)).toMatch(/between 0 and 100/)
    expect(validatePlatformFeePct(7.555)).toMatch(/2 decimal/)
    expect(validatePlatformFeePct('7.5')).toMatch(/must be a number/)
    expect(validatePlatformFeePct(Number.NaN)).toMatch(/must be a number/)
  })

  it('computes whole-coin fees without float drift', () => {
    expect(platformFeeFor(300, 10)).toBe(30)
    expect(platformFeeFor(300, 0)).toBe(0)
    expect(platformFeeFor(300, 7.5)).toBe(23)
    expect(platformFeeFor(105, 7.5)).toBe(8)
    expect(platformFeeFor(105, 10)).toBe(11)
    expect(platformFeeFor(0, 25)).toBe(0)
    expect(withPlatformFee(300, 10)).toBe(330)
    expect(withPlatformFee(100, 0)).toBe(100)
  })

  it('reads the live value with cache semantics', async () => {
    expect(getPlatformFeePct()).toBe(10)
    setPlatformFeePct(7.5)
    expect(getPlatformFeePct()).toBe(7.5)
    invalidatePlatformFeeCache()
    expect(getPlatformFeePct()).toBe(10)
    await writeFeeRow(25)
    expect(await loadPlatformFeePct()).toBe(25)
    expect(getPlatformFeePct()).toBe(25)
    await writeFeeRow('oops')
    expect(await loadPlatformFeePct()).toBe(10)
    await writeFeeRow(10)
    setPlatformFeePct(10)
  })

  it('drives both escrow calculators off the same knob', () => {
    setPlatformFeePct(10)
    expect(calculateTotalEscrow({ publisherCount: 3, coinsPerPublisher: 100 })).toBe(330)
    expect(calculatePublisherEscrow({ publisherCount: 3, coinsPerPublisher: 100 })).toEqual({
      publisherCost: 300, platformFee: 30, total: 330,
    })
    setPlatformFeePct(7.5)
    expect(calculateTotalEscrow({ publisherCount: 3, coinsPerPublisher: 100 })).toBe(323)
    expect(calculatePublisherEscrow({ publisherCount: 2, coinsPerPublisher: 105 }).total).toBe(210 + 16)
    setPlatformFeePct(0)
    expect(calculateTotalEscrow({ publisherCount: 3, coinsPerPublisher: 100 })).toBe(300)
    expect(calculatePublisherEscrow({ publisherCount: 3, coinsPerPublisher: 100 }).total).toBe(300)
    setPlatformFeePct(10)
  })

  it('exposes and updates the fee through the AI admin config endpoints', async () => {
    const adminToken = await loginAgent(app, 'admin@flowx.com', 'Admin@123')
    const got = await supertest(app)
      .get('/api/v1/admin/ai/config')
      .set('Authorization', `Bearer ${adminToken}`)
    expect(got.status).toBe(200)
    expect(got.body.data.platformFee.platformFeePct).toBe(10)

    const updated = await supertest(app)
      .put('/api/v1/admin/ai/config')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ platformFeePct: 7.5 })
    expect(updated.status).toBe(200)
    expect(updated.body.data.platformFee.platformFeePct).toBe(7.5)
    expect(getPlatformFeePct()).toBe(7.5)

    for (const bad of [{ platformFeePct: 101 }, { platformFeePct: -1 }, { platformFeePct: 7.555 }]) {
      const res = await supertest(app)
        .put('/api/v1/admin/ai/config')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(bad)
      expect(res.status).toBe(422)
    }
    expect(getPlatformFeePct()).toBe(7.5)

    await supertest(app)
      .put('/api/v1/admin/ai/config')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ platformFeePct: 10 })
    expect(getPlatformFeePct()).toBe(10)
  })

  it('admin AI config PUT accepts the pre-existing fields (destructure regression)', async () => {
    const adminToken = await loginAgent(app, 'admin@flowx.com', 'Admin@123')
    const res = await supertest(app)
      .put('/api/v1/admin/ai/config')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ imageBaseCost: 500 })
    expect(res.status).toBe(200)
    expect(res.body.data.imagePricing.imageBaseCost).toBe(500)
  })
})
