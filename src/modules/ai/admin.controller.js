import * as repo from './ai.repository.js';
import { query, queryOne } from '../../../shared/database/connection.js';
import { uuidToBuffer, bufferToUuid, generateUuid } from '../../../shared/utils/uuid.utils.js';
import { sendSuccess, sendError } from '../../../shared/utils/response.utils.js';
import { HTTP_STATUS } from '../../../shared/constants/httpStatus.js';
import { AI_LIMITS, getMarkupCoins, invalidateMarkupCache, getImageBaseCost, invalidateImageBaseCache } from './ai.config.js';

export async function getConfig(req, res, next) {
  try {
    const [markupCoins, imageBaseCost] = await Promise.all([
      getMarkupCoins(),
      getImageBaseCost(),
    ]);
    const config = {
      pricing: { markupCoins },
      imagePricing: { imageBaseCost },
      limits: {
        maxPromptLength: AI_LIMITS.maxPromptLength,
        rateLimitRpm: AI_LIMITS.rateLimitRpm,
      },
    };
    return sendSuccess(res, config);
  } catch (error) {
    next(error);
  }
}

export async function updateConfig(req, res, next) {
  try {
    const { markupCoins } = req.body;

    if (markupCoins !== undefined) {
      if (typeof markupCoins !== 'number' || markupCoins < 0 || !Number.isInteger(markupCoins)) {
        return sendError(res, HTTP_STATUS.UNPROCESSABLE_ENTITY, 'markupCoins must be a non-negative integer');
      }

      const existing = await queryOne(
        "SELECT id FROM app_config WHERE config_key = 'ai_markup_coins'"
      );

      if (existing) {
        await query(
          "UPDATE app_config SET config_value = ?, updated_by = ?, version = version + 1 WHERE config_key = 'ai_markup_coins'",
          [JSON.stringify(markupCoins), uuidToBuffer(req.user.id)]
        );
      } else {
        await query(
          `INSERT INTO app_config (id, config_key, config_value, is_public, description, version, updated_by)
           VALUES (?, 'ai_markup_coins', ?, 0, 'Admin markup coins added on top of LLM token cost per AI generation', 1, ?)`,
          [uuidToBuffer(generateUuid()), JSON.stringify(markupCoins), uuidToBuffer(req.user.id)]
        );
      }

      invalidateMarkupCache();
    }

    if (imageBaseCost !== undefined) {
      if (typeof imageBaseCost !== 'number' || imageBaseCost < 0 || !Number.isInteger(imageBaseCost)) {
        return sendError(res, HTTP_STATUS.UNPROCESSABLE_ENTITY, 'imageBaseCost must be a non-negative integer');
      }

      const existing = await queryOne(
        "SELECT id FROM app_config WHERE config_key = 'ai_image_base_cost'"
      );

      if (existing) {
        await query(
          "UPDATE app_config SET config_value = ?, updated_by = ?, version = version + 1 WHERE config_key = 'ai_image_base_cost'",
          [JSON.stringify(imageBaseCost), uuidToBuffer(req.user.id)]
        );
      } else {
        await query(
          `INSERT INTO app_config (id, config_key, config_value, is_public, description, version, updated_by)
           VALUES (?, 'ai_image_base_cost', ?, 0, 'Base coin cost per image generation (added to markup coins)', 1, ?)`,
          [uuidToBuffer(generateUuid()), JSON.stringify(imageBaseCost), uuidToBuffer(req.user.id)]
        );
      }

      invalidateImageBaseCache();
    }

    const [newMarkup, newImageBaseCost] = await Promise.all([
      getMarkupCoins(),
      getImageBaseCost(),
    ]);
    return sendSuccess(res, { pricing: { markupCoins: newMarkup }, imagePricing: { imageBaseCost: newImageBaseCost } }, 'AI config updated');
  } catch (error) {
    next(error);
  }
}

