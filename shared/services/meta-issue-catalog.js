export const INSTAGRAM_MIN_IMAGE_WIDTH_PX = 500

export const META_ISSUE_CATALOG = {
  2875006: {
    category: 'MEDIA_DIMENSION',
    summary: 'Media not wide enough',
    severity: 'HARD_ERROR',
    level: 'AD',
    repairable: true,
    requiredInput: 'image',
    instagramEligible: true,
    minimumWidthPx: INSTAGRAM_MIN_IMAGE_WIDTH_PX,
    guidance:
      'The image is below Meta\u2019s 500px minimum width for Instagram. Use an image at least 500px wide.',
  },
}

export const VIDEO_DIMENSION_ISSUE_CODES = [
]

export const VIDEO_DIMENSION_CATEGORY = {
  category: 'VIDEO_DIMENSION',
  severity: 'HARD_ERROR',
  level: 'AD',
  repairable: true,
  requiredInput: 'video',
}

export function videoDimensionIssueCategory(errorCode) {
  if (errorCode === null || errorCode === undefined) return null
  const pinned = VIDEO_DIMENSION_ISSUE_CODES.map((code) => String(code))
  if (!pinned.includes(String(errorCode))) return null
  return {
    errorCode: String(errorCode),
    ...VIDEO_DIMENSION_CATEGORY,
    summary: null,
    guidance: 'This video does not meet Meta\u2019s delivery requirements. Use an MP4 or MOV video at least 500px wide and 1s long.',
  }
}

/**
 * Issue-category capability matrix.
 *
 * Only categories with documented remediation evidence may be marked
 * repairable. Every other category stays informational: FlowX surfaces the
 * Meta-provided summary/message plus static guidance, and never offers an
 * automated fix. No Meta issue codes are invented here — unknown codes
 * classify as UNKNOWN and are never remediated.
 *
 * | category         | level | severity   | repairable | required input | rollout flag                              | blocker if enabled                    |
 * | MEDIA_DIMENSION  | AD    | HARD_ERROR | true       | image >=500px  | campaign_repair_category_media_dimension | none (live-proven end to end)         |
 * | VIDEO_DIMENSION  | AD    | HARD_ERROR | conditional| video, criteria| campaign_repair_category_video_dimension | allowlist empty until live-pinned     |
 * | BILLING          | n/a   | n/a        | false      | manual account | n/a                                       | requires money movement               |
 * | POLICY_APPEAL    | n/a   | n/a        | false      | text appeal    | n/a                                       | needs human review, no safe primitive |
 * | PERMISSIONS      | n/a   | n/a        | false      | reconnect      | n/a                                       | needs OAuth/user action               |
 * | ACCOUNT          | n/a   | n/a        | false      | manual review  | n/a                                       | needs account-level intervention      |
 * | IDENTITY         | n/a   | n/a        | false      | verification   | n/a                                       | needs identity verification flow      |
 * | UNKNOWN          | n/a   | n/a        | false      | none           | n/a                                       | unclassified, never remediated        |
 */
export const UNSUPPORTED_ISSUE_CATEGORIES = {
  BILLING: {
    category: 'BILLING',
    repairable: false,
    guidance: 'This looks like a billing or account-funding matter. Resolve it in Meta Ads Manager — FlowX cannot automate billing changes.',
  },
  POLICY_APPEAL: {
    category: 'POLICY_APPEAL',
    repairable: false,
    guidance: 'This looks like a policy decision that needs human review or appeal. Check Meta Ads Manager — FlowX cannot appeal policy decisions.',
  },
  PERMISSIONS: {
    category: 'PERMISSIONS',
    repairable: false,
    guidance: 'This looks like a missing permission. Reconnect the affected page or ad account — FlowX cannot grant permissions.',
  },
  ACCOUNT: {
    category: 'ACCOUNT',
    repairable: false,
    guidance: 'This looks like an ad-account restriction. Resolve it in Meta Ads Manager — FlowX cannot lift account restrictions.',
  },
  IDENTITY: {
    category: 'IDENTITY',
    repairable: false,
    guidance: 'This looks like an identity-verification requirement. Complete verification in Meta — FlowX cannot verify identity.',
  },
}

export function classifyIssueCode(errorCode) {
  const entry = META_ISSUE_CATALOG[Number(errorCode)]
  if (entry) return { errorCode: String(errorCode), ...entry }
  const video = videoDimensionIssueCategory(errorCode)
  if (video) return video
  return {
    errorCode: errorCode === null || errorCode === undefined ? null : String(errorCode),
    category: 'UNKNOWN',
    summary: null,
    severity: null,
    level: null,
    repairable: false,
    requiredInput: null,
    instagramEligible: false,
    minimumWidthPx: null,
    guidance: null,
  }
}

