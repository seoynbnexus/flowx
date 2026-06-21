import { getPool } from './connection.js';

const RETENTION_MONTHS = 12;

async function runCleanup() {
  const pool = getPool();

  try {
    console.log(`[cleanup] Starting at ${new Date().toISOString()}`);

    // Purge expired sessions
    const [sessionResult] = await pool.execute(
      'DELETE FROM user_sessions WHERE expires_at < NOW()'
    );
    if (sessionResult.affectedRows > 0) {
      console.log(`[cleanup] Purged ${sessionResult.affectedRows} expired sessions`);
    }

    // Purge old email verifications (older than 24 hours)
    const [emailResult] = await pool.execute(
      "DELETE FROM email_verifications WHERE expires_at < NOW() - INTERVAL 1 DAY"
    );
    if (emailResult.affectedRows > 0) {
      console.log(`[cleanup] Purged ${emailResult.affectedRows} expired email verifications`);
    }

    // Purge old password resets (older than 24 hours)
    const [resetResult] = await pool.execute(
      "DELETE FROM password_resets WHERE expires_at < NOW() - INTERVAL 1 DAY"
    );
    if (resetResult.affectedRows > 0) {
      console.log(`[cleanup] Purged ${resetResult.affectedRows} expired password resets`);
    }

    // Purge used/expired phone OTPs (older than 24 hours)
    const [otpResult] = await pool.execute(
      "DELETE FROM phone_otps WHERE (used_at IS NOT NULL OR expires_at < NOW()) AND created_at < NOW() - INTERVAL 1 DAY"
    );
    if (otpResult.affectedRows > 0) {
      console.log(`[cleanup] Purged ${otpResult.affectedRows} expired phone OTPs`);
    }

    // Purge used/expired email OTPs (older than 24 hours)
    const [emailOtpResult] = await pool.execute(
      "DELETE FROM email_otps WHERE (used_at IS NOT NULL OR expires_at < NOW()) AND created_at < NOW() - INTERVAL 1 DAY"
    );
    if (emailOtpResult.affectedRows > 0) {
      console.log(`[cleanup] Purged ${emailOtpResult.affectedRows} expired email OTPs`);
    }

    // Purge expired OAuth tokens (older than 1 day after expiry)
    const [tokenResult] = await pool.execute(
      "DELETE FROM oauth_tokens WHERE expires_at < NOW() - INTERVAL 1 DAY"
    );
    if (tokenResult.affectedRows > 0) {
      console.log(`[cleanup] Purged ${tokenResult.affectedRows} expired OAuth tokens`);
    }

    // Archive old audit logs (older than retention period)
    const [auditResult] = await pool.execute(
      `DELETE FROM audit_logs WHERE created_at < NOW() - INTERVAL ${RETENTION_MONTHS} MONTH`
    );
    if (auditResult.affectedRows > 0) {
      console.log(`[cleanup] Purged ${auditResult.affectedRows} old audit logs`);
    }

    // Archive old login history (older than retention period)
    const [loginResult] = await pool.execute(
      `DELETE FROM auth_login_history WHERE created_at < NOW() - INTERVAL ${RETENTION_MONTHS} MONTH`
    );
    if (loginResult.affectedRows > 0) {
      console.log(`[cleanup] Purged ${loginResult.affectedRows} old login history entries`);
    }

    console.log('[cleanup] Complete');
  } catch (error) {
    console.error('[cleanup] Failed:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runCleanup();
