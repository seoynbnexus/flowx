import dotenv from 'dotenv'
dotenv.config()

import { getPool, closePool } from '../shared/database/connection.js'
import { dbConfig } from '../shared/database/config.js'

const DRY_RUN = !process.argv.includes('--execute')
const ALLOW_PRODUCTION = process.argv.includes('--allow-production')

const EXPECTED_COLUMNS = [
  { name: 'boost_enabled', ddl: 'boost_enabled TINYINT(1) NOT NULL DEFAULT 0 AFTER run_on_publishers', type: 'tinyint(1)', nullable: 'NO', def: '0' },
  { name: 'boost_budget_type', ddl: "boost_budget_type ENUM('daily','lifetime') NULL AFTER boost_enabled", type: "enum('daily','lifetime')", nullable: 'YES', def: 'NULL' },
  { name: 'boost_budget_amount', ddl: 'boost_budget_amount DECIMAL(15,2) NULL AFTER boost_budget_type', type: 'decimal(15,2)', nullable: 'YES', def: 'NULL' },
  { name: 'boost_spend_cap', ddl: 'boost_spend_cap DECIMAL(15,2) NULL AFTER boost_budget_amount', type: 'decimal(15,2)', nullable: 'YES', def: 'NULL' },
  { name: 'boost_end_time', ddl: 'boost_end_time TIMESTAMP NULL AFTER boost_spend_cap', type: 'timestamp', nullable: 'YES', def: 'NULL' },
  { name: 'boost_targeting', ddl: 'boost_targeting JSON NULL AFTER boost_end_time', type: 'json', nullable: 'YES', def: 'NULL' },
  { name: 'boost_placement', ddl: 'boost_placement JSON NULL AFTER boost_targeting', type: 'json', nullable: 'YES', def: 'NULL' },
  { name: 'boost_bid_strategy', ddl: 'boost_bid_strategy VARCHAR(50) NULL AFTER boost_placement', type: 'varchar(50)', nullable: 'YES', def: 'NULL' },
  { name: 'boost_optimization_goal', ddl: 'boost_optimization_goal VARCHAR(100) NULL AFTER boost_bid_strategy', type: 'varchar(100)', nullable: 'YES', def: 'NULL' },
  { name: 'ad_account_id', ddl: 'ad_account_id BINARY(16) NULL AFTER boost_optimization_goal', type: 'binary(16)', nullable: 'YES', def: 'NULL' },
  { name: 'charged_boost_paise', ddl: 'charged_boost_paise BIGINT NOT NULL DEFAULT 0 AFTER ad_account_id', type: 'bigint(20)', nullable: 'NO', def: '0' },
  { name: 'boost_error', ddl: 'boost_error TEXT NULL AFTER charged_boost_paise', type: 'text', nullable: 'YES', def: 'NULL' },
]

const EXPECTED_FK = {
  name: 'fk_posts_ad_account',
  ddl: 'ALTER TABLE posts ADD CONSTRAINT fk_posts_ad_account FOREIGN KEY (ad_account_id) REFERENCES meta_ad_accounts (id)',
}

const EXPECTED_INDEX = {
  name: 'idx_posts_boost_enabled',
  ddl: 'ALTER TABLE posts ADD KEY idx_posts_boost_enabled (boost_enabled)',
}

