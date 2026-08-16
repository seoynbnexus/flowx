import { query } from '../../../shared/database/connection.js'

const postId = '019ffb27-f659-755f-993a-3bc7d6e8dd7e'

while (true) {
  const rows = await query(
    `SELECT j.id, j.status, j.attempts, j.run_after, LEFT(IFNULL(j.error,''), 260) AS error
     FROM campaign_jobs j WHERE j.campaign_id = UNHEX(REPLACE(?, '-', '')) AND j.job_type = 'post_publish'
     ORDER BY j.created_at DESC LIMIT 3`,
    [postId]
  )
  const jobs = rows.map(r => ({ id: r.id.toString('hex'), status: r.status, attempts: r.attempts, error: r.error }))
  console.log('TS', new Date().toISOString(), JSON.stringify(jobs))

  const targets = await query(
    `SELECT p.code AS platform, pt.status, pt.publish_state, pt.meta_object_id, pt.remote_video_id,
            LEFT(IFNULL(pt.error,''), 200) AS error
     FROM post_targets pt
     JOIN user_platform_accounts upa ON upa.id = pt.platform_account_id
     JOIN platforms p ON p.id = upa.platform_id
     WHERE pt.post_id = UNHEX(REPLACE(?, '-', ''))`,
    [postId]
  )
  console.log('   targets:', JSON.stringify(targets.map(t => ({ platform: t.platform, status: t.status, publish_state: t.publish_state, meta_object_id: t.meta_object_id, err: t.error }))))

  const active = jobs.some(j => j.status === 'queued' || j.status === 'running')
  const anyPublished = targets.some(t => t.status === 'posted')
  if (!active && (anyPublished || jobs.some(j => j.status === 'dead'))) {
    console.log('RESOLVED')
    process.exit(0)
  }
  await new Promise(r => setTimeout(r, 15000))
}