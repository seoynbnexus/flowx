import { query, queryOne } from './connection.js'
import { logger } from '../utils/logger.js'

/**
 * Single retention-policy authority. Every purgeable table is defined ONCE
 * here — cleanup.js (CLI), campaign.repository.js delegates and
 * runJobMaintenance all route through this registry. No duplicate predicates.
 *
 * post_engagement_daily DUAL-USE (documented, deliberate):
 * it stores historical daily lifetime-snapshot samples AND serves as the
 * effective current-state read model (PostTarget carries no metric columns;
 * reads take the latest row per target). Its 90-day purge is pre-existing
 * product policy — batching it here is a lock-safety change only.
 */

const clampDays = (raw, fallback) => {
  const n = Math.floor(Number(raw))
  if (!Number.isFinite(n) || n < 1) return fallback
  return n
}
export const _clampDays = clampDays

const clampBatch = (raw, fallback) => {
  const n = Math.floor(Number(raw))
  if (!Number.isFinite(n) || n < 1) return fallback
  return n
}
export const _clampBatch = clampBatch

const JOB_RETENTION_DAYS = clampDays(process.env.JOB_RETENTION_DAYS, 7)
const ENGAGEMENT_RETENTION_DAYS = clampDays(process.env.ENGAGEMENT_RETENTION_DAYS, 90)
const WEBHOOK_RETENTION_DAYS = clampDays(process.env.WEBHOOK_RETENTION_DAYS, 30)
const META_SNAPSHOT_RETENTION_DAYS = clampDays(process.env.META_SNAPSHOT_RETENTION_DAYS, 30)
const AUDIT_RETENTION_DAYS = clampDays(process.env.AUDIT_RETENTION_DAYS, 365)
const AUTH_LOGIN_HISTORY_RETENTION_DAYS = clampDays(process.env.AUTH_LOGIN_HISTORY_RETENTION_DAYS, 365)

export const retentionOptions = {
  deleteBatch: clampBatch(process.env.RETENTION_DELETE_BATCH, 5000),
  maxBatchesPerRun: clampBatch(process.env.RETENTION_MAX_BATCHES_PER_RUN, 50),
}

export const RETENTION_TABLES = Object.freeze({
  campaignJobs: 'campaign_jobs',
  postEngagementDaily: 'post_engagement_daily',
  metaWebhookEvents: 'meta_webhook_events',
  metaAccountSnapshots: 'meta_account_snapshots',
  userSessions: 'user_sessions',
  emailVerifications: 'email_verifications',
  passwordResets: 'password_resets',
  phoneOtps: 'phone_otps',
  emailOtps: 'email_otps',
  oauthTokens: 'oauth_tokens',
  auditLogs: 'audit_logs',
  authLoginHistory: 'auth_login_history',
})

const intervalDay = (days) => `NOW() - INTERVAL ${days} DAY`

/**
 * Predicate building is centralized here. Each entry receives the clamped
 * TTL days and returns the exact WHERE clause; days are sanitized integers
 * (never env strings) so interpolation is safe.
 */
export const TABLE_PURGES = [
  {
    table: RETENTION_TABLES.campaignJobs,
    retentionDays: JOB_RETENTION_DAYS,
    predicate: (days) => `status IN ('done','dead') AND finished_at < ${intervalDay(days)}`,
  },
  {
    table: RETENTION_TABLES.postEngagementDaily,
    retentionDays: ENGAGEMENT_RETENTION_DAYS,
    predicate: (days) => `created_at < ${intervalDay(days)}`,
  },
  {
    table: RETENTION_TABLES.metaWebhookEvents,
    retentionDays: WEBHOOK_RETENTION_DAYS,
    predicate: (days) => `created_at < ${intervalDay(days)}`,
  },
  {
    table: RETENTION_TABLES.metaAccountSnapshots,
    retentionDays: META_SNAPSHOT_RETENTION_DAYS,
    predicate: (days) => `created_at < ${intervalDay(days)}`,
  },
  {
    table: RETENTION_TABLES.userSessions,
    predicate: () => `expires_at < NOW()`,
  },
  {
    table: RETENTION_TABLES.emailVerifications,
    predicate: () => `expires_at < ${intervalDay(1)}`,
  },
  {
    table: RETENTION_TABLES.passwordResets,
    predicate: () => `expires_at < ${intervalDay(1)}`,
  },
  {
    table: RETENTION_TABLES.phoneOtps,
    predicate: () => `(used_at IS NOT NULL OR expires_at < NOW()) AND created_at < ${intervalDay(1)}`,
  },
  {
    table: RETENTION_TABLES.emailOtps,
    predicate: () => `(used_at IS NOT NULL OR expires_at < NOW()) AND created_at < ${intervalDay(1)}`,
  },
  {
    table: RETENTION_TABLES.oauthTokens,
    predicate: () => `expires_at < ${intervalDay(1)}`,
  },
  {
    table: RETENTION_TABLES.auditLogs,
    retentionDays: AUDIT_RETENTION_DAYS,
    predicate: (days) => `created_at < ${intervalDay(days)}`,
  },
  {
    table: RETENTION_TABLES.authLoginHistory,
    retentionDays: AUTH_LOGIN_HISTORY_RETENTION_DAYS,
    predicate: (days) => `created_at < ${intervalDay(days)}`,
  },
]

