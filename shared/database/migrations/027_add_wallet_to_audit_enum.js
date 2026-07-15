export async function up({ context: pool }) {
  await pool.query(
    "ALTER TABLE audit_logs MODIFY COLUMN entity_type ENUM('user','role','oauth_account','session','wallet') DEFAULT NULL"
  );
  console.log('  + Added wallet to audit_logs.entity_type ENUM');
}

export async function down({ context: pool }) {
  await pool.query(
    "ALTER TABLE audit_logs MODIFY COLUMN entity_type ENUM('user','role','oauth_account','session') DEFAULT NULL"
  );
  console.log('  - Removed wallet from audit_logs.entity_type ENUM');
}

export default { up, down };
