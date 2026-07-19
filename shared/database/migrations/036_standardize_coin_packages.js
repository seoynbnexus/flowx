export async function up({ context: pool }) {
  const [cols] = await pool.execute(
    "SHOW COLUMNS FROM coin_topup_packages LIKE 'price'"
  )
  if (cols.length > 0 && cols[0].Type === 'int(11)') {
    await pool.execute('ALTER TABLE coin_topup_packages MODIFY COLUMN price DECIMAL(10,2) NOT NULL')
    await pool.execute('UPDATE coin_topup_packages SET price = price / 100')
    console.log('  + Standardized coin_topup_packages.price to DECIMAL(10,2) rupees')
  } else {
    console.log('  ~ coin_topup_packages.price already DECIMAL or not found')
  }
}

export async function down({ context: pool }) {
  await pool.execute('UPDATE coin_topup_packages SET price = price * 100')
  await pool.execute('ALTER TABLE coin_topup_packages MODIFY COLUMN price INT NOT NULL')
  console.log('  - Reverted coin_topup_packages.price to INT paise')
}

export default { up, down }
