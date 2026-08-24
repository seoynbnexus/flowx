import dotenv from 'dotenv'
dotenv.config()

import { closePool } from '../../shared/database/connection.js'
import { cleanupOrphanContainers, watchdogIgVideoTargets } from '../modules/posts/post.service.js'

const results = await cleanupOrphanContainers()
console.log('Posts cleanup:', JSON.stringify(results))
const watchdog = await watchdogIgVideoTargets()
console.log('IG video watchdog:', JSON.stringify(watchdog))
await closePool()
process.exit(0)
