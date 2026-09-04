import 'dotenv/config'
import { getPool } from '../../shared/database/connection.js'
import { resubscribeAllWebhooks } from '../modules/campaigns/meta-webhook.service.js'

async function main() {
  const pool = getPool()
  await pool.getConnection()
  const isCheck = process.argv.includes('--check') || process.argv.includes('--verify')
  if (isCheck) {
    const { checkWebhookSubscriptions } = await import('./check-webhook-subscriptions.js')
    console.log('Checking webhook subscriptions...')
    const result = await checkWebhookSubscriptions()
    console.log(`Check done: ${result.active} active, ${result.healed} healed, ${result.failed} failed of ${result.total}`)
    if (result.results.filter(x => x.status === 'failed').length) {
      console.log('Failed:')
      for (const r of result.results.filter(x => x.status === 'failed')) {
        console.log(`  ${r.platform} ${r.id}: ${r.error}`)
      }
    }
    process.exit(result.failed > 0 ? 1 : 0)
  }
  console.log('Resubscribing all Page and Instagram webhooks...')
  const result = await resubscribeAllWebhooks()
  console.log(`Done: ${result.active} active, ${result.failed} failed of ${result.total}`)
  if (result.failed > 0) {
    console.log('Failed:')
    for (const r of result.results.filter(x => x.status === 'failed')) {
      console.log(`  ${r.platform} ${r.id}: ${r.error}`)
    }
  }
  process.exit(result.failed > 0 ? 1 : 0)
}

main().catch(err => {
  console.error('sync-webhooks failed', err)
  process.exit(1)
})
