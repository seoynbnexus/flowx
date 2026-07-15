import { query, queryOne } from '../../../shared/database/connection.js';
import { uuidToBuffer, bufferToUuid, generateUuid } from '../../../shared/utils/uuid.utils.js';

function mapGeneratedRow(row) {
  if (!row) return null;
  return {
    ...row,
    id: bufferToUuid(row.id),
    user_id: bufferToUuid(row.user_id),
    metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata || {},
  };
}

function mapUsageRow(row) {
  if (!row) return null;
  return {
    ...row,
    id: bufferToUuid(row.id),
    user_id: bufferToUuid(row.user_id),
  };
}

export async function createGeneratedContent(userId, prompt, contentType, content, cost, promptTokens, completionTokens, metadata) {
  const id = generateUuid();
  await query(
    `INSERT INTO ai_generated_content (id, user_id, prompt, content_type, generated_content, generation_cost, prompt_tokens, completion_tokens, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      uuidToBuffer(id),
      uuidToBuffer(userId),
      prompt,
      contentType,
      content,
      cost,
      promptTokens || 0,
      completionTokens || 0,
      JSON.stringify(metadata || {}),
    ]
  );
  return findById(id);
}

export async function findById(id) {
  const row = await queryOne('SELECT * FROM ai_generated_content WHERE id = ?', [uuidToBuffer(id)]);
  return mapGeneratedRow(row);
}

export async function findContentByUserId(userId, { page, limit, type }) {
  const offset = (page - 1) * limit;
  const where = ['user_id = ?'];
  const params = [uuidToBuffer(userId)];

  if (type) {
    where.push('content_type = ?');
    params.push(type);
  }

  const whereClause = `WHERE ${where.join(' AND ')}`;

  const countRow = await queryOne(
    `SELECT COUNT(*) as total FROM ai_generated_content ${whereClause}`,
    params
  );

  const rows = await query(
    `SELECT * FROM ai_generated_content ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, String(limit), String(offset)]
  );

  return {
    items: rows.map(mapGeneratedRow),
    total: countRow.total,
    page,
    limit,
  };
}

export async function deleteContent(id, userId) {
  await query(
    'DELETE FROM ai_generated_content WHERE id = ? AND user_id = ?',
    [uuidToBuffer(id), uuidToBuffer(userId)]
  );
}

