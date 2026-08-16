import { describe, it, expect } from 'vitest'
import {
  buildPostMessage,
  combinedCaptionLength,
  countCodepoints,
  countHashtags,
  countMentions,
  inferMediaKind,
  isPublicHttpUrl,
  validatePostContent,
  PostValidationError,
  POST_VALIDATION_CODES,
} from '../../shared/services/post-content-validation.js'
import { probeMedia } from '../../shared/services/media-probe.js'

const IG = { id: 't1', platformCode: 'instagram' }
const FB = { id: 't2', platformCode: 'facebook' }

function u16(n) {
  const b = Buffer.alloc(2)
  b.writeUInt16BE(n, 0)
  return b
}

function u32(n) {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n, 0)
  return b
}

function probedMediaReport(buffer) {
  return probeMedia(buffer)
}

function post(overrides = {}) {
  return {
    id: 'p1',
    name: 'My post',
    type: 'post',
    caption: 'Hello world',
    mediaUrl: 'https://cdn.example.com/media.jpg',
    ...overrides,
  }
}

describe('buildPostMessage', () => {
  it('joins caption, textBody and hashtags with blank lines', () => {
    const msg = buildPostMessage({ caption: 'a', textBody: 'b', hashtags: '#x #y' })
    expect(msg).toBe('a\n\nb\n\n#x #y')
  })

  it('falls back to the post name', () => {
    expect(buildPostMessage({ name: 'Fallback' })).toBe('Fallback')
  })
})

describe('counters', () => {
  it('counts codepoints (emoji = 1)', () => {
    expect(countCodepoints('abc😀')).toBe(4)
  })

  it('counts hashtags', () => {
    expect(countHashtags('#one #two_and #three123')).toBe(3)
  })

  it('counts mentions', () => {
    expect(countMentions('@user1 @user2.two')).toBe(2)
  })
})

describe('inferMediaKind', () => {
  it('infers by extension', () => {
    expect(inferMediaKind('https://x.com/a.jpg')).toBe('image')
    expect(inferMediaKind('https://x.com/a.mp4')).toBe('video')
    expect(inferMediaKind('https://x.com/a.png?w=100')).toBe('image')
  })

  it('prefers content-type over extension', () => {
    expect(inferMediaKind('https://x.com/a.jpg', 'video/mp4')).toBe('video')
    expect(inferMediaKind('https://x.com/noext', 'image/png')).toBe('image')
  })

  it('returns null for unknown', () => {
    expect(inferMediaKind('https://x.com/a.unknownext')).toBeNull()
  })
})

describe('isPublicHttpUrl', () => {
  it('accepts http and https', () => {
    expect(isPublicHttpUrl('https://cdn.example.com/a.jpg')).toBe(true)
    expect(isPublicHttpUrl('http://cdn.example.com/a.jpg')).toBe(true)
  })

  it('rejects non-http schemes and garbage', () => {
    expect(isPublicHttpUrl('file:///etc/passwd')).toBe(false)
    expect(isPublicHttpUrl('ftp://x.com/a.jpg')).toBe(false)
    expect(isPublicHttpUrl('not a url')).toBe(false)
    expect(isPublicHttpUrl(null)).toBe(false)
  })
})

