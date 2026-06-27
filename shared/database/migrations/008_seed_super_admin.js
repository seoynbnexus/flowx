import bcrypt from 'bcryptjs';
import { v7 as generateUuid } from 'uuid';

function uuidToBuffer(uuid) {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

const SUPER_ADMIN_EMAIL = process.env.SUPER_ADMIN_EMAIL || 'admin@flowx.com';
const SUPER_ADMIN_PASSWORD = process.env.SUPER_ADMIN_PASSWORD || 'Admin@123';
const SALT_ROUNDS = parseInt(process.env.SALT || '10', 10);

export async function up({ context: pool }) {
  const [existing] = await pool.execute(
    `SELECT u.id FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles r ON r.id = ur.role_id
     WHERE r.code = 'super_admin' AND u.email = ?`,
    [SUPER_ADMIN_EMAIL]
  );

  if (existing.length > 0) {
    console.log(`Super admin "${SUPER_ADMIN_EMAIL}" already exists, skipping.`);
    return;
  }

  const userId = generateUuid();
  const profileId = generateUuid();
  const passwordHash = await bcrypt.hash(SUPER_ADMIN_PASSWORD, SALT_ROUNDS);
  const userIdBuf = uuidToBuffer(userId);
  const profileIdBuf = uuidToBuffer(profileId);

  await pool.execute(
    `INSERT INTO users (id, email, phone, status, email_verified_at)
     VALUES (?, ?, NULL, 'active', NOW())`,
    [userIdBuf, SUPER_ADMIN_EMAIL]
  );

  await pool.execute(
    `INSERT INTO user_passwords (user_id, password_hash)
     VALUES (?, ?)`,
    [userIdBuf, passwordHash]
  );

  await pool.execute(
    `INSERT INTO user_profiles (id, user_id, first_name, last_name)
     VALUES (?, ?, 'Super', 'Admin')`,
    [profileIdBuf, userIdBuf]
  );

  await pool.execute(
    `INSERT INTO user_roles (id, user_id, role_id)
     SELECT ?, ?, r.id FROM roles r WHERE r.code = 'super_admin'`,
    [uuidToBuffer(generateUuid()), userIdBuf]
  );

  console.log(`Super admin "${SUPER_ADMIN_EMAIL}" seeded successfully.`);
}

export async function down({ context: pool }) {
  const [users] = await pool.execute(
    `SELECT u.id FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles r ON r.id = ur.role_id
     WHERE r.code = 'super_admin' AND u.email = ?`,
    [SUPER_ADMIN_EMAIL]
  );

  if (users.length === 0) return;

  const id = users[0].id;
  await pool.execute('DELETE FROM user_sessions WHERE user_id = ?', [id]);
  await pool.execute('DELETE FROM user_roles WHERE user_id = ?', [id]);
  await pool.execute('DELETE FROM user_profiles WHERE user_id = ?', [id]);
  await pool.execute('DELETE FROM user_passwords WHERE user_id = ?', [id]);
  await pool.execute('DELETE FROM users WHERE id = ?', [id]);

  console.log(`Super admin "${SUPER_ADMIN_EMAIL}" removed.`);
}

export default { up, down };
