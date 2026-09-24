const REPAIR_IMAGE_FORMATS = ['jpeg', 'png', 'gif', 'webp']

const REPAIR_IMAGE_MIME_TO_FORMAT = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

export const REPAIR_IMAGE_MAX_BYTES = 30 * 1024 * 1024
export const REPAIR_MIN_IMAGE_WIDTH_PX = 500
export const REPAIR_VIDEO_CONTAINERS = ['mp4', 'mov']
export const REPAIR_VIDEO_CODECS = ['avc1', 'h264', 'hev1', 'hvc1']
export const REPAIR_MIN_VIDEO_DURATION_SECONDS = 1
export const REPAIR_MIN_VIDEO_WIDTH_PX = 500
export const REPAIR_MAX_VIDEO_BYTES = 4 * 1024 * 1024 * 1024 // 4GB — Meta's documented ad-wide ceiling
export const REPAIR_MAX_VIDEO_DURATION_SECONDS = 240 * 60 // 240 minutes

export function normalizeRepairImageFormat({ mimeType = null, mediaType = null } = {}) {
  if (mediaType && REPAIR_IMAGE_FORMATS.includes(String(mediaType).toLowerCase())) {
    return String(mediaType).toLowerCase()
  }
  if (mimeType && REPAIR_IMAGE_MIME_TO_FORMAT[String(mimeType).toLowerCase()]) {
    return REPAIR_IMAGE_MIME_TO_FORMAT[String(mimeType).toLowerCase()]
  }
  return null
}

export function evaluateRepairImage({ mimeType = null, mediaType = null, width = null, height = null, sizeBytes = null } = {}) {
  const failures = []
  const fail = (rule, message) => {
    failures.push({ rule, message })
    return false
  }
  const format = normalizeRepairImageFormat({ mimeType, mediaType })
  if (!format) {
    fail(
      'format',
      'Facebook and Instagram ads accept JPEG, PNG, GIF, or WebP images — this file is not a supported image format.'
    )
  }
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    fail(
      'dimensions',
      'Facebook and Instagram could not determine this image\u2019s dimensions — upload an image with measurable dimensions.'
    )
  } else if (width < REPAIR_MIN_IMAGE_WIDTH_PX) {
    fail(
      'min-width',
      `Image is ${width}px wide — Facebook and Instagram require images at least ${REPAIR_MIN_IMAGE_WIDTH_PX}px wide for ads delivery.`
    )
  }
  if (Number.isFinite(sizeBytes) && sizeBytes > REPAIR_IMAGE_MAX_BYTES) {
    fail(
      'max-size',
      `Image is ${(sizeBytes / (1024 * 1024)).toFixed(1)} MB — Facebook and Instagram cap ad images at ${REPAIR_IMAGE_MAX_BYTES / (1024 * 1024)} MB.`
    )
  }
  return { ok: failures.length === 0, format, failures }
}

export function normalizeRepairVideoContainer({ mimeType = null, mediaType = null } = {}) {
  const type = String(mediaType || '').toLowerCase()
  if (REPAIR_VIDEO_CONTAINERS.includes(type)) return type
  const mime = String(mimeType || '').toLowerCase()
  if (mime === 'video/mp4') return 'mp4'
  if (mime === 'video/quicktime') return 'mov'
  return null
}

export function evaluateRepairVideo({
  mimeType = null,
  mediaType = null,
  width = null,
  height = null,
  durationSeconds = null,
  codecs = null,
  sizeBytes = null,
} = {}) {
  const failures = []
  const fail = (rule, message) => {
    failures.push({ rule, message })
    return false
  }
  const container = normalizeRepairVideoContainer({ mimeType, mediaType })
  if (!container) {
    fail(
      'container',
      'Facebook and Instagram ads accept MP4 or MOV videos — this file is not a supported video container.'
    )
  }
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    fail(
      'dimensions',
      'Facebook and Instagram could not determine this video\u2019s dimensions — use a video with measurable dimensions.'
    )
  } else if (width < REPAIR_MIN_VIDEO_WIDTH_PX) {
    fail(
      'min-width',
      `Video is ${width}px wide — Facebook and Instagram require videos at least ${REPAIR_MIN_VIDEO_WIDTH_PX}px wide for ads delivery.`
    )
  }
  if (durationSeconds !== null && durationSeconds !== undefined) {
    if (!Number.isFinite(durationSeconds)) {
      fail(
        'duration',
        'Facebook and Instagram could not determine this video\u2019s duration.'
      )
    } else if (durationSeconds < REPAIR_MIN_VIDEO_DURATION_SECONDS) {
      fail(
        'min-duration',
        `Video is ${durationSeconds.toFixed(1)}s long — Facebook and Instagram require ad videos at least ${REPAIR_MIN_VIDEO_DURATION_SECONDS}s long.`
      )
    } else if (durationSeconds > REPAIR_MAX_VIDEO_DURATION_SECONDS) {
      fail(
        'max-duration',
        `Video is ${(durationSeconds / 60).toFixed(1)} minutes long — Facebook and Instagram cap ad videos at ${REPAIR_MAX_VIDEO_DURATION_SECONDS / 60} minutes.`
      )
    }
  }
  if (Number.isFinite(sizeBytes) && sizeBytes > REPAIR_MAX_VIDEO_BYTES) {
    fail(
      'max-size',
      `Video is ${(sizeBytes / (1024 * 1024 * 1024)).toFixed(2)} GB — Facebook and Instagram cap ad videos at ${REPAIR_MAX_VIDEO_BYTES / (1024 * 1024 * 1024)} GB.`
    )
  }
  if (Array.isArray(codecs) && codecs.length > 0) {
    const known = codecs.map((c) => String(c).toLowerCase())
    if (!known.some((c) => REPAIR_VIDEO_CODECS.includes(c))) {
      fail(
        'codec',
        'Facebook and Instagram require H.264 or HEVC video — this file uses an unsupported codec.'
      )
    }
  }
  return { ok: failures.length === 0, container, failures }
}
