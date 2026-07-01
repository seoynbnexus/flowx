import dotenv from 'dotenv';
dotenv.config();

import { getPool, closePool, query } from '../../shared/database/connection.js';
import { bufferToUuid } from '../../shared/utils/uuid.utils.js';
import { decrypt, encrypt } from '../../shared/utils/crypto.utils.js';
import { exchangeForLongLivedToken, debugToken } from '../../shared/services/meta-auth.service.js';

async function refreshExpiringTokens() {
  const pool = getPool();
  console.log('[Token Refresh] Starting token refresh check...');

  try {
    const rows = await query(
      `SELECT * FROM user_platform_accounts
       WHERE token_status = 'active'
         AND access_token IS NOT NULL
         AND token_expires_at IS NOT NULL
         AND token_expires_at < DATE_ADD(NOW(), INTERVAL 30 DAY)`
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

        const debug = await debugToken(accessToken);

        if (debug.data?.is_valid) {
          const expiresAt = debug.data?.expires_at;
          if (expiresAt) {
            const expiresDate = new Date(expiresAt * 1000);
            await query(
              `UPDATE user_platform_accounts SET token_expires_at = ?, updated_at = NOW() WHERE id = ?`,
              [expiresDate, row.id]
            );
            console.log(`[Token Refresh] Account ${accountId}: token valid until ${expiresDate.toISOString()}`);
            continue;
          }
        }

        const longLivedData = await exchangeForLongLivedToken(accessToken);
        const newToken = longLivedData.access_token;
        const expiresIn = longLivedData.expires_in;

        if (newToken) {
          const tokenExpiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000) : null;
          await query(
            `UPDATE user_platform_accounts
             SET access_token = ?, token_expires_at = ?, token_issued_at = NOW(), updated_at = NOW()
             WHERE id = ?`,
            [encrypt(newToken), tokenExpiresAt, row.id]
          );
          refreshed++;
          console.log(`[Token Refresh] Account ${accountId}: token refreshed`);
        } else {
          throw new Error('No token returned from refresh');
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
