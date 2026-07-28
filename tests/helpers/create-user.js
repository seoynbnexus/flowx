import bcrypt from 'bcryptjs'
import { query } from '../../shared/database/connection.js'
import { generateUuid, uuidToBuffer } from '../../shared/utils/uuid.utils.js'

export async function createTestUser({
  email,
  password,
  role = 'client',
  coins = null,
  status = 'active',
}) {
  const userId = generateUuid()
  const profileId = generateUuid()
  const passwordHash = await bcrypt.hash(password, 4)
  const userIdBuf = uuidToBuffer(userId)
  const profileIdBuf = uuidToBuffer(profileId)

  await query(
    'INSERT INTO users (id, email, status, email_verified_at) VALUES (?, ?, ?, NOW())',
    [userIdBuf, email, status]
  )
  await query(
    'INSERT INTO user_passwords (user_id, password_hash) VALUES (?, ?)',
    [userIdBuf, passwordHash]
  )
  await query(
    'INSERT INTO user_profiles (id, user_id, first_name, last_name) VALUES (?, ?, ?, ?)',
    [profileIdBuf, userIdBuf, 'Test', 'User']
  )

  const [roleRows] = await query('SELECT id FROM roles WHERE code = ?', [role])
  if (roleRows && roleRows.length > 0) {
    await query(
      'INSERT INTO user_roles (id, user_id, role_id) VALUES (?, ?, ?)',
      [uuidToBuffer(generateUuid()), userIdBuf, roleRows[0].id]
    )
  }

  if (coins !== null) {
    await query(
      'INSERT INTO user_wallets (user_id, coins, total_purchased_coins) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE coins = COALESCE(?, coins)',
      [userIdBuf, coins, 0, coins]
    )
  }

  return { id: userId, email }
}

export async function createTestUsers(users) {
  return Promise.all(users.map(u => createTestUser(u)))
}
