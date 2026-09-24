import { describe, it, expect, beforeAll } from 'vitest'
import { generateUuid, uuidToBuffer } from '../../shared/utils/uuid.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import * as postService from '../../src/modules/posts/post.service.js'
import * as postRepo from '../../src/modules/posts/post.repository.js'
import { POST_JOB_TYPES } from '../../src/modules/posts/post.model.js'
import { query } from '../../shared/database/connection.js'

const dateTag = Date.now()
let userCounter = 0

async function createPostInStatus(status) {
  userCounter += 1
  const client = await createTestUser({ email: `post-dedup-${dateTag}-${userCounter}@flowx-test.com`, password: 'Test@123' })
  const postId = generateUuid()
  await postRepo.createPost(postId, client.id, { name: `Dedup ${generateUuid().substring(0, 8)}`, type: 'post', caption: 'dedup test', mediaUrl: 'https://example.com/img.jpg' })
  await query('UPDATE posts SET status = ? WHERE id = ?', [status, uuidToBuffer(postId)])
  return postId
}

async function countJobs(postId, jobType) {
  const rows = await query(
    "SELECT id, status, run_key FROM campaign_jobs WHERE campaign_id = ? AND job_type = ? AND entity_type = 'post'",
    [uuidToBuffer(postId), jobType]
  )
  return rows
}

describe('post publish/verify job dedup (run_key fix — prevents duplicate live posts)', () => {
  beforeAll(async () => {
    await query("DELETE FROM campaign_jobs WHERE job_type IN ('post_publish', 'post_verify')")
  })

  it('queuePostPublish called twice for the same post creates exactly one job row', async () => {
    const postId = await createPostInStatus('approved')

    await postService.queuePostPublish(postId)
    await postService.queuePostPublish(postId)

    const rows = await countJobs(postId, POST_JOB_TYPES.PUBLISH)
    expect(rows).toHaveLength(1)
    expect(rows[0].run_key).toBe(`post_publish:${postId}`)
  })

  it('requeuing the verify job twice (the ambiguous-IG-verification retry path) creates exactly one job row', async () => {
    const postId = await createPostInStatus('running')

    await postRepo.requeueAutoJob(postId, POST_JOB_TYPES.VERIFY, {}, { entityType: 'post', runKey: `post_verify:${postId}` })
    await postRepo.requeueAutoJob(postId, POST_JOB_TYPES.VERIFY, {}, { entityType: 'post', runKey: `post_verify:${postId}` })

    const rows = await countJobs(postId, POST_JOB_TYPES.VERIFY)
    expect(rows).toHaveLength(1)
    expect(rows[0].run_key).toBe(`post_verify:${postId}`)
  })

  it('queuePostPublish and a direct requeueAutoJob PUBLISH call for the same post converge on one row, not two', async () => {
    const postId = await createPostInStatus('failed')

    await postService.queuePostPublish(postId)
    // Simulates verifyPostJob's retry_pending requeue landing shortly after
    // the post's own queuePostPublish call (e.g. a client-triggered retry
    // racing the verify job's own retry) — before the fix, this always
    // inserted a second, independent row (run_key was NULL on both), and
    // processDueJobs would run both concurrently, publishing the same
    // not-yet-posted target twice on the customer's live page.
    await postRepo.requeueAutoJob(postId, POST_JOB_TYPES.PUBLISH, {}, { entityType: 'post', runKey: `post_publish:${postId}` })

    const rows = await countJobs(postId, POST_JOB_TYPES.PUBLISH)
    expect(rows).toHaveLength(1)
  })

  it('two different posts never collide on the same run_key', async () => {
    const postA = await createPostInStatus('approved')
    const postB = await createPostInStatus('approved')

    await postService.queuePostPublish(postA)
    await postService.queuePostPublish(postB)

    const rowsA = await countJobs(postA, POST_JOB_TYPES.PUBLISH)
    const rowsB = await countJobs(postB, POST_JOB_TYPES.PUBLISH)
    expect(rowsA).toHaveLength(1)
    expect(rowsB).toHaveLength(1)
    expect(rowsA[0].run_key).not.toBe(rowsB[0].run_key)
  })
})
