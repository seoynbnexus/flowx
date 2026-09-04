import 'dotenv/config'
import { query } from '../../shared/database/connection.js'
import { decrypt } from '../../shared/utils/crypto.utils.js'
import { bufferToUuid } from '../../shared/utils/uuid.utils.js'
import { getSubscribedApps, subscribePage } from '../../shared/services/meta-graph.service.js'
import { logger } from '../../shared/utils/logger.js'

function uuidOf(id) {
  try { return bufferToUuid(id) } catch { return String(id) }
}

export async function checkWebhookSubscriptions() {
  const rows = await query(`
    SELECT upa.*, p.code as platform_code FROM user_platform_accounts upa
    JOIN platforms p ON p.id = upa.platform_id
    WHERE upa.token_type = 'page' AND upa.verification_status = 'verified'
      AND p.code = 'facebook'
      AND upa.platform_user_id NOT LIKE 'dbg\\_%'
      AND upa.platform_user_id NOT LIKE 'dbg\\_page%'
  `)
  const results = []
  for (const row of rows) {
    const platform = row.platform_code
    const logId = uuidOf(row.id)
    const token = row.access_token ? decrypt(row.access_token) : null
    if (!token) {
      results.push({ id: logId, platform, status: 'failed', error: 'no token' })
      continue
    }
    const objectId = row.platform_user_id
    const hasLinkedIg = !!row.instagram_business_account_id
    const expected = hasLinkedIg ? ['feed', 'comments', 'story_insights', 'mentions'] : ['feed']
    let apps = null
    let fetchError = null
    try {
      apps = await getSubscribedApps(objectId, token)
    } catch (e) {
      fetchError = e
    }
    if (fetchError) {
      try {
        await subscribePage(row.platform_user_id, token, expected)
        const fieldsJson = JSON.stringify(expected)
        await query("UPDATE user_platform_accounts SET webhook_status = 'active', webhook_fields = ?, webhook_subscribed_at = NOW(), webhook_last_checked_at = NOW(), webhook_last_error = NULL WHERE id = ?", [fieldsJson, row.id])
        results.push({ id: logId, platform, status: 'active', healed: true, missing: expected, viaFetchError: true })
        logger.info({ webhook: { id: logId, platform, missing: expected } }, 'webhook subscription healed after fetch error')
        continue
      } catch (e2) {
        await query("UPDATE user_platform_accounts SET webhook_last_error = ?, webhook_last_checked_at = NOW() WHERE id = ?", [String(e2.message).slice(0, 1000), row.id])
        results.push({ id: logId, platform, status: 'failed', error: String(e2.message).slice(0, 500) })
        logger.warn({ webhook: { id: logId, platform, error: e2.message } }, 'webhook subscription check failed')
        continue
      }
    }
    const subscribedFields = new Set()
    for (const app of apps || []) {
      const fields = app.subscribed_fields || []
      for (const f of fields) subscribedFields.add(String(f))
    }
    const missing = expected.filter(f => !subscribedFields.has(f))
    if (missing.length === 0) {
      await query('UPDATE user_platform_accounts SET webhook_last_checked_at = NOW() WHERE id = ?', [row.id])
      results.push({ id: logId, platform, status: 'active', checked: true })
      continue
    }
    try {
      await subscribePage(row.platform_user_id, token, expected)
      const fieldsJson = JSON.stringify(expected)
      await query("UPDATE user_platform_accounts SET webhook_status = 'active', webhook_fields = ?, webhook_subscribed_at = NOW(), webhook_last_checked_at = NOW(), webhook_last_error = NULL WHERE id = ?", [fieldsJson, row.id])
      results.push({ id: logId, platform, status: 'active', healed: true, missing })
      logger.info({ webhook: { id: logId, platform, missing } }, 'webhook subscription healed')
    } catch (e) {
      await query("UPDATE user_platform_accounts SET webhook_last_error = ?, webhook_last_checked_at = NOW() WHERE id = ?", [String(e.message).slice(0, 1000), row.id])
      results.push({ id: logId, platform, status: 'failed', error: String(e.message).slice(0, 500) })
      logger.warn({ webhook: { id: logId, platform, error: e.message } }, 'webhook subscription heal failed')
    }
  }
  return {
    total: rows.length,
    healed: results.filter(r => r.healed).length,
    active: results.filter(r => r.status === 'active').length,
    failed: results.filter(r => r.status === 'failed').length,
    results,
  }
}

export default { checkWebhookSubscriptions }
