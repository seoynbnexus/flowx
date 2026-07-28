import { query, queryOne } from '../../shared/database/connection.js'
import { uuidToBuffer } from '../../shared/utils/uuid.utils.js'

export async function createTestWallet(userId, coins = 10000) {
  await query(
    'INSERT INTO user_wallets (user_id, coins, total_purchased_coins) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE coins = coins',
    [uuidToBuffer(userId), coins, 0]
  )
}

export async function getWalletCoins(userId) {
  const row = await queryOne('SELECT coins FROM user_wallets WHERE user_id = ?', [uuidToBuffer(userId)])
  return row ? row.coins : null
}
