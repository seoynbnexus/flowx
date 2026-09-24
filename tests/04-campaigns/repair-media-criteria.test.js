import { describe, it, expect } from 'vitest'
import {
  evaluateRepairImage,
  evaluateRepairVideo,
  normalizeRepairImageFormat,
  normalizeRepairVideoContainer,
  REPAIR_IMAGE_MAX_BYTES,
  REPAIR_MIN_IMAGE_WIDTH_PX,
  REPAIR_MAX_VIDEO_BYTES,
  REPAIR_MAX_VIDEO_DURATION_SECONDS,
} from '../../shared/services/repair-media-criteria.js'

describe('repair media criteria (Phase 1 — image hard gates)', () => {
  it('accepts a compliant JPEG/PNG image for Facebook and Instagram', () => {
    for (const mimeType of ['image/jpeg', 'image/png', 'image/gif', 'image/webp']) {
      const result = evaluateRepairImage({ mimeType, width: 800, height: 600, sizeBytes: 1024 })
      expect(result.ok).toBe(true)
      expect(result.failures).toHaveLength(0)
    }
    const probed = evaluateRepairImage({ mediaType: 'png', width: 1080, height: 1080, sizeBytes: 2048 })
    expect(probed.ok).toBe(true)
    expect(probed.format).toBe('png')
  })

  it('hard-rejects unsupported formats with platform-named reasons', () => {
    const bmp = evaluateRepairImage({ mimeType: 'image/bmp', width: 800, height: 600, sizeBytes: 1024 })
    expect(bmp.ok).toBe(false)
    expect(bmp.failures[0].rule).toBe('format')
    expect(bmp.failures[0].message).toMatch(/Facebook and Instagram/)
    const video = evaluateRepairImage({ mimeType: 'video/mp4', width: 800, height: 600, sizeBytes: 1024 })
    expect(video.ok).toBe(false)
    expect(video.failures[0].rule).toBe('format')
    const unknown = evaluateRepairImage({ mimeType: null, mediaType: null, width: 800, height: 600, sizeBytes: 1024 })
    expect(unknown.ok).toBe(false)
    expect(unknown.failures[0].rule).toBe('format')
  })

  it('hard-rejects narrow or dimensionless images', () => {
    const narrow = evaluateRepairImage({ mimeType: 'image/jpeg', width: 400, height: 400, sizeBytes: 1024 })
    expect(narrow.ok).toBe(false)
    expect(narrow.failures[0].rule).toBe('min-width')
    expect(narrow.failures[0].message).toMatch(/400px/)
    expect(narrow.failures[0].message).toMatch(/Facebook and Instagram/)
    const nodims = evaluateRepairImage({ mimeType: 'image/png', width: null, height: null, sizeBytes: 1024 })
    expect(nodims.ok).toBe(false)
    expect(nodims.failures[0].rule).toBe('dimensions')
    const boundary = evaluateRepairImage({ mimeType: 'image/jpeg', width: REPAIR_MIN_IMAGE_WIDTH_PX, height: 600, sizeBytes: 1024 })
    expect(boundary.ok).toBe(true)
  })

  it('hard-rejects oversized images and skips the size rule when unknown', () => {
    const big = evaluateRepairImage({
      mimeType: 'image/jpeg', width: 2000, height: 2000, sizeBytes: REPAIR_IMAGE_MAX_BYTES + 1,
    })
    expect(big.ok).toBe(false)
    expect(big.failures[0].rule).toBe('max-size')
    expect(big.failures[0].message).toMatch(/Facebook and Instagram/)
    const unknownSize = evaluateRepairImage({ mimeType: 'image/jpeg', width: 800, height: 600, sizeBytes: null })
    expect(unknownSize.ok).toBe(true)
  })

  it('reports every violated rule, not just the first', () => {
    const result = evaluateRepairImage({ mimeType: 'image/bmp', width: 100, height: 100, sizeBytes: REPAIR_IMAGE_MAX_BYTES + 1 })
    expect(result.ok).toBe(false)
    expect(result.failures.map((f) => f.rule)).toEqual(['format', 'min-width', 'max-size'])
  })

  it('normalizes probe types and MIME types to one format vocabulary', () => {
    expect(normalizeRepairImageFormat({ mediaType: 'PNG' })).toBe('png')
    expect(normalizeRepairImageFormat({ mimeType: 'IMAGE/JPEG' })).toBe('jpeg')
    expect(normalizeRepairImageFormat({ mimeType: 'video/mp4' })).toBeNull()
    expect(normalizeRepairImageFormat({})).toBeNull()
  })
})