export function normalizeIssuesInfo(issuesInfo) {
  if (!Array.isArray(issuesInfo)) return []
  const out = []
  for (const item of issuesInfo) {
    if (!item || item.error_code === null || item.error_code === undefined || item.error_code === '') continue
    out.push({
      level: item.level || null,
      errorCode: String(item.error_code),
      summary: item.error_summary || null,
      message: item.error_message || null,
      errorType: item.error_type || null,
    })
  }
  return out
}

export function describeIssuesForCampaign(issuesInfo) {
  const normalized = normalizeIssuesInfo(issuesInfo)
  if (!normalized.length) return null
  const described = normalized.map((issue) => ({ issue, classification: classifyIssueCode(issue.errorCode) }))
  const chosen = described.find((d) => d.classification.category !== 'UNKNOWN') || described[0]
  const { issue, classification } = chosen
  const headline = classification.summary || issue.summary || issue.message || `Meta reported issue ${issue.errorCode}`
  const guidance = classification.guidance
  return guidance ? `${headline} ${guidance}` : `${headline} (Meta code ${issue.errorCode}) — check Meta Ads Manager for details.`
}

export function hasRepairableIssue(issuesInfo) {
  const normalized = normalizeIssuesInfo(issuesInfo)
  return normalized.some((issue) => classifyIssueCode(issue.errorCode).repairable === true)
}

/**
 * Boost (promotion_target) repair category allowlist — deliberately
 * disjoint from campaigns' repairable set (META_ISSUE_CATALOG's
 * MEDIA_DIMENSION / VIDEO_DIMENSION). A boost's ad creative reuses an
 * already-published, already-validated object_story_id rather than an
 * independently-uploaded ad image, and boost repair is scoped to ad-level
 * fields only (never the underlying post's media) — so a media-dimension
 * code on a boost ad is never repairable here even though the same code IS
 * repairable for a traditional campaign. Starts empty on purpose, following
 * the exact same "never invent codes" convention as
 * VIDEO_DIMENSION_ISSUE_CODES: ships with the full detection/classification
 * pipeline live, and the first category is pinned only once a real Meta
 * disapproval code has been live-observed on a boosted ad and a genuine
 * ad-level (not media) remediation is confirmed.
 */
export const BOOST_SUPPORTED_REPAIR_CATEGORIES = []

export function isBoostRepairableCategory(category) {
  return BOOST_SUPPORTED_REPAIR_CATEGORIES.includes(category)
}

export function hasRepairableBoostIssue(issuesInfo) {
  const normalized = normalizeIssuesInfo(issuesInfo)
  return normalized.some((issue) => isBoostRepairableCategory(classifyIssueCode(issue.errorCode).category))
}

export function instagramAppliesToPlacement(platformPlacement) {
  if (!platformPlacement || typeof platformPlacement !== 'object') return true
  const platforms = platformPlacement.publisher_platforms
  if (!Array.isArray(platforms)) return true
  return platforms.map(String).includes('instagram')
}

export function checkInstagramImageWidth(width) {
  if (width === null || width === undefined) return { ok: true, skipped: true }
  if (!Number.isFinite(Number(width))) return { ok: true, skipped: true }
  if (Number(width) >= INSTAGRAM_MIN_IMAGE_WIDTH_PX) return { ok: true, skipped: false }
  return {
    ok: false,
    skipped: false,
    errorCode: '2875006',
    message: `Image is ${width}px wide — Meta requires at least ${INSTAGRAM_MIN_IMAGE_WIDTH_PX}px for Instagram delivery (issue 2875006).`,
  }
}

// Duration figures corroborated by this codebase's own organic-post caps
// (post-content-validation.js: facebook.reel.video.maxDurationSeconds=90,
// facebook.story.video.maxDurationSeconds=60). Width/height for Reels
// confirmed by this codebase's own organic Reel rule (facebook.reel.video:
// minWidth=540, minHeight=960 — exactly half Meta's commonly recommended
// 1080x1920 Reels resolution). Stories' width/height has no codebase
// precedent and is applied here by explicit analogy (same 9:16 vertical
// surface family as Reels) — reconfirm both placements' numbers against
// live Meta ad specs before treating as authoritative; these are
// aggregator/analogy-sourced, not pulled from Meta's own developer docs.
export const REELS_AD_SPEC = { surface: 'Reels', maxDurationSeconds: 90, minWidth: 540, minHeight: 960, maxAspect: 0.8 }
export const STORY_AD_SPEC = { surface: 'Stories', maxDurationSeconds: 60, minWidth: 540, minHeight: 960, maxAspect: 0.8 }

export function videoSpecForPlacement(platformPlacement) {
  if (!platformPlacement || typeof platformPlacement !== 'object') return null
  const fb = Array.isArray(platformPlacement.facebook_positions) ? platformPlacement.facebook_positions.map(String) : []
  const ig = Array.isArray(platformPlacement.instagram_positions) ? platformPlacement.instagram_positions.map(String) : []
  if (fb.includes('reels') || ig.includes('reels')) return REELS_AD_SPEC
  if (fb.includes('story') || ig.includes('story')) return STORY_AD_SPEC
  return null
}
