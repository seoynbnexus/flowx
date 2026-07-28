export async function up({ context }) {
  const connection = context

  const [utmCols] = await connection.execute(
    `SHOW COLUMNS FROM campaign_creatives LIKE 'utm_source'`
  )
  if (utmCols.length === 0) {
    await connection.execute(
      `ALTER TABLE campaign_creatives ADD COLUMN utm_source VARCHAR(500) NULL AFTER description`
    )
    console.log('  + Added utm_source to campaign_creatives')
  }

  const [utmMediumCols] = await connection.execute(
    `SHOW COLUMNS FROM campaign_creatives LIKE 'utm_medium'`
  )
  if (utmMediumCols.length === 0) {
    await connection.execute(
      `ALTER TABLE campaign_creatives ADD COLUMN utm_medium VARCHAR(500) NULL AFTER utm_source`
    )
    console.log('  + Added utm_medium to campaign_creatives')
  }

  const [utmCampaignCols] = await connection.execute(
    `SHOW COLUMNS FROM campaign_creatives LIKE 'utm_campaign'`
  )
  if (utmCampaignCols.length === 0) {
    await connection.execute(
      `ALTER TABLE campaign_creatives ADD COLUMN utm_campaign VARCHAR(500) NULL AFTER utm_medium`
    )
    console.log('  + Added utm_campaign to campaign_creatives')
  }

  const [utmContentCols] = await connection.execute(
    `SHOW COLUMNS FROM campaign_creatives LIKE 'utm_content'`
  )
  if (utmContentCols.length === 0) {
    await connection.execute(
      `ALTER TABLE campaign_creatives ADD COLUMN utm_content VARCHAR(500) NULL AFTER utm_campaign`
    )
    console.log('  + Added utm_content to campaign_creatives')
  }

  const [utmTermCols] = await connection.execute(
    `SHOW COLUMNS FROM campaign_creatives LIKE 'utm_term'`
  )
  if (utmTermCols.length === 0) {
    await connection.execute(
      `ALTER TABLE campaign_creatives ADD COLUMN utm_term VARCHAR(500) NULL AFTER utm_content`
    )
    console.log('  + Added utm_term to campaign_creatives')
  }
}

export async function down({ context }) {
  const connection = context
  await connection.execute('ALTER TABLE campaign_creatives DROP COLUMN utm_term')
  await connection.execute('ALTER TABLE campaign_creatives DROP COLUMN utm_content')
  await connection.execute('ALTER TABLE campaign_creatives DROP COLUMN utm_campaign')
  await connection.execute('ALTER TABLE campaign_creatives DROP COLUMN utm_medium')
  await connection.execute('ALTER TABLE campaign_creatives DROP COLUMN utm_source')
  console.log('  - Removed campaign UTM columns')
}
