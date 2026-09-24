import { hashConfig, stableStringify } from '../../../shared/services/snapshot.js'
import { liveGraphVersion } from './campaign-execution.service.js'
import { CLIENT_EDIT_CREATIVE_FIELDS, CLIENT_EDIT_ERROR_CODE } from './repair.model.js'

function sectionHash(value) {
  return hashConfig(value ?? null)
}

export function diffSnapshotForMediaRepair({ frozenConfig, liveConfig, amendment } = {}) {
  if (!frozenConfig || typeof frozenConfig !== 'object') {
    return { ok: false, reason: 'missing-frozen-snapshot' }
  }
  if (!liveConfig || typeof liveConfig !== 'object') {
    return { ok: false, reason: 'missing-live-config' }
  }
  if (!amendment || typeof amendment.mediaUrl !== 'string' || !amendment.mediaUrl) {
    return { ok: false, reason: 'missing-media-amendment' }
  }

  if (sectionHash(liveConfig.campaign) !== sectionHash(frozenConfig.campaign)) {
    return { ok: false, reason: 'drift:campaign' }
  }
  if (sectionHash(liveConfig.settings) !== sectionHash(frozenConfig.settings)) {
    return { ok: false, reason: 'drift:settings' }
  }
  if (stableStringify(liveConfig.creative ?? null) !== stableStringify(frozenConfig.creative ?? null)) {
    return { ok: false, reason: 'drift:creative' }
  }

  const proposed = JSON.parse(JSON.stringify(frozenConfig))
  if (!proposed.creative || typeof proposed.creative !== 'object') {
    return { ok: false, reason: 'missing-creative-subtree' }
  }
  proposed.creative.mediaUrl = amendment.mediaUrl

  const proposedCreative = { ...proposed.creative }
  const frozenCreative = { ...frozenConfig.creative }
  delete proposedCreative.mediaUrl
  delete frozenCreative.mediaUrl
  if (stableStringify(proposedCreative) !== stableStringify(frozenCreative)) {
    return { ok: false, reason: 'non-media-difference:creative' }
  }

  const graphVersion = liveGraphVersion()
  const hash = hashConfig({ config: proposed, graphVersion })
  return { ok: true, config: proposed, hash, graphVersion }
}

// Single dispatch point used by every preflight/verify/re-stamp call site in
// runRepairCreation/activationPreflight/previewRepairInner — picks the right
// diff function and amendment shape for the repair's trigger type, so the 4
// call sites never have to know CLIENT_EDIT exists.
export function diffRepairSnapshot({ repair, frozenConfig, liveConfig }) {
  if (repair.errorCode === CLIENT_EDIT_ERROR_CODE) {
    return diffSnapshotForContentAmendment({
      frozenConfig, liveConfig,
      amendment: { ...(repair.amendmentCreative || {}), mediaUrl: repair.mediaUrl },
    })
  }
  return diffSnapshotForMediaRepair({ frozenConfig, liveConfig, amendment: { mediaUrl: repair.mediaUrl } })
}

// Generalizes diffSnapshotForMediaRepair to the full creative-only edit
// scope (caption/media/CTA/headline/description/UTM) for a client-initiated
// amendment on a FAILED, already-live campaign. Same invariant as the media
// version: budget/targeting/schedule/placement/objective (campaign+settings
// sections) and every creative field OUTSIDE the declared amendment must
// stay byte-identical to the frozen snapshot — this asserts the live
// campaign/creative rows were never touched directly, only the amendment
// object was, so any unexpected drift fails closed instead of silently
// shipping an un-reviewed change to Meta.
export function diffSnapshotForContentAmendment({ frozenConfig, liveConfig, amendment } = {}) {
  if (!frozenConfig || typeof frozenConfig !== 'object') {
    return { ok: false, reason: 'missing-frozen-snapshot' }
  }
  if (!liveConfig || typeof liveConfig !== 'object') {
    return { ok: false, reason: 'missing-live-config' }
  }
  if (!amendment || typeof amendment !== 'object') {
    return { ok: false, reason: 'missing-amendment' }
  }
  const amendedKeys = CLIENT_EDIT_CREATIVE_FIELDS.filter((key) => amendment[key] !== undefined)
  if (!amendedKeys.length) {
    return { ok: false, reason: 'empty-amendment' }
  }

  if (sectionHash(liveConfig.campaign) !== sectionHash(frozenConfig.campaign)) {
    return { ok: false, reason: 'drift:campaign' }
  }
  if (sectionHash(liveConfig.settings) !== sectionHash(frozenConfig.settings)) {
    return { ok: false, reason: 'drift:settings' }
  }
  if (stableStringify(liveConfig.creative ?? null) !== stableStringify(frozenConfig.creative ?? null)) {
    return { ok: false, reason: 'drift:creative' }
  }

  const proposed = JSON.parse(JSON.stringify(frozenConfig))
  if (!proposed.creative || typeof proposed.creative !== 'object') {
    return { ok: false, reason: 'missing-creative-subtree' }
  }
  for (const key of amendedKeys) {
    proposed.creative[key] = amendment[key]
  }

  const proposedCreative = { ...proposed.creative }
  const frozenCreative = { ...frozenConfig.creative }
  for (const key of amendedKeys) {
    delete proposedCreative[key]
    delete frozenCreative[key]
  }
  if (stableStringify(proposedCreative) !== stableStringify(frozenCreative)) {
    return { ok: false, reason: 'non-amended-difference:creative' }
  }

  const graphVersion = liveGraphVersion()
  const hash = hashConfig({ config: proposed, graphVersion })
  return { ok: true, config: proposed, hash, graphVersion }
}
