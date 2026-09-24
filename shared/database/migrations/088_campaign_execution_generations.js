import { generateUuid, uuidToBuffer } from '../../utils/uuid.utils.js'

async function tableExists(pool, name) {
  const [rows] = await pool.query(
    'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    [name]
  )
  return rows.length > 0
}

async function columnExists(pool, table, column) {
  const [rows] = await pool.query(
    'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    [table, column]
  )
  return rows.length > 0
}

function hexOrNull(value) {
  if (value === null || value === undefined) return null
  return Buffer.from(value).toString('hex').toUpperCase()
}

function idsEqual(a, b) {
  return (a || null) === (b || null)
}

export async function backfillExecutionGenerations(pool) {
  const summary = { executions: 0, created: 0, verified: 0, incomplete: [], conflicts: [] }
  const [executions] = await pool.query(
    `SELECT id, platform_campaign_id, platform_adset_id, platform_creative_id, platform_ad_id, active_generation_no
     FROM campaign_executions`
  )
  const [generations] = await pool.query(
    `SELECT campaign_execution_id, generation_no, status,
            platform_campaign_id, platform_adset_id, platform_creative_id, platform_ad_id
     FROM campaign_execution_generations WHERE generation_no = 0`
  )
  const genByExec = new Map()
  for (const gen of generations) {
    genByExec.set(hexOrNull(gen.campaign_execution_id), gen)
  }

  for (const exec of executions) {
    summary.executions += 1
    const execHex = hexOrNull(exec.id)
    const ids = {
      platform_campaign_id: exec.platform_campaign_id || null,
      platform_adset_id: exec.platform_adset_id || null,
      platform_creative_id: exec.platform_creative_id || null,
      platform_ad_id: exec.platform_ad_id || null,
    }
    if (Object.values(ids).some((v) => v === null)) {
      summary.incomplete.push(execHex)
    }
    const existing = genByExec.get(execHex)
    if (!existing) {
      if (exec.active_generation_no !== null && exec.active_generation_no !== undefined && Number(exec.active_generation_no) !== 0) {
        throw new Error(`Generation backfill conflict: execution ${execHex} has no Generation 0 but active_generation_no=${exec.active_generation_no}`)
      }
      await pool.execute(
        `INSERT INTO campaign_execution_generations
           (id, campaign_execution_id, generation_no, status,
            platform_campaign_id, platform_adset_id, platform_creative_id, platform_ad_id)
         VALUES (?, ?, 0, 'active', ?, ?, ?, ?)`,
        [uuidToBuffer(generateUuid()), exec.id, ids.platform_campaign_id, ids.platform_adset_id, ids.platform_creative_id, ids.platform_ad_id]
      )
      await pool.execute(
        'UPDATE campaign_executions SET active_generation_no = 0 WHERE id = ? AND active_generation_no IS NULL',
        [exec.id]
      )
      summary.created += 1
      continue
    }

    const same =
      idsEqual(existing.platform_campaign_id, ids.platform_campaign_id) &&
      idsEqual(existing.platform_adset_id, ids.platform_adset_id) &&
      idsEqual(existing.platform_creative_id, ids.platform_creative_id) &&
      idsEqual(existing.platform_ad_id, ids.platform_ad_id)
    if (!same || existing.status !== 'active') {
      throw new Error(
        `Generation backfill conflict: execution ${execHex} has a divergent Generation 0 (status=${existing.status}). Refusing to overwrite.`
      )
    }
    if (exec.active_generation_no !== null && exec.active_generation_no !== undefined && Number(exec.active_generation_no) !== 0) {
      throw new Error(`Generation backfill conflict: execution ${execHex} verified Generation 0 but active_generation_no=${exec.active_generation_no}`)
    }
    await pool.execute(
      'UPDATE campaign_executions SET active_generation_no = 0 WHERE id = ? AND active_generation_no IS NULL',
      [exec.id]
    )
    summary.verified += 1
  }
  return summary
}

export async function up({ context: pool }) {
  if (!(await tableExists(pool, 'campaign_execution_generations'))) {
    await pool.execute(`
      CREATE TABLE campaign_execution_generations (
        id BINARY(16) NOT NULL,
        campaign_execution_id BINARY(16) NOT NULL,
        generation_no INT NOT NULL DEFAULT 0,
        status ENUM('active','superseded','failed') NOT NULL DEFAULT 'active',
        platform_campaign_id VARCHAR(64) NULL DEFAULT NULL,
        platform_adset_id VARCHAR(64) NULL DEFAULT NULL,
        platform_creative_id VARCHAR(64) NULL DEFAULT NULL,
        platform_ad_id VARCHAR(64) NULL DEFAULT NULL,
        repair_run_id VARCHAR(64) NULL DEFAULT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uk_exec_generation (campaign_execution_id, generation_no),
        KEY idx_exec_generations_execution (campaign_execution_id),
        CONSTRAINT fk_exec_generations_execution FOREIGN KEY (campaign_execution_id)
          REFERENCES campaign_executions (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)
    console.log('  + Created campaign_execution_generations table')
  } else {
    console.log('  ~ campaign_execution_generations table already present')
  }

  if (!(await columnExists(pool, 'campaign_executions', 'active_generation_no'))) {
    await pool.execute('ALTER TABLE campaign_executions ADD COLUMN active_generation_no INT NULL DEFAULT NULL')
    console.log('  + Added campaign_executions.active_generation_no')
  } else {
    console.log('  ~ campaign_executions.active_generation_no already present')
  }

  const summary = await backfillExecutionGenerations(pool)
  console.log(`  ~ Generation 0 backfill: ${summary.executions} executions, ${summary.created} created, ${summary.verified} verified, ${summary.incomplete.length} incomplete`)
  if (summary.incomplete.length) {
    console.log(`  ~ Incomplete executions mirrored as-is (NULLs preserved): ${summary.incomplete.join(', ')}`)
  }
}

export async function down({ context: pool }) {
  if (await tableExists(pool, 'campaign_execution_generations')) {
    await pool.execute('DROP TABLE IF EXISTS campaign_execution_generations')
    console.log('  - Dropped campaign_execution_generations table')
  } else {
    console.log('  ~ campaign_execution_generations table already absent')
  }
  if (await columnExists(pool, 'campaign_executions', 'active_generation_no')) {
    await pool.execute('ALTER TABLE campaign_executions DROP COLUMN active_generation_no')
    console.log('  - Dropped campaign_executions.active_generation_no')
  } else {
    console.log('  ~ campaign_executions.active_generation_no already absent')
  }
}

export default { up, down, backfillExecutionGenerations }
