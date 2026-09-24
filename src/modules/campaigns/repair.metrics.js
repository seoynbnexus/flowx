import { query } from '../../../shared/database/connection.js'
import * as repo from './campaign.repository.js'
import { sendAdminAlert } from '../../../shared/mailer/alert.mailer.js'

const METRIC_PREFIX = 'repair_metric:'
const ALERT_PREFIX = 'repair_alert:'
const ALERT_DEDUPE_MS = 24 * 60 * 60 * 1000

function bump(bucket, key) {
  if (key === null || key === undefined || key === '') return
  const name = String(key)
  if (name.length > 64) return
  bucket[name] = (Number(bucket[name]) || 0) + 1
}

export async function recordRepairMetric(event, dims = {}) {
  try {
    const key = `${METRIC_PREFIX}${event}`
    const current = await repo.getMetaSyncState(key)
    const data = current && typeof current === 'object' ? current : {}
    data.total = (Number(data.total) || 0) + 1
    data.byCode = data.byCode || {}
    data.byCategory = data.byCategory || {}
    data.byKind = data.byKind || {}
    data.byState = data.byState || {}
    data.byMetaCode = data.byMetaCode || {}
    bump(data.byCode, dims.code)
    bump(data.byCategory, dims.category)
    bump(data.byKind, dims.kind)
    bump(data.byState, dims.state)
    if (dims.metaCode !== null && dims.metaCode !== undefined) {
      bump(data.byMetaCode, dims.metaSubcode !== null && dims.metaSubcode !== undefined
        ? `${dims.metaCode}/${dims.metaSubcode}`
        : dims.metaCode)
    }
    if (dims.durationMs !== null && dims.durationMs !== undefined && Number.isFinite(Number(dims.durationMs))) {
      const ms = Number(dims.durationMs)
      data.totalMs = (Number(data.totalMs) || 0) + ms
      data.maxMs = Math.max(Number(data.maxMs) || 0, ms)
    }
    data.updatedAt = new Date().toISOString()
    await repo.saveMetaSyncState(key, data)
  } catch {
    // metrics must never break repair flows
  }
}

export async function getRepairMetrics() {
  const rows = await query(
    "SELECT run_key, state FROM meta_sync_state WHERE run_key LIKE 'repair_metric:%' ORDER BY run_key"
  )
  const metrics = {}
  for (const row of rows) {
    const event = String(row.run_key).slice(METRIC_PREFIX.length)
    try {
      metrics[event] = typeof row.state === 'string' ? JSON.parse(row.state) : row.state
    } catch {
      metrics[event] = null
    }
  }
  return metrics
}

export async function getRepairFleetSummary() {
  const statusRows = await query(
    'SELECT status, COUNT(*) AS n FROM campaign_execution_repairs GROUP BY status'
  )
  const codeRows = await query(
    `SELECT error_code, status, COUNT(*) AS n FROM campaign_execution_repairs
     GROUP BY error_code, status ORDER BY n DESC LIMIT 50`
  )
  const stuckRows = await query(
    `SELECT HEX(id) AS id, HEX(campaign_execution_id) AS executionId, status, object_id, error_code, updated_at
     FROM campaign_execution_repairs
     WHERE status NOT IN ('completed','failed','unknown','superseded')
       AND updated_at < (NOW() - INTERVAL 1 HOUR)
     ORDER BY updated_at ASC LIMIT 25`
  )
  const cleanupRows = await query(
    `SELECT HEX(id) AS id, HEX(campaign_execution_id) AS executionId, updated_at
     FROM campaign_execution_repairs
     WHERE status = 'old_cleanup' AND updated_at < (NOW() - INTERVAL 24 HOUR)
     ORDER BY updated_at ASC LIMIT 25`
  )
  return {
    byStatus: Object.fromEntries(statusRows.map((row) => [row.status, Number(row.n)])),
    byCode: codeRows.map((row) => ({ errorCode: row.error_code, status: row.status, count: Number(row.n) })),
    stuck: stuckRows,
    cleanupBacklog: cleanupRows,
  }
}

async function alertOnce(key, subject, body) {
  const state = await repo.getMetaSyncState(`${ALERT_PREFIX}${key}`)
  const lastAlert = state?.alertedAt ? Number(state.alertedAt) : 0
  if (Date.now() - lastAlert < ALERT_DEDUPE_MS) return false
  const sent = await sendAdminAlert(subject, body)
  if (sent) {
    await repo.saveMetaSyncState(`${ALERT_PREFIX}${key}`, { alertedAt: Date.now() })
  }
  return sent
}

export async function checkRepairAlerts() {
  const alerts = []
  const fleet = await getRepairFleetSummary()
  const byStatus = fleet.byStatus
  const terminal = (byStatus.completed || 0) + (byStatus.failed || 0) + (byStatus.unknown || 0)
  const unknownCount = byStatus.unknown || 0
  if (terminal >= 3 && unknownCount / terminal > 0.2) {
    const sent = await alertOnce('unknown-rate',
      'Repair UNKNOWN rate is abnormal',
      `${unknownCount} of ${terminal} terminal repairs are UNKNOWN. Review reconciliation output.`)
    alerts.push({ alert: 'unknown-rate', fired: sent, unknownCount, terminal })
  }
  const failedCount = byStatus.failed || 0
  if (terminal >= 5 && failedCount / terminal > 0.4) {
    const sent = await alertOnce('failed-rate',
      'Repair FAILED rate is abnormal',
      `${failedCount} of ${terminal} terminal repairs FAILED. Review repair errors.`)
    alerts.push({ alert: 'failed-rate', fired: sent, failedCount, terminal })
  }
  if (fleet.stuck.length) {
    const sent = await alertOnce('stuck-repairs',
      'Repairs stuck in mid-state',
      `${fleet.stuck.length} repairs show no progress for over an hour: ${fleet.stuck.slice(0, 5).map((r) => `${r.id} (${r.status})`).join(', ')}.`)
    alerts.push({ alert: 'stuck-repairs', fired: sent, count: fleet.stuck.length })
  }
  if (fleet.cleanupBacklog.length) {
    const sent = await alertOnce('cleanup-backlog',
      'Repair cleanup backlog',
      `${fleet.cleanupBacklog.length} repairs sit in OLD_CLEANUP for over 24 hours.`)
    alerts.push({ alert: 'cleanup-backlog', fired: sent, count: fleet.cleanupBacklog.length })
  }
  return alerts
}
