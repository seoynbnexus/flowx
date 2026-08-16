const UP = `
ALTER TABLE post_publisher_requests
  ADD COLUMN platform_account_id BINARY(16) NULL DEFAULT NULL AFTER publisher_id,
  ADD COLUMN accepted_at TIMESTAMP NULL DEFAULT NULL AFTER responded_at,
  ADD COLUMN rejected_at TIMESTAMP NULL DEFAULT NULL AFTER accepted_at,
  ADD COLUMN completed_at TIMESTAMP NULL DEFAULT NULL AFTER rejected_at,
  ADD COLUMN expires_at TIMESTAMP NULL DEFAULT NULL AFTER completed_at,
  ADD COLUMN failure_reason TEXT NULL DEFAULT NULL AFTER expires_at,
  ADD COLUMN content_snapshot TEXT NULL DEFAULT NULL AFTER creative_snapshot,
  ADD COLUMN content_snapshot_hash VARCHAR(64) NULL DEFAULT NULL AFTER content_snapshot,
  ADD COLUMN payout_status ENUM('pending','paid','skipped') NOT NULL DEFAULT 'pending' AFTER content_snapshot_hash,
  ADD COLUMN payout_transaction_id VARCHAR(64) NULL DEFAULT NULL AFTER payout_status,
  ADD COLUMN request_generation INT NOT NULL DEFAULT 1 AFTER payout_transaction_id;

CREATE INDEX idx_ppr_post_publisher_gen ON post_publisher_requests (post_id, publisher_id, request_generation);
CREATE UNIQUE INDEX uk_ppr_post_publisher_gen ON post_publisher_requests (post_id, publisher_id, request_generation);

ALTER TABLE post_publisher_requests
  ADD CONSTRAINT fk_ppr_account FOREIGN KEY (platform_account_id) REFERENCES user_platform_accounts (id);

ALTER TABLE post_targets
  ADD CONSTRAINT fk_pt_publisher_request FOREIGN KEY (publisher_request_id) REFERENCES post_publisher_requests (id);
`;

const DOWN = `
ALTER TABLE post_targets DROP FOREIGN KEY fk_pt_publisher_request;
ALTER TABLE post_publisher_requests DROP FOREIGN KEY fk_ppr_account;
DROP INDEX uk_ppr_post_publisher_gen ON post_publisher_requests;
DROP INDEX idx_ppr_post_publisher_gen ON post_publisher_requests;
ALTER TABLE post_publisher_requests
  DROP COLUMN request_generation,
  DROP COLUMN payout_transaction_id,
  DROP COLUMN payout_status,
  DROP COLUMN content_snapshot_hash,
  DROP COLUMN content_snapshot,
  DROP COLUMN failure_reason,
  DROP COLUMN expires_at,
  DROP COLUMN completed_at,
  DROP COLUMN rejected_at,
  DROP COLUMN accepted_at,
  DROP COLUMN platform_account_id;
`;

export async function up({ context: pool }) {
  const statements = UP.split(';').filter(s => s.trim().length > 0)
  for (const stmt of statements) {
    await pool.execute(stmt.trim() + ';')
  }
}

export async function down({ context: pool }) {
  const statements = DOWN.split(';').filter(s => s.trim().length > 0)
  for (const stmt of statements) {
    await pool.execute(stmt.trim() + ';')
  }
}
