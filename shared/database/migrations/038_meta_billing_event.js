export async function up({ context: pool }) {
  const [cols] = await pool.execute(
    "SHOW COLUMNS FROM campaign_meta_settings LIKE 'billing_event'"
  )
  if (cols.length === 0) {
    await pool.execute(
      "ALTER TABLE campaign_meta_settings ADD COLUMN billing_event VARCHAR(50) NULL AFTER budget_amount"
    )
    console.log('  + Added billing_event to campaign_meta_settings')
  } else {
    console.log('  ~ billing_event already exists')
  }
}

export async function down({ context: pool }) {
  const [cols] = await pool.execute(
    "SHOW COLUMNS FROM campaign_meta_settings LIKE 'billing_event'"
  )
  if (cols.length > 0) {
    await pool.execute('ALTER TABLE campaign_meta_settings DROP COLUMN billing_event')
    console.log('  - Removed billing_event from campaign_meta_settings')
  }
}

export default { up, down }
