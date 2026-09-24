import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { generateUuid, uuidToBuffer } from '../../shared/utils/uuid.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import { query } from '../../shared/database/connection.js'
import { probeMedia } from '../../shared/services/media-probe.js'
import * as mediaService from '../../src/modules/media-library/media.service.js'
import * as campaignService from '../../src/modules/campaigns/campaign.service.js'
import * as campaignRepo from '../../src/modules/campaigns/campaign.repository.js'
import { checkCreativeMediaForMeta } from '../../src/modules/campaigns/campaign.service.js'
import { adMediaGate } from '../../shared/services/ad-content-validation.js'

// This file exercises the network-touching media gate directly, so it opts
// back into the (test-env-default-off) gate — see ad-content-validation.js.
const originalMediaGateEnabled = adMediaGate.enabled
beforeAll(() => { adMediaGate.enabled = true })
afterAll(() => { adMediaGate.enabled = originalMediaGateEnabled })

var metaMocks
vi.mock('../../shared/services/meta-ads.service.js', async () => {
  const actual = await vi.importActual('../../shared/services/meta-ads.service.js')
  const mocks = {
    ...actual,
    listAccountAds: vi.fn().mockResolvedValue({ rows: [], truncated: false }),
    getObjectStatus: vi.fn().mockResolvedValue({ status: 'ACTIVE', effective_status: 'ACTIVE' }),
    getCampaignStatusesBatch: vi.fn().mockResolvedValue({}),
    getAdAccount: vi.fn().mockResolvedValue({ balance: '10.00', currency: 'INR', account_status: 1, disable_reason: null }),
    createAdCreative: vi.fn().mockResolvedValue({ id: 'mock_creative' }),
    createAdCampaign: vi.fn().mockResolvedValue({ id: 'mock_campaign' }),
    uploadRepairVideoFromUrl: vi.fn().mockResolvedValue({ videoId: 'mock_video' }),
    waitForAdVideoReady: vi.fn().mockResolvedValue({ video_status: 'ready' }),
    deleteAdVideo: vi.fn().mockResolvedValue({}),
  }
  metaMocks = mocks
  return mocks
})

var fetchMock
vi.mock('../../shared/services/media-url.js', async () => {
  const actual = await vi.importActual('../../shared/services/media-url.js')
  fetchMock = vi.fn().mockResolvedValue({ bytes: Buffer.alloc(0), truncated: false })
  const inspectMediaSize = vi.fn().mockResolvedValue({ status: 'UNKNOWN_SIZE', sizeBytes: null })
  return { ...actual, fetchBoundedBytes: fetchMock, inspectMediaSize }
})

const dateTag = Date.now()

function pngBuffer(width, height) {
  const buf = Buffer.alloc(29)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0)
  buf.writeUInt32BE(13, 8)
  buf.write('IHDR', 12)
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  return buf
}

function gifBuffer(width, height) {
  const buf = Buffer.alloc(10)
  buf.write('GIF89a', 0)
  buf.writeUInt16LE(width, 6)
  buf.writeUInt16LE(height, 8)
  return buf
}

function webpHeader(chunkFourcc, chunkSize, chunkData) {
  const buf = Buffer.alloc(12 + 8 + chunkData.length)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(4 + 8 + chunkData.length, 4)
  buf.write('WEBP', 8)
  buf.write(chunkFourcc, 12)
  buf.writeUInt32LE(chunkSize, 16)
  chunkData.copy(buf, 20)
  return buf
}

function webpVp8xBuffer(width, height) {
  const data = Buffer.alloc(10)
  data.writeUIntLE(width - 1, 4, 3)
  data.writeUIntLE(height - 1, 7, 3)
  return webpHeader('VP8X', 10, data)
}

function box(type, body) {
  const b = Buffer.alloc(8 + body.length)
  b.writeUInt32BE(8 + body.length, 0)
  b.write(type, 4, 'ascii')
  body.copy(b, 8)
  return b
}

function u32(n) {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n, 0)
  return b
}

function u16(n) {
  const b = Buffer.alloc(2)
  b.writeUInt16BE(n, 0)
  return b
}

