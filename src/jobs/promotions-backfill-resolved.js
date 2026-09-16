import dotenv from 'dotenv'
dotenv.config()

import { closePool } from '../../shared/database/connection.js'
import * as promoRepo from '../modules/posts/promotion.repository.js'
import { backfillPromotionSnapshot } from '../modules/posts/promotion.service.js'

const BATCH = Math.max(1, Math.min(100, Number(process.argv.find((a) => a.startsWith('--batch='))?.split('=')[1]) || 25))

async function main() {
  let resolved = 0
  let unresolved = 0
  let skipped = 0
  let afterId = null
  for (;;) {
    const batch = await promoRepo.findPromotionsNeedingResolution(BATCH, afterId)
    if (!batch.length) break
    for (const promotion of batch) {
      afterId = promotion.id
      try {
        const outcome = await backfillPromotionSnapshot(promotion.id)
        if (outcome.status === 'resolved') resolved += 1
        else if (outcome.status === 'unresolved') unresolved += 1
        else skipped += 1
        console.log(`${outcome.status} promotion ${outcome.id}${outcome.failures ? ` (${outcome.failures} failures)` : ''}`)
      } catch (err) {
        skipped += 1
        console.error(`error promotion ${promotion.id}: ${err.message}`)
      }
    }
  }
  console.log(`backfill complete: resolved=${resolved} unresolved=${unresolved} skipped=${skipped}`)
  await closePool()
}

main().catch(async (err) => {
  console.error(`backfill failed: ${err.message}`)
  await closePool()
  process.exit(1)
})
