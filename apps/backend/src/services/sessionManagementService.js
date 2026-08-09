// src/services/sessionManagementService.js
// Active session management: list, view, and revoke user sessions.
//
// ── Why this reads user_active_sessions and not auth_logs ────────────────────
// It used to query `auth_logs WHERE action = 'login_success'`. Nothing in this
// repo has ever written that action value, and no login path writes `user_id`
// or `jti` onto an auth_logs row at all (the three writers are
// firebaseAuthService.logFirebaseAuth, staffAuthService.logAuthAttempt, and the
// logout row in authService — the first two insert only phone/action/success/
// method/ip/ua). So every query here matched zero rows for every user, always:
// GET returned [], DELETE returned 404, revoke-all returned 0 (audit P15).
//
// The real session registry is `user_active_sessions`, written by
// claimUserSession() on every login that goes through issueAccessTokenAndClaimSession.
// Its primary key is `user_uid` with ON CONFLICT DO UPDATE, so the platform
// holds AT MOST ONE session per user — a login elsewhere evicts the previous
// device and pushes it a `session:revoked` event. This surface now reports that
// truthfully instead of inventing a multi-session history.

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
 * Where a listed session came from. Not every login path claims a registry row
 * — the admin paths in adminAuthController mint tokens with generateToken()
 * directly, never calling claimUserSession — so a registry-only answer would
 * tell a signed-in admin they have no sessions. The caller's own token is
 * always authoritative for its own existence, so it is reported explicitly.
 */
export const SESSION_SOURCE = Object.freeze({
  REGISTRY: 'session_registry',
  ACCESS_TOKEN: 'access_token',
});

