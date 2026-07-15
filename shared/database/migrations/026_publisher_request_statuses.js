const UP = `
ALTER TABLE campaign_publisher_requests
MODIFY COLUMN status ENUM('pending','accepted','rejected','cancelled','completed','published','failed') NOT NULL DEFAULT 'pending';
`;

const DOWN = `
ALTER TABLE campaign_publisher_requests
MODIFY COLUMN status ENUM('pending','accepted','rejected','cancelled','completed') NOT NULL DEFAULT 'pending';
`;

export async function up({ context: pool }) {
  const statements = UP.split(';').filter(s => s.trim().length > 0);
  for (const stmt of statements) {
    await pool.execute(stmt.trim() + ';');
  }
}

export async function down({ context: pool }) {
  const statements = DOWN.split(';').filter(s => s.trim().length > 0);
  for (const stmt of statements) {
    await pool.execute(stmt.trim() + ';');
  }
}
