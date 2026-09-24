export const REPAIR_STATUS = {
  PENDING: 'pending',
  READY_FOR_CREATION: 'ready_for_creation',
  CREATIVE_CREATED: 'creative_created',
  AD_CREATED: 'ad_created',
  NEW_VERIFIED: 'new_verified',
  NEW_ACTIVATING: 'new_activating',
  NEW_ACTIVE_VERIFIED: 'new_active_verified',
  NEW_ACTIVE: 'new_active',
  OLD_PAUSING: 'old_pausing',
  OLD_PAUSED_VERIFIED: 'old_paused_verified',
  OLD_PAUSED: 'old_paused',
  ACTIVE_POINTER_MOVED: 'active_pointer_moved',
  OLD_CLEANUP: 'old_cleanup',
  COMPLETED: 'completed',
  FAILED: 'failed',
  UNKNOWN: 'unknown',
  SUPERSEDED: 'superseded',
}

export const ACTIVE_REPAIR_STATUSES = [
  REPAIR_STATUS.PENDING,
  REPAIR_STATUS.READY_FOR_CREATION,
  REPAIR_STATUS.CREATIVE_CREATED,
  REPAIR_STATUS.AD_CREATED,
  REPAIR_STATUS.NEW_VERIFIED,
  REPAIR_STATUS.NEW_ACTIVE,
  REPAIR_STATUS.OLD_PAUSED,
  REPAIR_STATUS.UNKNOWN,
]

export const TERMINAL_REPAIR_STATUSES = [
  REPAIR_STATUS.COMPLETED,
  REPAIR_STATUS.FAILED,
  REPAIR_STATUS.SUPERSEDED,
]

export const VALID_REPAIR_TRANSITIONS = {
  [REPAIR_STATUS.PENDING]: [REPAIR_STATUS.READY_FOR_CREATION, REPAIR_STATUS.FAILED, REPAIR_STATUS.UNKNOWN, REPAIR_STATUS.SUPERSEDED],
  [REPAIR_STATUS.READY_FOR_CREATION]: [REPAIR_STATUS.CREATIVE_CREATED, REPAIR_STATUS.FAILED, REPAIR_STATUS.UNKNOWN, REPAIR_STATUS.SUPERSEDED],
  [REPAIR_STATUS.CREATIVE_CREATED]: [REPAIR_STATUS.AD_CREATED, REPAIR_STATUS.FAILED, REPAIR_STATUS.UNKNOWN, REPAIR_STATUS.SUPERSEDED],
  [REPAIR_STATUS.AD_CREATED]: [REPAIR_STATUS.NEW_VERIFIED, REPAIR_STATUS.FAILED, REPAIR_STATUS.UNKNOWN, REPAIR_STATUS.SUPERSEDED],
  [REPAIR_STATUS.NEW_VERIFIED]: [REPAIR_STATUS.NEW_ACTIVATING, REPAIR_STATUS.FAILED, REPAIR_STATUS.UNKNOWN, REPAIR_STATUS.SUPERSEDED],
  [REPAIR_STATUS.NEW_ACTIVATING]: [REPAIR_STATUS.NEW_ACTIVE_VERIFIED, REPAIR_STATUS.FAILED, REPAIR_STATUS.UNKNOWN],
  [REPAIR_STATUS.NEW_ACTIVE_VERIFIED]: [REPAIR_STATUS.OLD_PAUSING, REPAIR_STATUS.FAILED, REPAIR_STATUS.UNKNOWN],
  [REPAIR_STATUS.OLD_PAUSING]: [REPAIR_STATUS.OLD_PAUSED_VERIFIED, REPAIR_STATUS.FAILED, REPAIR_STATUS.UNKNOWN],
  [REPAIR_STATUS.OLD_PAUSED_VERIFIED]: [REPAIR_STATUS.ACTIVE_POINTER_MOVED, REPAIR_STATUS.FAILED, REPAIR_STATUS.UNKNOWN],
  [REPAIR_STATUS.ACTIVE_POINTER_MOVED]: [REPAIR_STATUS.OLD_CLEANUP, REPAIR_STATUS.FAILED, REPAIR_STATUS.UNKNOWN],
  [REPAIR_STATUS.OLD_CLEANUP]: [REPAIR_STATUS.COMPLETED, REPAIR_STATUS.FAILED, REPAIR_STATUS.UNKNOWN],
  [REPAIR_STATUS.NEW_ACTIVE]: [REPAIR_STATUS.FAILED, REPAIR_STATUS.UNKNOWN, REPAIR_STATUS.SUPERSEDED],
  [REPAIR_STATUS.OLD_PAUSED]: [REPAIR_STATUS.FAILED, REPAIR_STATUS.UNKNOWN, REPAIR_STATUS.SUPERSEDED],
  [REPAIR_STATUS.UNKNOWN]: [REPAIR_STATUS.PENDING, REPAIR_STATUS.FAILED, REPAIR_STATUS.SUPERSEDED],
  [REPAIR_STATUS.FAILED]: [REPAIR_STATUS.PENDING],
  [REPAIR_STATUS.SUPERSEDED]: [REPAIR_STATUS.PENDING],
  [REPAIR_STATUS.COMPLETED]: [REPAIR_STATUS.PENDING],
}

export function assertValidRepairTransition(from, to) {
  const allowed = VALID_REPAIR_TRANSITIONS[from] || []
  if (!allowed.includes(to)) {
    throw new Error(`Invalid repair transition ${from} -> ${to}`)
  }
}

export const SUPPORTED_REPAIR_CATEGORIES = ['MEDIA_DIMENSION', 'VIDEO_DIMENSION', 'CLIENT_EDIT']

// Sentinel error_code for a client-initiated creative amendment on a FAILED
// campaign with a live Meta chain — not a real Meta issue code (classifyIssueCode
// never produces it), just the required discriminator in the repair row's
// (execution_id, object_id, error_code) unique triple. Gated by its own
// rollout flag via isRepairCategoryEnabled('CLIENT_EDIT') like any other
// category, fail-closed default off.
export const CLIENT_EDIT_ERROR_CODE = 'CLIENT_EDIT'

// The only campaign fields a client may amend on a FAILED, already-live
// campaign — budget/targeting/schedule/placement/objective stay frozen
// (matches the approved edit scope; enforced by diffSnapshotForContentAmendment).
export const CLIENT_EDIT_CREATIVE_FIELDS = [
  'caption', 'textBody', 'mediaUrl', 'callToAction', 'headline', 'description',
  'utmSource', 'utmMedium', 'utmCampaign', 'utmContent', 'utmTerm',
]

export const ACTIVATION_MID_STATES = [
  REPAIR_STATUS.NEW_ACTIVATING,
  REPAIR_STATUS.NEW_ACTIVE_VERIFIED,
  REPAIR_STATUS.OLD_PAUSING,
  REPAIR_STATUS.OLD_PAUSED_VERIFIED,
  REPAIR_STATUS.ACTIVE_POINTER_MOVED,
  REPAIR_STATUS.OLD_CLEANUP,
]

export function buildRepairRunKey(repairIdHex) {
  return `repair:${String(repairIdHex).replace(/-/g, '').toLowerCase()}`
}

export function buildRepairCreativeName(repairId, generationNo) {
  return `Repair ${String(repairId).replace(/-/g, '').substring(0, 8)} g${generationNo}`
}

export function buildRepairAdName(repairId, generationNo) {
  return `RepairAd ${String(repairId).replace(/-/g, '').substring(0, 8)} g${generationNo}`
}