const stateKeyFor = (table) => `retention:${table}`

async function readRetentionState(table) {
  const row = await queryOne('SELECT state FROM meta_sync_state WHERE run_key = ?', [stateKeyFor(table)])
  if (!row) return null
  try {
    const state = typeof row.state === 'string' ? JSON.parse(row.state) : row.state
    return state || null
  } catch {
    return null
  }
}

async function writeRetentionState(table, state) {
  try {
    await query(
      `INSERT INTO meta_sync_state (run_key, state) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE state = VALUES(state), updated_at = NOW()`,
      [stateKeyFor(table), JSON.stringify(state)]
    )
  } catch (err) {
    logger.warn({ err: err?.message, table }, 'Retention state write failed (telemetry only)')
  }
}

/**
 * Bounded, resumable, idempotent purge for one table.
 *
 * MariaDB constraint (confirmed in this repository): a bound `LIMIT ?`
 * parameter is treated as `LIMIT 1` — the same reason claimDueCampaignJobs
 * interpolates a sanitized integer. Here `retentionOptions.deleteBatch` is
 * clamped at module load (finite integer >= 1), never an env string, so
 * interpolation is safe and can never produce an unbounded delete.
 *
 * `complete` comes ONLY from the independent residual existence probe —
 * never inferred from `capped`. `backlogRows` COUNT is diagnostic-only and
 * its failure never fails the purge (returns null instead).
 *
 * Telemetry (state write, COUNT) failures are logged and swallowed; the
 * purge result reflects only the actual deletion work done.
 */
export async function runTablePurge(entry, options = {}) {
  const batchLimit = clampBatch(options.deleteBatch, retentionOptions.deleteBatch)
  const maxBatches = clampBatch(options.maxBatchesPerRun, retentionOptions.maxBatchesPerRun)
  const days = clampDays(entry.retentionDays ?? 1, 1)
  const where = entry.predicate(days)

  const startedAt = Date.now()
  let rowsDeleted = 0
  let batches = 0
  let lastBatchFull = false
  while (batches < maxBatches) {
    const result = await query(
      `DELETE FROM ${entry.table} WHERE ${where} LIMIT ${batchLimit}`
    )
    const affected = result.affectedRows || 0
    batches += 1
    rowsDeleted += affected
    lastBatchFull = affected >= batchLimit
    if (affected < batchLimit) break
  }
  // capped = the batch ceiling was the binding constraint: we executed the
  // maximum number of batches AND the last one deleted a full batch (work
  // may remain). A final partial batch means the table was exhausted first.
  const capped = batches >= maxBatches && lastBatchFull

  let complete = false
  try {
    const residual = await queryOne(`SELECT 1 FROM ${entry.table} WHERE ${where} LIMIT 1`)
    complete = !residual
  } catch (err) {
    logger.warn({ err: err?.message, table: entry.table }, 'Retention residual probe failed')
    complete = false
  }

  let backlogRows = null
  if (capped) {
    try {
      const row = await queryOne(`SELECT COUNT(*) AS c FROM ${entry.table} WHERE ${where}`)
      backlogRows = Number(row?.c) || 0
    } catch (err) {
      logger.warn({ err: err?.message, table: entry.table }, 'Retention backlog COUNT failed (diagnostic only)')
      backlogRows = null
    }
  } else {
    backlogRows = complete ? 0 : null
  }

  let consecutivePartialRuns = 0
  try {
    const previous = await readRetentionState(entry.table)
    consecutivePartialRuns = complete ? 0 : ((Number(previous?.consecutivePartialRuns) || 0) + 1)
    await writeRetentionState(entry.table, {
      lastRunAt: new Date().toISOString(),
      lastRowsDeleted: rowsDeleted,
      lastCapped: capped,
      lastComplete: complete,
      lastBacklogRows: backlogRows,
      lastBatches: batches,
      lastDurationMs: Date.now() - startedAt,
      consecutivePartialRuns,
    })
  } catch (err) {
    logger.warn({ err: err?.message, table: entry.table }, 'Retention state tracking failed (telemetry only)')
  }

  return {
    table: entry.table,
    removed: rowsDeleted,
    rowsDeleted,
    batches,
    durationMs: Date.now() - startedAt,
    capped,
    complete,
    partial: !complete,
    backlogRows,
    consecutivePartialRuns,
  }
}

