# Production Runbook — Meta Traffic Hardening

Change: engagement hot-loop elimination (run-keyed + floored `post_sync_engagement`) + `campaign_job_worker` lease + process-local Meta request gate + bulk insights writes + 900s balance poll + signal-only rate alert. No migrations in this release (`run_key`/`entity_type`/leases pre-exist). No architecture changes.

## 1. Pre-deployment env verification

Unset = code default. Confirm prod matches the expected column; do not carry stale debug values.

| Var | Expected | Code default |
|---|---|---|
| `POST_ENGAGEMENT_MIN_REQUEUE_SECONDS` | 300 | 300 (`post.service.js`) — resurrection floor: a DONE row can't re-enqueue within 300s of finishing |
| `POST_ENGAGEMENT_SWEEP_SECONDS` | 60 | 60 — scheduler sweep gate interval |
| `POST_ENGAGEMENT_MANUAL_REFRESH_SECONDS` | 30 | 30 — manual-refresh resurrection floor |
| `POST_ENGAGEMENT_TARGET_FLOOR_SECONDS` | 60 | 60 — per-target **minimum Meta-call interval**, not a mandatory delay (never-synced/stale≥60s syncs immediately; recently-synced skips) |
| `META_GLOBAL_CONCURRENCY` | 8 | 8 — per-process global cap |
| `META_ACCOUNT_CONCURRENCY` | 4 | 4 — per-process per-account cap |
| `META_GATE_MAX_QUEUE` | 100 | 100 — saturation throws transient → existing job backoff |
| `META_BALANCE_POLL_SECONDS` | 900 | 900 — only consumer is the admin health snapshot |
| `META_RATE_ALERT_PER_MIN` | 120 | 120 — signal-only, 1h `meta_sync_state` dedupe, never a correctness limiter |

Also review: `POST_ENGAGEMENT_SYNC_SECONDS` (3600, hourly cadence), `POST_ENGAGEMENT_SYNC_LIMIT` (20, per-tick sweep cap — raising increases per-tick fan-out), `META_GATE_WAIT_TIMEOUT_MS` (20000). Leave `WORKER_ENABLED` / `SYNC_SCHEDULER_ENABLED` at `1`.

## 2. Production topology discovery (do before deploy — do not assume single-process)

Inspect the actual deployment/runtime configuration (process manager, container replicas, Procfile/systemd units, hosting dashboard) and record which of these production is:

- one API/backend process, or
- multiple API/backend processes, or
- a separate worker process (`npm run worker` / equivalent).

Record the finding here (process count, hostnames/PIDs, which processes run worker vs scheduler). If multiple API/backend processes exist, state explicitly: `META_GLOBAL_CONCURRENCY=8` and `META_ACCOUNT_CONCURRENCY=4` apply **independently per process** — aggregate budget ≈ 8×N globally / 4×N per account. The gate is process-local by design (see §7); background singularity still comes from the `campaign_job_worker` lease, verified per §4 regardless of topology. No architecture changes in this deployment.

## 3. One-time NULL-run-key cleanup (prod DB, before deploy)

```sql
-- FIRST, inspect:
SELECT job_type, status, COUNT(*)
FROM campaign_jobs
WHERE job_type = 'post_sync_engagement'
  AND run_key IS NULL
GROUP BY job_type, status;

-- THEN, ONLY IF queued/running rows exist:
UPDATE campaign_jobs
SET status = 'dead',
    error = 'Superseded by run-key dedupe fix',
    finished_at = NOW()
WHERE job_type = 'post_sync_engagement'
  AND run_key IS NULL
  AND status IN ('queued', 'running');
```

Do not delete completed historical rows (the 7-day purge ages them out).

## 4. Deployment sequence

1. Deploy the new build; restart backend process(es).
2. Within ~30s confirm single lease ownership:
   `SELECT lease_name, owner_id, expires_at FROM scheduler_leases;`
   Expect exactly one owner per lease (`campaign_job_worker`, `meta_sync_scheduler`).

## 5. Post-deployment checks

