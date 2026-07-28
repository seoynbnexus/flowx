export async function up({ context }) {
  const connection = context

  const [cols] = await connection.execute(
    `SHOW COLUMNS FROM campaign_review_log LIKE 'reviewer_id'`
  )
  if (cols.length > 0 && cols[0].Null === 'NO') {
    await connection.execute(
      `ALTER TABLE campaign_review_log MODIFY reviewer_id BINARY(16) NULL`
    )
    console.log('  + Made reviewer_id nullable in campaign_review_log')
  }
}

export async function down({ context }) {
  const connection = context

  await connection.execute(
    `ALTER TABLE campaign_review_log MODIFY reviewer_id BINARY(16) NOT NULL`
  )
  console.log('  - Restored NOT NULL on reviewer_id')
}
