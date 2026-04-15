// src/services/sessionManagementService.js
// Active session management: list, view, and revoke user sessions.

import prisma from '../lib/prisma.js';
import logger from '../logging/logger.js';
import { blacklistToken } from '../utils/tokenBlacklist.js';

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
 * @returns {{ success: boolean, message: string }}
 */
export async function revokeSession(userId, jti) {
  try {
    // Verify the session belongs to this user
    const session = await prisma.$queryRawUnsafe(
      `SELECT id, user_id FROM auth_logs
       WHERE jti = $1 AND user_id = $2 AND action = 'login_success'`,
      jti, userId
    );

    if (session.length === 0) {
      return { success: false, message: 'Session not found or access denied' };
    }

    await blacklistToken(jti);

    logger.info('Session revoked', { userId, jti });
    return { success: true, message: 'Session revoked successfully' };
  } catch (err) {
    logger.error('Failed to revoke session:', err);
    return { success: false, message: 'Failed to revoke session' };
  }
}

/**
 * Revoke all sessions for a user except the current one.
 *
 * @param {string} userId - The user's UID.
 * @param {string} currentJti - The JTI of the current session to keep.
 * @returns {{ success: boolean, revokedCount: number }}
 */
export async function revokeAllOtherSessions(userId, currentJti) {
  try {
    const sessions = await prisma.$queryRawUnsafe(
      `SELECT al.jti FROM auth_logs al
       LEFT JOIN invalidated_tokens it ON al.jti = it.jti
       WHERE al.user_id = $1
         AND al.jti != $2
         AND al.action = 'login_success'
         AND it.jti IS NULL
         AND al.created_at > NOW() - INTERVAL '30 days'`,
      userId, currentJti
    );

    let revokedCount = 0;
    for (const session of sessions) {
      if (session.jti) {
        await blacklistToken(session.jti);
        revokedCount++;
      }
    }

    logger.info('All other sessions revoked', { userId, revokedCount });
    return { success: true, revokedCount };
  } catch (err) {
    logger.error('Failed to revoke all sessions:', err);
    return { success: false, revokedCount: 0 };
  }
}
