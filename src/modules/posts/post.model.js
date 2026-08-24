export const POST_STATUS = {
  DRAFT: 'draft',
  PENDING_REVIEW: 'pending_review',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  CHANGES_REQUESTED: 'changes_requested',
  SCHEDULED: 'scheduled',
  RUNNING: 'running',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
  AWAITING_PUBLISHERS: 'awaiting_publishers',
}

export const POST_TYPES = {
  POST: 'post',
  STORY: 'story',
  REEL: 'reel',
}

export const POST_TARGET_STATUS = {
  PENDING: 'pending',
  POSTED: 'posted',
  FAILED: 'failed',
}

export const POST_TARGET_PUBLISH_STATE = {
  NONE: 'none',
  PUBLISHING: 'publishing',
  UPLOAD_STARTED: 'upload_started',
  UPLOADING: 'uploading',
  UPLOADED: 'uploaded',
  PROCESSING: 'processing',
  READY: 'ready',
  PUBLISHED: 'published',
  PERMANENT_FAILURE: 'permanent_failure',
  RETRYABLE_FAILURE: 'retryable_failure',
  UNKNOWN: 'unknown',
  VERIFYING: 'verifying',
  RETRY_PENDING: 'retry_pending',
  MANUAL_REVIEW: 'manual_review',
}

export const POST_TARGET_TYPES = {
  CLIENT: 'client',
  PUBLISHER: 'publisher',
}

export const PUBLISHER_REQUEST_STATUS = {
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
  COMPLETED: 'completed',
  PUBLISHED: 'published',
  FAILED: 'failed',
  PENDING_REPUBLISH: 'pending_republish',
  EXPIRED: 'expired',
}

export const POST_JOB_TYPES = {
  PUBLISH: 'post_publish',
  VERIFY: 'post_verify',
  SYNC_ENGAGEMENT: 'post_sync_engagement',
  FB_REEL: 'post_fb_reel',
  IG_REEL: 'post_ig_reel',
  IG_STORY: 'post_ig_story',
  PUBLISHER_GO_LIVE: 'post_publisher_go_live',
  EXPIRE_PUBLISHER_REQUESTS: 'post_expire_publisher_requests',
}

export const REVIEW_ACTIONS = {
  SUBMITTED: 'submitted',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  CHANGES_REQUESTED: 'changes_requested',
  CANCELLED: 'cancelled',
  CONFIRMED: 'confirmed',
}

export const POST_STATUS_LABELS = {
  draft: 'Draft',
  pending_review: 'Pending Review',
  approved: 'Approved',
  rejected: 'Rejected',
  changes_requested: 'Changes Requested',
  scheduled: 'Scheduled',
  running: 'Running',
  completed: 'Completed',
  cancelled: 'Cancelled',
  failed: 'Failed',
  awaiting_publishers: 'Awaiting Publishers',
}

export const PUBLISHER_REQUEST_STATUS_LABELS = {
  pending: 'Pending',
  accepted: 'Accepted',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  completed: 'Completed',
  published: 'Published',
  failed: 'Failed',
  pending_republish: 'Pending Republish',
  expired: 'Expired',
}

export const VALID_TRANSITIONS = {
  [POST_STATUS.DRAFT]: [POST_STATUS.PENDING_REVIEW, POST_STATUS.CANCELLED],
  [POST_STATUS.PENDING_REVIEW]: [POST_STATUS.APPROVED, POST_STATUS.REJECTED, POST_STATUS.CANCELLED],
  [POST_STATUS.APPROVED]: [POST_STATUS.RUNNING, POST_STATUS.COMPLETED, POST_STATUS.FAILED, POST_STATUS.CANCELLED, POST_STATUS.AWAITING_PUBLISHERS],
  [POST_STATUS.REJECTED]: [POST_STATUS.DRAFT, POST_STATUS.CANCELLED],
  [POST_STATUS.CHANGES_REQUESTED]: [POST_STATUS.PENDING_REVIEW, POST_STATUS.CANCELLED],
  [POST_STATUS.SCHEDULED]: [POST_STATUS.RUNNING, POST_STATUS.COMPLETED, POST_STATUS.FAILED, POST_STATUS.CANCELLED],
  [POST_STATUS.RUNNING]: [POST_STATUS.COMPLETED, POST_STATUS.FAILED, POST_STATUS.CANCELLED],
  [POST_STATUS.COMPLETED]: [],
  [POST_STATUS.CANCELLED]: [],
  [POST_STATUS.FAILED]: [POST_STATUS.DRAFT, POST_STATUS.CANCELLED],
  [POST_STATUS.AWAITING_PUBLISHERS]: [POST_STATUS.RUNNING, POST_STATUS.SCHEDULED, POST_STATUS.FAILED, POST_STATUS.CANCELLED],
}
