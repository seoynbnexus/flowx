import { fetchBoundedBytes, inspectMediaSize } from './media-url.js'
import { probeMedia } from './media-probe.js'
import { evaluateRepairImage, evaluateRepairVideo, REPAIR_MAX_VIDEO_BYTES } from './repair-media-criteria.js'
import { instagramAppliesToPlacement, checkInstagramImageWidth, videoSpecForPlacement } from './meta-issue-catalog.js'

export const META_CALL_TO_ACTION_TYPES = [
  'LEARN_MORE',
  'SHOP_NOW',
  'SIGN_UP',
  'CONTACT_US',
  'GET_OFFER',
  'DOWNLOAD',
  'SUBSCRIBE',
  'BOOK_TRAVEL',
  'APPLY_NOW',
  'CALL_NOW',
  'BUY_NOW',
  'WHATSAPP_MESSAGE',
  'NO_BUTTON',
]

// retryable: true — this is a "we couldn't fetch/probe it THIS time" result
// (network error, timeout, DNS hiccup, momentarily-slow host), never "this
// file is wrong." A caller that treats every gate failure as permanent turns
// an ordinary transient blip into a dead job requiring manual intervention —
// the message's own "please retry" wording only means something if callers
// actually honor this flag.
const UNVERIFIABLE = {
  ok: false,
  errorCode: 'MEDIA_UNVERIFIABLE',
  retryable: true,
  message: 'Could not verify media before publishing — please retry or contact support.',
}

// Same test-environment seam as post.service.js:postMediaProbe — off by default
// under NODE_ENV=test so the network-touching media probe never runs against
// the many existing campaign tests that use placeholder mediaUrl values;
// individual test files opt back in with adMediaGate.enabled = true.
export const adMediaGate = {
  enabled: process.env.NODE_ENV !== 'test' && process.env.AD_CONTENT_MEDIA_GATE !== '0',
}

// Bounds how many bytes we actually download to probe format/dimensions/
// duration — deliberately larger than REPAIR_IMAGE_MAX_BYTES (30MB) so a
// legitimate ad image is never truncated before its real size is known, and
// generous enough to contain the moov/mvhd/tkhd/stsd boxes of the vast
// majority of real-world ad videos. This is NOT the real max-file-size gate
// for video (see the HEAD-based check in checkAdMediaForMeta) — a multi-GB
// size cap can never fire off a bounded download this small.
export const adMediaProbeLimits = {
  maxBytes: Number(process.env.AD_MEDIA_PROBE_MAX_BYTES) || 40 * 1024 * 1024,
  timeoutMs: Number(process.env.AD_MEDIA_PROBE_TIMEOUT_MS) || 20000,
}

function truncatedFailure() {
  const mb = Math.round(adMediaProbeLimits.maxBytes / (1024 * 1024))
  return {
    ok: false,
    errorCode: 'MEDIA_TRUNCATED',
    // Genuinely could go either way (a real oversized/non-fast-start file
    // will keep failing; a slow host that didn't finish the download in time
    // might succeed on a later attempt) — err toward retryable so a slow
    // network doesn't permanently kill the job over what re-encoding advice
    // implies is often a one-off transfer issue, not a content problem.
    retryable: true,
    message: `Could not fully download this file to verify it (it exceeds our ${mb}MB verification limit, or its metadata isn't near the front of the file) — re-encode video with the moov atom first ("fast start") or reduce file size, then retry.`,
  }
}

export function isValidCallToAction(value) {
  if (value === null || value === undefined || value === '') return true
  return META_CALL_TO_ACTION_TYPES.includes(value)
}

export function checkCallToAction(callToAction) {
  if (isValidCallToAction(callToAction)) return null
  return {
    ok: false,
    errorCode: 'invalid-cta',
    message: `"${callToAction}" is not a supported call-to-action for Meta ads.`,
  }
}

