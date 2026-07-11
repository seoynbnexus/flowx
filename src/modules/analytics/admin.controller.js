import { query, queryOne } from '../../../shared/database/connection.js';
import { sendSuccess } from '../../../shared/utils/response.utils.js';
import { bufferToUuid } from '../../../shared/utils/uuid.utils.js';

export async function getOverview(req, res, next) {
  try {
    const [totalUsers, dau, wau, mau, totalAi, totalCoins, blocked] = await Promise.all([
      queryOne('SELECT COUNT(*) as count FROM users'),
      queryOne("SELECT COUNT(DISTINCT user_id) as count FROM auth_login_history WHERE created_at >= CURDATE() AND success = 1"),
      queryOne("SELECT COUNT(DISTINCT user_id) as count FROM auth_login_history WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY) AND success = 1"),
      queryOne("SELECT COUNT(DISTINCT user_id) as count FROM auth_login_history WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) AND success = 1"),
      queryOne('SELECT COUNT(*) as count FROM ai_usage_log WHERE was_blocked = 0'),
      queryOne('SELECT COALESCE(SUM(coins_spent), 0) as total FROM ai_usage_log WHERE was_blocked = 0'),
      queryOne('SELECT COUNT(*) as count FROM users WHERE status = ?', ['blocked']),
    ]);

    return sendSuccess(res, {
      totalUsers: totalUsers?.count || 0,
      dailyActiveUsers: dau?.count || 0,
      weeklyActiveUsers: wau?.count || 0,
      monthlyActiveUsers: mau?.count || 0,
      totalAiGenerations: totalAi?.count || 0,
      totalAiCoinsSpent: totalCoins?.total || 0,
      blockedUsers: blocked?.count || 0,
    });
  } catch (error) {
    next(error);
  }
}

export async function getUsers(req, res, next) {
  try {
    const { page = 1, limit = 20, sort = 'logins', order = 'desc' } = req.query;
    const offset = (page - 1) * limit;
    const validSort = ['logins', 'last_login', 'coins', 'created_at'].includes(sort) ? sort : 'logins';
    const validOrder = order === 'asc' ? 'ASC' : 'DESC';

    const orderMap = {
      logins: 'login_count',
      last_login: 'u.last_login_at',
      coins: 'total_coins_spent',
      created_at: 'u.created_at',
    };

    const countRow = await queryOne('SELECT COUNT(*) as total FROM users');
    const rows = await query(`
      SELECT u.id, u.email, u.status, u.created_at, u.last_login_at,
             COALESCE(l.login_count, 0) as login_count,
             COALESCE(a.total_generations, 0) as total_generations,
             COALESCE(a.total_coins_spent, 0) as total_coins_spent
      FROM users u
      LEFT JOIN (
        SELECT user_id, COUNT(*) as login_count
        FROM auth_login_history WHERE success = 1
        GROUP BY user_id
      ) l ON u.id = l.user_id
      LEFT JOIN (
        SELECT user_id, COUNT(*) as total_generations, SUM(coins_spent) as total_coins_spent
        FROM ai_usage_log WHERE was_blocked = 0
        GROUP BY user_id
      ) a ON u.id = a.user_id
      ORDER BY ${orderMap[validSort]} ${validOrder}
      LIMIT ? OFFSET ?
    `, [String(limit), String(offset)]);

    const items = rows.map(r => ({
      id: bufferToUuid(r.id),
      email: r.email,
      status: r.status,
      createdAt: r.created_at,
      lastLoginAt: r.last_login_at,
      loginCount: r.login_count,
      totalGenerations: r.total_generations,
      totalCoinsSpent: Number(r.total_coins_spent) || 0,
    }));

    return sendSuccess(res, {
      items,
      total: countRow?.total || 0,
      page: Number(page),
      limit: Number(limit),
    });
  } catch (error) {
    next(error);
  }
}

export async function getLogins(req, res, next) {
  try {
    const days = parseInt(req.query.days) || 30;

    const dailyLoginRows = await query(`
      SELECT DATE(created_at) as date, COUNT(DISTINCT user_id) as active_users, COUNT(*) as total_logins,
             SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successful,
             SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failed
      FROM auth_login_history
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `, [days]);

    const methodRows = await query(`
      SELECT login_method, COUNT(*) as count
      FROM auth_login_history
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY) AND success = 1
      GROUP BY login_method
      ORDER BY count DESC
    `, [days]);

    const dailyLogins = dailyLoginRows.map(r => ({
      date: r.date,
      activeUsers: r.active_users,
      totalLogins: r.total_logins,
      successful: r.successful,
      failed: r.failed,
    }));

    const loginMethods = methodRows.map(r => ({
      method: r.login_method,
      count: r.count,
    }));

    return sendSuccess(res, { dailyLogins, loginMethods });
  } catch (error) {
    next(error);
  }
}

export async function getAiUsage(req, res, next) {
  try {
    const days = parseInt(req.query.days) || 30;

    const dailyRows = await query(`
      SELECT DATE(created_at) as date,
             content_type,
             COUNT(*) as count,
             SUM(coins_spent) as coins_spent,
             SUM(CASE WHEN was_blocked = 1 THEN 1 ELSE 0 END) as blocked
      FROM ai_usage_log
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
      GROUP BY DATE(created_at), content_type
      ORDER BY date ASC
    `, [days]);

    const typeRows = await query(`
      SELECT content_type, COUNT(*) as count, SUM(coins_spent) as coins_spent
      FROM ai_usage_log
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY) AND was_blocked = 0
      GROUP BY content_type
      ORDER BY count DESC
    `, [days]);

    return sendSuccess(res, {
      dailyUsage: dailyRows.map(r => ({
        date: r.date,
        contentType: r.content_type,
        count: r.count,
        coinsSpent: Number(r.coins_spent) || 0,
        blocked: r.blocked,
      })),
      typeBreakdown: typeRows.map(r => ({
        type: r.content_type,
        count: r.count,
        coinsSpent: Number(r.coins_spent) || 0,
      })),
    });
  } catch (error) {
    next(error);
  }
}

export async function getEconomy(req, res, next) {
  try {
    const [walletStats, totalCredits, totalDebits] = await Promise.all([
      query(`
        SELECT COUNT(*) as wallet_count, COALESCE(SUM(coins), 0) as total_coins,
               COALESCE(AVG(coins), 0) as avg_coins
        FROM user_wallets
      `),
      queryOne("SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type = 'credit'"),
      queryOne("SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type = 'debit'"),
    ]);

    return sendSuccess(res, {
      totalWallets: walletStats[0]?.wallet_count || 0,
      totalCoinsInSystem: Number(walletStats[0]?.total_coins) || 0,
      averageCoinsPerUser: Math.round(Number(walletStats[0]?.avg_coins) || 0),
      totalCredits: Number(totalCredits?.total) || 0,
      totalDebits: Number(totalDebits?.total) || 0,
    });
  } catch (error) {
    next(error);
  }
}
