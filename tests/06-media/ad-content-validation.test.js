import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest'

var fetchMock
var inspectSizeMock
vi.mock('../../shared/services/media-url.js', async () => {
  const actual = await vi.importActual('../../shared/services/media-url.js')
  fetchMock = vi.fn()
  inspectSizeMock = vi.fn().mockResolvedValue({ status: 'UNKNOWN_SIZE', sizeBytes: null })
  return { ...actual, fetchBoundedBytes: fetchMock, inspectMediaSize: inspectSizeMock }
})

beforeEach(() => {
  fetchMock.mockReset()
  inspectSizeMock.mockReset().mockResolvedValue({ status: 'UNKNOWN_SIZE', sizeBytes: null })
})

const {
  checkAdContentForMeta,
  checkAdMediaForMeta,
  checkCallToAction,
  isValidCallToAction,
  META_CALL_TO_ACTION_TYPES,
  adMediaGate,
  adMediaProbeLimits,
} = await import('../../shared/services/ad-content-validation.js')

// This file exercises the network-touching media gate directly, so it opts
// back into the (test-env-default-off) gate — see ad-content-validation.js.
const originalMediaGateEnabled = adMediaGate.enabled
beforeAll(() => { adMediaGate.enabled = true })
afterAll(() => { adMediaGate.enabled = originalMediaGateEnabled })

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

describe('ad-content-validation: call-to-action', () => {
  it('accepts a valid CTA from the Meta CTA type list', () => {
    expect(isValidCallToAction('LEARN_MORE')).toBe(true)
    expect(checkCallToAction('SHOP_NOW')).toBeNull()
  })

  it('treats an empty/absent CTA as valid (optional field)', () => {
    expect(isValidCallToAction(null)).toBe(true)
    expect(isValidCallToAction(undefined)).toBe(true)
    expect(checkCallToAction('')).toBeNull()
  })

  it('rejects a CTA not in the supported list', () => {
    const failure = checkCallToAction('DEFINITELY_NOT_A_CTA')
    expect(failure).toMatchObject({ ok: false, errorCode: 'invalid-cta' })
    expect(failure.message).toMatch(/not a supported call-to-action/)
  })

  it('exports a non-empty, deduplicated CTA type list', () => {
    expect(META_CALL_TO_ACTION_TYPES.length).toBeGreaterThan(0)
    expect(new Set(META_CALL_TO_ACTION_TYPES).size).toBe(META_CALL_TO_ACTION_TYPES.length)
  })
})

describe('ad-content-validation: media (Facebook-only placement — the closed gap)', () => {
  it('blocks an oversized/undersized image even when Instagram is not in the placement', async () => {
    fetchMock.mockResolvedValue({ bytes: pngBuffer(300, 300) })
    const gate = await checkAdMediaForMeta({
      mediaUrl: 'https://example.com/small.png',
      platformPlacement: { publisher_platforms: ['facebook'] },
    })
    expect(gate).toMatchObject({ ok: false })
    expect(gate.message).toMatch(/500px/)
  })

  it('passes a compliant image on a Facebook-only placement', async () => {
    fetchMock.mockResolvedValue({ bytes: pngBuffer(800, 600) })
    const gate = await checkAdMediaForMeta({
      mediaUrl: 'https://example.com/big.png',
      platformPlacement: { publisher_platforms: ['facebook'] },
    })
    expect(gate).toBeNull()
  })

  it('still applies the Instagram-specific width classification when Instagram is in the placement', async () => {
    fetchMock.mockResolvedValue({ bytes: pngBuffer(300, 300) })
    const gate = await checkAdMediaForMeta({
      mediaUrl: 'https://example.com/small.png',
      platformPlacement: { publisher_platforms: ['facebook', 'instagram'] },
    })
    expect(gate).toMatchObject({ ok: false })
  })
})

