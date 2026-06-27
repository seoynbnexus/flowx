const UP = `
ALTER TABLE user_profiles
  ADD COLUMN pincode VARCHAR(6) DEFAULT NULL AFTER city;
`;

const DOWN = `
ALTER TABLE user_profiles DROP COLUMN pincode;
`;

export async function up({ context: pool }) {
  await pool.execute(UP);
}

export async function down({ context: pool }) {
  await pool.execute(DOWN);
}

export default { up, down };
