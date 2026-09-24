export const REPAIR_STATUS = {
  PENDING: 'pending',
  READY_FOR_CREATION: 'ready_for_creation',
  CREATIVE_CREATED: 'creative_created',
  AD_CREATED: 'ad_created',
  ACTIVATING: 'activating',
  ACTIVE_VERIFIED: 'active_verified',
  COMPLETED: 'completed',
  FAILED: 'failed',
  UNKNOWN: 'unknown',
}

export const ACTIVE_REPAIR_STATUSES = [
  REPAIR_STATUS.PENDING,
  REPAIR_STATUS.READY_FOR_CREATION,
  REPAIR_STATUS.CREATIVE_CREATED,
  REPAIR_STATUS.AD_CREATED,
  REPAIR_STATUS.ACTIVATING,
  REPAIR_STATUS.ACTIVE_VERIFIED,
  REPAIR_STATUS.UNKNOWN,
]

export const TERMINAL_REPAIR_STATUSES = [
  REPAIR_STATUS.COMPLETED,
  REPAIR_STATUS.FAILED,
  REPAIR_STATUS.UNKNOWN,
]

// Linear staircase (no dual-live/pointer-move phase like campaigns — a boost
// repair accepts a brief delivery gap: delete the old ad+creative, create
// the new one, activate). executeBoostCreation's own on-failure cleanup
// (deletes + nulls the target's columns on ANY failure, including transient)
// means a repair-row status parked at CREATIVE_CREATED would go stale the
// instant that cleanup fires — so the actual creation flow takes the
// ready_for_creation -> ad_created hop in one guarded step, only after
// executeBoostCreation fully succeeds. CREATIVE_CREATED stays modeled for
// future finer-grained observability but is never a state runRepairCreation
// parks in today.
export const VALID_REPAIR_TRANSITIONS = {
  [REPAIR_STATUS.PENDING]: [REPAIR_STATUS.READY_FOR_CREATION, REPAIR_STATUS.FAILED, REPAIR_STATUS.UNKNOWN],
  [REPAIR_STATUS.READY_FOR_CREATION]: [REPAIR_STATUS.CREATIVE_CREATED, REPAIR_STATUS.AD_CREATED, REPAIR_STATUS.FAILED, REPAIR_STATUS.UNKNOWN],
  [REPAIR_STATUS.CREATIVE_CREATED]: [REPAIR_STATUS.AD_CREATED, REPAIR_STATUS.FAILED, REPAIR_STATUS.UNKNOWN],
  [REPAIR_STATUS.AD_CREATED]: [REPAIR_STATUS.ACTIVATING, REPAIR_STATUS.FAILED, REPAIR_STATUS.UNKNOWN],
  [REPAIR_STATUS.ACTIVATING]: [REPAIR_STATUS.ACTIVE_VERIFIED, REPAIR_STATUS.FAILED, REPAIR_STATUS.UNKNOWN],
  [REPAIR_STATUS.ACTIVE_VERIFIED]: [REPAIR_STATUS.COMPLETED, REPAIR_STATUS.FAILED, REPAIR_STATUS.UNKNOWN],
  [REPAIR_STATUS.FAILED]: [REPAIR_STATUS.PENDING],
  [REPAIR_STATUS.UNKNOWN]: [REPAIR_STATUS.PENDING],
  [REPAIR_STATUS.COMPLETED]: [REPAIR_STATUS.PENDING],
}

export function assertValidRepairTransition(from, to) {
  const allowed = VALID_REPAIR_TRANSITIONS[from] || []
  if (!allowed.includes(to)) {
    throw new Error(`Invalid boost repair transition ${from} -> ${to}`)
  }
}

export function buildRepairRunKey(repairId) {
  return `promotion_repair:${String(repairId).replace(/-/g, '').toLowerCase()}`
}
