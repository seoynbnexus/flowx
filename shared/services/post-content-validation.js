import { ValidationError } from '../errors/AppError.js'

export const POST_VALIDATION_CODES = {
  CAPTION_NOT_SUPPORTED_FOR_STORY: 'CAPTION_NOT_SUPPORTED_FOR_STORY',
  CAPTION_TOO_LONG: 'CAPTION_TOO_LONG',
  TOO_MANY_HASHTAGS: 'TOO_MANY_HASHTAGS',
  TOO_MANY_MENTIONS: 'TOO_MANY_MENTIONS',
  MEDIA_REQUIRED: 'MEDIA_REQUIRED',
  MEDIA_TYPE_MISMATCH: 'MEDIA_TYPE_MISMATCH',
  MEDIA_FORMAT_UNSUPPORTED: 'MEDIA_FORMAT_UNSUPPORTED',
  MEDIA_TOO_LARGE: 'MEDIA_TOO_LARGE',
  MEDIA_TOO_SMALL: 'MEDIA_TOO_SMALL',
  MEDIA_ASPECT_RATIO: 'MEDIA_ASPECT_RATIO',
  MEDIA_DURATION: 'MEDIA_DURATION',
  MEDIA_FRAME_RATE: 'MEDIA_FRAME_RATE',
  MEDIA_RESOLUTION: 'MEDIA_RESOLUTION',
  MEDIA_CODEC: 'MEDIA_CODEC',
  MEDIA_SSRF_BLOCKED: 'MEDIA_SSRF_BLOCKED',
  MEDIA_INVALID: 'MEDIA_INVALID',
  MEDIA_UNAVAILABLE: 'MEDIA_UNAVAILABLE',
  URL_INVALID: 'URL_INVALID',
}

export class PostValidationError extends ValidationError {
  constructor(issues = []) {
    super('Post validation failed', issues, 'POST_VALIDATION_ERROR')
    this.name = 'PostValidationError'
    this.issues = issues
  }
}

const MB = 1024 * 1024

export const IMAGE_EXTENSIONS = {
  jpeg: ['.jpg', '.jpeg'],
  png: ['.png'],
  gif: ['.gif'],
  bmp: ['.bmp'],
  tiff: ['.tif', '.tiff'],
}

export const VIDEO_EXTENSIONS = {
  mp4: ['.mp4', '.m4v'],
  mov: ['.mov'],
  webm: ['.webm'],
}

export const FACEBOOK_VIDEO_EXTENSIONS = [
  '.3g2', '.3gp', '.3gpp', '.asf', '.avi', '.dat', '.divx', '.dv', '.f4v', '.flv',
  '.m2ts', '.m4v', '.mkv', '.mod', '.mov', '.mp4', '.mpe', '.mpeg', '.mpeg4', '.mpg',
  '.mts', '.mxf', '.nsv', '.ogm', '.ogv', '.qt', '.tod', '.ts', '.vob', '.wmv',
]

