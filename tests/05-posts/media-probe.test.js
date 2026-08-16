import { describe, it, expect } from 'vitest'
import { probeMedia } from '../../shared/services/media-probe.js'

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

function leU16(n) {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(n, 0)
  return b
}

function leU32(n) {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n, 0)
  return b
}

function validJpeg({ width = 1080, height = 1920, includeEoi = true, trailing = 0, orientation = 1 } = {}) {
  const parts = [Buffer.from([0xff, 0xd8])]
  if (orientation !== 1) {
    const tiff = Buffer.concat([
      Buffer.from('II'),
      leU16(42),
      leU32(8),
      leU16(1),
      leU16(0x0112),
      leU16(3),
      leU32(1),
      leU32(orientation),
      leU32(0),
    ])
    const exifPayload = Buffer.concat([Buffer.from('Exif\0\0'), tiff])
    parts.push(Buffer.from([0xff, 0xe1]), u16(exifPayload.length + 2), exifPayload)
  }
  const sofPayload = Buffer.concat([
    Buffer.from([0x08]),
    u16(height),
    u16(width),
    Buffer.from([0x01]),
    Buffer.from([0x11]),
    Buffer.from([0x00]),
  ])
  parts.push(Buffer.from([0xff, 0xc0]), u16(sofPayload.length + 2), sofPayload)
  const sosPayload = Buffer.concat([
    Buffer.from([0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00]),
    Buffer.from([0x01, 0x02, 0x03]),
  ])
  const sos = Buffer.concat([Buffer.from([0xff, 0xda]), u16(sosPayload.length + 2), sosPayload])
  parts.push(sos)
  if (includeEoi) parts.push(Buffer.from([0xff, 0xd9]))
  if (trailing > 0) parts.push(Buffer.alloc(trailing, 0))
  return Buffer.concat(parts)
}

function validMp4({ duration = 5000, timescale = 1000, width = 1280, height = 720, rotation = 0, codec = 'avc1', fragmented = false } = {}) {
  const matrix = Buffer.alloc(36)
  if (rotation) {
    const rad = (rotation * Math.PI) / 180
    matrix.writeInt32BE(Math.round(Math.cos(rad) * 65536), 0)
    matrix.writeInt32BE(Math.round(Math.sin(rad) * 65536), 4)
    matrix.writeInt32BE(-Math.round(Math.sin(rad) * 65536), 20)
    matrix.writeInt32BE(Math.round(Math.cos(rad) * 65536), 24)
    matrix.writeInt32BE(0x10000, 16)
  } else {
    matrix.writeInt32BE(0x10000, 0)
    matrix.writeInt32BE(0x10000, 20)
  }
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
  const stbl = box('stbl', stsd)
  const minf = box('minf', stbl)
  const mdia = box('mdia', minf)
  const tkhd = box('tkhd', Buffer.concat([
    u32(0), u32(9), u32(0), u32(1), u32(0), u32(duration), Buffer.alloc(8),
    u16(0), u16(0), u16(0x100), u16(0), matrix, u32(width << 16), u32(height << 16),
  ]))
  const moov = box('moov', Buffer.concat([mvhd, box('trak', Buffer.concat([tkhd, mdia]))]))
  const ftyp = box('ftyp', Buffer.concat([Buffer.from('isom'), u32(0), Buffer.from('isom')]))
  if (fragmented) {
    const moof = box('moof', Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))
    return Buffer.concat([ftyp, moof])
  }
  return Buffer.concat([ftyp, moov])
}

function realJpeg({ width = 1080, height = 1920, truncateScan = false } = {}) {
  const parts = [Buffer.from([0xff, 0xd8])]
  const sofPayload = Buffer.concat([
    Buffer.from([0x08]),
    u16(height),
    u16(width),
    Buffer.from([0x01]),
    Buffer.from([0x11]),
    Buffer.from([0x00]),
  ])
  parts.push(Buffer.from([0xff, 0xc0]), u16(sofPayload.length + 2), sofPayload)
  const sosParams = Buffer.from([0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00])
  parts.push(Buffer.from([0xff, 0xda]), u16(sosParams.length + 2), sosParams)
  const scan = Buffer.concat([
    Buffer.from([0xab, 0xcd, 0xef, 0xff, 0x00, 0x12, 0x34]),
    Buffer.from([0x99, 0x88, 0xff, 0xd0, 0x77, 0x66, 0x55]),
    Buffer.from([0x44, 0x33, 0x22, 0x11]),
  ])
  parts.push(scan)
  if (!truncateScan) parts.push(Buffer.from([0xff, 0xd9]))
  return Buffer.concat(parts)
}

