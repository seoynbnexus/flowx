import { v7 as generateUuid } from 'uuid';

function uuidToBuffer(uuid) {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

const SEEDS = [
  {
    key: 'coin_conversion_rate',
    value: 1,
    isPublic: 1,
    description: 'Conversion rate: 1 coin = X INR when calculating Meta ad budget from coin budget',
  },
];

export async function up({ context: pool }) {
  for (const seed of SEEDS) {
    await pool.execute(
      `INSERT IGNORE INTO app_config (id, config_key, config_value, is_public, description, version)
       VALUES (?, ?, ?, ?, ?, 1)`,
      [uuidToBuffer(generateUuid()), seed.key, JSON.stringify(seed.value), seed.isPublic ?? 1, seed.description]
    );
  }
}

export async function down({ context: pool }) {
  for (const seed of SEEDS) {
    await pool.execute('DELETE FROM app_config WHERE config_key = ?', [seed.key]);
  }
}
