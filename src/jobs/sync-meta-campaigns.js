import dotenv from 'dotenv'
dotenv.config()

import { closePool } from '../../shared/database/connection.js'
import { syncAllActiveCampaigns } from '../modules/campaigns/campaign.service.js'

async function main() {
  const results = await syncAllActiveCampaigns()
  console.log(`[sync-meta-campaigns] Synced ${results.length} campaigns`)
  for (const r of results) {
    console.log(r)
    if (r.success) {
      const parts = [`${r.campaignId}`]
      if (r.result.statusChanged) parts.push(`status: ${r.result.statusBefore} → ${r.result.statusAfter}`)
      if (r.result.spendUpdated) parts.push(`spend: ${r.result.metaSpendPaise} paise`)
      if (r.result.errors.length) parts.push(`errors: ${r.result.errors.join('; ')}`)
      console.log(`  SYNCED ${parts.join(' | ')}`)
    } else {
      console.log(`  FAILED ${r.campaignId}${r.error ? ': ' + r.error : ''}`)
    }
  }
  await closePool()
}

main().catch((err) => {
  console.error('[sync-meta-campaigns] Fatal:', err)
  process.exit(1)
})
