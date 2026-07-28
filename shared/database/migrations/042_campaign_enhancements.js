export async function up({ context }) {
  const connection = context

  const [spendCapCols] = await connection.execute(
    `SHOW COLUMNS FROM campaign_meta_settings LIKE 'spend_cap'`
  )
  if (spendCapCols.length === 0) {
    await connection.execute(
      `ALTER TABLE campaign_meta_settings ADD COLUMN spend_cap DECIMAL(15,2) NULL AFTER billing_event`
    )
    console.log('  + Added spend_cap to campaign_meta_settings')
  }

  const [endTimeCols] = await connection.execute(
    `SHOW COLUMNS FROM campaign_meta_settings LIKE 'end_time'`
  )
  if (endTimeCols.length === 0) {
    await connection.execute(
      `ALTER TABLE campaign_meta_settings ADD COLUMN end_time DATETIME NULL AFTER spend_cap`
    )
    console.log('  + Added end_time to campaign_meta_settings')
  }

  const [headlineCols] = await connection.execute(
    `SHOW COLUMNS FROM campaign_creatives LIKE 'headline'`
  )
  if (headlineCols.length === 0) {
    await connection.execute(
      `ALTER TABLE campaign_creatives ADD COLUMN headline VARCHAR(255) NULL AFTER call_to_action`
    )
    console.log('  + Added headline to campaign_creatives')
  }

  const [descCols] = await connection.execute(
    `SHOW COLUMNS FROM campaign_creatives LIKE 'description'`
  )
  if (descCols.length === 0) {
    await connection.execute(
      `ALTER TABLE campaign_creatives ADD COLUMN description TEXT NULL AFTER headline`
    )
    console.log('  + Added description to campaign_creatives')
  }
}

export async function down({ context }) {
  const connection = context

  await connection.execute('ALTER TABLE campaign_meta_settings DROP COLUMN end_time')
  await connection.execute('ALTER TABLE campaign_meta_settings DROP COLUMN spend_cap')
  await connection.execute('ALTER TABLE campaign_creatives DROP COLUMN description')
  await connection.execute('ALTER TABLE campaign_creatives DROP COLUMN headline')
  console.log('  - Removed campaign enhancement columns')
}
