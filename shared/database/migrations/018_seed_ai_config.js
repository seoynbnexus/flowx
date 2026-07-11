import { v7 as generateUuid } from 'uuid';

function uuidToBuffer(uuid) {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

const SEEDS = [
  {
    key: 'ai_markup_coins',
    value: 200,
    isPublic: 0,
    description: 'Admin markup coins added on top of LLM token cost per AI generation',
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
