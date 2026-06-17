import pg from 'pg';
import 'dotenv/config';

const RETENTION_MONTHS = 12;
const PARTITION_MONTHS_AHEAD = 2;

function getNextMonthDate(year, month) {
  if (month === 12) return { year: year + 1, month: 1 };
  return { year, month: month + 1 };
}

function formatMonth(month) {
  return String(month).padStart(2, '0');
}

async function runCleanup() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  try {
    const now = new Date();
    const currentYear = now.getUTCFullYear();
    const currentMonth = now.getUTCMonth() + 1;

    console.log(`[cleanup] Starting at ${now.toISOString()}`);

    // 1. Ensure future partitions exist
    for (let i = 0; i <= PARTITION_MONTHS_AHEAD; i++) {
      const absMonth = currentMonth + i;
      const year = currentYear + Math.floor((absMonth - 1) / 12);
      const month = ((absMonth - 1) % 12) + 1;
      const padded = formatMonth(month);

      const next = getNextMonthDate(year, month);
      const nextPadded = formatMonth(next.month);

      for (const table of ['auth_login_history', 'audit_logs']) {
        const partitionName = `${table}_${year}_${padded}`;
        const exists = await pool.query(`
          SELECT 1 FROM pg_class WHERE relname = $1 AND relkind = 'r'
        `, [partitionName]);

        if (exists.rowCount === 0) {
          await pool.query(`
            CREATE TABLE public.${partitionName}
            PARTITION OF public.${table}
            FOR VALUES FROM ('${year}-${padded}-01') TO ('${next.year}-${nextPadded}-01')
          `);
          console.log(`[cleanup] Created partition: ${partitionName}`);
        }
      }
    }

    // 2. Drop partitions older than retention
    const cutoffYear = currentYear - Math.ceil(RETENTION_MONTHS / 12) - 1;
    const dropResult = await pool.query(`
      SELECT relname FROM pg_class
      WHERE relkind = 'r'
        AND relname ~ '^(auth_login_history|audit_logs)_(\\d{4})_(\\d{2})$'
    `);

    for (const row of dropResult.rows) {
      const match = row.relname.match(/^(auth_login_history|audit_logs)_(\d{4})_(\d{2})$/);
      if (!match) continue;
      const partitionYear = parseInt(match[2], 10);
      const partitionMonth = parseInt(match[3], 10);
      const partitionDate = new Date(partitionYear, partitionMonth, 1);
      const cutoffDate = new Date(now.getFullYear(), now.getMonth() - RETENTION_MONTHS, 1);

      if (partitionDate < cutoffDate) {
        await pool.query(`DROP TABLE IF EXISTS public.${row.relname}`);
        console.log(`[cleanup] Dropped old partition: ${row.relname}`);
      }
    }

    // 3. Purge expired data from non-partitioned tables
    const purges = [
      { table: 'user_sessions', where: 'expires_at < NOW()' },
      { table: 'email_verifications', where: 'expires_at < NOW() - INTERVAL \'1 day\'' },
      { table: 'password_resets', where: 'expires_at < NOW() - INTERVAL \'1 day\'' },
      { table: 'oauth_tokens', where: 'expires_at < NOW() - INTERVAL \'1 day\'' },
    ];

    for (const { table, where } of purges) {
      const result = await pool.query(`DELETE FROM public.${table} WHERE ${where}`);
      if (result.rowCount > 0) {
        console.log(`[cleanup] Purged ${result.rowCount} rows from ${table}`);
      }
    }

    console.log('[cleanup] Complete');
  } finally {
    await pool.end();
  }
}

runCleanup().catch((err) => {
  console.error('[cleanup] Failed:', err.message);
  process.exit(1);
});
