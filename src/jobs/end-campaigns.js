import dotenv from 'dotenv'
dotenv.config()

import { closePool } from '../../shared/database/connection.js'
import { endExpiredCampaigns } from '../modules/campaigns/campaign.service.js'

async function main() {
  const results = await endExpiredCampaigns()
  console.log(`[end-campaigns] Ended ${results.length} campaigns`)
  for (const r of results) {
    console.log(`  ${r.success ? 'ENDED' : 'FAILED'} ${r.campaignId}${r.error ? ': ' + r.error : ''}`)
  }
  await closePool()
}

main().catch((err) => {
  console.error('[end-campaigns] Fatal:', err)
  process.exit(1)
})