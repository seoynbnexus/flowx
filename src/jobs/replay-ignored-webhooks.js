import dotenv from 'dotenv'
dotenv.config()

import { closePool } from '../../shared/database/connection.js'
import { requeueAutoJob } from '../modules/campaigns/campaign.repository.js'
import { findPostTargetByExternalId } from '../modules/campaigns/campaign.repository.js'
import { CAMPAIGN_JOB_TYPES } from '../modules/campaigns/campaign.model.js'

const execute = process.argv.includes('--execute')
const dryRun = !execute

async function main() {
  const { query } = await import('../../shared/database/connection.js')

  const events = await query(
    `SELECT id, provider_event_key, external_object_id, payload
     FROM meta_webhook_events
     WHERE processing_status = 'ignored' AND event_type = 'feed'
     AND payload IS NOT NULL AND payload != ''
     ORDER BY event_time DESC`
  )

  console.log(`Found ${events.length} ignored feed events`)
  if (!events.length) {
    console.log('No events to process')
    return
  }

  let matchable = 0
  let matched = 0
  let noPhotoId = 0
  let noTarget = 0
  let queued = 0

  for (const ev of events) {
    let payload
    try {
      payload = typeof ev.payload === 'string' ? JSON.parse(ev.payload) : ev.payload
    } catch {
      continue
    }
    const val = payload?.value || payload

    if (!val?.photo_id) {
      noPhotoId++
      continue
    }

    matchable++

    const target = await findPostTargetByExternalId(val.photo_id, 'facebook')

    if (!target) {
      noTarget++
      continue
    }

    matched++

    if (dryRun) {
      console.log(`  [dry-run] would replay: event=${ev.id} photo_id=${val.photo_id} → target=${target.id} post=${target.post_id} (${target.status})`)
      queued++
      continue
    }

    await query(
      `UPDATE meta_webhook_events
       SET processing_status = 'received', attempts = 0, last_error = NULL, next_attempt_at = NULL
       WHERE id = ?`,
      [ev.id]
    )

    const runKey = ev.provider_event_key
      ? `webhook:${ev.provider_event_key.slice(0, 32)}`
      : `webhook:${ev.id}`

    await requeueAutoJob(null, CAMPAIGN_JOB_TYPES.META_WEBHOOK,
      { eventId: ev.id, providerEventKey: ev.provider_event_key },
      { runKey, entityType: 'system' }
    )

    queued++
    console.log(`  [execute] replayed: event=${ev.id} photo_id=${val.photo_id} → target=${target.id} post=${target.post_id}`)
  }

  console.log(`\nSummary:`)
  console.log(`  Total ignored feed events: ${events.length}`)
  console.log(`  Events with photo_id in payload: ${matchable}`)
  console.log(`  Events with matching target: ${matched}`)
  console.log(`  Events without photo_id (reactions/comments): ${noPhotoId}`)
  console.log(`  Events with photo_id but no matching target: ${noTarget}`)
  console.log(`  ${dryRun ? 'Would replay' : 'Replayed'}: ${queued}`)
}

try {
  await main()
} finally {
  await closePool()
  process.exit(0)
}