describe('probeMedia: JPEG', () => {
  it('parses a valid JPEG with dimensions', () => {
    const buf = validJpeg({ width: 1080, height: 1920 })
    const res = probeMedia(buf)
    expect(res.status).toBe('valid')
    expect(res.kind).toBe('image')
    expect(res.mediaType).toBe('jpeg')
    expect(res.width).toBe(1080)
    expect(res.height).toBe(1920)
    expect(res.aspect).toBeCloseTo(0.5625, 4)
    expect(res.orientation).toBe(1)
  })

  it('parses EXIF orientation', () => {
    const res = probeMedia(validJpeg({ orientation: 6 }))
    expect(res.status).toBe('valid')
    expect(res.orientation).toBe(6)
  })

  it('parses a realistic JPEG with entropy-coded scan data outside the SOS payload (byte-stuffed, restart markers)', () => {
    const res = probeMedia(realJpeg())
    expect(res.status).toBe('valid')
    expect(res.width).toBe(1080)
    expect(res.height).toBe(1920)
    expect(res.kind).toBe('image')
    expect(res.mediaType).toBe('jpeg')
  })

  it('rejects a realistic JPEG whose scan data runs off the end without EOI', () => {
    const res = probeMedia(realJpeg({ truncateScan: true }))
    expect(res.status).toBe('invalid')
    expect(res.reason).toMatch(/truncated|EOI|eoi/i)
  })

  it('rejects a truncated JPEG without EOI', () => {
    const res = probeMedia(validJpeg({ includeEoi: false }))
    expect(res.status).toBe('invalid')
    expect(res.reason).toMatch(/eoi|truncated/i)
  })

  it('rejects trailing bytes after EOI', () => {
    const res = probeMedia(validJpeg({ trailing: 8 }))
    expect(res.status).toBe('invalid')
  })

  it('treats unrecognized containers as unknown', () => {
    const res = probeMedia(Buffer.from('not a jpeg at all, definitely not a file'))
    expect(res.status).toBe('unknown')
  })
})

describe('probeMedia: MP4', () => {
  it('parses a valid MP4 with duration, dimensions, rotation and codec', () => {
    const res = probeMedia(validMp4({ width: 1280, height: 720, duration: 15000, rotation: 90, codec: 'avc1' }))
    expect(res.status).toBe('valid')
    expect(res.kind).toBe('video')
    expect(res.mediaType).toBe('mp4')
    expect(res.width).toBe(1280)
    expect(res.height).toBe(720)
    expect(res.aspect).toBeCloseTo(1.7778, 3)
    expect(res.durationSeconds).toBe(15)
    expect(res.codecs).toContain('avc1')
  })

  it('maps hev1/hvc1 codecs', () => {
    const res = probeMedia(validMp4({ codec: 'hvc1' }))
    expect(res.status).toBe('valid')
    expect(res.codecs).toContain('hvc1')
  })

  it('returns unknown for fragmented MP4 without moov', () => {
    const res = probeMedia(validMp4({ fragmented: true }))
    expect(res.status).toBe('unknown')
  })

  it('rejects an MP4 with no moov box', () => {
    const ftyp = box('ftyp', Buffer.concat([Buffer.from('isom'), u32(0), Buffer.from('isom')]))
    const res = probeMedia(Buffer.concat([ftyp, Buffer.from('mdat goes here without a movie header')]))
    expect(res.status).toBe('invalid')
    expect(res.reason).toMatch(/moov/i)
  })
})

describe('probeMedia: dispatch', () => {
  it('returns unknown for unsupported containers', () => {
    const res = probeMedia(Buffer.from('%PDF-1.7 some pdf bytes'))
    expect(res.status).toBe('unknown')
  })

  it('returns invalid for empty input', () => {
    const res = probeMedia(Buffer.alloc(0))
    expect(res.status).toBe('invalid')
  })
})