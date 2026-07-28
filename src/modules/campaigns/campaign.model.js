export const CAMPAIGN_STATUS = {
  DRAFT: 'draft',
  PENDING_REVIEW: 'pending_review',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  CHANGES_REQUESTED: 'changes_requested',
  SCHEDULED: 'scheduled',
  RUNNING: 'running',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
}

export const CAMPAIGN_TYPES = {
  POST: 'post',
  STORY: 'story',
  REEL: 'reel',
  ADVERTISEMENT: 'advertisement',
}

export const PUBLISHER_REQUEST_STATUS = {
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
  COMPLETED: 'completed',
  PUBLISHED: 'published',
  FAILED: 'failed',
}

export const META_OBJECT_TYPES = {
  FACEBOOK_CAMPAIGN: 'facebook_campaign',
  AD_SET: 'ad_set',
  AD_CREATIVE: 'ad_creative',
  AD: 'ad',
  FACEBOOK_POST: 'facebook_post',
  INSTAGRAM_MEDIA: 'instagram_media',
}

export const BUDGET_TYPES = {
  DAILY: 'daily',
  LIFETIME: 'lifetime',
}

export const REVIEW_ACTIONS = {
  SUBMITTED: 'submitted',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  CHANGES_REQUESTED: 'changes_requested',
  CANCELLED: 'cancelled',
  CONFIRMED: 'confirmed',
}

export const CAMPAIGN_STATUS_LABELS = {
  draft: 'Draft',
  pending_review: 'Pending Review',
  approved: 'Approved',
  rejected: 'Rejected',
  changes_requested: 'Changes Requested',
  scheduled: 'Scheduled',
  running: 'Running',
  paused: 'Paused',
  completed: 'Completed',
  cancelled: 'Cancelled',
  failed: 'Failed',
}

export const VALID_TRANSITIONS = {
  [CAMPAIGN_STATUS.DRAFT]: [CAMPAIGN_STATUS.PENDING_REVIEW, CAMPAIGN_STATUS.CANCELLED],
  [CAMPAIGN_STATUS.PENDING_REVIEW]: [CAMPAIGN_STATUS.APPROVED, CAMPAIGN_STATUS.REJECTED, CAMPAIGN_STATUS.CANCELLED],
  [CAMPAIGN_STATUS.APPROVED]: [CAMPAIGN_STATUS.SCHEDULED, CAMPAIGN_STATUS.CANCELLED],
  [CAMPAIGN_STATUS.REJECTED]: [CAMPAIGN_STATUS.DRAFT, CAMPAIGN_STATUS.CANCELLED],
  [CAMPAIGN_STATUS.CHANGES_REQUESTED]: [CAMPAIGN_STATUS.PENDING_REVIEW, CAMPAIGN_STATUS.CANCELLED],
  [CAMPAIGN_STATUS.SCHEDULED]: [CAMPAIGN_STATUS.RUNNING, CAMPAIGN_STATUS.CANCELLED],
  [CAMPAIGN_STATUS.RUNNING]: [CAMPAIGN_STATUS.PAUSED, CAMPAIGN_STATUS.COMPLETED, CAMPAIGN_STATUS.FAILED, CAMPAIGN_STATUS.CANCELLED],
  [CAMPAIGN_STATUS.PAUSED]: [CAMPAIGN_STATUS.RUNNING, CAMPAIGN_STATUS.COMPLETED, CAMPAIGN_STATUS.CANCELLED],
  [CAMPAIGN_STATUS.COMPLETED]: [],
  [CAMPAIGN_STATUS.CANCELLED]: [],
  [CAMPAIGN_STATUS.FAILED]: [],
}