function mp4Buffer({ duration = 15000, timescale = 1000, width = 1080, height = 1920 } = {}) {  const matrix = Buffer.alloc(36)
  matrix.writeInt32BE(0x10000, 0)
  matrix.writeInt32BE(0x10000, 20)
  const mvhd = box('mvhd', Buffer.concat([
    u32(0), u32(0), u32(0), u32(timescale), u32(duration), u32(0x10000), u16(0x100), u16(0),
    Buffer.alloc(8), matrix, Buffer.alloc(24), u32(2),
  ]))
  const entry = box('avc1', Buffer.concat([
    u16(0), u16(0), u16(0), u16(0), u16(0), u16(1), u16(0), u16(0), u16(0), u16(0),
    u16(0), u16(0), u16(0), u16(0), u16(width), u16(height), u32(0x480000), u16(0), u16(0),
    u32(0), u16(0x18), u16(0xffff), Buffer.alloc(32), u16(0x18), u16(0xffff),
  ]))
  const stsd = box('stsd', Buffer.concat([u32(0), u32(1), entry]))
  const minf = box('minf', box('stbl', stsd))
  const mdia = box('mdia', minf)
  const tkhd = box('tkhd', Buffer.concat([
    u32(0), u32(9), u32(0), u32(1), u32(0), u32(duration), Buffer.alloc(8),
    u16(0), u16(0), u16(0x100), u16(0), matrix, u32(width << 16), u32(height << 16),
  ]))
  const moov = box('moov', Buffer.concat([mvhd, box('trak', Buffer.concat([tkhd, mdia]))]))
  const ftyp = box('ftyp', Buffer.concat([Buffer.from('isom'), u32(0), Buffer.from('isom')]))
  return Buffer.concat([ftyp, moov])
}

function webpVp8Buffer(width, height) {
  const data = Buffer.alloc(10)
  data[3] = 0x9d
  data[4] = 0x01
  data[5] = 0x2a
  data.writeUInt16LE(width & 0x3fff, 6)
  data.writeUInt16LE(height & 0x3fff, 8)
  return webpHeader('VP8 ', 10, data)
}

function webpVp8lBuffer() {
  const data = Buffer.from([0x2f, 0x63, 0xc0, 0x0e, 0x00])
  return webpHeader('VP8L', 5, data)
}

describe('media probe: PNG/GIF/WebP dimensions', () => {
  it('parses PNG dimensions', () => {
    const res = probeMedia(pngBuffer(800, 600))
    expect(res).toMatchObject({ status: 'valid', kind: 'image', mediaType: 'png', width: 800, height: 600 })
    expect(res.aspect).toBeCloseTo(800 / 600, 5)
  })

  it('rejects a truncated PNG', () => {
    expect(probeMedia(pngBuffer(800, 600).subarray(0, 20)).status).toBe('invalid')
    expect(probeMedia(Buffer.from([0x89, 0x50])).status).toBe('invalid')
  })

  it('parses GIF87a and GIF89a dimensions', () => {
    expect(probeMedia(gifBuffer(320, 200))).toMatchObject({ status: 'valid', kind: 'image', mediaType: 'gif', width: 320, height: 200 })
    const gif87 = gifBuffer(100, 100)
    gif87.write('GIF87a', 0)
    expect(probeMedia(gif87)).toMatchObject({ status: 'valid', mediaType: 'gif', width: 100, height: 100 })
  })

  it('rejects malformed GIF data', () => {
    expect(probeMedia(Buffer.from('GIF8'))).toMatchObject({ status: 'invalid' })
    const bad = gifBuffer(10, 10)
    bad.write('GIF00x', 0)
    expect(probeMedia(bad).status).toBe('invalid')
  })

  it('parses WebP VP8X canvas dimensions', () => {
    expect(probeMedia(webpVp8xBuffer(800, 600))).toMatchObject({ status: 'valid', kind: 'image', mediaType: 'webp', width: 800, height: 600 })
  })

  it('parses WebP lossy VP8 frame dimensions', () => {
    expect(probeMedia(webpVp8Buffer(640, 480))).toMatchObject({ status: 'valid', mediaType: 'webp', width: 640, height: 480 })
  })

  it('parses WebP lossless VP8L dimensions', () => {
    expect(probeMedia(webpVp8lBuffer())).toMatchObject({ status: 'valid', mediaType: 'webp', width: 100, height: 60 })
  })

  it('handles truncated and imageless WebP input', () => {
    expect(probeMedia(webpVp8xBuffer(800, 600).subarray(0, 20)).status).not.toBe('valid')
    const animOnly = webpHeader('ANMF', 0, Buffer.alloc(0))
    expect(probeMedia(animOnly)).toMatchObject({ status: 'unknown', mediaType: 'webp' })
  })

  it('still treats unrecognized input as unknown', () => {
    expect(probeMedia(Buffer.from('definitely not an image file'))).toMatchObject({ status: 'unknown' })
  })
})

