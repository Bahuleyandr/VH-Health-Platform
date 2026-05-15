// src/services/auth/userActiveSession.js
//
// Single-active-session enforcement, shared across all three auth realms
// (staff, admin, patient).
//
// Every login service calls `claimUserSession(...)` after generating the new
// JWT. The helper:
//   1. Looks up the user's current active session row (one row per user_uid).
//   2. If one exists, blacklists its `jti` via tokenBlacklist.blacklistToken
//      so the old device's next API call returns 401.
//   3. Emits a `session:revoked` event over the realtime fabric (per-user
//      routing via wsServer.sendToUser) so the old device routes to /login
//      immediately, not on the next API call.
//   4. Upserts the new session row with the freshly-issued jti.
//
// Backed by the `user_active_sessions` table (migration 232).

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { blacklistToken } from '../../utils/tokenBlacklist.js';
import { sendToUser } from '../../utils/websocket/wsServer.js';

/**
 * Replace the user's prior active session (if any) with the new one. Revokes
 * the prior jti and emits a `session:revoked` event to that user.
 *
 * @param {Object} args
 * @param {string} args.userUid - The user's UUID (users.uid). Required.
 * @param {string} args.jti - The new access token's jti claim. Required.
 * @param {string} args.deviceType - 'mobile' | 'desktop' | 'web'. Required.
 * @param {Date}   args.expiresAt - Expiry of the new access token. Required.
 * @param {string} [args.deviceLabel] - Optional human label (e.g. "Pixel 8").
 * @param {string} [args.ipAddress] - req.ip of the new login.
 * @param {string} [args.userAgent] - User-Agent of the new login.
 * @returns {Promise<{ revokedPrior: boolean, priorDeviceType: string|null }>}
 */
export async function claimUserSession({
  userUid,
  jti,
  deviceType,
  expiresAt,
  deviceLabel = null,
  ipAddress = null,
  userAgent = null,
}) {
  if (!userUid || !jti || !deviceType || !expiresAt) {
    throw new Error('claimUserSession: userUid, jti, deviceType, expiresAt are required');
  }

  // Step 1: look up the prior session for this user.
  let prior = null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT jti, device_type, EXTRACT(EPOCH FROM expires_at)::bigint AS expires_at_unix
         FROM user_active_sessions
        WHERE user_uid = $1::uuid
        LIMIT 1`,
      userUid,
    );
    if (rows.length > 0) prior = rows[0];
  } catch (err) {
    // A read failure should not block a login. Log and continue without
    // revoking — the worst case is the prior device stays alive one more
    // request cycle, until its jti naturally expires.
    logger.warn('claimUserSession: prior-session lookup failed', { userUid, error: err.message });
  }

  // Step 2: blacklist the prior jti + push a realtime kick to that user.
  if (prior && prior.jti && prior.jti !== jti) {
    try {
      await blacklistToken(prior.jti, Number(prior.expires_at_unix), 'replaced_by_new_login');
    } catch (err) {
      logger.warn('claimUserSession: blacklistToken failed', { userUid, error: err.message });
    }
    try {
      sendToUser(userUid, 'session:revoked', {
        reason: 'new_login_elsewhere',
        newDeviceType: deviceType,
        priorDeviceType: prior.device_type,
        at: new Date().toISOString(),
      });
    } catch (err) {
      logger.warn('claimUserSession: sendToUser failed', { userUid, error: err.message });
    }
  }

  // Step 3: upsert the new session row.
  try {
    await prisma.$executeRawUnsafe(
      `INSERT INTO user_active_sessions
         (user_uid, jti, device_type, device_label, ip_address, user_agent, expires_at)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_uid) DO UPDATE SET
         jti          = EXCLUDED.jti,
         device_type  = EXCLUDED.device_type,
         device_label = EXCLUDED.device_label,
         ip_address   = EXCLUDED.ip_address,
         user_agent   = EXCLUDED.user_agent,
         issued_at    = NOW(),
         expires_at   = EXCLUDED.expires_at`,
      userUid,
      jti,
      deviceType,
      deviceLabel,
      ipAddress,
      userAgent,
      expiresAt,
    );
  } catch (err) {
    // If the insert fails, the new token is still valid (we generated it
    // already) — the user just won't be tracked here. Log and continue;
    // the next login will catch up.
    logger.error('claimUserSession: upsert failed', { userUid, error: err.message });
  }

  return {
    revokedPrior: Boolean(prior),
    priorDeviceType: prior?.device_type ?? null,
  };
}

/**
 * Clear the user's active session row entirely. Used on explicit logout so a
 * subsequent login on the same device is not flagged as "evicting" anything.
 *
 * Does NOT blacklist the jti — the caller (LogoutService etc.) does that as
 * part of its own logout flow.
 *
 * @param {string} userUid
 */
export async function dropUserSession(userUid) {
  if (!userUid) return;
  try {
    await prisma.$executeRawUnsafe(
      'DELETE FROM user_active_sessions WHERE user_uid = $1::uuid',
      userUid,
    );
  } catch (err) {
    logger.warn('dropUserSession failed', { userUid, error: err.message });
  }
}
