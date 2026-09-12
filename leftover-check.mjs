import mysql from 'mysql2/promise'
// connect before teardown drops it — same DB the suite uses
const conn = await mysql.createConnection({ host: 'localhost', user: 'root', password: '', database: 'flowx_test' })
const [rows] = await conn.query("SELECT job_type, status, run_key, run_after FROM campaign_jobs WHERE status IN ('queued','running')")
console.log('active jobs left after floor file:', rows.length)
for (const r of rows) console.log(r.job_type, r.status, r.run_key, String(r.run_after))
await conn.end()