describe('media upload dimensions', () => {
  let user
  const tempFiles = []
  const assetIds = []

  async function tempImage(name, bytes) {
    const filePath = path.join(os.tmpdir(), `${name}-${dateTag}-${Math.random().toString(36).slice(2)}`)
    await fs.writeFile(filePath, bytes)
    tempFiles.push(filePath)
    return filePath
  }

  beforeAll(async () => {
    user = await createTestUser({ email: `media-dims-${dateTag}@flowx-test.com`, password: 'Test@123' })
  })

  afterAll(async () => {
    for (const id of assetIds) {
      await query('DELETE FROM media_assets WHERE id = ?', [uuidToBuffer(id)]).catch(() => {})
    }
    for (const file of tempFiles) {
      await fs.unlink(file).catch(() => {})
    }
  })

  it('persists PNG dimensions at upload', async () => {
    const filePath = await tempImage('dims.png', pngBuffer(800, 600))
    const asset = await mediaService.uploadMedia(user.id, {
      path: filePath, filename: `dims-${dateTag}.png`, mimetype: 'image/png', size: 29, originalname: 'dims.png',
    })
    assetIds.push(asset.id)
    expect(asset.width).toBe(800)
    expect(asset.height).toBe(600)
  })

  it('leaves dimensions null for video uploads', async () => {
    const asset = await mediaService.uploadMedia(user.id, {
      filename: `novideo-${dateTag}.mp4`, mimetype: 'video/mp4', size: 2048,
    })
    assetIds.push(asset.id)
    expect(asset.width).toBeNull()
    expect(asset.height).toBeNull()
  })

  it('leaves dimensions null when the file cannot be probed but still succeeds', async () => {
    const asset = await mediaService.uploadMedia(user.id, {
      path: path.join(os.tmpdir(), `missing-${dateTag}.png`),
      filename: `missing-${dateTag}.png`, mimetype: 'image/png', size: 29,
    })
    assetIds.push(asset.id)
    expect(asset.width).toBeNull()
    expect(asset.height).toBeNull()
  })

  it('keeps existing rows with NULL dimensions valid', async () => {
    const rows = await query('SELECT id FROM media_assets WHERE width IS NULL LIMIT 1')
    expect(Array.isArray(rows)).toBe(true)
  })
})