describe('ad-content-validation: media (video)', () => {
  it('rejects a video with an unsupported codec', async () => {
    // 'mp4a' is a recognized (audio) codec in the prober's CODEC_MAP but not in
    // evaluateRepairVideo's accepted video codec list — an unrecognized fourcc
    // (e.g. 'vp09') is intentionally treated as "unknown, pass through to Meta"
    fetchMock.mockResolvedValue({ bytes: mp4Buffer({ codec: 'mp4a' }) })
    const gate = await checkAdMediaForMeta({
      mediaUrl: 'https://example.com/bad-codec.mp4',
      platformPlacement: { publisher_platforms: ['facebook'] },
    })
    expect(gate).toMatchObject({ ok: false, errorCode: 'codec' })
  })

  it('passes a compliant h264 video', async () => {
    fetchMock.mockResolvedValue({ bytes: mp4Buffer({ codec: 'avc1' }) })
    const gate = await checkAdMediaForMeta({
      mediaUrl: 'https://example.com/good.mp4',
      platformPlacement: { publisher_platforms: ['facebook'] },
    })
    expect(gate).toBeNull()
  })

  it('fetches with the raised probe cap, not the old 2MB organic-post default', async () => {
    fetchMock.mockResolvedValue({ bytes: mp4Buffer({ codec: 'avc1' }) })
    await checkAdMediaForMeta({
      mediaUrl: 'https://example.com/good.mp4',
      platformPlacement: { publisher_platforms: ['facebook'] },
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com/good.mp4',
      expect.objectContaining({ maxBytes: adMediaProbeLimits.maxBytes })
    )
  })

  it('rejects immediately via the real-size HEAD check when the remote file is known too large, with zero body download', async () => {
    inspectSizeMock.mockResolvedValue({ status: 'KNOWN_TOO_LARGE', sizeBytes: 5 * 1024 * 1024 * 1024 })
    const gate = await checkAdMediaForMeta({
      mediaUrl: 'https://example.com/huge.mp4',
      platformPlacement: { publisher_platforms: ['facebook'] },
    })
    expect(gate).toMatchObject({ ok: false, errorCode: 'max-size' })
    expect(gate.message).toMatch(/GB/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('falls through to the bounded fetch when HEAD size is unknown or valid', async () => {
    inspectSizeMock.mockResolvedValue({ status: 'KNOWN_VALID', sizeBytes: 1024 })
    fetchMock.mockResolvedValue({ bytes: mp4Buffer({ codec: 'avc1' }) })
    const gate = await checkAdMediaForMeta({
      mediaUrl: 'https://example.com/good.mp4',
      platformPlacement: { publisher_platforms: ['facebook'] },
    })
    expect(gate).toBeNull()
    expect(fetchMock).toHaveBeenCalled()
  })

  it('gives truncated downloads a distinct, actionable error instead of generic MEDIA_UNVERIFIABLE', async () => {
    fetchMock.mockResolvedValue({ bytes: Buffer.from('not enough bytes to find moov'), truncated: true })
    const gate = await checkAdMediaForMeta({
      mediaUrl: 'https://example.com/big-non-faststart.mp4',
      platformPlacement: { publisher_platforms: ['facebook'] },
    })
    expect(gate).toMatchObject({ ok: false, errorCode: 'MEDIA_TRUNCATED', retryable: true })
    expect(gate.message).toMatch(/fast start/)
  })

  it('probes valid past the old 2MB truncation point when moov sits after a large mdat', async () => {
    // Real-shaped fixture: ftyp -> large mdat (> old 2MB cap, < new 40MB cap) -> moov.
    // The old 2MB default would have truncated before reaching moov at all.
    const ftyp = box('ftyp', Buffer.concat([Buffer.from('isom'), u32(0), Buffer.from('isom')]))
    const mdat = box('mdat', Buffer.alloc(3 * 1024 * 1024))
    const withoutFtyp = mp4Buffer({ codec: 'avc1' }).subarray(ftyp.length)
    fetchMock.mockResolvedValue({ bytes: Buffer.concat([ftyp, mdat, withoutFtyp]) })
    const gate = await checkAdMediaForMeta({
      mediaUrl: 'https://example.com/real-shaped.mp4',
      platformPlacement: { publisher_platforms: ['facebook'] },
    })
    expect(gate).toBeNull()
  })
})

describe('ad-content-validation: placement-aware Reels/Stories video checks', () => {
  const reelsPlacement = { instagram_positions: ['reels'] }
  const storyPlacement = { facebook_positions: ['story'] }

  it('rejects a Reels video longer than 90s', async () => {
    fetchMock.mockResolvedValue({ bytes: mp4Buffer({ codec: 'avc1', duration: 95000, timescale: 1000, width: 1080, height: 1920 }) })
    const gate = await checkAdMediaForMeta({ mediaUrl: 'https://example.com/long-reel.mp4', platformPlacement: reelsPlacement })
    expect(gate).toMatchObject({ ok: false, errorCode: 'placement-max-duration' })
  })

  it('rejects a landscape video for Reels even though it clears the min-width AND min-height floors independently', async () => {
    // 1920x1080 clears width>=540 and height>=960 individually, but is landscape,
    // not vertical — floors alone cannot catch this, only the aspect check can.
    fetchMock.mockResolvedValue({ bytes: mp4Buffer({ codec: 'avc1', width: 1920, height: 1080 }) })
    const gate = await checkAdMediaForMeta({ mediaUrl: 'https://example.com/landscape.mp4', platformPlacement: reelsPlacement })
    expect(gate).toMatchObject({ ok: false, errorCode: 'placement-orientation' })
  })

  it('rejects a vertical Reels video below the 540x960 floor as a dimensions failure, not orientation', async () => {
    // width/height chosen to clear the generic evaluateRepairVideo floor (500px)
    // but fail the Reels-specific 540x960 floor, isolating placement-min-dimensions
    fetchMock.mockResolvedValue({ bytes: mp4Buffer({ codec: 'avc1', width: 520, height: 920 }) })
    const gate = await checkAdMediaForMeta({ mediaUrl: 'https://example.com/small-vertical.mp4', platformPlacement: reelsPlacement })
    expect(gate).toMatchObject({ ok: false, errorCode: 'placement-min-dimensions' })
  })

  it('passes a compliant vertical Reels video', async () => {
    fetchMock.mockResolvedValue({ bytes: mp4Buffer({ codec: 'avc1', width: 1080, height: 1920, duration: 30000, timescale: 1000 }) })
    const gate = await checkAdMediaForMeta({ mediaUrl: 'https://example.com/good-reel.mp4', platformPlacement: reelsPlacement })
    expect(gate).toBeNull()
  })

  it('rejects a Stories video longer than 60s', async () => {
    fetchMock.mockResolvedValue({ bytes: mp4Buffer({ codec: 'avc1', width: 1080, height: 1920, duration: 65000, timescale: 1000 }) })
    const gate = await checkAdMediaForMeta({ mediaUrl: 'https://example.com/long-story.mp4', platformPlacement: storyPlacement })
    expect(gate).toMatchObject({ ok: false, errorCode: 'placement-max-duration' })
  })

  it('passes a compliant vertical Stories video', async () => {
    fetchMock.mockResolvedValue({ bytes: mp4Buffer({ codec: 'avc1', width: 1080, height: 1920, duration: 20000, timescale: 1000 }) })
    const gate = await checkAdMediaForMeta({ mediaUrl: 'https://example.com/good-story.mp4', platformPlacement: storyPlacement })
    expect(gate).toBeNull()
  })

  it('does not apply Reels/Stories dimension rules to a Feed-only placement', async () => {
    fetchMock.mockResolvedValue({ bytes: mp4Buffer({ codec: 'avc1', width: 1920, height: 1080, duration: 200000, timescale: 1000 }) })
    const gate = await checkAdMediaForMeta({ mediaUrl: 'https://example.com/feed-video.mp4', platformPlacement: { facebook_positions: ['feed'] } })
    expect(gate).toBeNull()
  })
})

describe('ad-content-validation: fail-closed on unverifiable media', () => {
  it('fails closed when the fetch throws (e.g. SSRF block or network error) and marks it retryable', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('blocked'), { code: 'MEDIA_SSRF_BLOCKED' }))
    const gate = await checkAdMediaForMeta({
      mediaUrl: 'http://127.0.0.1/evil.png',
      platformPlacement: { publisher_platforms: ['facebook'] },
    })
    // retryable: true here is load-bearing, not incidental — a transient
    // network/timeout hiccup fetching the media must never be treated the
    // same as "this file is genuinely wrong" by callers deciding whether to
    // kill the job outright (throwClientLegFailure/throwGoLiveFailure in
    // campaign.service.js) or let it back off and retry automatically.
    expect(gate).toMatchObject({ ok: false, errorCode: 'MEDIA_UNVERIFIABLE', retryable: true })
  })

  it('fails closed when the fetched body is empty and marks it retryable', async () => {
    fetchMock.mockResolvedValue({ bytes: Buffer.alloc(0) })
    const gate = await checkAdMediaForMeta({
      mediaUrl: 'https://example.com/empty.png',
      platformPlacement: { publisher_platforms: ['facebook'] },
    })
    expect(gate).toMatchObject({ ok: false, errorCode: 'MEDIA_UNVERIFIABLE', retryable: true })
  })

  it('fails closed when the media cannot be recognized as image or video and marks it retryable', async () => {
    fetchMock.mockResolvedValue({ bytes: Buffer.from('not a media file at all') })
    const gate = await checkAdMediaForMeta({
      mediaUrl: 'https://example.com/x.bin',
      platformPlacement: { publisher_platforms: ['facebook'] },
    })
    expect(gate).toMatchObject({ ok: false, errorCode: 'MEDIA_UNVERIFIABLE', retryable: true })
  })

  it('a genuine content violation (bad dimensions) is NOT marked retryable — retrying with the same file can never fix it', async () => {
    fetchMock.mockResolvedValue({ bytes: pngBuffer(10, 10) })
    const gate = await checkAdMediaForMeta({
      mediaUrl: 'https://example.com/tiny.png',
      platformPlacement: { publisher_platforms: ['facebook'] },
    })
    expect(gate.ok).toBe(false)
    expect(gate.retryable).toBeFalsy()
  })

  it('an invalid call-to-action is NOT marked retryable', () => {
    const failure = checkCallToAction('NOT_A_REAL_CTA')
    expect(failure.ok).toBe(false)
    expect(failure.retryable).toBeFalsy()
  })

  it('returns null (no gate) when there is no media URL at all', async () => {
    const gate = await checkAdMediaForMeta({ mediaUrl: null, platformPlacement: { publisher_platforms: ['facebook'] } })
    expect(gate).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('ad-content-validation: checkAdContentForMeta (combined CTA + media)', () => {
  it('rejects on invalid CTA before ever fetching media', async () => {
    const result = await checkAdContentForMeta({
      creative: { callToAction: 'NOT_REAL', mediaUrl: 'https://example.com/img.png' },
      metaSettings: { platformPlacement: { publisher_platforms: ['facebook'] } },
    })
    expect(result).toMatchObject({ ok: false, errorCode: 'invalid-cta' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects on bad media when CTA is valid', async () => {
    fetchMock.mockResolvedValue({ bytes: pngBuffer(200, 200) })
    const result = await checkAdContentForMeta({
      creative: { callToAction: 'LEARN_MORE', mediaUrl: 'https://example.com/small.png' },
      metaSettings: { platformPlacement: { publisher_platforms: ['facebook'] } },
    })
    expect(result.ok).toBe(false)
  })

  it('passes when both CTA and media are valid', async () => {
    fetchMock.mockResolvedValue({ bytes: pngBuffer(800, 600) })
    const result = await checkAdContentForMeta({
      creative: { callToAction: 'SHOP_NOW', mediaUrl: 'https://example.com/big.png' },
      metaSettings: { platformPlacement: { publisher_platforms: ['facebook'] } },
    })
    expect(result).toEqual({ ok: true, errorCode: null, message: null })
  })

  it('passes when there is no creative/media at all (nothing to validate yet)', async () => {
    const result = await checkAdContentForMeta({ creative: null, metaSettings: null })
    expect(result.ok).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
