export const EXECUTION_KIND = {
  CLIENT: 'client',
  PUBLISHER: 'publisher',
}

export const EXECUTION_STATUS = {
  PENDING: 'pending',
  VALIDATING: 'validating',
  CREATING: 'creating',
  ACTIVE: 'active',
  PAUSED: 'paused',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  COMPLETED: 'completed',
}

export const EXECUTION_REMOTE_STATE = {
  VISIBLE: 'visible',
  HIDDEN: 'hidden',
  MISSING: 'missing',
  UNKNOWN: 'unknown',
}

export const VALID_EXECUTION_TRANSITIONS = {
  pending: ['validating', 'cancelled', 'failed'],
  validating: ['creating', 'cancelled', 'failed'],
  creating: ['active', 'paused', 'cancelled', 'failed'],
  active: ['paused', 'cancelled', 'failed'],
  paused: ['active', 'cancelled', 'failed'],
  failed: [],
  cancelled: [],
  completed: [],
}

export const IN_FLIGHT_EXECUTION_STATUSES = ['pending', 'validating', 'creating']

export const LIVE_EXECUTION_STATUSES = ['active', 'paused']

export const TERMINAL_EXECUTION_STATUSES = ['failed', 'cancelled', 'completed']

export function assertValidExecutionTransition(from, to) {
  const allowed = VALID_EXECUTION_TRANSITIONS[from] || []
  return allowed.includes(to)
}
