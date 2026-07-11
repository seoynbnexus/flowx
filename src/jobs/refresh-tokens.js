import dotenv from 'dotenv';
dotenv.config();

import { getPool, closePool, query } from '../../shared/database/connection.js';
import { bufferToUuid } from '../../shared/utils/uuid.utils.js';
import { decrypt, encrypt } from '../../shared/utils/crypto.utils.js';
import { exchangeForLongLivedToken, debugToken } from '../../shared/services/meta-auth.service.js';

const REFRESH_STRATEGIES = {

  meta_exchange: async (accessToken) => {
    const debug = await debugToken(accessToken)

    if (debug.data?.is_valid) {
      const expiresAt = debug.data?.expires_at
      if (expiresAt) {
        return { token: accessToken, expiresAt: new Date(expiresAt * 1000) }
      }
    }

    const longLivedData = await exchangeForLongLivedToken(accessToken)
    const newToken = longLivedData.access_token
    if (!newToken) {
      throw new Error('No token returned from exchange')
    }

    const expiresIn = longLivedData.expires_in
    return {
      token: newToken,
      expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000) : null,
    }
  },

  none: async () => null,

}

async function refreshExpiringTokens() {
  const pool = getPool();
  console.log('[Token Refresh] Starting token refresh check...');

  try {
    const rows = await query(
      `SELECT a.id, a.access_token, a.token_expires_at,
              p.code as platform_code, p.token_refresh_strategy
       FROM user_platform_accounts a
       JOIN platforms p ON p.id = a.platform_id
       WHERE a.token_status = 'active'
         AND a.access_token IS NOT NULL
         AND a.token_expires_at IS NOT NULL
         AND a.token_expires_at < DATE_ADD(NOW(), INTERVAL 30 DAY)
         AND p.token_refresh_strategy IS NOT NULL
         AND p.token_refresh_strategy != 'none'`
    );

    console.log(`[Token Refresh] Found ${rows.length} tokens approaching expiry`);

    let refreshed = 0;
    let failed = 0;

    for (const row of rows) {
      try {
        const accountId = bufferToUuid(row.id);
        const accessToken = decrypt(row.access_token);

        if (!accessToken) {
          console.log(`[Token Refresh] Account ${accountId}: no access token, skipping`);
          continue;
        }

        const strategy = REFRESH_STRATEGIES[row.token_refresh_strategy];
        if (!strategy) {
          console.log(`[Token Refresh] Account ${accountId}: unknown strategy "${row.token_refresh_strategy}", skipping`);
          continue;
        }

        const result = await strategy(accessToken);

        if (result) {
          await query(
            `UPDATE user_platform_accounts
             SET access_token = ?, token_expires_at = ?, token_issued_at = NOW(), updated_at = NOW()
             WHERE id = ?`,
            [encrypt(result.token), result.expiresAt, row.id]
          );
          refreshed++;
          console.log(`[Token Refresh] Account ${accountId}: refreshed via ${row.token_refresh_strategy}`);
        }
      } catch (error) {
        failed++;
        const accountId = bufferToUuid(row.id);
        console.error(`[Token Refresh] Account ${accountId}: refresh failed - ${error.message}`);
        await query(
          `UPDATE user_platform_accounts SET token_status = 'expired', updated_at = NOW() WHERE id = ?`,
          [row.id]
        );
      }
    }

    console.log(`[Token Refresh] Complete. Refreshed: ${refreshed}, Failed: ${failed}`);
  } catch (error) {
    console.error('[Token Refresh] Error:', error);
  } finally {
    await closePool();
  }
}

refreshExpiringTokens();
