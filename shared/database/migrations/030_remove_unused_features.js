export async function up({ context: pool }) {
  const [rows] = await pool.query(
    `SELECT f.feature_key, f.id FROM features f WHERE f.feature_key IN (?, ?, ?, ?, ?)`,
    ['storage', 'team_members', 'automation', 'analytics', 'ai_assistant']
  )

  for (const row of rows) {
    await pool.execute('DELETE FROM plan_features WHERE feature_id = ?', [row.id])
    console.log(`  - Removed plan_features for: ${row.feature_key}`)
  }

  await pool.execute(
    "DELETE FROM features WHERE feature_key IN ('storage', 'team_members', 'automation', 'analytics', 'ai_assistant')"
  )
  console.log('  - Removed features: storage, team_members, automation, analytics, ai_assistant')
}

export async function down({ context: pool }) {
  console.log('  ! Down migration not implemented — features were removed permanently')
}

export default { up, down }
