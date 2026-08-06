export async function up({ context }) {
  await context.query(`
    ALTER TABLE campaigns
    MODIFY COLUMN status ENUM(
      'draft', 'pending_review', 'approved', 'rejected', 'changes_requested',
      'scheduled', 'running', 'paused', 'completed', 'cancelled', 'failed',
      'awaiting_publishers', 'archived'
    ) NOT NULL DEFAULT 'draft'
  `)

  await context.query(`
    ALTER TABLE campaigns
    MODIFY COLUMN meta_status ENUM(
      'pending', 'created', 'active', 'paused', 'failed', 'archived',
      'pending_review', 'pending_billing_info', 'with_issues', 'preapproved', 'deleted'
    ) NULL DEFAULT 'pending'
  `)
}

export async function down({ context }) {
  await context.query(`
    ALTER TABLE campaigns
    MODIFY COLUMN status ENUM(
      'draft', 'pending_review', 'approved', 'rejected', 'changes_requested',
      'scheduled', 'running', 'paused', 'completed', 'cancelled', 'failed',
      'awaiting_publishers'
    ) NOT NULL DEFAULT 'draft'
  `)

  await context.query(`
    ALTER TABLE campaigns
    MODIFY COLUMN meta_status ENUM(
      'pending', 'created', 'active', 'paused', 'failed', 'archived'
    ) NULL DEFAULT 'pending'
  `)
}