```sql
-- no NULL-key engagement rows created after deploy:
SELECT COUNT(*) FROM campaign_jobs
 WHERE job_type = 'post_sync_engagement' AND run_key IS NULL
   AND created_at > <deploy_time>;
-- engagement job states + duplicate run keys:
SELECT status, COUNT(*) FROM campaign_jobs
 WHERE job_type LIKE 'post_sync_engagement%' GROUP BY status;
SELECT run_key, COUNT(*) c FROM campaign_jobs
 WHERE job_type = 'post_sync_engagement' AND status IN ('queued','running')
 GROUP BY run_key HAVING c > 1;
```

Acceptance = **no pathological accumulation** (a small amount of legitimate queued/running work is acceptable — do not require zero):

- No NULL `run_key` rows created after deployment.
- No duplicate logical run keys (`eng:<postId>` / `eng-target:<id>` unique among active rows).
- No repeated creation of the same engagement job every scheduler tick.
- Queued jobs carry valid `run_after` values (floors/backoff reflected, none stuck in the past across ticks).
- Running jobs make forward progress (claimed → done/dead).
- Completed jobs do not resurrect inside the configured floor (300s scheduler / 30s manual).
- Confirmed-missing targets do not generate continuous engagement work (stamped once, excluded from due-ness).
- Fresh targets are skipped; stale targets are processed.
- Health shows `metaTraffic.processLocal = true`; no token material in fresh logs.

## 6. Live traffic verification (30–60 min)

Historical reference only (not a pass/fail threshold): BEFORE ≈ 160/min sustained from the incident loop (~31k calls/day from 5 objects); observed AFTER ≈ 1/min on equivalent workload. Keep the before/after comparison in the deployment report.

Acceptance on steady workload:

- No repeated engagement requests every scheduler tick.
- No repeated requests for recently synced targets (floors honored).
- No repeated requests for confirmed-missing targets.
- Insights remain account-batched (one report per account per cadence, 1/min poll throttle).
- Webhook reconciliation remains coalesced (≤1 targeted refresh per 60s floor per target).
- Traffic stays bounded by the configured gate (peaks ≤ global/account limits) and DB limiter.
- Request volume does not continuously grow while workload is steady.

Metrics to inspect:

- Meta calls/min from `logs/app.*.log` (reads should dominate; POSTs only publishes/boosts).
- Jobs created/min per `job_type` (engagement creates ≈ 0 on steady state).
- `SELECT id, last_engagement_sync_at FROM post_targets WHERE status='posted' ORDER BY last_engagement_sync_at DESC LIMIT 20;` — stamps advance on cadence, not every tick.
- Gate stats in health: `peakGlobalInFlight`, per-account peaks, queue depth ≈ 0, `dedupedGets` rising on overlapping reads.
- Rate-limit events (`429`/`80004`/rate-alert log): none sustained; isolated 429 → per-account cooldown only.

## 7. Rollback / containment (existing mechanisms only — nothing new invented)

1. **Engagement storm / job accumulation:** `SYNC_SCHEDULER_ENABLED=0` + restart stops all scheduler enqueues (worker drains in-flight idempotently). Re-enable with `=1`.
2. **Worker misbehaving:** `WORKER_ENABLED=0` + restart stops job draining entirely. Re-enable with `=1`.
3. **Gate too tight (queue saturation/timeouts):** raise `META_GLOBAL_CONCURRENCY` / `META_ACCOUNT_CONCURRENCY` / `META_GATE_WAIT_TIMEOUT_MS` + restart (per-process).
4. **DANGER — code revert is not a clean rollback (verified):** the previous build drains new rows harmlessly (same table/columns/job types/payload shape) but its scheduler recreates the hot loop within one tick (NULL `run_key` never dedupes under MySQL UNIQUE + missing-target due-ness). Never redeploy an old build with `SYNC_SCHEDULER_ENABLED=1`. Revert only with `SYNC_SCHEDULER_ENABLED=0` set; after re-deploying the fix, run the §3 cleanup for rows the old build created while reverted.

## 8. Known limitations

- **Process-local Meta concurrency** (§2): 8 global / 4 per-account apply per Node process only — never fleet-wide. Background singularity comes from the worker lease; a second API process budgets its direct Meta calls independently.
- **Two pre-existing shared-test-DB flakes** (`post-engagement` sweep-dedupe, `post-ig-reel-state-machine` drain): documented before this change, green in isolation/subsets, unrelated code paths.
- **One-time prod cleanup** (§3) still to be run once after deploy.