export async function usageStats(req, res, next) {
  try {
    const { page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    const countRow = await queryOne('SELECT COUNT(DISTINCT user_id) as total FROM ai_usage_log');
    const rows = await query(
      `SELECT user_id, COUNT(*) as total_requests,
              SUM(was_blocked) as blocked_count,
              SUM(coins_spent) as total_coins_spent,
              SUM(tokens_used) as total_tokens
       FROM ai_usage_log
       GROUP BY user_id
       ORDER BY total_requests DESC
       LIMIT ? OFFSET ?`,
      [String(limit), String(offset)]
    );

    const stats = rows.map(r => ({
      userId: bufferToUuid(r.user_id),
      totalRequests: r.total_requests,
      blockedCount: r.blocked_count,
      totalCoinsSpent: r.total_coins_spent,
      totalTokens: r.total_tokens,
    }));

    return sendSuccess(res, {
      items: stats,
      total: countRow?.total || 0,
      page: Number(page),
      limit: Number(limit),
    });
  } catch (error) {
    next(error);
  }
}

export async function usageByUser(req, res, next) {
  try {
    const { userId } = req.params;
    const { page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    const countRow = await queryOne(
      'SELECT COUNT(*) as total FROM ai_usage_log WHERE user_id = ?',
      [uuidToBuffer(userId)]
    );

    const rows = await query(
      `SELECT * FROM ai_usage_log WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [uuidToBuffer(userId), String(limit), String(offset)]
    );

    const logs = rows.map(r => ({
      ...r,
      id: bufferToUuid(r.id),
      user_id: bufferToUuid(r.user_id),
    }));

    return sendSuccess(res, {
      items: logs,
      total: countRow?.total || 0,
      page: Number(page),
      limit: Number(limit),
    });
  } catch (error) {
    next(error);
  }
}

export async function addCoins(req, res, next) {
  try {
    const { userId, amount, reason } = req.body;

    if (!userId || !amount || amount <= 0) {
      return sendError(res, HTTP_STATUS.UNPROCESSABLE_ENTITY, 'Valid userId and positive amount are required');
    }

    const user = await queryOne('SELECT id FROM users WHERE id = ?', [uuidToBuffer(userId)]);
    if (!user) {
      return sendError(res, HTTP_STATUS.NOT_FOUND, 'User not found');
    }

    await repo.addCoins(userId, amount);
    const transactionId = generateUuid();
    await repo.createTransaction(transactionId, userId, reason || 'Admin credit adjustment', amount, 'credit', 'admin_adjustment', null);

    const { default: authRepo } = await import('../auth/auth.repository.js');
    await authRepo.createAuditLog(
      generateUuid(), req.user.id, 'wallet', userId,
      'wallet.admin_credit', null,
      { amount, reason: reason || 'Admin credit adjustment', newBalance: await repo.findUserWalletCoins(userId) }
    );

    return sendSuccess(res, {
      amount,
      newBalance: await repo.findUserWalletCoins(userId),
      transactionId,
    }, 'Coins added successfully');
  } catch (error) {
    next(error);
  }
}

export async function deductCoins(req, res, next) {
  try {
    const { userId, amount, reason } = req.body;

    if (!userId || !amount || amount <= 0) {
      return sendError(res, HTTP_STATUS.UNPROCESSABLE_ENTITY, 'Valid userId and positive amount are required');
    }

    const balance = await repo.findUserWalletCoins(userId);
    if (balance < amount) {
      return sendError(res, HTTP_STATUS.UNPROCESSABLE_ENTITY, 'Insufficient coins');
    }

    await repo.deductCoins(userId, amount);
    const transactionId = generateUuid();
    await repo.createTransaction(transactionId, userId, reason || 'Admin debit adjustment', amount, 'debit', 'admin_adjustment', null);

    const { default: authRepo } = await import('../auth/auth.repository.js');
    await authRepo.createAuditLog(
      generateUuid(), req.user.id, 'wallet', userId,
      'wallet.admin_debit', null,
      { amount, reason: reason || 'Admin debit adjustment', newBalance: await repo.findUserWalletCoins(userId) }
    );

    return sendSuccess(res, {
      amount,
      newBalance: await repo.findUserWalletCoins(userId),
      transactionId,
    }, 'Coins deducted successfully');
  } catch (error) {
    next(error);
  }
}

export async function getWallet(req, res, next) {
  try {
    const { userId } = req.params;
    const { page = 1, limit = 20 } = req.query;

    const wallet = await queryOne(
      'SELECT coins FROM user_wallets WHERE user_id = ?',
      [uuidToBuffer(userId)]
    );

    const transactions = await query(
      'SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
      [uuidToBuffer(userId), String(limit), String((page - 1) * limit)]
    );

    const countRow = await queryOne(
      'SELECT COUNT(*) as total FROM transactions WHERE user_id = ?',
      [uuidToBuffer(userId)]
    );

    return sendSuccess(res, {
      balance: wallet?.coins || 0,
      transactions: transactions.map(t => ({
        ...t,
        id: bufferToUuid(t.id),
        user_id: bufferToUuid(t.user_id),
        reference_id: t.reference_id ? bufferToUuid(t.reference_id) : null,
      })),
      total: countRow?.total || 0,
      page: Number(page),
      limit: Number(limit),
    });
  } catch (error) {
    next(error);
  }
}
