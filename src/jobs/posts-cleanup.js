import dotenv from 'dotenv'
dotenv.config()

import { closePool } from '../../shared/database/connection.js'
import { cleanupOrphanContainers } from '../modules/posts/post.service.js'

const results = await cleanupOrphanContainers()
console.log('Posts cleanup:', JSON.stringify(results))
await closePool()
process.exit(0)
