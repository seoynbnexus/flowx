const UP = `
CREATE TABLE IF NOT EXISTS posts (
  id BINARY(16) NOT NULL,
  client_id BINARY(16) NOT NULL,
  name VARCHAR(255) NOT NULL,
  type ENUM('post','story','reel') NOT NULL DEFAULT 'post',
  status ENUM('draft','pending_review','approved','rejected','changes_requested','scheduled','running','completed','cancelled','failed','awaiting_publishers') NOT NULL DEFAULT 'draft',
  scheduled_at TIMESTAMP NULL DEFAULT NULL,
  caption TEXT NULL DEFAULT NULL,
  media_url TEXT NULL DEFAULT NULL,
  hashtags TEXT NULL DEFAULT NULL,
  text_body TEXT NULL DEFAULT NULL,
  category_id BINARY(16) NULL DEFAULT NULL,
  run_on_publishers TINYINT(1) NOT NULL DEFAULT 0,
  publisher_count INT NULL DEFAULT NULL,
  coins_per_publisher DECIMAL(15,2) NULL DEFAULT NULL,
  escrow_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  coins_escrowed_at TIMESTAMP NULL DEFAULT NULL,
  publisher_response_deadline_at TIMESTAMP NULL DEFAULT NULL,
  client_confirmed TINYINT(1) NOT NULL DEFAULT 0,
  client_confirmed_at TIMESTAMP NULL DEFAULT NULL,
  admin_notes TEXT NULL DEFAULT NULL,
  reviewed_by BINARY(16) NULL DEFAULT NULL,
  reviewed_at TIMESTAMP NULL DEFAULT NULL,
  review_notes TEXT NULL DEFAULT NULL,
  published_at TIMESTAMP NULL DEFAULT NULL,
  error TEXT NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP NULL DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_posts_client (client_id, status, created_at),
  KEY idx_posts_status (status, created_at),
  CONSTRAINT fk_posts_client FOREIGN KEY (client_id) REFERENCES users (id),
  CONSTRAINT fk_posts_category FOREIGN KEY (category_id) REFERENCES ad_categories (id),
  CONSTRAINT fk_posts_reviewer FOREIGN KEY (reviewed_by) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS post_targets (
  id BINARY(16) NOT NULL,
  post_id BINARY(16) NOT NULL,
  platform_account_id BINARY(16) NOT NULL,
  target_type ENUM('client','publisher') NOT NULL DEFAULT 'client',
  publisher_request_id BINARY(16) NULL DEFAULT NULL,
  status ENUM('pending','posted','failed') NOT NULL DEFAULT 'pending',
  error TEXT NULL DEFAULT NULL,
  meta_object_id VARCHAR(255) NULL DEFAULT NULL,
  posted_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_post_target (post_id, platform_account_id),
  KEY idx_post_targets_post (post_id, status),
  CONSTRAINT fk_pt_post FOREIGN KEY (post_id) REFERENCES posts (id) ON DELETE CASCADE,
  CONSTRAINT fk_pt_account FOREIGN KEY (platform_account_id) REFERENCES user_platform_accounts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS post_review_log (
  id BINARY(16) NOT NULL,
  post_id BINARY(16) NOT NULL,
  reviewer_id BINARY(16) NULL DEFAULT NULL,
  action ENUM('submitted','approved','rejected','changes_requested','cancelled','confirmed') NOT NULL,
  previous_status VARCHAR(50) NOT NULL,
  notes TEXT NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_review_log_post (post_id, created_at),
  CONSTRAINT fk_review_log_post FOREIGN KEY (post_id) REFERENCES posts (id) ON DELETE CASCADE,
  CONSTRAINT fk_review_log_post_reviewer FOREIGN KEY (reviewer_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS post_publisher_requests (
  id BINARY(16) NOT NULL,
  post_id BINARY(16) NOT NULL,
  publisher_id BINARY(16) NOT NULL,
  coins_offered DECIMAL(15,2) NOT NULL,
  status ENUM('pending','accepted','rejected','cancelled','completed','published','failed','pending_republish') NOT NULL DEFAULT 'pending',
  creative_snapshot TEXT NULL DEFAULT NULL,
  responded_at TIMESTAMP NULL DEFAULT NULL,
  published_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ppr_post (post_id, status),
  KEY idx_ppr_publisher (publisher_id, status),
  CONSTRAINT fk_ppr_post FOREIGN KEY (post_id) REFERENCES posts (id) ON DELETE CASCADE,
  CONSTRAINT fk_ppr_publisher FOREIGN KEY (publisher_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

const DOWN = `
DROP TABLE IF EXISTS post_publisher_requests;
DROP TABLE IF EXISTS post_review_log;
DROP TABLE IF EXISTS post_targets;
DROP TABLE IF EXISTS posts;
`;

const POST_PERMISSIONS = [
  { code: 'posts.read', name: 'Read Posts', description: 'View own posts' },
  { code: 'posts.create', name: 'Create Posts', description: 'Create and manage own posts' },
  { code: 'posts.review', name: 'Review Posts', description: 'Approve or reject posts as admin' },
  { code: 'posts.manage', name: 'Manage Posts', description: 'Full post management access' },
]

import { v7 as generateUuid } from 'uuid'

function uuidToBuffer(uuid) {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex')
}

export async function up({ context: pool }) {
  const statements = UP.split(';').filter(s => s.trim().length > 0)
  for (const stmt of statements) {
    await pool.execute(stmt.trim() + ';')
  }

  for (const perm of POST_PERMISSIONS) {
    const permissionId = generateUuid()
    try {
      await pool.query(
        `INSERT IGNORE INTO permissions (id, module, code, name, description)
         VALUES (?, 'posts', ?, ?, ?)`,
        [uuidToBuffer(permissionId), perm.code, perm.name, perm.description]
      )
      console.log(`  + Seeded permission: ${perm.code}`)
    } catch (error) {
      console.error(`  ! Error seeding permission ${perm.code}: ${error.message}`)
    }
  }

  const [entityCols] = await pool.execute(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'campaign_jobs' AND COLUMN_NAME = 'entity_type'"
  )
  if (entityCols.length === 0) {
    await pool.execute("ALTER TABLE campaign_jobs ADD COLUMN entity_type VARCHAR(10) NOT NULL DEFAULT 'campaign' AFTER job_type")
    console.log('  + Added entity_type to campaign_jobs')
  } else {
    console.log('  ~ campaign_jobs.entity_type already present')
  }

  const [fkRows] = await pool.execute(
    "SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'campaign_jobs' AND CONSTRAINT_NAME = 'fk_campaign_jobs_campaign'"
  )
  if (fkRows.length > 0) {
    await pool.execute('ALTER TABLE campaign_jobs DROP FOREIGN KEY fk_campaign_jobs_campaign')
    console.log('  + Dropped campaign FK from campaign_jobs (generic entity queue)')
  } else {
    console.log('  ~ campaign_jobs campaign FK already dropped')
  }
}

export async function down({ context: pool }) {
  for (const perm of POST_PERMISSIONS) {
    try {
      await pool.query('DELETE FROM permissions WHERE code = ?', [perm.code])
      console.log(`  - Removed permission: ${perm.code}`)
    } catch (error) {
      console.error(`  ! Error removing permission ${perm.code}: ${error.message}`)
    }
  }

  const [entityCols] = await pool.execute(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'campaign_jobs' AND COLUMN_NAME = 'entity_type'"
  )
  if (entityCols.length > 0) {
    await pool.execute('ALTER TABLE campaign_jobs DROP COLUMN entity_type')
    console.log('  - Dropped entity_type from campaign_jobs')
  }

  const [fkRows] = await pool.execute(
    "SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'campaign_jobs' AND CONSTRAINT_NAME = 'fk_campaign_jobs_campaign'"
  )
  if (fkRows.length === 0) {
    await pool.execute('ALTER TABLE campaign_jobs ADD CONSTRAINT fk_campaign_jobs_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns (id)')
    console.log('  - Restored campaign FK on campaign_jobs')
  }

  const statements = DOWN.split(';').filter(s => s.trim().length > 0)
  for (const stmt of statements) {
    await pool.execute(stmt.trim() + ';')
  }
}

export default { up, down }