export const META_RULES = {
  instagram: {
    post: {
      media: ['image', 'video'],
      caption: { supported: true, maxLength: 2200, maxHashtags: 30, maxMentions: 20 },
      image: {
        formats: ['jpeg'],
        maxSizeBytes: 8 * MB,
        minWidth: 320,
        maxWidth: 1440,
        minAspect: 0.8,
        maxAspect: 1.91,
      },
      video: {
        formats: ['mp4', 'mov'],
        maxSizeBytes: 300 * MB,
        codecs: ['avc1', 'h264', 'hev1', 'hvc1'],
        maxBitDepth: 8,
        maxChromaSubsampling: '4:2:0',
        minDurationSeconds: 3,
        maxDurationSeconds: 900,
      },
    },
    reel: {
      media: ['video'],
      caption: { supported: true, maxLength: 2200, maxHashtags: 30, maxMentions: 20 },
      video: {
        formats: ['mp4', 'mov'],
        maxSizeBytes: 300 * MB,
        codecs: ['avc1', 'h264', 'hev1', 'hvc1'],
        maxBitDepth: 8,
        maxChromaSubsampling: '4:2:0',
        minDurationSeconds: 3,
        maxDurationSeconds: 900,
        warnDurationSeconds: 90,
      },
    },
    story: {
      media: ['image', 'video'],
      caption: { supported: false },
      image: {
        formats: ['jpeg'],
        maxSizeBytes: 8 * MB,
        minWidth: 320,
        maxWidth: 1440,
        minAspect: 0.8,
        maxAspect: 1.91,
      },
      video: {
        formats: ['mp4', 'mov'],
        maxSizeBytes: 100 * MB,
        codecs: ['avc1', 'h264', 'hev1', 'hvc1'],
        maxBitDepth: 8,
        maxChromaSubsampling: '4:2:0',
        minDurationSeconds: 3,
        maxDurationSeconds: 60,
      },
    },
  },
  facebook: {
    post: {
      media: ['image', 'video', 'none'],
      caption: { supported: true, maxLength: 63000 },
      image: {
        formats: ['jpeg', 'png', 'gif', 'bmp', 'tiff'],
        maxSizeBytes: 10 * MB,
      },
      video: {
        formats: ['mp4', 'mov', 'm4v', 'avi', 'wmv', 'mkv', 'flv', 'mpeg', 'mpg', 'ts', 'm2ts', 'mxf', '3gp', 'ogv'],
        maxSizeBytes: 10 * 1024 * MB,
        minDurationSeconds: 1,
        maxDurationSeconds: 2400,
      },
    },
    reel: {
      media: ['video'],
      caption: { supported: true, maxLength: 63000 },
      video: {
        formats: ['mp4'],
        maxSizeBytes: 10 * 1024 * MB,
        codecs: ['avc1', 'h264', 'hev1', 'hvc1'],
        minWidth: 540,
        minHeight: 960,
        minFps: 24,
        maxFps: 60,
        minDurationSeconds: 3,
        maxDurationSeconds: 90,
      },
    },
    story: {
      media: ['image', 'video'],
      caption: { supported: false },
      image: {
        formats: ['jpeg', 'png', 'gif', 'bmp', 'tiff'],
        maxSizeBytes: 10 * MB,
      },
      video: {
        formats: ['mp4', 'mov'],
        maxSizeBytes: 100 * MB,
        codecs: ['avc1', 'h264', 'hev1', 'hvc1'],
        maxBitDepth: 8,
        maxChromaSubsampling: '4:2:0',
        minDurationSeconds: 3,
        maxDurationSeconds: 60,
      },
    },
  },
}

export function countCodepoints(value) {
  if (!value) return 0
  return [...String(value)].length
}

