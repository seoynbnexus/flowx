import dotenv from 'dotenv'
dotenv.config()

import { closePool } from '../../shared/database/connection.js'
import { handleExpiredAwaitingCampaigns } from '../modules/campaigns/campaign.service.js'

async function main() {
  const results = await handleExpiredAwaitingCampaigns()
  console.log(`[handle-awaiting-publishers] Checked ${results.length} expired campaigns`)
  for (const r of results) {
    console.log(`  ${r.success ? 'EXPIRED' : 'FAILED'} ${r.campaignId}${r.error ? ': ' + r.error : ''}`)
  }
  await closePool()
}

main().catch((err) => {
  console.error('[handle-awaiting-publishers] Fatal:', err)
  process.exit(1)
})
