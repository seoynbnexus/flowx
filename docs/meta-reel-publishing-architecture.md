# Meta Reel Publishing — Durable State Machine

Graph version: **v25.0** (`shared/services/meta-oauth.config.js`). Do not upgrade in this task.

## Why this exists (CURRENT → TARGET)

### CURRENT (replaced)

`publishToFacebookPage` (called synchronously inside the `post_publish` job) drove FB Reels
through a single long-running worker flow:

```
START (video_reels) → UPLOAD (hosted) → in-worker poll video_status → FINISH → success
```

One `campaign_jobs` row per post; the whole upload+processing+publish happened inside one job
invocation. Consequences:

- A worker crash between START and FINISH lost the persisted `remote_video_id` (migration 060
  columns were never written) → the retry re-created the reel from scratch.
- A duplicate reel could be published on Facebook — the old code re-STARTed a fresh session
  instead of resuming the persisted one.
- A timeout mid-processing threw and the generic job backoff blindly retried, with no
  "did the upload actually land?" check.
- FINISH id resolution used a loose "pick newest reel" heuristic, which could attribute the
  wrong post id.

### TARGET (this change)

One persisted **sentinel `post_fb_reel` job row per FB reel target** (`run_key = 'fb_reel:<targetId>'`,
`campaign_id = NULL`). The job is *rescheduled through the same row* (`requeueReelJob`) between
steps; the `post_targets.publish_state` column is the source of truth. Each job invocation performs
exactly one state step and returns `{ requeueAfterSeconds }` (or `{ done: true }`).

```
START ──allocate──▶ UPLOADING ──upload──▶ UPLOADED ──poll──▶ PROCESSING ──poll──▶ READY ──finish──▶ PUBLISHED
```

Non-reel paths (FB photo/video posts, FB photo/video stories, all Instagram) are untouched and
still run synchronously inside `post_publish`. `publishPostJob` routes only
`platformCode === 'facebook' && post.type === 'reel'` targets to the background reel pipeline.

## The four requirements

### 1. Strictly idempotent requeue-sentinel

- `enqueueTargetJob` (campaign.repository.js) inserts with
  `INSERT … SELECT … FROM DUAL WHERE NOT EXISTS (run_key = ? AND status IN ('queued','running'))`,
  `campaign_id = NULL`. No `ON DUPLICATE` (which would reset a running row). Races are closed by
  `uk_campaign_jobs_run (job_type, run_key)` — a duplicate-key error is swallowed by the caller.
- `requeueReelJob` reschedules the **same row** via guarded
  `UPDATE … SET status='queued', attempts=0, run_after=… WHERE id=? AND status='running'`. A stale
  replay against an already-`queued`/`done` row is CAS-inert (affects 0 rows).
- `attempts` is always reset to 0 on requeue and carried in `payload.$.attempts`, so the generic
  `max_attempts=3` backoff can never dead-letter a recoverable reel workflow.

### 2. Explicit ambiguous-upload recovery (verify before re-upload)

An ambiguous upload (timeout, `ECONNRESET`, unreachable status) transitions the target to
`unknown` and requeues on the **verify** cadence — never a blind re-upload. On the next run
`fbReelVerify` reads the persisted `remote_video_id` status first:

- `publishing_phase.publish_status === 'published'` → resolve post id (see 3).
- upload not finished (`uploading_phase.status !== 'finished'`) → Meta **confirmed** the upload is
  incomplete → verified re-upload (`fbReelUpload` probes again and skips if it flipped to uploaded).
- processing finished but unpublished → `fbReelFinish`.
- still processing → keep verifying (`verification_attempts` bumps toward `POST_FB_REEL_VERIFY_CAP`).

On a **fresh** START the probe is skipped (`skipProbe`) — a brand-new session is definitionally
not uploaded; probing there could read a stale sibling's status.

### 3. Correlation-safe FINISH / post-id resolution

`finishPageReel` prefers the returned `post_id` (persisted as `meta_object_id`). When Meta answers
`{message: 'Video is Processing…'}` (no id), the target goes `verifying` and `resolvePageReelPostId`
lists `{pageId}/video_reels` with **strict** filtering:

- `updated_time >= since` (publish window, not wall-clock "latest").
- when a caption exists, `description === caption` **exact match**.

Exactly one → id. Zero → continue verifying. **Multiple → `manual_review` — never pick newest.**

### 4. Verified v25 contract + labeling

- START `POST {page}/video_reels` body `{upload_phase:'start'}` → `{video_id, upload_url}`.
  **START must NOT include `file_url`** (the guide's curl examples omit it; sending it is a contract
  deviation). Verified against the official Reels Publishing guide v25.0.
