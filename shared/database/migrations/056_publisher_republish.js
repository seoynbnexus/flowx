export async function up({ context }) {
  await context.query(`
    ALTER TABLE campaign_publisher_requests
    MODIFY COLUMN status ENUM(
      'pending', 'accepted', 'rejected', 'cancelled', 'completed',
      'published', 'failed', 'pending_republish'
    ) NOT NULL DEFAULT 'pending'
  `)

  await context.query(`
    ALTER TABLE campaign_publisher_requests
    ADD COLUMN creative_snapshot TEXT NULL AFTER coins_offered
  `)
}

export async function down({ context }) {
  await context.query(`
    ALTER TABLE campaign_publisher_requests
    DROP COLUMN creative_snapshot
  `)

  await context.query(`
    ALTER TABLE campaign_publisher_requests
    MODIFY COLUMN status ENUM(
      'pending', 'accepted', 'rejected', 'cancelled', 'completed',
      'published', 'failed'
    ) NOT NULL DEFAULT 'pending'
  `)
}