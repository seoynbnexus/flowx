import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import {
  shouldRunWorker,
  shouldRunScheduler,
  startBackgroundWorkers,
  startCampaignJobWorker,
  stopCampaignJobWorker,
  startMetaSyncScheduler,
  stopMetaSyncScheduler,
} from '../../src/modules/campaigns/campaign.jobs.js'

const savedEnv = {}

describe('worker + scheduler env gates', () => {
  beforeAll(() => {
    for (const key of ['WORKER_ENABLED', 'SYNC_SCHEDULER_ENABLED']) {
      savedEnv[key] = process.env[key]
    }
  })

  afterEach(() => {
    delete process.env.WORKER_ENABLED
    delete process.env.SYNC_SCHEDULER_ENABLED
    stopCampaignJobWorker()
    stopMetaSyncScheduler()
  })

  afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('enables worker and scheduler by default', () => {
    expect(shouldRunWorker()).toBe(true)
    expect(shouldRunScheduler()).toBe(true)
  })

  it('disables the worker when WORKER_ENABLED=0', () => {
    process.env.WORKER_ENABLED = '0'
    expect(shouldRunWorker()).toBe(false)
    expect(shouldRunScheduler()).toBe(true)
  })

  it('disables the scheduler when SYNC_SCHEDULER_ENABLED=0', () => {
    process.env.SYNC_SCHEDULER_ENABLED = '0'
    expect(shouldRunScheduler()).toBe(false)
    expect(shouldRunWorker()).toBe(true)
  })

  it('startBackgroundWorkers honors both flags', () => {
    process.env.WORKER_ENABLED = '0'
    process.env.SYNC_SCHEDULER_ENABLED = '1'
    const started = startBackgroundWorkers()
    expect(started).toEqual({ workerEnabled: false, schedulerEnabled: true })
  })

  it('start/stop worker is idempotent', () => {
    const first = startCampaignJobWorker()
    const second = startCampaignJobWorker()
    expect(second).toBe(first)
    stopCampaignJobWorker()
    expect(startCampaignJobWorker()).not.toBe(first)
    stopCampaignJobWorker()
  })

  it('start/stop scheduler is idempotent', () => {
    const first = startMetaSyncScheduler()
    const second = startMetaSyncScheduler()
    expect(second).toBe(first)
    stopMetaSyncScheduler()
    expect(startMetaSyncScheduler()).not.toBe(first)
    stopMetaSyncScheduler()
  })
})