export async function logUsage(userId, prompt, contentType, wasBlocked, blockReason, tokensUsed, coinsSpent) {
  const id = generateUuid();
  await query(
    `INSERT INTO ai_usage_log (id, user_id, prompt_text, content_type, was_blocked, block_reason, tokens_used, coins_spent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      uuidToBuffer(id),
      uuidToBuffer(userId),
      prompt ? prompt.substring(0, 500) : null,
      contentType || null,
      wasBlocked ? 1 : 0,
      blockReason || null,
      tokensUsed || 0,
      coinsSpent || 0,
    ]
  );
}

export async function countAbuseViolations(userId, windowHours) {
  const row = await queryOne(
    `SELECT COUNT(*) as count FROM ai_usage_log
     WHERE user_id = ? AND was_blocked = 1
     AND created_at > DATE_SUB(NOW(), INTERVAL ? HOUR)`,
    [uuidToBuffer(userId), windowHours]
  );
  return row?.count || 0;
}

export async function findUserWalletCoins(userId) {
  const row = await queryOne(
    'SELECT coins FROM user_wallets WHERE user_id = ?',
    [uuidToBuffer(userId)]
  );
  return row ? row.coins : 0;
}

export async function addCoins(userId, amount) {
  await query(
    'UPDATE user_wallets SET coins = coins + ? WHERE user_id = ?',
    [amount, uuidToBuffer(userId)]
  );
}

export async function deductCoins(userId, amount) {
  await query(
    'UPDATE user_wallets SET coins = coins - ? WHERE user_id = ? AND coins >= ?',
    [amount, uuidToBuffer(userId), amount]
  );
}

export async function createTransaction(id, userId, label, amount, type, referenceType = null, referenceId = null) {
  await query(
    `INSERT INTO transactions (id, user_id, label, amount, type, reference_type, reference_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [uuidToBuffer(id), uuidToBuffer(userId), label, amount, type, referenceType, referenceId ? uuidToBuffer(referenceId) : null]
  );
}

export async function findBlockedStatus(userId) {
  const row = await queryOne(
    'SELECT ai_generation_blocked FROM user_restrictions WHERE user_id = ?',
    [uuidToBuffer(userId)]
  );
  return row?.ai_generation_blocked === 1;
}

export async function blockGeneration(userId) {
  await query(
    `INSERT INTO user_restrictions (id, user_id, ai_generation_blocked)
     VALUES (?, ?, 1)
     ON DUPLICATE KEY UPDATE ai_generation_blocked = 1`,
    [uuidToBuffer(generateUuid()), uuidToBuffer(userId)]
  );
}

export async function findTransactions(userId, { page, limit }) {
  const offset = (page - 1) * limit;
  const rows = await query(
    'SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
    [uuidToBuffer(userId), String(limit), String(offset)]
  );
  return rows;
}

export async function getUsageStats(userId, since) {
  const rows = await query(
    `SELECT content_type, COUNT(*) as count, SUM(coins_spent) as total_coins, SUM(tokens_used) as total_tokens
     FROM ai_usage_log
     WHERE user_id = ? AND created_at > ?
     GROUP BY content_type`,
    [uuidToBuffer(userId), since]
  );
  return rows;
}

export async function getAiUsageSummary(userId, since) {
  const rows = await query(
    `SELECT COUNT(*) as total_generations,
            SUM(coins_spent) as total_coins_spent,
            SUM(tokens_used) as total_tokens_used,
            SUM(was_blocked) as total_blocked
     FROM ai_usage_log
     WHERE user_id = ? AND created_at > ?`,
    [uuidToBuffer(userId), since]
  )
  return rows[0] || { total_generations: 0, total_coins_spent: 0, total_tokens_used: 0, total_blocked: 0 }
}

export async function getAiUsageByType(userId, since) {
  const rows = await query(
    `SELECT content_type, COUNT(*) as count, SUM(coins_spent) as coins_spent
     FROM ai_usage_log
     WHERE user_id = ? AND created_at > ?
     GROUP BY content_type`,
    [uuidToBuffer(userId), since]
  )
  return rows.map(r => ({
    type: r.content_type || 'unknown',
    count: r.count,
    coins_spent: r.coins_spent || 0,
  }))
}

function mapImageRow(row) {
  if (!row) return null;
  return {
    ...row,
    id: bufferToUuid(row.id),
    user_id: bufferToUuid(row.user_id),
    metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata || {},
  };
}

export async function createGeneratedImage(userId, prompt, imageUrl, style, size, cost, metadata) {
  const id = generateUuid();
  await query(
    `INSERT INTO ai_generated_images (id, user_id, prompt, image_url, style, size, generation_cost, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      uuidToBuffer(id),
      uuidToBuffer(userId),
      prompt,
      imageUrl,
      style || null,
      size || '1024x1024',
      cost,
      JSON.stringify(metadata || {}),
    ]
  );
  const row = await queryOne('SELECT * FROM ai_generated_images WHERE id = ?', [uuidToBuffer(id)]);
  return mapImageRow(row);
}

export async function findImagesByUserId(userId, { page, limit }) {
  const offset = (page - 1) * limit;
  const countRow = await queryOne(
    'SELECT COUNT(*) as total FROM ai_generated_images WHERE user_id = ?',
    [uuidToBuffer(userId)]
  );
  const rows = await query(
    'SELECT * FROM ai_generated_images WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
    [uuidToBuffer(userId), String(limit), String(offset)]
  );
  return {
    items: rows.map(mapImageRow),
    total: countRow.total,
    page,
    limit,
  };
}

export async function deleteImage(id, userId) {
  const row = await queryOne(
    'SELECT image_url FROM ai_generated_images WHERE id = ? AND user_id = ?',
    [uuidToBuffer(id), uuidToBuffer(userId)]
  );
  if (row) {
    await query(
      'DELETE FROM ai_generated_images WHERE id = ? AND user_id = ?',
      [uuidToBuffer(id), uuidToBuffer(userId)]
    );
  }
  return row;
}