/** Normalises a Date | ISO string | epoch-seconds number to epoch seconds. */
function toEpochSeconds(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.floor(value) : null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/**
 * Live sessions for a user, straight from the registry.
 *
 * A row counts as live only if all three hold — mirroring exactly what
 * jwtMiddleware enforces on every request, so the list cannot claim a session
 * the API would actually reject:
 *   1. its own `expires_at` is still in the future;
 *   2. its jti is not in `invalidated_tokens` (per-token revocation);
 *   3. no `user:<uid>` revoke-all marker post-dates its `issued_at`
 *      (revokeAllUserTokens writes that marker rather than per-jti rows).
 */
async function selectLiveRegistrySessions(userUid) {
  return prisma.$queryRawUnsafe(
    `SELECT
       s.jti,
       s.device_type,
       s.device_label,
       s.ip_address,
       s.user_agent,
       s.issued_at,
       s.expires_at
     FROM user_active_sessions s
     LEFT JOIN invalidated_tokens t
       ON t.jti = s.jti
      AND t.expires_at > NOW()
     LEFT JOIN invalidated_tokens r
       ON r.jti = 'user:' || s.user_uid::text
      AND r.expires_at > NOW()
      AND r.created_at > s.issued_at
     WHERE s.user_uid = $1::uuid
       AND s.expires_at > NOW()
       AND t.jti IS NULL
       AND r.jti IS NULL`,
    userUid,
  );
}

/**
 * List the caller's live sessions.
 *
 * @param {string} userUid - The caller's UID, from the verified JWT.
 * @param {{jti?: string, expiresAt?: Date|string|number}} [currentToken] - The
 *   caller's own presented token claims, so its session is reported even on
 *   login paths that never claimed a registry row.
 * @returns {Promise<Array>} Live sessions, newest first.
 * @throws when the registry cannot be read — an empty list would be
 *   indistinguishable from "you have no sessions", which is a different claim.
 */
export async function listActiveSessions(userUid, currentToken = {}) {
  const rows = await selectLiveRegistrySessions(userUid);
  const currentJti = currentToken.jti ?? null;

  const sessions = rows.map((row) => ({
    jti: row.jti,
    device_type: row.device_type,
    device_label: row.device_label,
    ip_address: row.ip_address,
    user_agent: row.user_agent,
    issued_at: row.issued_at,
    expires_at: row.expires_at,
    is_current: currentJti != null && row.jti === currentJti,
    source: SESSION_SOURCE.REGISTRY,
  }));

  if (currentJti && !sessions.some((s) => s.is_current)) {
    // The caller is demonstrably holding a live token right now — jwtMiddleware
    // verified it to get here — so omitting it would be the same class of lie
    // this endpoint is being fixed for.
    sessions.push({
      jti: currentJti,
      device_type: null,
      device_label: null,
      ip_address: null,
      user_agent: null,
      issued_at: null,
      expires_at: currentToken.expiresAt ?? null,
      is_current: true,
      source: SESSION_SOURCE.ACCESS_TOKEN,
    });
  }

  return sessions.sort((a, b) => {
    if (a.is_current !== b.is_current) return a.is_current ? -1 : 1;
    return String(b.issued_at ?? '').localeCompare(String(a.issued_at ?? ''));
  });
}

/**
 * Revoke one of the caller's sessions by jti.
 *
 * @param {string} userUid
 * @param {string} jti
 * @param {{jti?: string, expiresAt?: Date|string|number}} [currentToken]
 * @returns {Promise<{success: boolean, code?: string, message: string}>}
 */
export async function revokeSession(userUid, jti, currentToken = {}) {
  let expiresAtSeconds = null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT jti, expires_at FROM user_active_sessions
        WHERE user_uid = $1::uuid AND jti = $2`,
      userUid, jti,
    );
    if (rows.length > 0) {
      expiresAtSeconds = toEpochSeconds(rows[0].expires_at);
    } else if (currentToken.jti && currentToken.jti === jti) {
      // No registry row, but the caller is presenting this exact token — the
      // admin login paths mint tokens without claiming a row, and refusing to
      // revoke a token we just authenticated would be absurd.
      expiresAtSeconds = toEpochSeconds(currentToken.expiresAt);
    }
  } catch (err) {
    logger.error('Failed to look up session for revocation:', err);
    return {
      success: false,
      code: SESSION_REVOKE_FAILURE.STORE_UNAVAILABLE,
      message: 'Failed to revoke session',
    };
  }

  if (expiresAtSeconds == null) {
    return {
      success: false,
      code: SESSION_REVOKE_FAILURE.NOT_FOUND,
      message: 'Session not found or access denied',
    };
  }

  try {
    // requireEvidence awaits the durable write and throws when NEITHER Redis
    // nor the DB accepted it, so this cannot report a revocation that did not
    // persist (audit P12).
    await blacklistToken(jti, expiresAtSeconds, 'session_revoked', { requireEvidence: true });
  } catch (err) {
    if (err instanceof RevocationWriteUnavailableError) {
      logger.error('Session revocation not persisted — no revocation store accepted it', {
        userUid, jti,
        causes: { redis: err.causes?.redis?.message, database: err.causes?.database?.message },
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

  logger.info('Session revoked', { userUid, jti });
  return { success: true, message: 'Session revoked successfully' };
}

/**
 * Revoke every live session except the caller's current one.
 *
 * The registry holds at most one row per user, so in practice this revokes
 * nothing and truthfully says so. It is kept because that is a property of the
 * current login model, not a guarantee of the API — if the platform ever allows
 * concurrent sessions this keeps working without a client change.
 *
 * @returns {Promise<{success: boolean, code?: string, revokedCount: number, failedCount: number}>}
 */
export async function revokeAllOtherSessions(userUid, currentJti) {
  let sessions;
  try {
    sessions = await selectLiveRegistrySessions(userUid);
  } catch (err) {
    logger.error('Failed to list sessions for bulk revocation:', err);
    return {
      success: false,
      code: SESSION_REVOKE_FAILURE.STORE_UNAVAILABLE,
      revokedCount: 0,
      failedCount: 0,
    };
  }

  const others = sessions.filter((s) => s.jti && s.jti !== currentJti);

  // Each is revoked independently: one store failure must not silently abandon
  // the rest, and the caller is told how many actually persisted.
  let revokedCount = 0;
  let failedCount = 0;
  for (const session of others) {
    const expiresAtSeconds = toEpochSeconds(session.expires_at);
    if (expiresAtSeconds == null) continue;
    try {
      await blacklistToken(session.jti, expiresAtSeconds, 'session_revoked', { requireEvidence: true });
      revokedCount++;
    } catch (err) {
      failedCount++;
      logger.error('Session revocation not persisted during revoke-all', {
        userUid, jti: session.jti, error: err?.message,
      });
    }
  }

  logger.info('All other sessions revoked', { userUid, revokedCount, failedCount });
  return failedCount === 0
    ? { success: true, revokedCount, failedCount }
    : {
        success: false,
        code: SESSION_REVOKE_FAILURE.STORE_UNAVAILABLE,
        revokedCount,
        failedCount,
      };
}