export function findTablePurge(table) {
  return TABLE_PURGES.find((e) => e.table === table) || null
}

/**
 * Full sweep over exactly the 12 registry entries. Sequential on purpose:
 * each table's work is independent and bounded; running them serially keeps
 * maintenance I/O predictable on a shared pool. Telemetry failures never
 * propagate — a table that throws is recorded as partial with the error,
 * and the sweep continues.
 */
export async function runRetentionSweep(options = {}) {
  const startedAt = Date.now()
  const tables = {}
  const partial = []
  let removed = 0
  let batches = 0

  for (const entry of TABLE_PURGES) {
    let result
    try {
      result = await runTablePurge(entry, options)
    } catch (err) {
      logger.warn({ err: err?.message, table: entry.table }, 'Retention purge failed')
      result = {
        table: entry.table,
        removed: 0,
        rowsDeleted: 0,
        batches: 0,
        durationMs: 0,
        capped: false,
        complete: false,
        partial: true,
        backlogRows: null,
        consecutivePartialRuns: null,
        error: err?.message || String(err),
      }
    }
    tables[entry.table] = result
    removed += result.rowsDeleted
    batches += result.batches
    if (result.partial) partial.push(entry.table)
  }

  return {
    removed,
    rowsDeleted: removed,
    batches,
    durationMs: Date.now() - startedAt,
    tables,
    partial,
  }
}

const DB_GROWTH_KEY_PREFIX = 'db_growth:'
const DB_GROWTH_MAX_SAMPLES = 31

const GROWTH_TABLES = [
  'users',
  'posts',
  'post_targets',
  'campaigns',
  'promotions',
  'promotion_targets',
  'campaign_jobs',
  'post_engagement_daily',
  'campaign_daily_stats',
  'post_boost_daily_stats',
  'meta_webhook_events',
  'meta_account_snapshots',
  'user_sessions',
  'auth_login_history',
  'audit_logs',
  'ai_usage_log',
  'notifications',
  'usage_ledger',
  'transactions',
  'media_assets',
]

/**
 * Backend-only daily DB-growth telemetry. One information_schema query over
 * ~20 major tables; stored under db_growth:YYYY-MM-DD (UTC). Self-capped at
 * 31 samples via a bounded delete of oldest keys — never unbounded. Any
 * failure is logged and swallowed: growth sampling must never fail retention
 * maintenance.
 */
