import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { generateUuid } from '../../shared/utils/uuid.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import { query } from '../../shared/database/connection.js'
import * as mediaService from '../../src/modules/media-library/media.service.js'
import fs from 'fs/promises'
import path from 'path'

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

function mp4Buffer({ duration = 15000, timescale = 1000, width = 1080, height = 1920, codec = 'avc1' } = {}) {
  const matrix = Buffer.alloc(36)
  matrix.writeInt32BE(0x10000, 0)
  matrix.writeInt32BE(0x10000, 20)
  const mvhd = box('mvhd', Buffer.concat([
    u32(0), u32(0), u32(0), u32(timescale), u32(duration), u32(0x10000), u16(0x100), u16(0),
    Buffer.alloc(8), matrix, Buffer.alloc(24), u32(2),
  ]))
  const entry = box(codec, Buffer.concat([
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

describe('media library', () => {
  let testUser, adminId
  const createdAssets = []

  beforeAll(async () => {
    testUser = await createTestUser({
      email: `media-user-${dateTag}@flowx-test.com`,
      password: 'Test@123',
    })
    const row = await query("SELECT id FROM users WHERE email = 'admin@flowx.com' LIMIT 1")
    const { bufferToUuid } = await import('../../shared/utils/uuid.utils.js')
    adminId = row.length ? bufferToUuid(row[0].id) : null
  })

  afterAll(async () => {
    await query('DELETE FROM media_assets WHERE user_id = ?', [
      (await import('../../shared/utils/uuid.utils.js')).uuidToBuffer(testUser.id),
    ])
    for (const file of createdAssets) {
      await fs.unlink(file).catch(() => {})
    }
  })

  it('rejects an upload without a file', async () => {
    await expect(mediaService.uploadMedia(testUser.id, null)).rejects.toThrow(/file/i)
  })

  it('rejects an unsupported media type', async () => {
    const file = { filename: `x-${dateTag}.pdf`, size: 100, mimetype: 'application/pdf' }
    await expect(mediaService.uploadMedia(testUser.id, file)).rejects.toThrow(/invalid media type/i)
  })

  it('rejects an empty file', async () => {
    const file = { filename: `x-${dateTag}.jpg`, size: 0, mimetype: 'image/jpeg' }
    await expect(mediaService.uploadMedia(testUser.id, file)).rejects.toThrow(/empty/i)
  })

  it('uploads an image asset with an absolute url', async () => {
    const file = { filename: `img-${dateTag}.jpg`, size: 1024, mimetype: 'image/jpeg' }
    const asset = await mediaService.uploadMedia(testUser.id, file, { name: 'hero image' })
    expect(asset.id).toBeTruthy()
    expect(asset.mediaKind).toBe('image')
    expect(asset.storagePath).toBe(`/uploads/posts/${file.filename}`)
    expect(asset.url).toContain(`/uploads/posts/${file.filename}`)
    createdAssets.push(path.join('public/uploads/posts', file.filename))
  })

  it('uploads a video asset', async () => {
    const file = { filename: `video-${dateTag}.mp4`, size: 2 * 1024 * 1024, mimetype: 'video/mp4' }
    const asset = await mediaService.uploadMedia(testUser.id, file, { name: 'reel' })
    expect(asset.mediaKind).toBe('video')
    createdAssets.push(path.join('public/uploads/posts', file.filename))
  })

  it('accepts a real compliant image, recording its probed dimensions', async () => {
    const filename = `real-ok-${dateTag}.png`
    const fileOnDisk = path.join('public/uploads/posts', filename)
    await fs.writeFile(fileOnDisk, pngBuffer(800, 600))
    createdAssets.push(fileOnDisk)
    const file = { filename, path: fileOnDisk, size: 29, mimetype: 'image/png' }
    const asset = await mediaService.uploadMedia(testUser.id, file, { name: 'real image' })
    expect(asset.width).toBe(800)
    expect(asset.height).toBe(600)
  })

  it('rejects a real too-narrow image and deletes the uploaded file', async () => {
    const filename = `real-narrow-${dateTag}.png`
    const fileOnDisk = path.join('public/uploads/posts', filename)
    await fs.writeFile(fileOnDisk, pngBuffer(300, 300))
    const file = { filename, path: fileOnDisk, size: 29, mimetype: 'image/png' }
    await expect(mediaService.uploadMedia(testUser.id, file)).rejects.toThrow(/500px/)
    await expect(fs.access(fileOnDisk)).rejects.toThrow()
  })

  it('accepts a real compliant video, recording its probed dimensions', async () => {
    const filename = `real-video-ok-${dateTag}.mp4`
    const fileOnDisk = path.join('public/uploads/posts', filename)
    await fs.writeFile(fileOnDisk, mp4Buffer({ codec: 'avc1', width: 1080, height: 1920 }))
    createdAssets.push(fileOnDisk)
    const file = { filename, path: fileOnDisk, size: 4096, mimetype: 'video/mp4' }
    const asset = await mediaService.uploadMedia(testUser.id, file, { name: 'real video' })
    expect(asset.width).toBe(1080)
    expect(asset.height).toBe(1920)
  })

  it('rejects a real video with an unsupported codec and deletes the uploaded file', async () => {
    const filename = `real-video-bad-codec-${dateTag}.mp4`
    const fileOnDisk = path.join('public/uploads/posts', filename)
    await fs.writeFile(fileOnDisk, mp4Buffer({ codec: 'mp4a' }))
    const file = { filename, path: fileOnDisk, size: 4096, mimetype: 'video/mp4' }
    await expect(mediaService.uploadMedia(testUser.id, file)).rejects.toThrow(/unsupported codec/)
    await expect(fs.access(fileOnDisk)).rejects.toThrow()
  })

  it('does not block an upload whose file cannot be probed (missing on disk)', async () => {
    // Preserves prior best-effort behavior: probing failure never blocks upload
    const file = { filename: `unreachable-${dateTag}.png`, path: '/nonexistent/path.png', size: 29, mimetype: 'image/png' }
    const asset = await mediaService.uploadMedia(testUser.id, file)
    expect(asset.width).toBeNull()
    expect(asset.height).toBeNull()
  })

  it('enforces the per-file size cap', async () => {
    const originalMax = process.env.POST_MEDIA_MAX_FILE_BYTES
    delete process.env.POST_MEDIA_MAX_FILE_BYTES
    const { MAX_MEDIA_FILE_BYTES } = await import('../../shared/utils/post-media-upload.js')
    const file = { filename: `big-${dateTag}.mp4`, size: MAX_MEDIA_FILE_BYTES + 1, mimetype: 'video/mp4' }
    await expect(mediaService.uploadMedia(testUser.id, file)).rejects.toThrow(/per-file limit/i)
    if (originalMax !== undefined) process.env.POST_MEDIA_MAX_FILE_BYTES = originalMax
  })

  it('rejects uploads that exceed the total quota', async () => {
    const fresh = await createTestUser({
      email: `media-quota-${dateTag}@flowx-test.com`,
      password: 'Test@123',
    })
    const { uuidToBuffer, generateUuid: genUuid } = await import('../../shared/utils/uuid.utils.js')
    const key = 'post_media_quota_bytes'
    const prev = await query('SELECT config_value FROM app_config WHERE config_key = ?', [key])

    await query(
      `INSERT INTO app_config (id, config_key, config_value, is_public, description, version)
       VALUES (?, ?, '2048', 1, 'test', 1)
       ON DUPLICATE KEY UPDATE config_value = '2048', version = version + 1`,
      [uuidToBuffer(genUuid()), key]
    )
    try {
      const file = { filename: `q-${dateTag}.jpg`, size: 1024, mimetype: 'image/jpeg' }
      await mediaService.uploadMedia(fresh.id, file)
      const file2 = { filename: `q2-${dateTag}.jpg`, size: 2048, mimetype: 'image/jpeg' }
      await expect(mediaService.uploadMedia(fresh.id, file2)).rejects.toThrow(/quota exceeded/i)
    } finally {
      if (prev.length) {
        await query('UPDATE app_config SET config_value = ? WHERE config_key = ?', [prev[0].config_value, key])
      } else {
        await query('DELETE FROM app_config WHERE config_key = ?', [key])
      }
    }
  })

  it('lists media with totals and quota', async () => {
    const result = await mediaService.listMedia(testUser.id, { page: 1, limit: 20 })
    expect(result.items.length).toBeGreaterThanOrEqual(2)
    expect(result.totalBytes).toBeGreaterThan(0)
    expect(result.quotaBytes).toBe(512 * 1024 * 1024)
    for (const asset of result.items) {
      expect(asset.url).toContain('/uploads/posts/')
    }
  })

  it('filters media by kind', async () => {
    const videos = await mediaService.listMedia(testUser.id, { page: 1, limit: 20, kind: 'video' })
    expect(videos.items.length).toBeGreaterThanOrEqual(1)
    expect(videos.items.every(a => a.mediaKind === 'video')).toBe(true)
  })

  it('forbids deleting another users media', async () => {
    const other = await createTestUser({
      email: `media-other-${dateTag}@flowx-test.com`,
      password: 'Test@123',
    })
    const file = { filename: `other-${dateTag}.jpg`, size: 100, mimetype: 'image/jpeg' }
    const asset = await mediaService.uploadMedia(other.id, file, { name: 'other' })
    createdAssets.push(path.join('public/uploads/posts', file.filename))
    await expect(mediaService.deleteMedia(testUser.id, asset.id)).rejects.toThrow(/only delete your own/i)
  })

  it('deletes a media asset and removes its file', async () => {
    const file = { filename: `del-${dateTag}.jpg`, size: 100, mimetype: 'image/jpeg' }
    const fileOnDisk = path.join('public/uploads/posts', file.filename)
    await fs.writeFile(fileOnDisk, 'x')
    createdAssets.push(fileOnDisk)
    const asset = await mediaService.uploadMedia(testUser.id, file, { name: 'delete me' })

    await mediaService.deleteMedia(testUser.id, asset.id)
    await expect(fs.access(fileOnDisk)).rejects.toThrow()
    const stillThere = await mediaService.listMedia(testUser.id, { page: 1, limit: 100 })
    expect(stillThere.items.some(a => a.id === asset.id)).toBe(false)
  })

  it('blocks deleting a media asset referenced by a live post', async () => {
    const file = { filename: `ref-${dateTag}.mp4`, size: 1024, mimetype: 'video/mp4' }
    const asset = await mediaService.uploadMedia(testUser.id, file, { name: 'referenced' })
    createdAssets.push(path.join('public/uploads/posts', file.filename))

    await query(
      `INSERT INTO posts (id, client_id, name, type, status, media_url)
       VALUES (?, ?, 'ref post', 'reel', 'approved', ?)`,
      [
        (await import('../../shared/utils/uuid.utils.js')).uuidToBuffer(generateUuid()),
        (await import('../../shared/utils/uuid.utils.js')).uuidToBuffer(testUser.id),
        asset.url,
      ]
    )

    await expect(mediaService.deleteMedia(testUser.id, asset.id)).rejects.toThrow(/referenced by a post/i)
  })

  it('exposes quota config via public config', async () => {
    const configService = await import('../../src/modules/config/config.service.js')
    const config = await configService.getPublicConfig()
    expect(config.postMedia).toBeTruthy()
    expect(config.postMedia.quotaBytes).toBeGreaterThan(0)
  })

  it('updates media config as admin', async () => {
    if (!adminId) return
    const admin = await import('../../src/modules/media-library/admin.controller.js')
    const req = { user: { id: adminId }, body: { quotaBytes: 64 * 1024 * 1024 } }
    let statusCode = null
    const res = {
      status(code) { statusCode = code; return this },
      json(payload) { this.body = payload; return this },
    }
    await admin.updateMediaConfig(req, res, () => {})
    expect(statusCode).toBe(200)
    expect(res.body.data.quotaBytes).toBe(64 * 1024 * 1024)
    // restore
    await admin.updateMediaConfig({ user: { id: adminId }, body: { quotaBytes: 512 * 1024 * 1024 } }, res, () => {})
  })
})