export async function checkAdMediaForMeta({ mediaUrl, platformPlacement } = {}) {
  if (!mediaUrl) return null
  if (!adMediaGate.enabled) return null

  // Cheap real-size gate via HEAD/Content-Length, before downloading any body
  // bytes — the only way to enforce a multi-GB video size cap without
  // actually downloading gigabytes. Best-effort: many hosts omit
  // Content-Length on HEAD, so anything other than a confirmed too-large
  // result falls through to the bounded fetch+probe below unchanged.
  try {
    const sizeCheck = await inspectMediaSize(mediaUrl, { maxBytes: REPAIR_MAX_VIDEO_BYTES })
    if (sizeCheck.status === 'KNOWN_TOO_LARGE') {
      return {
        ok: false,
        errorCode: 'max-size',
        message: `File is ${(sizeCheck.sizeBytes / (1024 * 1024 * 1024)).toFixed(2)} GB — Facebook and Instagram cap ad videos at ${REPAIR_MAX_VIDEO_BYTES / (1024 * 1024 * 1024)} GB.`,
      }
    }
  } catch {
    return UNVERIFIABLE
  }

  let fetched
  try {
    fetched = await fetchBoundedBytes(mediaUrl, { maxBytes: adMediaProbeLimits.maxBytes, timeoutMs: adMediaProbeLimits.timeoutMs })
  } catch {
    return UNVERIFIABLE
  }
  if (!fetched?.bytes?.length) return UNVERIFIABLE

  let probed
  try {
    probed = probeMedia(fetched.bytes)
  } catch {
    return UNVERIFIABLE
  }
  if (probed?.status !== 'valid') return fetched.truncated ? truncatedFailure() : UNVERIFIABLE

  if (probed.kind === 'video') {
    const video = evaluateRepairVideo({
      mediaType: probed.mediaType,
      width: probed.width,
      height: probed.height,
      durationSeconds: probed.durationSeconds ?? null,
      codecs: probed.codecs ?? null,
      sizeBytes: fetched.bytes.length,
    })
    if (!video.ok) {
      return {
        ok: false,
        errorCode: video.failures[0].rule,
        message: video.failures[0].message,
        width: probed.width,
        height: probed.height,
        durationSeconds: probed.durationSeconds ?? null,
      }
    }
    const spec = videoSpecForPlacement(platformPlacement)
    if (spec) {
      if (Number.isFinite(probed.durationSeconds) && probed.durationSeconds > spec.maxDurationSeconds) {
        return {
          ok: false,
          errorCode: 'placement-max-duration',
          message: `Video is ${probed.durationSeconds.toFixed(1)}s long — Meta ${spec.surface} ads must be ${spec.maxDurationSeconds}s or shorter.`,
          width: probed.width, height: probed.height, durationSeconds: probed.durationSeconds,
        }
      }
      if ((Number.isFinite(probed.width) && probed.width < spec.minWidth) || (Number.isFinite(probed.height) && probed.height < spec.minHeight)) {
        return {
          ok: false,
          errorCode: 'placement-min-dimensions',
          message: `Video is ${probed.width}x${probed.height}px — Meta ${spec.surface} ads require at least ${spec.minWidth}x${spec.minHeight}px.`,
          width: probed.width, height: probed.height, durationSeconds: probed.durationSeconds ?? null,
        }
      }
      if (Number.isFinite(probed.aspect) && probed.aspect > spec.maxAspect) {
        return {
          ok: false,
          errorCode: 'placement-orientation',
          message: `Video is landscape/square (aspect ${probed.aspect.toFixed(2)}) — Meta ${spec.surface} ads require a vertical/portrait video.`,
          width: probed.width, height: probed.height, durationSeconds: probed.durationSeconds ?? null,
        }
      }
    }
    return null
  }

  if (probed.kind === 'image') {
    const image = evaluateRepairImage({
      mediaType: probed.mediaType,
      width: probed.width,
      height: probed.height,
      sizeBytes: fetched.bytes.length,
    })
    if (!image.ok) {
      return {
        ok: false,
        errorCode: image.failures[0].rule,
        message: image.failures[0].message,
        width: probed.width,
        height: probed.height,
      }
    }
    if (instagramAppliesToPlacement(platformPlacement)) {
      const igGate = checkInstagramImageWidth(probed.width)
      if (!igGate.ok) {
        return { ok: false, errorCode: igGate.errorCode, message: igGate.message, width: probed.width, height: probed.height }
      }
    }
    return null
  }

  return UNVERIFIABLE
}

export async function checkAdContentForMeta({ creative, metaSettings } = {}) {
  const ctaFailure = checkCallToAction(creative?.callToAction)
  if (ctaFailure) return ctaFailure

  const mediaFailure = await checkAdMediaForMeta({
    mediaUrl: creative?.mediaUrl || null,
    platformPlacement: metaSettings?.platformPlacement || null,
  })
  if (mediaFailure) return mediaFailure

  return { ok: true, errorCode: null, message: null }
}
