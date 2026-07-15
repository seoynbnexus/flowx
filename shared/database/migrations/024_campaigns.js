const UP = `
CREATE TABLE IF NOT EXISTS campaigns (
  id BINARY(16) NOT NULL,
  client_id BINARY(16) NOT NULL,
  category_id BINARY(16) NULL DEFAULT NULL,
  name VARCHAR(255) NOT NULL,
  type ENUM('post','story','reel','advertisement') NOT NULL DEFAULT 'post',
  status ENUM('draft','pending_review','approved','rejected','changes_requested','scheduled','running','completed','cancelled','failed') NOT NULL DEFAULT 'draft',
  scheduled_at TIMESTAMP NULL DEFAULT NULL,
  publisher_count INT NULL DEFAULT NULL,
  coins_per_publisher DECIMAL(15,2) NULL DEFAULT NULL,
  escrow_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  coins_escrowed_at TIMESTAMP NULL DEFAULT NULL,
  client_confirmed TINYINT(1) NOT NULL DEFAULT 0,
  client_confirmed_at TIMESTAMP NULL DEFAULT NULL,
  admin_notes TEXT NULL DEFAULT NULL,
  reviewed_by BINARY(16) NULL DEFAULT NULL,
  reviewed_at TIMESTAMP NULL DEFAULT NULL,
  review_notes TEXT NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP NULL DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_campaigns_client (client_id, status, created_at),
  KEY idx_campaigns_status (status, created_at),
  CONSTRAINT fk_campaigns_client FOREIGN KEY (client_id) REFERENCES users (id),
  CONSTRAINT fk_campaigns_category FOREIGN KEY (category_id) REFERENCES ad_categories (id),
  CONSTRAINT fk_campaigns_reviewer FOREIGN KEY (reviewed_by) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS campaign_creatives (
  id BINARY(16) NOT NULL,
  campaign_id BINARY(16) NOT NULL,
  media_url TEXT NULL DEFAULT NULL,
  caption TEXT NULL DEFAULT NULL,
  hashtags TEXT NULL DEFAULT NULL,
  text_body TEXT NULL DEFAULT NULL,
  call_to_action VARCHAR(100) NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_creative_campaign (campaign_id),
  CONSTRAINT fk_creative_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS campaign_meta_settings (
  id BINARY(16) NOT NULL,
  campaign_id BINARY(16) NOT NULL,
  objective VARCHAR(100) NOT NULL,
  ad_account_id VARCHAR(100) NULL DEFAULT NULL,
  bid_strategy VARCHAR(50) NULL DEFAULT NULL,
  optimization_goal VARCHAR(100) NULL DEFAULT NULL,
  budget_type ENUM('daily','lifetime') NULL DEFAULT NULL,
  budget_amount DECIMAL(15,2) NULL DEFAULT NULL,
  targeting JSON NOT NULL DEFAULT (JSON_OBJECT()),
  platform_placement JSON NOT NULL DEFAULT (JSON_OBJECT()),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_meta_campaign (campaign_id),
  CONSTRAINT fk_meta_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS campaign_meta_objects (
  id BINARY(16) NOT NULL,
  campaign_id BINARY(16) NOT NULL,
  object_type ENUM('facebook_campaign','ad_set','ad_creative','ad','facebook_post','instagram_media') NOT NULL,
  object_id VARCHAR(255) NOT NULL,
  platform_account_id BINARY(16) NULL DEFAULT NULL,
  status VARCHAR(50) NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_meta_objects_campaign (campaign_id, object_type),
  CONSTRAINT fk_meta_objects_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns (id) ON DELETE CASCADE,
  CONSTRAINT fk_meta_objects_account FOREIGN KEY (platform_account_id) REFERENCES user_platform_accounts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS campaign_review_log (
  id BINARY(16) NOT NULL,
  campaign_id BINARY(16) NOT NULL,
  reviewer_id BINARY(16) NOT NULL,
  action ENUM('submitted','approved','rejected','changes_requested','cancelled','confirmed') NOT NULL,
  previous_status VARCHAR(50) NOT NULL,
  notes TEXT NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_review_log_campaign (campaign_id, created_at),
  CONSTRAINT fk_review_log_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns (id) ON DELETE CASCADE,
  CONSTRAINT fk_review_log_reviewer FOREIGN KEY (reviewer_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

const DOWN = `
DROP TABLE IF EXISTS campaign_review_log;
DROP TABLE IF EXISTS campaign_meta_objects;
DROP TABLE IF EXISTS campaign_meta_settings;
DROP TABLE IF EXISTS campaign_creatives;
DROP TABLE IF EXISTS campaigns;
`;

import { v7 as generateUuid } from 'uuid';

function uuidToBuffer(uuid) {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

const CAMPAIGN_PERMISSIONS = [
  { code: 'campaigns.read', name: 'Read Campaigns', description: 'View own campaigns' },
  { code: 'campaigns.create', name: 'Create Campaigns', description: 'Create new campaigns' },
  { code: 'campaigns.review', name: 'Review Campaigns', description: 'Approve or reject campaigns as admin' },
  { code: 'campaigns.manage', name: 'Manage Campaigns', description: 'Full campaign management access' },
];

export async function up({ context: pool }) {
  const statements = UP.split(';').filter(s => s.trim().length > 0);
  for (const stmt of statements) {
    await pool.execute(stmt.trim() + ';');
  }

  for (const perm of CAMPAIGN_PERMISSIONS) {
    const permissionId = generateUuid();
    try {
      await pool.query(
        `INSERT IGNORE INTO permissions (id, module, code, name, description)
         VALUES (?, 'campaigns', ?, ?, ?)`,
        [uuidToBuffer(permissionId), perm.code, perm.name, perm.description]
      );
      console.log(`  + Seeded permission: ${perm.code}`);
    } catch (error) {
      console.error(`  ! Error seeding permission ${perm.code}: ${error.message}`);
    }
  }
}

export async function down({ context: pool }) {
  try {
    for (const perm of CAMPAIGN_PERMISSIONS) {
      await pool.query('DELETE FROM permissions WHERE code = ?', [perm.code]);
      console.log(`  - Removed permission: ${perm.code}`);
    }
  } catch (error) {
    console.error(`  ! Error removing permissions: ${error.message}`);
  }

  const statements = DOWN.split(';').filter(s => s.trim().length > 0);
  for (const stmt of statements) {
    await pool.execute(stmt.trim() + ';');
  }
}