describe('validatePostContent: submit mode', () => {
  it('passes a valid IG post with image', () => {
    const result = validatePostContent({ post: post({ type: 'post' }), targets: [IG] })
    expect(result.valid).toBe(true)
  })

  it('rejects story posts that carry caption content', () => {
    expect(() =>
      validatePostContent({ post: post({ type: 'story', caption: 'nope' }), targets: [IG, FB] })
    ).toThrow(PostValidationError)
  })

  it('emits CAPTION_NOT_SUPPORTED_FOR_STORY for each platform', () => {
    try {
      validatePostContent({ post: post({ type: 'story', caption: 'nope' }), targets: [IG, FB] })
    } catch (err) {
      const codes = err.issues.map(i => i.code)
      expect(codes).toEqual([POST_VALIDATION_CODES.CAPTION_NOT_SUPPORTED_FOR_STORY, POST_VALIDATION_CODES.CAPTION_NOT_SUPPORTED_FOR_STORY])
      expect(err.statusCode).toBe(422)
      expect(err.code).toBe('POST_VALIDATION_ERROR')
    }
  })

  it('rejects a reel with image media', () => {
    expect(() =>
      validatePostContent({ post: post({ type: 'reel', mediaUrl: 'https://x.com/a.jpg' }), targets: [IG] })
    ).toThrow(PostValidationError)
  })

  it('accepts a reel with video media', () => {
    const result = validatePostContent({ post: post({ type: 'reel', mediaUrl: 'https://x.com/a.mp4' }), targets: [IG] })
    expect(result.valid).toBe(true)
  })

  it('rejects missing media where required', () => {
    expect(() =>
      validatePostContent({ post: post({ type: 'post', mediaUrl: null }), targets: [IG] })
    ).toThrow(PostValidationError)
  })

  it('allows text-only FB posts', () => {
    const result = validatePostContent({ post: post({ type: 'post', mediaUrl: null }), targets: [FB] })
    expect(result.valid).toBe(true)
  })

  it('rejects non-http media URLs', () => {
    expect(() =>
      validatePostContent({ post: post({ mediaUrl: 'C:\\evil\\x.jpg' }), targets: [IG] })
    ).toThrow(PostValidationError)
  })

  it('rejects captions over the IG limit', () => {
    expect(() =>
      validatePostContent({ post: post({ caption: 'x'.repeat(2201) }), targets: [IG] })
    ).toThrow(PostValidationError)
  })

  it('rejects too many hashtags for IG', () => {
    const tags = Array.from({ length: 31 }, (_, i) => `#tag${i}`).join(' ')
    expect(() =>
      validatePostContent({ post: post({ hashtags: tags }), targets: [IG] })
    ).toThrow(PostValidationError)
  })

  it('rejects too many mentions for IG', () => {
    const mentions = Array.from({ length: 21 }, (_, i) => `@user${i}`).join(' ')
    expect(() =>
      validatePostContent({ post: post({ textBody: mentions }), targets: [IG] })
    ).toThrow(PostValidationError)
  })
})

describe('validatePostContent: publish mode', () => {
  it('reports SSRF-blocked media', () => {
    expect(() =>
      validatePostContent({
        post: post({ type: 'post' }),
        targets: [IG],
        mode: 'publish',
        mediaByTarget: { t1: { blocked: true, blockedReason: 'private-ip' } },
      })
    ).toThrow(PostValidationError)
  })

  it('reports invalid probe results', () => {
    try {
      validatePostContent({
        post: post({ type: 'reel', mediaUrl: 'https://x.com/a.mp4' }),
        targets: [IG],
        mode: 'publish',
        mediaByTarget: { t1: { probe: { status: 'invalid', reason: 'no moov' } } },
      })
    } catch (err) {
      expect(err.issues.some(i => i.code === POST_VALIDATION_CODES.MEDIA_INVALID)).toBe(true)
    }
  })

  it('warns on known-too-large size without blocking', () => {
    const result = validatePostContent({
      post: post({ type: 'post' }),
      targets: [IG],
      mode: 'publish',
      mediaByTarget: { t1: { size: 'KNOWN_TOO_LARGE', sizeBytes: 10 * 1024 * 1024 } },
    })
    expect(result.valid).toBe(true)
    const issue = result.issues.find(i => i.code === POST_VALIDATION_CODES.MEDIA_TOO_LARGE)
    expect(issue).toBeDefined()
    expect(issue.severity).toBe('warning')
  })

  it('does not flag KNOWN_TOO_LARGE within the platform size limit (probe cap vs platform rule)', () => {
    const result = validatePostContent({
      post: post({ type: 'post' }),
      targets: [IG],
      mode: 'publish',
      mediaByTarget: { t1: { size: 'KNOWN_TOO_LARGE', sizeBytes: 5 * 1024 * 1024 } },
    })
    expect(result.valid).toBe(true)
    expect(result.issues.some(i => i.code === POST_VALIDATION_CODES.MEDIA_TOO_LARGE)).toBe(false)
  })

  it('does not flag KNOWN_TOO_LARGE with unknown size (non-blocking)', () => {
    const result = validatePostContent({
      post: post({ type: 'post' }),
      targets: [IG],
      mode: 'publish',
      mediaByTarget: { t1: { size: 'KNOWN_TOO_LARGE', sizeBytes: null } },
    })
    expect(result.valid).toBe(true)
    expect(result.issues.some(i => i.code === POST_VALIDATION_CODES.MEDIA_TOO_LARGE)).toBe(false)
  })

  it('warns on KNOWN_TOO_LARGE exceeding the platform size limit without blocking', () => {
    const result = validatePostContent({
      post: post({ type: 'post' }),
      targets: [IG],
      mode: 'publish',
      mediaByTarget: { t1: { size: 'KNOWN_TOO_LARGE', sizeBytes: 20 * 1024 * 1024 } },
    })
    expect(result.valid).toBe(true)
    const issue = result.issues.find(i => i.code === POST_VALIDATION_CODES.MEDIA_TOO_LARGE)
    expect(issue).toBeDefined()
    expect(issue.severity).toBe('warning')
  })

  it('warns on probe-dimension violations without blocking (too small for FB reel)', () => {
    const result = validatePostContent({
      post: post({ type: 'reel', mediaUrl: 'https://x.com/a.mp4' }),
      targets: [FB],
      mode: 'publish',
      mediaByTarget: {
        t2: { probe: { status: 'valid', kind: 'video', width: 320, height: 480, durationSeconds: 30, codecs: ['avc1'], sizeBytes: 1000 } },
      },
    })
    expect(result.valid).toBe(true)
    const issue = result.issues.find(i => i.code === POST_VALIDATION_CODES.MEDIA_TOO_SMALL)
    expect(issue).toBeDefined()
    expect(issue.severity).toBe('warning')
  })

  it('treats unknown probe results as non-blocking', () => {
    const result = validatePostContent({
      post: post({ type: 'post' }),
      targets: [IG],
      mode: 'publish',
      mediaByTarget: { t1: { probe: { status: 'unknown' } } },
    })
    expect(result.valid).toBe(true)
  })
})

