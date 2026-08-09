// src/services/sessionManagementService.js
// Active session management: list, view, and revoke user sessions.

import { SECURITY_CONFIG } from '../config/securityConfig.js';
import prisma from '../lib/prisma.js';
import logger from '../logging/logger.js';
import { blacklistToken, RevocationWriteUnavailableError } from '../utils/tokenBlacklist.js';

/**
 * Failure codes returned by the revoke functions. The route layer maps these
 * to HTTP status codes — a missing session is a 404, but a revocation store
 * that refused the write is a 503, NOT a success.
 */
export const SESSION_REVOKE_FAILURE = Object.freeze({
  NOT_FOUND: 'SESSION_NOT_FOUND',
  STORE_UNAVAILABLE: 'REVOCATION_STORE_UNAVAILABLE',
});

/**
 * Upper bound on how long a blacklist row must outlive the token it revokes.
 *
 * `auth_logs` records the jti and the login time but NOT the token's `exp`, so
 * a revoke-by-jti request cannot read the real expiry off the session row. The
 * blacklist row only has to be RETAINED until the revoked token would have
 * expired on its own (`isTokenBlacklisted` filters on `expires_at > NOW()`), so
 * erring long is harmless while erring short silently un-revokes a live token.
 * We therefore use the same conservative ceiling `revokeAllUserTokens` uses —
 * `SECURITY_CONFIG.blacklist.maxTokenLifetimeDays`, "longest any token can live".
 */
function blacklistRetentionSeconds(loginAt) {
  const issuedAtMs = loginAt instanceof Date ? loginAt.getTime() : Date.parse(loginAt);
  const baseMs = Number.isFinite(issuedAtMs) ? issuedAtMs : Date.now();
  const lifetimeMs = SECURITY_CONFIG.blacklist.maxTokenLifetimeDays * 24 * 60 * 60 * 1000;
  return Math.floor((baseMs + lifetimeMs) / 1000);
}

/**
 * List all active sessions for a user.
 * Queries the auth_logs table for recent successful logins
 * and cross-references with invalidated_tokens to find active ones.
 *
 * @param {string} userId - The user's UID.
 * @param {number} limit - Max sessions to return.
 * @returns {Array} Active sessions.
 */
export async function listActiveSessions(userId, limit = 20) {
  try {
    const sessions = await prisma.$queryRawUnsafe(
      `SELECT
        al.id,
        al.jti,
        al.ip_address,
        al.user_agent,
        al.created_at AS login_at,
        al.device_info,
        CASE WHEN it.jti IS NOT NULL THEN false ELSE true END AS is_active
      FROM auth_logs al
      LEFT JOIN invalidated_tokens it ON al.jti = it.jti
      WHERE al.user_id = $1
        AND al.action = 'login_success'
        AND al.created_at > NOW() - INTERVAL '30 days'
      ORDER BY al.created_at DESC
      LIMIT $2`,
      userId, Math.min(Math.max(limit, 1), 50)
    );
    return sessions;
  } catch (err) {
    logger.error('Failed to list active sessions:', err);
    return [];
  }
}

/**
 * Revoke a specific session by its JTI (JWT ID).
 *
 * @param {string} userId - The user requesting revocation (for auth).
 * @param {string} jti - The JWT ID to revoke.
 * @returns {{ success: boolean, code?: string, message: string }}
 */
export async function revokeSession(userId, jti) {
  let session;
  try {
    // Verify the session belongs to this user.
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, user_id, created_at FROM auth_logs
       WHERE jti = $1 AND user_id = $2 AND action = 'login_success'`,
      jti, userId
    );

    if (rows.length === 0) {
      return {
        success: false,
        code: SESSION_REVOKE_FAILURE.NOT_FOUND,
        message: 'Session not found or access denied',
      };
    }
    session = rows[0];
  } catch (err) {
    logger.error('Failed to look up session for revocation:', err);
    return {
      success: false,
      code: SESSION_REVOKE_FAILURE.STORE_UNAVAILABLE,
      message: 'Failed to revoke session',
    };
  }

  try {
    // `requireEvidence` awaits the durable write and throws when NEITHER Redis
    // nor the DB accepted it. Without it this call was fire-and-forget, so the
    // endpoint answered 200 while nothing was persisted and the token stayed
    // live for its full lifetime (audit follow-up P12).
    await blacklistToken(
      jti,
      blacklistRetentionSeconds(session.created_at),
      'session_revoked',
      { requireEvidence: true },
    );
  } catch (err) {
    if (err instanceof RevocationWriteUnavailableError) {
      logger.error('Session revocation not persisted — no revocation store accepted it', {
        userId, jti, causes: { redis: err.causes?.redis?.message, database: err.causes?.database?.message },
      });
    } else {
      logger.error('Failed to revoke session:', err);
    }
    return {
      success: false,
      code: SESSION_REVOKE_FAILURE.STORE_UNAVAILABLE,
      message: 'Failed to revoke session',
    };
  }

  logger.info('Session revoked', { userId, jti });
  return { success: true, message: 'Session revoked successfully' };
}

/**
 * Revoke all sessions for a user except the current one.
 *
 * @param {string} userId - The user's UID.
 * @param {string} currentJti - The JTI of the current session to keep.
 * @returns {{ success: boolean, revokedCount: number, failedCount: number }}
 */
export async function revokeAllOtherSessions(userId, currentJti) {
  let sessions;
  try {
    sessions = await prisma.$queryRawUnsafe(
      `SELECT al.jti, al.created_at FROM auth_logs al
       LEFT JOIN invalidated_tokens it ON al.jti = it.jti
       WHERE al.user_id = $1
         AND al.jti != $2
         AND al.action = 'login_success'
         AND it.jti IS NULL
         AND al.created_at > NOW() - INTERVAL '30 days'`,
      userId, currentJti
    );
  } catch (err) {
    logger.error('Failed to list sessions for bulk revocation:', err);
    return {
      success: false,
      code: SESSION_REVOKE_FAILURE.STORE_UNAVAILABLE,
      revokedCount: 0,
      failedCount: 0,
    };
  }

  // Each session is revoked independently: one store failure must not silently
  // abandon the sessions after it, and the caller is told exactly how many of
  // the requested revocations actually persisted.
  let revokedCount = 0;
  let failedCount = 0;
  for (const session of sessions) {
    if (!session.jti) continue;
    try {
      await blacklistToken(
        session.jti,
        blacklistRetentionSeconds(session.created_at),
        'session_revoked',
        { requireEvidence: true },
      );
      revokedCount++;
    } catch (err) {
      failedCount++;
      logger.error('Session revocation not persisted during revoke-all', {
        userId, jti: session.jti, error: err?.message,
      });
    }
  }

  logger.info('All other sessions revoked', { userId, revokedCount, failedCount });
  return failedCount === 0
    ? { success: true, revokedCount, failedCount }
    : {
        success: false,
        code: SESSION_REVOKE_FAILURE.STORE_UNAVAILABLE,
        revokedCount,
        failedCount,
      };
}