describe('Instagram dimension gate', () => {
  let client
  const campaignIds = []

  beforeAll(async () => {
    process.env.META_SYSTEM_USER_TOKEN = 'test_system_user_token'
    process.env.META_AD_ACCOUNT_ID = 'act_test_account'
    client = await createTestUser({ email: `media-gate-${dateTag}@flowx-test.com`, password: 'Test@123', coins: 10000 })
    const fbPlatform = await query('SELECT id FROM platforms WHERE code = \'facebook\' LIMIT 1').then(r => r[0]).catch(() => null)
    if (fbPlatform) {
      await query(
        `INSERT INTO user_platform_accounts (id, user_id, platform_id, profile_url, platform_user_id, platform_username, token_type, token_expires_at, verification_status)
         VALUES (?, ?, ?, ?, ?, ?, 'page', DATE_ADD(NOW(), INTERVAL 60 DAY), 'verified')`,
        [uuidToBuffer(generateUuid()), uuidToBuffer(client.id), fbPlatform.id, 'https://fb.com/test', `fb_gate_${dateTag}`, 'GatePage']
      )
    }
  })

  afterAll(async () => {
    for (const id of campaignIds) {
      await query('DELETE FROM campaigns WHERE id = ?', [uuidToBuffer(id)]).catch(() => {})
    }
  })

  async function draftWithMedia(mediaUrl, placement = { publisher_platforms: ['facebook', 'instagram'] }) {
    const campaign = await campaignService.createCampaign(client.id, { name: `Gate ${generateUuid().substring(0, 8)}`, type: 'post' })
    campaignIds.push(campaign.id)
    await campaignRepo.createCreative(generateUuid(), campaign.id, { caption: 'gate', mediaUrl })
    await campaignService.saveMetaSettings(client.id, campaign.id, {
      objective: 'OUTCOME_TRAFFIC',
      budgetAmount: 10000,
      targeting: { geo_locations: { countries: ['IN'] } },
      platformPlacement: placement,
      endTime: new Date(Date.now() + 10 * 24 * 3600000).toISOString(),
    })
    return campaign
  }

  it('blocks a sub-500px image even when Instagram delivery does not apply (Facebook-only placement)', async () => {
    fetchMock.mockResolvedValue({ bytes: pngBuffer(400, 400) })
    const gate = await checkCreativeMediaForMeta({
      mediaUrl: 'https://example.com/small.png',
      platformPlacement: { publisher_platforms: ['facebook'] },
    })
    expect(gate).toMatchObject({ ok: false })
    expect(gate.message).toMatch(/500px/)
    expect(fetchMock).toHaveBeenCalled()
  })

  it('passes a compliant image through on a Facebook-only placement', async () => {
    fetchMock.mockResolvedValue({ bytes: pngBuffer(800, 600) })
    const gate = await checkCreativeMediaForMeta({
      mediaUrl: 'https://example.com/big.png',
      platformPlacement: { publisher_platforms: ['facebook'] },
    })
    expect(gate).toBeNull()
  })

  it('fails closed for unprobable (empty) media instead of silently passing', async () => {
    fetchMock.mockResolvedValue({ bytes: Buffer.alloc(0) })
    const gate = await checkCreativeMediaForMeta({
      mediaUrl: 'https://example.com/empty.png',
      platformPlacement: { publisher_platforms: ['facebook', 'instagram'] },
    })
    expect(gate).toMatchObject({ ok: false, errorCode: 'MEDIA_UNVERIFIABLE' })
  })

  it('blocks a sub-500px Instagram image in pre-validation', async () => {
    fetchMock.mockResolvedValue({ bytes: pngBuffer(400, 400) })
    const campaign = await draftWithMedia('https://example.com/small.png')
    const result = await campaignService.validateCampaignDraft(client.id, campaign.id)
    expect(result.valid).toBe(false)
    expect(result.checks[0]).toMatchObject({ object: 'creative', ok: false })
    expect(result.checks[0].error).toMatch(/500px/)
    expect(result.error).toMatch(/500px/)
  })

  it('passes a 500px-plus image through to Meta validation', async () => {
    fetchMock.mockResolvedValue({ bytes: pngBuffer(800, 600) })
    const campaign = await draftWithMedia('https://example.com/big.png')
    const result = await campaignService.validateCampaignDraft(client.id, campaign.id)
    expect(result.valid).toBe(true)
    expect(metaMocks.createAdCreative).toHaveBeenCalled()
  })

  it('treats exact 500px as passing', async () => {
    fetchMock.mockResolvedValue({ bytes: pngBuffer(500, 500) })
    const campaign = await draftWithMedia('https://example.com/exact.png')
    const result = await campaignService.validateCampaignDraft(client.id, campaign.id)
    expect(result.valid).toBe(true)
  })

  it('blocks a sub-500px video in pre-validation', async () => {
    fetchMock.mockResolvedValue({ bytes: mp4Buffer({ width: 400, height: 800 }) })
    const campaign = await draftWithMedia('https://example.com/narrow.mp4')
    const result = await campaignService.validateCampaignDraft(client.id, campaign.id)
    expect(result.valid).toBe(false)
    expect(result.checks[0]).toMatchObject({ object: 'creative', ok: false })
    expect(result.checks[0].error).toMatch(/500px/)
  })

  it('blocks a sub-second video in pre-validation', async () => {
    fetchMock.mockResolvedValue({ bytes: mp4Buffer({ duration: 500, timescale: 1000 }) })
    const campaign = await draftWithMedia('https://example.com/short.mp4')
    const result = await campaignService.validateCampaignDraft(client.id, campaign.id)
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/1s/)
  })

  it('passes a compliant video through to Meta validation', async () => {
    fetchMock.mockResolvedValue({ bytes: mp4Buffer() })
    const campaign = await draftWithMedia('https://example.com/good.mp4')
    const result = await campaignService.validateCampaignDraft(client.id, campaign.id)
    expect(result.valid).toBe(true)
    expect(metaMocks.createAdCreative).toHaveBeenCalled()
  })

  it('fails closed for unrecognized video containers instead of silently passing', async () => {
    fetchMock.mockResolvedValue({ bytes: Buffer.from('not a video at all') })
    const gate = await checkCreativeMediaForMeta({
      mediaUrl: 'https://example.com/x.bin',
      platformPlacement: { publisher_platforms: ['facebook', 'instagram'] },
    })
    expect(gate).toMatchObject({ ok: false, errorCode: 'MEDIA_UNVERIFIABLE' })
  })

  it('gives truncated downloads a distinct error instead of generic MEDIA_UNVERIFIABLE', async () => {
    fetchMock.mockResolvedValue({ bytes: Buffer.from('too short to find moov'), truncated: true })
    const gate = await checkCreativeMediaForMeta({
      mediaUrl: 'https://example.com/huge-non-faststart.mp4',
      platformPlacement: { publisher_platforms: ['facebook'] },
    })
    expect(gate).toMatchObject({ ok: false, errorCode: 'MEDIA_TRUNCATED' })
  })

  it('blocks a landscape video submitted for a Reels-only placement end to end, via validateCampaignDraft', async () => {
    fetchMock.mockResolvedValue({ bytes: mp4Buffer({ width: 1920, height: 1080 }) })
    const campaign = await draftWithMedia('https://example.com/landscape-reel.mp4', { instagram_positions: ['reels'] })
    const result = await campaignService.validateCampaignDraft(client.id, campaign.id)
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/vertical|portrait/)
  })

  it('passes a compliant vertical Reels video end to end, via validateCampaignDraft', async () => {
    fetchMock.mockResolvedValue({ bytes: mp4Buffer({ width: 1080, height: 1920, duration: 30000, timescale: 1000 }) })
    const campaign = await draftWithMedia('https://example.com/good-reel.mp4', { instagram_positions: ['reels'] })
    const result = await campaignService.validateCampaignDraft(client.id, campaign.id)
    expect(result.valid).toBe(true)
  })
})

