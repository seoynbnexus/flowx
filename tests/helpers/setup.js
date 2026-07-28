import { beforeAll, afterAll } from 'vitest'

beforeAll(async () => {
  const { getPool } = await import('../../shared/database/connection.js')
  const { createMigrator, ensureMigrationTable } = await import('../../shared/database/migrate.js')

  const pool = getPool()
  await ensureMigrationTable(pool)
  const migrator = await createMigrator(pool)
  const pending = await migrator.pending()
  if (pending.length > 0) {
    await migrator.up()
  }
}, 60000)

afterAll(async () => {
  const { closePool } = await import('../../shared/database/connection.js')
  await closePool()
})