describe('publish-mode end-to-end with real probed media', () => {
  function realJpegBuffer({ width = 1080, height = 1350 } = {}) {
    const parts = [Buffer.from([0xff, 0xd8])]
    const sof = Buffer.concat([
      Buffer.from([0x08]),
      u16(height),
      u16(width),
      Buffer.from([0x01]),
      Buffer.from([0x11]),
      Buffer.from([0x00]),
    ])
    parts.push(Buffer.from([0xff, 0xc0]), u16(sof.length + 2), sof)
    const sosParams = Buffer.from([0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00])
    parts.push(Buffer.from([0xff, 0xda]), u16(sosParams.length + 2), sosParams)
    parts.push(Buffer.from([0xab, 0xcd, 0xff, 0x00, 0x12, 0xff, 0xd0, 0x55, 0x99]))
    parts.push(Buffer.from([0xff, 0xd9]))
    return Buffer.concat(parts)
  }

  it('passes a realistic probed JPEG through IG post publish-mode validation', () => {
    const report = probedMediaReport(realJpegBuffer())
    expect(report.status).toBe('valid')
    const result = validatePostContent({
      post: post({ type: 'post', mediaUrl: 'https://cdn.example.com/media.jpg' }),
      targets: [IG],
      mode: 'publish',
      mediaByTarget: { t1: { probe: report, size: 'KNOWN_VALID', sizeBytes: report.sizeBytes } },
    })
    expect(result.valid).toBe(true)
  })

  it('surfaces too-small dimensions from a real probed JPEG for IG image posts', () => {
    const parts = [Buffer.from([0xff, 0xd8])]
    const sof = Buffer.concat([
      Buffer.from([0x08]),
      u16(100),
      u16(80),
      Buffer.from([0x01]),
      Buffer.from([0x11]),
      Buffer.from([0x00]),
    ])
    parts.push(Buffer.from([0xff, 0xc0]), u16(sof.length + 2), sof)
    const sosParams = Buffer.from([0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00])
    parts.push(Buffer.from([0xff, 0xda]), u16(sosParams.length + 2), sosParams)
    parts.push(Buffer.from([0xab, 0xcd, 0xff, 0x00, 0x12, 0xff, 0xd0, 0x55, 0x99]))
    parts.push(Buffer.from([0xff, 0xd9]))
    const small = Buffer.concat(parts)
    const report = probedMediaReport(small)
    expect(report.status).toBe('valid')
    expect(report.width).toBe(80)
    expect(report.height).toBe(100)
    const result = validatePostContent({
      post: post({ type: 'post', mediaUrl: 'https://cdn.example.com/small.jpg' }),
      targets: [IG],
      mode: 'publish',
      mediaByTarget: { t1: { probe: report, size: 'KNOWN_VALID', sizeBytes: report.sizeBytes } },
    })
    expect(result.valid).toBe(true)
    expect(result.issues.some(i => i.code === POST_VALIDATION_CODES.MEDIA_TOO_SMALL && i.severity === 'warning')).toBe(true)
  })
})

describe('combinedCaptionLength', () => {
  it('measures the combined message (caption + blank line + body)', () => {
    expect(combinedCaptionLength({ caption: 'a', textBody: 'b' })).toBe(4)
  })
})