describe('repair media criteria (Phase 2 — video hard gates)', () => {
  function validVideo(overrides = {}) {
    return {
      mimeType: 'video/mp4', mediaType: 'mp4', width: 1080, height: 1920,
      durationSeconds: 15, codecs: ['avc1'], sizeBytes: 5 * 1024 * 1024,
      ...overrides,
    }
  }

  it('accepts a compliant MP4/MOV video for Facebook and Instagram', () => {
    expect(evaluateRepairVideo(validVideo()).ok).toBe(true)
    expect(evaluateRepairVideo(validVideo({ mimeType: 'video/quicktime', mediaType: 'mp4' })).ok).toBe(true)
    expect(evaluateRepairVideo(validVideo({ mediaType: 'mov' })).ok).toBe(true)
  })

  it('hard-rejects unsupported containers with platform-named reasons', () => {
    const avi = evaluateRepairVideo(validVideo({ mimeType: 'video/avi', mediaType: 'avi' }))
    expect(avi.ok).toBe(false)
    expect(avi.failures[0].rule).toBe('container')
    expect(avi.failures[0].message).toMatch(/Facebook and Instagram/)
    const unknown = evaluateRepairVideo(validVideo({ mimeType: null, mediaType: null }))
    expect(unknown.ok).toBe(false)
    expect(unknown.failures[0].rule).toBe('container')
  })

  it('hard-rejects narrow, dimensionless, and too-short videos', () => {
    const narrow = evaluateRepairVideo(validVideo({ width: 400, height: 800 }))
    expect(narrow.ok).toBe(false)
    expect(narrow.failures[0].rule).toBe('min-width')
    expect(narrow.failures[0].message).toMatch(/400px/)
    const nodims = evaluateRepairVideo(validVideo({ width: null, height: null }))
    expect(nodims.ok).toBe(false)
    expect(nodims.failures[0].rule).toBe('dimensions')
    const short = evaluateRepairVideo(validVideo({ durationSeconds: 0.5 }))
    expect(short.ok).toBe(false)
    expect(short.failures[0].rule).toBe('min-duration')
  })

  it('passes through unknown duration and unprobeable codecs without rejecting', () => {
    expect(evaluateRepairVideo(validVideo({ durationSeconds: null })).ok).toBe(true)
    expect(evaluateRepairVideo(validVideo({ durationSeconds: undefined })).ok).toBe(true)
    expect(evaluateRepairVideo(validVideo({ codecs: [] })).ok).toBe(true)
    expect(evaluateRepairVideo(validVideo({ codecs: null })).ok).toBe(true)
  })

  it('hard-rejects non-H264/HEVC codecs only when positively identified', () => {
    const bad = evaluateRepairVideo(validVideo({ codecs: ['vp09'] }))
    expect(bad.ok).toBe(false)
    expect(bad.failures[0].rule).toBe('codec')
    expect(evaluateRepairVideo(validVideo({ codecs: ['H264'] })).ok).toBe(true)
  })

  it('normalizes video containers across probe types and MIME types', () => {
    expect(normalizeRepairVideoContainer({ mediaType: 'MP4' })).toBe('mp4')
    expect(normalizeRepairVideoContainer({ mediaType: 'mov' })).toBe('mov')
    expect(normalizeRepairVideoContainer({ mimeType: 'video/quicktime' })).toBe('mov')
    expect(normalizeRepairVideoContainer({ mimeType: 'video/avi' })).toBeNull()
    expect(normalizeRepairVideoContainer({})).toBeNull()
  })

  it('hard-rejects oversized videos and skips the size rule when unknown', () => {
    const big = evaluateRepairVideo(validVideo({ sizeBytes: REPAIR_MAX_VIDEO_BYTES + 1 }))
    expect(big.ok).toBe(false)
    expect(big.failures[0].rule).toBe('max-size')
    expect(big.failures[0].message).toMatch(/Facebook and Instagram/)
    const unknownSize = evaluateRepairVideo(validVideo({ sizeBytes: null }))
    expect(unknownSize.ok).toBe(true)
    const atCap = evaluateRepairVideo(validVideo({ sizeBytes: REPAIR_MAX_VIDEO_BYTES }))
    expect(atCap.ok).toBe(true)
  })

  it('hard-rejects videos longer than the overall duration ceiling', () => {
    const tooLong = evaluateRepairVideo(validVideo({ durationSeconds: REPAIR_MAX_VIDEO_DURATION_SECONDS + 1 }))
    expect(tooLong.ok).toBe(false)
    expect(tooLong.failures[0].rule).toBe('max-duration')
    expect(tooLong.failures[0].message).toMatch(/Facebook and Instagram/)
    const atCap = evaluateRepairVideo(validVideo({ durationSeconds: REPAIR_MAX_VIDEO_DURATION_SECONDS }))
    expect(atCap.ok).toBe(true)
  })

  it('reports every violated video rule, not just the first', () => {
    const result = evaluateRepairVideo({
      mimeType: 'video/avi', mediaType: 'avi', width: 100, height: 100,
      durationSeconds: REPAIR_MAX_VIDEO_DURATION_SECONDS + 1, codecs: ['vp09'], sizeBytes: REPAIR_MAX_VIDEO_BYTES + 1,
    })
    expect(result.ok).toBe(false)
    expect(result.failures.map((f) => f.rule)).toEqual(['container', 'min-width', 'max-duration', 'max-size', 'codec'])
  })
})