const EXPECTED_TABLES = [
  {
    name: 'post_boost_targets',
    ddl: `CREATE TABLE post_boost_targets (
        id BINARY(16) NOT NULL,
        post_id BINARY(16) NOT NULL,
        post_target_id BINARY(16) NOT NULL,
        platform_account_id BINARY(16) NULL,
        object_type ENUM('facebook_campaign','ad_set','ad_creative','ad') NOT NULL,
        object_id VARCHAR(255) NOT NULL,
        status VARCHAR(50) NULL,
        boost_status ENUM('pending','active','paused','failed','archived') NOT NULL DEFAULT 'pending',
        created_for_user_id BINARY(16) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uk_pbt_object_id (object_id),
        KEY idx_pbt_post_id (post_id),
        KEY idx_pbt_target_id (post_target_id),
        CONSTRAINT fk_pbt_post FOREIGN KEY (post_id) REFERENCES posts (id) ON DELETE CASCADE,
        CONSTRAINT fk_pbt_target FOREIGN KEY (post_target_id) REFERENCES post_targets (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  },
  {
    name: 'post_billing_entries',
    ddl: `CREATE TABLE post_billing_entries (
        id BINARY(16) NOT NULL,
        post_id BINARY(16) NOT NULL,
        kind ENUM('charge','settle','refund','overspend') NOT NULL,
        paise BIGINT NOT NULL,
        coins DECIMAL(15,2) NOT NULL,
        rate DECIMAL(15,6) NOT NULL,
        paid_from_monthly DECIMAL(15,2) NOT NULL DEFAULT 0,
        paid_from_wallet DECIMAL(15,2) NOT NULL DEFAULT 0,
        reason VARCHAR(255) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_pbe_post_id (post_id, created_at),
        CONSTRAINT fk_pbe_post FOREIGN KEY (post_id) REFERENCES posts (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  },
]

const COUNT_TABLES = ['posts', 'campaigns', 'campaign_executions', 'promotions', 'post_boost_daily_stats']

function normType(t) {
  return String(t || '').toLowerCase().replace(/^longtext$/, 'json')
}

async function classify(pool) {
  const missing = []
  const matching = []
  const conflicts = []

  const [cols] = await pool.query(
    "SELECT COLUMN_NAME AS n, COLUMN_TYPE AS t, IS_NULLABLE AS nl, COLUMN_DEFAULT AS d FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'posts'"
  )
  const byName = new Map(cols.map(c => [c.n, c]))
  for (const col of EXPECTED_COLUMNS) {
    const live = byName.get(col.name)
    if (!live) {
      missing.push({ kind: 'column', name: `posts.${col.name}`, ddl: `ALTER TABLE posts ADD COLUMN ${col.ddl}` })
    } else if (normType(live.t) !== normType(col.type) || live.nl !== col.nullable || String(live.d) !== col.def) {
      conflicts.push({ kind: 'column', name: `posts.${col.name}`, expected: `${col.type} nullable=${col.nullable} default=${col.def}`, actual: `${live.t} nullable=${live.nl} default=${live.d}`, reason: 'definition differs from 071 intent' })
    } else {
      matching.push(`posts.${col.name}`)
    }
  }

  const [idx] = await pool.query(
    "SELECT INDEX_NAME AS n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'posts' AND INDEX_NAME = ?",
    [EXPECTED_INDEX.name]
  )
  if (idx.length === 0) {
    missing.push({ kind: 'index', name: EXPECTED_INDEX.name, ddl: EXPECTED_INDEX.ddl })
  } else {
    matching.push(EXPECTED_INDEX.name)
  }

  const [fk] = await pool.query(
    'SELECT CONSTRAINT_NAME AS n FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?',
    ['posts', EXPECTED_FK.name]
  )
  if (fk.length === 0) {
    missing.push({ kind: 'fk', name: EXPECTED_FK.name, ddl: EXPECTED_FK.ddl })
  } else {
    matching.push(EXPECTED_FK.name)
  }

  const [tables] = await pool.query(
    'SELECT TABLE_NAME AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()'
  )
  const tableSet = new Set(tables.map(t => t.n))
  for (const table of EXPECTED_TABLES) {
    if (!tableSet.has(table.name)) {
      missing.push({ kind: 'table', name: table.name, ddl: table.ddl })
    } else {
      matching.push(table.name)
    }
  }

  return { missing, matching, conflicts }
}

async function rowCounts(pool) {
  const counts = {}
  for (const table of [...COUNT_TABLES, 'post_boost_targets', 'post_billing_entries']) {
    try {
      const [rows] = await pool.query(`SELECT COUNT(*) AS n FROM \`${table}\``)
      counts[table] = Number(rows[0].n)
    } catch {
      counts[table] = 'MISSING_TABLE'
    }
  }
  const [mig] = await pool.query('SELECT COUNT(*) AS n FROM _migrations')
  counts._migrations = Number(mig[0].n)
  return counts
}

async function main() {
  console.log('071 schema repair')
  console.log(`DB host: ${dbConfig.host} | DB name: ${dbConfig.database} | NODE_ENV: ${process.env.NODE_ENV || 'development'}`)
  if ((process.env.NODE_ENV === 'production' || /prod/i.test(dbConfig.database)) && !ALLOW_PRODUCTION) {
    console.error('STOP: target looks like production. Re-run with --allow-production only after explicit operator confirmation.')
    process.exit(1)
  }

  const pool = getPool()
  try {
    const before = await rowCounts(pool)
    console.log('Row counts before:', JSON.stringify(before))

    const { missing, matching, conflicts } = await classify(pool)
    console.log('\nMissing:')
    for (const m of missing) console.log(`  + ${m.kind} ${m.name}`)
    if (!missing.length) console.log('  (none)')
    console.log('\nMatching:')
    for (const m of matching) console.log(`  ✓ ${m}`)
    console.log('\nConflicts:')
    for (const c of conflicts) console.log(`  ! ${c.kind} ${c.name} expected=[${c.expected}] actual=[${c.actual}] reason=${c.reason}`)
    if (!conflicts.length) console.log('  none')

    if (conflicts.length > 0) {
      console.error('\nSTOP: conflicts must be resolved by an operator before any repair.')
      process.exit(1)
    }

    console.log('\nPlanned DDL:')
    for (const m of missing) console.log(`  -- ${m.kind} ${m.name}\n  ${m.ddl};`)
    if (!missing.length) console.log('  (nothing to repair)')

    if (DRY_RUN) {
      console.log('\nNo changes executed (dry-run; pass --execute to apply).')
      return
    }

    let created = 0
    let skipped = 0
    const createdTables = []
    for (const m of missing) {
      const fresh = await classify(pool)
      const stillMissing = fresh.missing.some(x => x.kind === m.kind && x.name === m.name)
      if (!stillMissing) {
        const nowMatching = fresh.matching.includes(m.name)
        const nowConflict = fresh.conflicts.find(x => x.kind === m.kind && x.name === m.name)
        if (nowMatching) {
          console.log(`SKIPPED_ALREADY_PRESENT ${m.kind} ${m.name}`)
          skipped += 1
          continue
        }
        if (nowConflict) {
          console.error(`CONFLICT ${m.kind} ${m.name} expected=[${nowConflict.expected}] actual=[${nowConflict.actual}]`)
          process.exit(1)
        }
      }
      try {
        await pool.execute(m.ddl)
        console.log(`CREATED ${m.kind} ${m.name}`)
        created += 1
        if (m.kind === 'table') createdTables.push(m.name)
      } catch (err) {
        console.error(`FAILED ${m.kind} ${m.name}: ${err.message}`)
        process.exit(1)
      }
    }

    const final = await classify(pool)
    const after = await rowCounts(pool)
    console.log('\nRow counts after:', JSON.stringify(after))
    for (const table of COUNT_TABLES) {
      if (before[table] !== after[table]) {
        console.error(`FAIL: row count changed for ${table}: ${before[table]} -> ${after[table]}`)
        process.exit(1)
      }
    }
    if (before._migrations !== after._migrations) {
      console.error(`FAIL: _migrations changed: ${before._migrations} -> ${after._migrations}`)
      process.exit(1)
    }
    for (const table of createdTables) {
      if (after[table] !== 0) {
        console.error(`FAIL: repaired table ${table} is not empty: ${after[table]}`)
        process.exit(1)
      }
    }

    if (final.missing.length === 0 && final.conflicts.length === 0) {
      console.log('\n071 schema verification: PASS')
      console.log(`Missing: 0 | Conflicts: 0 | Created: ${created} | Skipped: ${skipped} | Unexpected destructive operations: 0`)
    } else {
      console.error(`\n071 schema verification: FAIL (missing=${final.missing.length}, conflicts=${final.conflicts.length})`)
      for (const m of [...final.missing, ...final.conflicts]) console.error(`  - ${m.kind} ${m.name}`)
      process.exit(1)
    }
  } finally {
    await closePool()
  }
}

main().catch(err => {
  console.error(`repair failed: ${err.message}`)
  process.exit(1)
})
