import dotenv from 'dotenv'
dotenv.config()

import { closePool } from '../../shared/database/connection.js'
import { activateDueScheduledCampaigns } from '../modules/campaigns/campaign.service.js'

async function main() {
  const results = await activateDueScheduledCampaigns()
  console.log(`[activate-scheduled-campaigns] Checked ${results.length} due campaigns`)
  for (const r of results) {
    console.log(`  ${r.success ? 'ACTIVATED' : 'FAILED'} ${r.campaignId}${r.error ? ': ' + r.error : ''}`)
  }
  await closePool()
}

main().catch((err) => {
  console.error('[activate-scheduled-campaigns] Fatal:', err)
  process.exit(1)
})
