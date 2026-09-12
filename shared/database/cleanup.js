import { runRetentionSweep } from './retention.js';

/**
 * CLI retention cleanup (npm run db:cleanup). Thin delegate — the single
 * retention-policy authority is shared/database/retention.js (TABLE_PURGES
 * registry). No retention predicates live here.
 */
async function runCleanup() {
  try {
    console.log(`[cleanup] Starting at ${new Date().toISOString()}`);
    const result = await runRetentionSweep();
    for (const [table, r] of Object.entries(result.tables)) {
      if (r.rowsDeleted > 0) {
        console.log(`[cleanup] ${table}: purged ${r.rowsDeleted} rows in ${r.batches} batch(es)${r.partial ? ' (PARTIAL — backlog remains)' : ''}`);
      }
    }
    if (result.partial.length > 0) {
      console.warn(`[cleanup] PARTIAL run — backlog remains in: ${result.partial.join(', ')}`);
    } else {
      console.log('[cleanup] All retention tables complete');
    }
    console.log(`[cleanup] Complete: ${result.rowsDeleted} rows in ${result.durationMs}ms`);
  } catch (error) {
    console.error('[cleanup] Failed:', error.message);
    process.exitCode = 1;
  } finally {
    const { closePool } = await import('./connection.js');
    await closePool();
  }
}

runCleanup();
