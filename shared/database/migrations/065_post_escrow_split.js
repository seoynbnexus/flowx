const UP = `
ALTER TABLE posts
  ADD COLUMN escrow_from_monthly DECIMAL(15,2) NOT NULL DEFAULT 0 AFTER escrow_amount,
  ADD COLUMN escrow_from_wallet DECIMAL(15,2) NOT NULL DEFAULT 0 AFTER escrow_from_monthly;
`;

const DOWN = `
ALTER TABLE posts
  DROP COLUMN escrow_from_wallet,
  DROP COLUMN escrow_from_monthly;
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