- Hosted upload: `POST {upload_url}` with `Authorization: OAuth <token>` + `file_url` header; binary
  fallback `Content-Type: application/octet-stream` + `offset:0` + `file_size`.
- Status: `GET /{video_id}?fields=status`.
- FINISH `POST {page}/video_reels` `{upload_phase:'finish', video_id, video_state:'PUBLISHED', description}`.

## Media rules — correction note

The existing `post-content-validation.js` FB reel rules (mp4, ≤10GB, h264/hevc, **min 540×960**,
**3–90s**, 24–60fps) are v25-accurate and are the guide's own error-table values (1363128/1363129).
An earlier doc delta ("4–60s / ~23fps") was wrong — fix the doc, not the code. No rule changes were
made.

## State machine (post_targets.publish_state)

`none → upload_started → uploading → uploaded → processing → ready → published`

Failure/uncertain paths:

| from | to | trigger |
|------|----|---------|
| any in-flight | `retryable_failure` | transient error → requeue with `backoffForStep` |
| any in-flight | `unknown` | ambiguous error / processing cap → verify cadence |
| `unknown`/`verifying` | `published` | status published + strict resolve → id |
| `unknown`/`verifying` | `manual_review` | >1 match, or `POST_FB_REEL_VERIFY_CAP` exhausted |
| any in-flight | `permanent_failure` | Meta 4xx / status error → target failed, done |

`publish_state_changed_at` bumps on every CAS transition; observability columns (migration 061)
`last_meta_status`, `last_operation`, `last_operation_at`, `processing_started_at`,
`unknown_since` record the most recent Meta signal for the admin detail view.

Upload completion (`video_status:'upload_complete'` or `uploading_phase.status` `complete`/`finished`)
transitions `uploaded`/`processing` straight to `ready` — the finish call triggers Meta's processing
and publishing. `fbReelVerify` also rescues targets whose finish never ran (upload complete +
processing/publishing `not_started`) by calling `fbReelFinish`.

## Files

- `shared/services/meta-ads.service.js` — one-op primitives `startPageReel`,
  `uploadPageReelMedia`, `getPageReelStatus`, `finishPageReel`; `resolvePageReelPostId` strict
  resolver. Story helpers `getVideoUploadStatus` + `createPageVideoStory` — order is start →
  hosted upload → finish → `waitForStoryPublished` (no pre-finish processing wait: Meta only
  starts processing after `upload_phase:'finish'`, and its status literals are `complete` /
  `upload_complete`, not `finished`).
- `src/modules/posts/post.service.js` — `fbReelJob` dispatcher + `fbReelState` tunables
  (`backoffSteps`, `processingBackoffMs`, `verifyBackoffSeconds`, `processingCapMs`),
  `FB_REEL_VERIFY_CAP`, step functions, `refreshPostStatus`; `publishPostJob` routes reel targets to
  `post_fb_reel`.
- `src/modules/posts/post.repository.js` — `transitionPostTargetState` (CAS `WHERE … AND publish_state
  IN (…)`), `findPostTargetById`, observability mapping in `mapPostTargetRow` / `updatePostTargetStatus`.
- `src/modules/campaigns/campaign.repository.js` — `enqueueTargetJob`, `requeueReelJob`.
- `src/modules/campaigns/campaign.jobs.js` — `POST_JOB_TYPES.FB_REEL` handler + the
  `requeueAfterSeconds` branch in `processDueJobs`.
- `shared/database/migrations/061_post_reel_observability.js` — 5 nullable observability columns
  (idempotent up/down).

## Queue semantics

- Per-target sentinel rows use `campaign_id = NULL` + `run_key = 'fb_reel:<targetId>'` because
  `uk_campaign_jobs_run` is `(job_type, run_key)` and no `(campaign_id, job_type)` unique exists;
  using `campaign_id = postId` would collapse two reel targets of one post. (Verified across
  migrations 048/050/058.)
- `processDueJobs` completes `done` on `{done:true}` and re-schedules the same row on
  `{requeueAfterSeconds}`; `attempts=0` on requeue keeps the generic dead-letter path inert for
  reels. All other handlers return `undefined` → unchanged `done` path.
- `drainCampaignJobs` keeps processing a reel sentinel until terminal because the requeued row is
  immediately due (tests set `fbReelState.backoffSteps = [0,…]`); a requeue with `run_after` in the
  future counts as active and would time out `drain` — real deployments rely on the worker polling.

## Env knobs (`.env.example`)

- `POST_FB_REEL_VERIFY_BACKOFF_SECONDS` (default 60)
- `POST_FB_REEL_PROCESSING_CAP_MS` (default 1800000 = 30 min)
- `POST_FB_REEL_VERIFY_CAP` (default 3)
