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

export async function getPublishers(req, res, next) {
  try {
    const [roleBreakdown, totals, topEarners, campaignStatusRows, postStatusRows, totalPayout, connectedAccounts] = await Promise.all([
      query(`
        SELECT r.code as role, COUNT(DISTINCT ur.user_id) as count
        FROM user_roles ur
        JOIN roles r ON r.id = ur.role_id
        GROUP BY r.code
      `),
      queryOne(`
        SELECT
          COUNT(*) as totalPublishers,
          SUM(CASE WHEN EXISTS (
            SELECT 1 FROM campaign_publisher_requests cpr WHERE cpr.publisher_id = u.id AND cpr.status = 'accepted'
          ) OR EXISTS (
            SELECT 1 FROM post_publisher_requests ppr WHERE ppr.publisher_id = u.id AND ppr.status = 'accepted'
          ) THEN 1 ELSE 0 END) as activePublishers
        FROM users u
        WHERE u.id IN (SELECT user_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.code = 'publisher')
      `),
      query(`
        SELECT u.id, u.email, up.first_name, up.last_name,
               COALESCE(SUM(t.amount), 0) as totalEarned
        FROM users u
        LEFT JOIN user_profiles up ON up.user_id = u.id
        JOIN transactions t ON t.user_id = u.id AND t.type = 'credit' AND t.reference_type IN ('campaign', 'post')
        WHERE u.id IN (SELECT user_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.code = 'publisher')
        GROUP BY u.id, u.email, up.first_name, up.last_name
        ORDER BY totalEarned DESC
        LIMIT 10
      `),
      query(`SELECT status, COUNT(*) as cnt FROM campaign_publisher_requests GROUP BY status`),
      query(`SELECT status, COUNT(*) as cnt FROM post_publisher_requests GROUP BY status`),
      queryOne(`SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type = 'credit' AND reference_type IN ('campaign', 'post')`),
      queryOne(`
        SELECT COUNT(*) as total FROM user_platform_accounts upa
        WHERE upa.verification_status = 'verified'
          AND upa.user_id IN (SELECT user_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.code = 'publisher')
      `),
    ]);

    return sendSuccess(res, {
      roleBreakdown: roleBreakdown.map(r => ({ role: r.role, count: Number(r.count) })),
      totalPublishers: Number(totals?.totalPublishers || 0),
      activePublishers: Number(totals?.activePublishers || 0),
      totalPayoutCoins: Number(totalPayout?.total || 0),
      totalConnectedAccounts: Number(connectedAccounts?.total || 0),
      topEarners: topEarners.map(r => ({
        id: bufferToUuid(r.id),
        email: r.email,
        name: [r.first_name, r.last_name].filter(Boolean).join(' ') || null,
        totalEarned: Number(r.totalEarned) || 0,
      })),
      campaignRequestsByStatus: Object.fromEntries(campaignStatusRows.map(r => [r.status, Number(r.cnt)])),
      postRequestsByStatus: Object.fromEntries(postStatusRows.map(r => [r.status, Number(r.cnt)])),
    });
  } catch (error) {
    next(error);
  }
}

export async function getClients(req, res, next) {
  try {
    const [totals, topSpenders, campaignStatusRows, postStatusRows, connectedAccounts] = await Promise.all([
      queryOne(`
        SELECT
          COUNT(*) as totalClients,
          SUM(CASE WHEN EXISTS (
            SELECT 1 FROM campaigns c WHERE c.client_id = u.id AND c.deleted_at IS NULL
          ) OR EXISTS (
            SELECT 1 FROM posts p WHERE p.client_id = u.id AND p.deleted_at IS NULL
          ) THEN 1 ELSE 0 END) as activeClients
        FROM users u
        WHERE u.id IN (SELECT user_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.code = 'client')
      `),
      query(`
        SELECT u.id, u.email, up.first_name, up.last_name,
               COALESCE(SUM(c.charged_ad_budget_paise), 0) as totalSpentPaise,
               COUNT(DISTINCT c.id) as campaignCount
        FROM users u
        LEFT JOIN user_profiles up ON up.user_id = u.id
        JOIN campaigns c ON c.client_id = u.id AND c.deleted_at IS NULL
        WHERE u.id IN (SELECT user_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.code = 'client')
        GROUP BY u.id, u.email, up.first_name, up.last_name
        ORDER BY totalSpentPaise DESC
        LIMIT 10
      `),
      query(`SELECT status, COUNT(*) as cnt FROM campaigns WHERE deleted_at IS NULL GROUP BY status`),
      query(`SELECT status, COUNT(*) as cnt FROM posts WHERE deleted_at IS NULL GROUP BY status`),
      queryOne(`
        SELECT COUNT(*) as total FROM user_platform_accounts upa
        WHERE upa.verification_status = 'verified'
          AND upa.user_id IN (SELECT user_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.code = 'client')
      `),
    ]);

    return sendSuccess(res, {
      totalClients: Number(totals?.totalClients || 0),
      activeClients: Number(totals?.activeClients || 0),
      totalConnectedAccounts: Number(connectedAccounts?.total || 0),
      topSpenders: topSpenders.map(r => ({
        id: bufferToUuid(r.id),
        email: r.email,
        name: [r.first_name, r.last_name].filter(Boolean).join(' ') || null,
        totalSpentPaise: Number(r.totalSpentPaise) || 0,
        campaignCount: Number(r.campaignCount) || 0,
      })),
      campaignsByStatus: Object.fromEntries(campaignStatusRows.map(r => [r.status, Number(r.cnt)])),
      postsByStatus: Object.fromEntries(postStatusRows.map(r => [r.status, Number(r.cnt)])),
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
