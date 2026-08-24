import dotenv from 'dotenv'
dotenv.config()

import { getPool, closePool } from '../../shared/database/connection.js'
import { logger } from '../../shared/utils/logger.js'
import { startBackgroundWorkers, stopCampaignJobWorker, stopMetaSyncScheduler } from '../modules/campaigns/campaign.jobs.js'

async function main() {
  const pool = getPool()
  await pool.getConnection()
  logger.info('FlowX job worker: database connected')
  const started = startBackgroundWorkers()
  logger.info(started, 'FlowX job worker started')
}

const shutdown = async () => {
  logger.info('Stopping FlowX job worker')
  stopCampaignJobWorker()
  stopMetaSyncScheduler()
  await closePool()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

await main()