export async function sampleDbGrowth(now = new Date()) {
  try {
    const rows = await query(
      `SELECT table_name AS tbl, table_rows AS rows_est, data_length AS data_bytes, index_length AS index_bytes
       FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name IN (${GROWTH_TABLES.map(() => '?').join(',')})`,
      GROWTH_TABLES
    )
    const tables = {}
    for (const row of rows) {
      tables[row.tbl] = {
        rows: Number(row.rows_est) || 0,
        dataKB: Math.round(Number(row.data_bytes) / 1024) || 0,
        indexKB: Math.round(Number(row.index_bytes) / 1024) || 0,
      }
    }
    const sampleDate = now.toISOString().slice(0, 10)
    const state = { sampledAt: now.toISOString(), tables }
    await query(
      `INSERT INTO meta_sync_state (run_key, state) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE state = VALUES(state), updated_at = NOW()`,
      [`${DB_GROWTH_KEY_PREFIX}${sampleDate}`, JSON.stringify(state)]
    )
    const cutoffDate = new Date(now.getTime() - DB_GROWTH_MAX_SAMPLES * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    await query(
      `DELETE FROM meta_sync_state WHERE run_key LIKE ? AND run_key < ? LIMIT 100`,
      [`${DB_GROWTH_KEY_PREFIX}%`, `${DB_GROWTH_KEY_PREFIX}${cutoffDate}`]
    )
    return { sampledAt: state.sampledAt, tables }
  } catch (err) {
    logger.warn({ err: err?.message }, 'DB growth sampling failed (telemetry only)')
    return null
  }
}

const DB_GROWTH_DELTA_KEYS = { 1: '24h', 7: '7d', 30: '30d' }

/**
 * Health-view aggregator over the per-table retention:<table> state keys.
 * `partial` lists every table whose latest recorded run was incomplete —
 * a partial retention run must never appear as healthy. Tables with no
 * state yet (never swept) report complete:false + partial — honest, not
 * silent. Never throws; health consumers get a usable block either way.
 */
export async function readRetentionHealth() {
  const tables = {}
  const partial = []
  for (const entry of TABLE_PURGES) {
    let state = null
    try {
      state = await readRetentionState(entry.table)
    } catch {
      state = null
    }
    const complete = !!state?.lastComplete
    const tableStatus = {
      lastRunAt: state?.lastRunAt || null,
      rowsDeleted: Number(state?.lastRowsDeleted) || 0,
      batches: Number.isFinite(Number(state?.lastBatches)) ? Number(state.lastBatches) : null,
      durationMs: Number.isFinite(Number(state?.lastDurationMs)) ? Number(state.lastDurationMs) : null,
      capped: !!state?.lastCapped,
      complete,
      partial: !complete,
      backlogRows: state?.lastBacklogRows ?? null,
      consecutivePartialRuns: Number(state?.consecutivePartialRuns) || 0,
    }
    tables[entry.table] = tableStatus
    if (!complete) partial.push(entry.table)
  }
  return {
    lastRunAt: null,
    totalRowsDeleted: Object.values(tables).reduce((s, t) => s + (t.rowsDeleted || 0), 0),
    tables,
    partial,
  }
}

async function readDbGrowthSample(daysBack) {
  const date = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const row = await queryOne('SELECT state FROM meta_sync_state WHERE run_key = ?', [`${DB_GROWTH_KEY_PREFIX}${date}`])
  if (!row) return null
  try {
    const state = typeof row.state === 'string' ? JSON.parse(row.state) : row.state
    return state && state.tables ? { date, tables: state.tables } : null
  } catch {
    return null
  }
}

/**
 * Latest sample + 24h/7d/30d deltas when historical samples exist. Read-only,
 * backend-only; any failure degrades to null deltas (health endpoint must
 * stay green even with zero samples).
 */
export async function getDbGrowthSnapshot() {
  try {
    const rows = await query(
      `SELECT run_key, state FROM meta_sync_state WHERE run_key LIKE ? ORDER BY run_key DESC`,
      [`${DB_GROWTH_KEY_PREFIX}%`]
    )
    if (!rows.length) return null
    const parse = (row) => {
      try {
        const state = typeof row.state === 'string' ? JSON.parse(row.state) : row.state
        return state || null
      } catch {
        return null
      }
    }
    const latest = parse(rows[0])
    if (!latest) return null
    const latestDate = String(rows[0].run_key).slice(DB_GROWTH_KEY_PREFIX.length)

    const deltas = {}
    for (const [daysBack, label] of Object.entries(DB_GROWTH_DELTA_KEYS)) {
      const match = rows.find((row) => {
        const date = String(row.run_key).slice(DB_GROWTH_KEY_PREFIX.length)
        const diffDays = Math.round(
          (new Date(latestDate).getTime() - new Date(date).getTime()) / (24 * 60 * 60 * 1000)
        )
        return diffDays === Number(daysBack)
      })
      const past = match ? parse(match) : null
      if (!past || !past.tables) {
        deltas[label] = null
        continue
      }
      const delta = {}
      for (const [tbl, current] of Object.entries(latest.tables || {})) {
        const previous = past.tables[tbl]
        if (!previous) continue
        delta[tbl] = {
          rows: (current.rows || 0) - (previous.rows || 0),
          dataKB: (current.dataKB || 0) - (previous.dataKB || 0),
          indexKB: (current.indexKB || 0) - (previous.indexKB || 0),
        }
      }
      deltas[label] = delta
    }

    return { latestSampleDate: latestDate, tables: latest.tables, deltas }
  } catch (err) {
    logger.warn({ err: err?.message }, 'DB growth snapshot read failed')
    return null
  }
}
