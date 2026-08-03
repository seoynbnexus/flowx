export async function up({ context: pool }) {
  const [cols] = await pool.execute(
    "SHOW COLUMNS FROM campaign_meta_objects LIKE 'created_for_user_id'"
  )
  if (cols.length === 0) {
    await pool.execute(
      'ALTER TABLE campaign_meta_objects ADD COLUMN created_for_user_id BINARY(16) NULL AFTER platform_account_id'
    )
    await pool.execute(
      'ALTER TABLE campaign_meta_objects ADD CONSTRAINT fk_meta_objects_user FOREIGN KEY (created_for_user_id) REFERENCES users (id)'
    )
    await pool.execute(
      `UPDATE campaign_meta_objects mo JOIN campaigns c ON c.id = mo.campaign_id
       SET mo.created_for_user_id = c.client_id WHERE mo.created_for_user_id IS NULL`
    )
    await pool.execute(
      'CREATE INDEX idx_meta_objects_campaign_user ON campaign_meta_objects (campaign_id, created_for_user_id)'
    )
    console.log('  + Added created_for_user_id to campaign_meta_objects')
  } else {
    console.log('  ~ created_for_user_id already exists')
  }

  const [objIdx] = await pool.execute(
    "SHOW INDEX FROM campaign_meta_objects WHERE Key_name = 'uk_meta_objects_object'"
  )
  if (objIdx.length === 0) {
    await pool.execute(
      'CREATE UNIQUE INDEX uk_meta_objects_object ON campaign_meta_objects (object_id)'
    )
    console.log('  + Added unique index uk_meta_objects_object on campaign_meta_objects.object_id')
  } else {
    console.log('  ~ uk_meta_objects_object already exists')
  }
}

export async function down({ context: pool }) {
  const [objIdx] = await pool.execute(
    "SHOW INDEX FROM campaign_meta_objects WHERE Key_name = 'uk_meta_objects_object'"
  )
  if (objIdx.length > 0) {
    await pool.execute('ALTER TABLE campaign_meta_objects DROP INDEX uk_meta_objects_object')
  }

  const [cols] = await pool.execute(
    "SHOW COLUMNS FROM campaign_meta_objects LIKE 'created_for_user_id'"
  )
  if (cols.length > 0) {
    await pool.execute('ALTER TABLE campaign_meta_objects DROP FOREIGN KEY fk_meta_objects_user')
    await pool.execute('ALTER TABLE campaign_meta_objects DROP INDEX idx_meta_objects_campaign_user')
    await pool.execute('ALTER TABLE campaign_meta_objects DROP COLUMN created_for_user_id')
    console.log('  - Removed created_for_user_id and uk_meta_objects_object')
  }
}

export default { up, down }