describe('checkCampaignMedia (pre-draft real-time check)', () => {
  it('reports ok:true and no media url required when nothing is provided yet', async () => {
    const result = await campaignService.checkCampaignMedia({ mediaUrl: null, platformPlacement: null })
    expect(result).toEqual({ ok: true, errorCode: null, message: null })
  })

  it('reports ok:false for a too-narrow image before any campaign exists', async () => {
    fetchMock.mockResolvedValue({ bytes: pngBuffer(300, 300) })
    const result = await campaignService.checkCampaignMedia({
      mediaUrl: 'https://example.com/small.png',
      platformPlacement: { publisher_platforms: ['facebook'] },
    })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/500px/)
  })

  it('reports ok:true for a compliant image before any campaign exists', async () => {
    fetchMock.mockResolvedValue({ bytes: pngBuffer(800, 600) })
    const result = await campaignService.checkCampaignMedia({
      mediaUrl: 'https://example.com/big.png',
      platformPlacement: { publisher_platforms: ['facebook'] },
    })
    expect(result).toEqual({ ok: true, errorCode: null, message: null })
  })

  it('applies Reels/Stories placement rules even from the pre-draft check', async () => {
    fetchMock.mockResolvedValue({ bytes: mp4Buffer({ width: 1920, height: 1080 }) })
    const result = await campaignService.checkCampaignMedia({
      mediaUrl: 'https://example.com/landscape.mp4',
      platformPlacement: { instagram_positions: ['reels'] },
    })
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('placement-orientation')
  })
})
