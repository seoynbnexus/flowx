import dotenv from 'dotenv'
dotenv.config()

import { closePool } from '../../shared/database/connection.js'
import * as campaignRepo from '../modules/campaigns/campaign.repository.js'
import { runExecutionBackfill, BACKFILL_CHECKPOINT_KEY, backfillExecutionSnapshots, SNAPSHOT_BACKFILL_CHECKPOINT_KEY } from '../modules/campaigns/campaign-execution.service.js'

function argValue(name) {
  return process.argv.find(a => a.startsWith(`${name}=`))?.split('=')[1] || null
}

const EXECUTE = process.argv.includes('--execute')
const VERIFY = process.argv.includes('--verify')
const SNAPSHOTS = process.argv.includes('--snapshots')
const INCLUDE_QUARANTINED = process.argv.includes('--include-quarantined')
const BATCH = Math.max(1, Math.min(200, Number(argValue('--batch')) || 25))
const MAX_BATCHES = argValue('--max-batches') === null ? null : Math.max(1, Number(argValue('--max-batches')))
const ONLY_CAMPAIGN = argValue('--campaign')
const AFTER_ARG = argValue('--after')

async function mainSnapshots() {
  const mode = EXECUTE ? 'execute' : 'dry-run'
  console.log(`campaign execution snapshots backfill (${mode})`)
  const afterId = AFTER_ARG || (EXECUTE ? (await loadCheckpointFor(SNAPSHOT_BACKFILL_CHECKPOINT_KEY)) : null)
  if (afterId) console.log(`resuming after ${afterId}`)
  const summary = await backfillExecutionSnapshots({
    batch: BATCH,
    afterId,
    execute: EXECUTE,
    maxBatches: MAX_BATCHES,
    onEvent: event => {
      if (event.type === 'snapshot-skipped') {
        console.log(`skipped ${short(event.campaignId)} reason=${event.reason}`)
      } else if (event.type === 'snapshot-plan') {
        console.log(`[dry-run] freeze snapshot ${short(event.campaignId)}`)
      } else if (event.type === 'snapshot-frozen') {
        console.log(`frozen snapshot ${short(event.campaignId)}`)
      } else if (event.type === 'batch' && EXECUTE) {
        campaignRepo.saveMetaSyncState(SNAPSHOT_BACKFILL_CHECKPOINT_KEY, { afterId: event.afterId }).catch(err => {
          console.error(`checkpoint write failed: ${err.message}`)
        })
      }
    },
  })
  console.log(
    `snapshots backfill ${mode} complete: campaigns=${summary.campaigns} frozen=${summary.frozen} ` +
    `stamped=${summary.stamped} skipped=${summary.skipped.length}`
  )
  await closePool()
}

async function loadCheckpointFor(key) {
  if (AFTER_ARG) return AFTER_ARG
  try {
    const state = await campaignRepo.getMetaSyncState(key)
    return state?.afterId || null
  } catch {
    return null
  }
}

function short(id) {
  return id ? id.substring(0, 8) : 'none'
}

async function main() {
  if (SNAPSHOTS) {
    await mainSnapshots()
    return
  }
  const mode = VERIFY && !EXECUTE ? 'verify' : EXECUTE ? 'execute' : 'dry-run'
  console.log(`campaign executions backfill (${mode})`)
  const afterId = ONLY_CAMPAIGN ? null : VERIFY && !EXECUTE ? AFTER_ARG : await loadCheckpointFor(BACKFILL_CHECKPOINT_KEY)
  if (afterId) console.log(`resuming after ${afterId}`)

  const summary = await runExecutionBackfill({
    execute: EXECUTE,
    verify: VERIFY && !EXECUTE,
    batch: BATCH,
    afterId,
    onlyCampaign: ONLY_CAMPAIGN,
    includeQuarantined: INCLUDE_QUARANTINED,
    maxBatches: MAX_BATCHES,
    onEvent: event => {
      if (event.type === 'quarantined') {
        console.log(`quarantined ${short(event.campaignId)} reason=${event.reason} plans=${event.plans}`)
      } else if (event.type === 'plan' && !EXECUTE) {
        const plan = event.plan
        console.log(`[dry-run] plan ${short(plan.campaignId)} ${short(plan.ownerUserId)}:${plan.kind} status=${plan.status} chain=${plan.hasChain ? 'yes' : 'no'}`)
      } else if (event.type === 'divergent') {
        console.log(`${event.type} ${short(event.campaignId)} ${short(event.ownerUserId)}:${event.kind}`)
      } else if (event.type === 'batch' && EXECUTE && !ONLY_CAMPAIGN) {
        campaignRepo.saveMetaSyncState(BACKFILL_CHECKPOINT_KEY, { afterId: event.afterId }).catch(err => {
          console.error(`checkpoint write failed: ${err.message}`)
        })
      }
    },
  })

  console.log(
    `backfill ${mode} complete: campaigns=${summary.campaigns} planned=${summary.planned} ` +
    `created=${summary.created} existing=${summary.existing} quarantined=${summary.skipped.length} divergent=${summary.divergent.length}`
  )

  if (EXECUTE && !VERIFY) {
    console.log('running mandatory post-execute verification')
    const verification = await runExecutionBackfill({
      execute: false,
      verify: true,
      batch: BATCH,
      afterId: null,
      onlyCampaign: ONLY_CAMPAIGN,
      includeQuarantined: INCLUDE_QUARANTINED,
      onEvent: event => {
        if (event.type === 'divergent') {
          console.log(`post-verify ${event.type} ${short(event.campaignId)} ${short(event.ownerUserId)}:${event.kind}`)
        }
      },
    })
    console.log(`post-execute verification: divergent=${verification.divergent.length}`)
    summary.divergent = verification.divergent
  }

  await closePool()
  if (summary.divergent.length > 0) {
    console.error(`FAIL: ${summary.divergent.length} unexplained reconciliation differences`)
    process.exitCode = 1
  }
}

main().catch(async err => {
  console.error(`backfill failed: ${err.message}`)
  await closePool()
  process.exit(1)
})