export function countHashtags(value) {
  if (!value) return 0
  const matches = String(value).match(/#[\p{L}\p{N}_]+/gu)
  return matches ? matches.length : 0
}

export function countMentions(value) {
  if (!value) return 0
  const matches = String(value).match(/@[\p{L}\p{N}._]+/gu)
  return matches ? matches.length : 0
}

export function buildPostMessage(post) {
  const parts = []
  if (post.caption) parts.push(post.caption)
  if (post.textBody) parts.push(post.textBody)
  if (post.hashtags) parts.push(post.hashtags)
  return parts.join('\n\n').trim() || post.name
}

export function combinedCaptionLength(post) {
  return countCodepoints(buildPostMessage(post))
}

function urlExtension(url) {
  if (!url) return null
  try {
    const pathname = new URL(url).pathname
    const match = pathname.match(/\.([a-z0-9]{1,8})$/i)
    return match ? match[1].toLowerCase() : null
  } catch {
    return null
  }
}

export function isPublicHttpUrl(url) {
  if (!url || typeof url !== 'string') return false
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

export function formatHasExtension(url, extensions) {
  const ext = urlExtension(url)
  if (!ext) return null
  return extensions.includes(`.${ext}`)
}

export function inferMediaKind(url, contentType = null) {
  if (contentType) {
    if (contentType.startsWith('image/')) return 'image'
    if (contentType.startsWith('video/')) return 'video'
  }
  const ext = urlExtension(url)
  if (!ext) return null
  if (Object.values(IMAGE_EXTENSIONS).some(list => list.includes(`.${ext}`))) return 'image'
  if (Object.values(VIDEO_EXTENSIONS).some(list => list.includes(`.${ext}`)) || FACEBOOK_VIDEO_EXTENSIONS.includes(`.${ext}`)) return 'video'
  return null
}

function mediaRulesFor(platform, postType) {
  return META_RULES[platform]?.[postType] || null
}

function captionIssue({ platform, postType, target, field, code, message, actual, expected, severity = 'error' }) {
  return {
    target: target || null,
    platform,
    postType,
    field,
    code,
    severity,
    actual,
    expected,
    message,
  }
}

export function validatePostContent({ post, targets = [], mode = 'submit', mediaByTarget = {} } = {}) {
  const issues = []
  const postType = post.type || 'post'
  const hasCaptionContent = !!(post.caption || post.hashtags || post.textBody)

  const platformSet = new Set((targets.length ? targets : [{ platformCode: 'instagram' }, { platformCode: 'facebook' }]).map(t => t.platformCode))

  if (postType === 'story' && hasCaptionContent) {
    for (const platform of platformSet) {
      issues.push(captionIssue({
        platform,
        postType,
        field: 'caption',
        code: POST_VALIDATION_CODES.CAPTION_NOT_SUPPORTED_FOR_STORY,
        message: 'Captions, hashtags and text are not supported for stories — the story posts to the story tray with media only.',
        actual: 'caption content present',
        expected: 'no caption content',
      }))
    }
  }

  for (const target of targets) {
    const platform = target.platformCode
    const rules = mediaRulesFor(platform, postType)
    if (!rules) continue

    const caption = rules.caption
    if (caption && caption.supported) {
      const len = combinedCaptionLength(post)
      if (len > caption.maxLength) {
        issues.push(captionIssue({
          platform,
          postType,
          target: target.id,
          field: 'caption',
          code: POST_VALIDATION_CODES.CAPTION_TOO_LONG,
          message: `Combined caption is ${len} characters — max ${caption.maxLength} for ${platform} ${postType}`,
          actual: len,
          expected: caption.maxLength,
        }))
      }
      if (caption.maxHashtags != null && countHashtags(post.hashtags) > caption.maxHashtags) {
        issues.push(captionIssue({
          platform,
          postType,
          target: target.id,
          field: 'hashtags',
          code: POST_VALIDATION_CODES.TOO_MANY_HASHTAGS,
          message: `Post has ${countHashtags(post.hashtags)} hashtags — max ${caption.maxHashtags}`,
          actual: countHashtags(post.hashtags),
          expected: caption.maxHashtags,
        }))
      }
      if (caption.maxMentions != null && countMentions(buildPostMessage(post)) > caption.maxMentions) {
        issues.push(captionIssue({
          platform,
          postType,
          target: target.id,
          field: 'textBody',
          code: POST_VALIDATION_CODES.TOO_MANY_MENTIONS,
          message: `Post mentions ${countMentions(buildPostMessage(post))} accounts — max ${caption.maxMentions}`,
          actual: countMentions(buildPostMessage(post)),
          expected: caption.maxMentions,
        }))
      }
    }

    if (postType !== 'story' && postType !== 'reel' && !post.mediaUrl && rules.media.includes('none')) continue

    if (!post.mediaUrl) {
      if (rules.media.includes('image') || rules.media.includes('video')) {
        issues.push(captionIssue({
          platform,
          postType,
          target: target.id,
          field: 'mediaUrl',
          code: POST_VALIDATION_CODES.MEDIA_REQUIRED,
          message: `${platform} ${postType} posts require a media URL`,
          actual: null,
          expected: 'media URL',
        }))
      }
      continue
    }

    if (!isPublicHttpUrl(post.mediaUrl)) {
      issues.push(captionIssue({
        platform,
        postType,
        target: target.id,
        field: 'mediaUrl',
        code: POST_VALIDATION_CODES.URL_INVALID,
        message: 'Media URL must be an absolute http(s) URL',
        actual: post.mediaUrl,
        expected: 'http(s) URL',
      }))
      continue
    }

    const mediaReport = mode === 'publish' ? mediaByTarget[target.id] : null

    if (mediaReport && mediaReport.blocked) {
      issues.push(captionIssue({
        platform,
        postType,
        target: target.id,
        field: 'mediaUrl',
        code: POST_VALIDATION_CODES.MEDIA_SSRF_BLOCKED,
        message: 'Media URL resolves to a private or restricted address and was blocked',
        actual: mediaReport.blockedReason || 'blocked',
        expected: 'public address',
      }))
      continue
    }

    const allowedMedia = rules.media
    const kind = inferMediaKind(post.mediaUrl, mediaReport?.contentType || null)
    if (allowedMedia.length === 1 && allowedMedia[0] !== 'none' && kind && !allowedMedia.includes(kind)) {
      issues.push(captionIssue({
        platform,
        postType,
        target: target.id,
        field: 'mediaUrl',
        code: POST_VALIDATION_CODES.MEDIA_TYPE_MISMATCH,
        message: `${platform} ${postType} posts only support ${allowedMedia.join(' and ')} — got ${kind}`,
        actual: kind,
        expected: allowedMedia.join(' or '),
      }))
    }

    const mediaKind = kind || (mediaReport?.probe?.kind || null)
    if (mediaReport && mediaReport.probe && mediaReport.probe.status === 'invalid') {
      issues.push(captionIssue({
        platform,
        postType,
        target: target.id,
        field: 'mediaUrl',
        code: POST_VALIDATION_CODES.MEDIA_INVALID,
        message: `Media file is invalid or unsupported: ${mediaReport.probe.reason || 'malformed media'}`,
        actual: mediaReport.probe.reason || 'invalid',
        expected: 'valid media container',
      }))
      continue
    }

    if (mediaReport && mediaReport.size === 'KNOWN_TOO_LARGE' && mediaReport.sizeBytes != null) {
      const sizeRule = mediaKind === 'image' ? rules.image : rules.video
      if (sizeRule?.maxSizeBytes != null && mediaReport.sizeBytes > sizeRule.maxSizeBytes) {
        issues.push(captionIssue({
          platform,
          postType,
          target: target.id,
          field: 'mediaUrl',
          code: POST_VALIDATION_CODES.MEDIA_TOO_LARGE,
          message: `Media is ${Math.round(mediaReport.sizeBytes / MB)}MB — max ${sizeRule.maxSizeBytes / MB}MB`,
          actual: mediaReport.sizeBytes,
          expected: sizeRule.maxSizeBytes,
          severity: 'warning',
        }))
      }
    }

    if (mediaReport && mediaReport.probe && mediaReport.probe.status === 'valid') {
      const rulesForKind = mediaKind === 'image' ? rules.image : rules.video
      if (rulesForKind) {
        applyProbeIssues(issues, { platform, postType, target: target.id, rules: rulesForKind, probe: mediaReport.probe })
      }
    }
  }

  if (issues.some(i => i.severity === 'error')) {
    throw new PostValidationError(issues)
  }
  return { issues, valid: !issues.some(i => i.severity === 'error') }
}

function applyProbeIssues(issues, { platform, postType, target, rules, probe }) {
  const push = (code, message, actual, expected, severity = 'warning') => {
    issues.push({
      target,
      platform,
      postType,
      field: 'mediaUrl',
      code,
      severity,
      actual,
      expected,
      message,
    })
  }

  if (rules.maxSizeBytes && probe.sizeBytes != null && probe.sizeBytes > rules.maxSizeBytes) {
    push(
      POST_VALIDATION_CODES.MEDIA_TOO_LARGE,
      `Media is ${Math.round(probe.sizeBytes / MB)}MB — max ${rules.maxSizeBytes / MB}MB`,
      probe.sizeBytes,
      rules.maxSizeBytes,
    )
  }
  if (rules.minWidth != null && probe.width != null && probe.width < rules.minWidth) {
    push(
      POST_VALIDATION_CODES.MEDIA_TOO_SMALL,
      `Media width ${probe.width}px is below the ${rules.minWidth}px minimum`,
      probe.width,
      rules.minWidth,
    )
  }
  if (rules.maxWidth != null && probe.width != null && probe.width > rules.maxWidth) {
    push(
      POST_VALIDATION_CODES.MEDIA_RESOLUTION,
      `Media width ${probe.width}px exceeds the ${rules.maxWidth}px maximum`,
      probe.width,
      rules.maxWidth,
    )
  }
  if (rules.minHeight != null && probe.height != null && probe.height < rules.minHeight) {
    push(
      POST_VALIDATION_CODES.MEDIA_TOO_SMALL,
      `Media height ${probe.height}px is below the ${rules.minHeight}px minimum`,
      probe.height,
      rules.minHeight,
    )
  }
  if (rules.minAspect != null && probe.aspect != null && probe.aspect < rules.minAspect) {
    push(
      POST_VALIDATION_CODES.MEDIA_ASPECT_RATIO,
      `Aspect ratio ${probe.aspect.toFixed(2)} is below the ${rules.minAspect} minimum (4:5)`,
      probe.aspect,
      rules.minAspect,
    )
  }
  if (rules.maxAspect != null && probe.aspect != null && probe.aspect > rules.maxAspect) {
    push(
      POST_VALIDATION_CODES.MEDIA_ASPECT_RATIO,
      `Aspect ratio ${probe.aspect.toFixed(2)} exceeds the ${rules.maxAspect} maximum (1.91:1)`,
      probe.aspect,
      rules.maxAspect,
    )
  }
  if (rules.minDurationSeconds != null && probe.durationSeconds != null && probe.durationSeconds < rules.minDurationSeconds) {
    push(
      POST_VALIDATION_CODES.MEDIA_DURATION,
      `Video is ${probe.durationSeconds}s — min ${rules.minDurationSeconds}s`,
      probe.durationSeconds,
      rules.minDurationSeconds,
    )
  }
  if (rules.maxDurationSeconds != null && probe.durationSeconds != null && probe.durationSeconds > rules.maxDurationSeconds) {
    push(
      POST_VALIDATION_CODES.MEDIA_DURATION,
      `Video is ${probe.durationSeconds}s — max ${rules.maxDurationSeconds}s`,
      probe.durationSeconds,
      rules.maxDurationSeconds,
    )
  }
  if (rules.minFps != null && probe.fps != null && probe.fps < rules.minFps) {
    push(
      POST_VALIDATION_CODES.MEDIA_FRAME_RATE,
      `Frame rate ${probe.fps}fps is below the ${rules.minFps}fps minimum`,
      probe.fps,
      rules.minFps,
    )
  }
  if (rules.maxFps != null && probe.fps != null && probe.fps > rules.maxFps) {
    push(
      POST_VALIDATION_CODES.MEDIA_FRAME_RATE,
      `Frame rate ${probe.fps}fps exceeds the ${rules.maxFps}fps maximum`,
      probe.fps,
      rules.maxFps,
    )
  }
  if (rules.codecs && probe.codecs && probe.codecs.length) {
    const unsupported = probe.codecs.filter(c => !rules.codecs.includes(c))
    if (unsupported.length) {
      push(
        POST_VALIDATION_CODES.MEDIA_CODEC,
        `Video codec ${unsupported.join(', ')} is not supported (use ${rules.codecs.join(' or ')})`,
        unsupported.join(', '),
        rules.codecs.join(' or '),
      )
    }
  }
  if (rules.maxBitDepth != null && probe.bitDepth != null && probe.bitDepth > rules.maxBitDepth) {
    push(
      POST_VALIDATION_CODES.MEDIA_CODEC,
      `Video bit depth ${probe.bitDepth} is not supported (max ${rules.maxBitDepth})`,
      probe.bitDepth,
      rules.maxBitDepth,
    )
  }
}
