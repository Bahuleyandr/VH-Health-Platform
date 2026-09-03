// src/services/auth/userActiveSession.js
//
// Active-session tracking, shared across all three auth realms
// (staff, admin, patient).
//
// Every login service calls `claimUserSession(...)` after generating the new
// JWT. The helper:
//   1. Looks up the user's current active session row (one row per user_uid).
//   2. For refresh-token rotation, blacklists the replaced access-token jti.
//   3. For deployments that explicitly opt into strict single-session mode,
//      blacklists the old login token and emits `session:revoked`.
//   4. Upserts the newest session row for operator visibility.
//
// Backed by the `user_active_sessions` table (migration 232).

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { blacklistToken } from '../../utils/tokenBlacklist.js';
import { pushSessionRevoked } from '../../utils/websocket/wsServer.js';

function strictSingleSessionEnabled() {
  const raw = process.env.AUTH_ENFORCE_SINGLE_ACTIVE_SESSION
    ?? process.env.ENFORCE_SINGLE_ACTIVE_SESSION
    ?? '';
  return String(raw).toLowerCase() === 'true';
}

/**
 * Replace the user's prior active session (if any) with the new one. Revokes
 * the prior jti and (by default) emits a `session:revoked` event to that user.
 *
 * Pass `pushRevoked: false` for refresh-token rotation: the new jti is the
 * same logical session, just rotated, so the device should NOT kick itself
 * to login on receiving its own revoke event.
 *
 * @param {Object} args
 * @param {string} args.userUid - The user's UUID (users.uid). Required.
 * @param {string} args.jti - The new access token's jti claim. Required.
 * @param {string} args.deviceType - 'mobile' | 'tablet' | 'desktop' | 'web'. Required.
 * @param {Date}   args.expiresAt - Expiry of the new access token. Required.
 * @param {string} [args.deviceLabel] - Optional human label (e.g. "Pixel 8").
 * @param {string} [args.ipAddress] - req.ip of the new login.
 * @param {string} [args.userAgent] - User-Agent of the new login.
 * @param {string} [args.sessionFamilyId] - Stable selector shared by access, refresh, and WS tokens.
 * @param {string} [args.stableDeviceId] - Stable UUID for device-bound staff sessions.
 * @param {boolean} [args.pushRevoked=true] - Emit `session:revoked` over WS
 *   for the prior jti. Set false on refresh-token rotation.
 * @param {boolean} [args.enforceSingleSession] - Override the environment
 *   flag for login-token replacement. Refresh rotation always revokes the
 *   rotated token regardless of this flag.
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
  sessionFamilyId = null,
  stableDeviceId = null,
  pushRevoked = true,
  enforceSingleSession,
  tenantId = null,
}) {
  if (!userUid || !jti || !deviceType || !expiresAt) {
    throw new Error('claimUserSession: userUid, jti, deviceType, expiresAt are required');
  }

  const revocationRequired = Boolean(
    pushRevoked === false || (enforceSingleSession ?? strictSingleSessionEnabled())
  );

  // Step 1: look up the prior session for this user.
  let prior = null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT jti, device_type, session_family_id, stable_device_id,
              EXTRACT(EPOCH FROM expires_at)::bigint AS expires_at_unix
         FROM user_active_sessions
        WHERE user_uid = $1::uuid
        LIMIT 1`,
      userUid,
    );
    if (rows.length > 0) prior = rows[0];
  } catch (err) {
    if (revocationRequired) throw err;
    // A normal, non-strict login does not promise to retire a prior session.
    // Preserve that availability contract when the operator has not enabled
    // single-session enforcement.
    logger.warn('claimUserSession: prior-session lookup failed', { userUid, error: err.message });
  }

  // Step 2: blacklist the prior jti only when it is a refresh-token
  // rotation, or when strict single-session mode is explicitly enabled.
  // Normal staff/admin logins must not silently revoke a still-active token:
  // shared hospital workstations and parallel QA journeys can otherwise lock
  // each other out seconds after a successful login.
  const shouldRevokePrior = Boolean(
    prior?.jti
    && prior.jti !== jti
    && revocationRequired
  );

  if (shouldRevokePrior) {
    await blacklistToken(
      prior.jti,
      Number(prior.expires_at_unix),
      pushRevoked ? 'replaced_by_new_login' : 'refresh_rotation',
      {
        requireEvidence: true,
        userId: userUid,
        sessionFamilyId: prior.session_family_id ?? null,
        stableDeviceId: prior.stable_device_id ?? null,
        notifySession: false,
      },
    );
    if (pushRevoked) {
      try {
        pushSessionRevoked(userUid, {
          reason: 'new_login_elsewhere',
          jti: prior.jti,
          sessionFamilyId: prior.session_family_id ?? null,
          stableDeviceId: prior.stable_device_id ?? null,
          newDeviceType: deviceType,
          priorDeviceType: prior.device_type,
          at: new Date().toISOString(),
        });
      } catch (err) {
        logger.warn('claimUserSession: pushSessionRevoked failed', { userUid, error: err.message });
      }
    }
  }

  // Step 3: upsert the new session row.
  try {
    await prisma.$executeRawUnsafe(
      // M8 (audit 2026-06-22): stamp tenant_id EXPLICITLY. user_active_sessions is
      // a FORCE-RLS table whose tenant_id default reads app.current_tenant_id;
      // claimUserSession runs OUTSIDE a setTenant context (GUC unset), so without
      // this the session row fell back to the DEFAULT tenant — post-cutover that
      // mis-attributes a non-default-tenant user's session. The caller threads the
      // bearer's resolved tenant; if null we keep the GUC→default behaviour so
      // single-tenant deployments are unchanged.
       `INSERT INTO user_active_sessions
         (user_uid, jti, device_type, device_label, ip_address, user_agent, expires_at,
          tenant_id, session_family_id, stable_device_id)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7,
                COALESCE($8::uuid,
                         (NULLIF(NULLIF(current_setting('app.current_tenant_id', true), ''), 'bypass'))::uuid,
                         '00000000-0000-4000-8000-000000000001'::uuid),
               $9, $10::uuid)
       ON CONFLICT (user_uid) DO UPDATE SET
         jti          = EXCLUDED.jti,
         device_type  = EXCLUDED.device_type,
         device_label = EXCLUDED.device_label,
         ip_address   = EXCLUDED.ip_address,
         user_agent   = EXCLUDED.user_agent,
         issued_at    = NOW(),
         expires_at   = EXCLUDED.expires_at,
         tenant_id    = EXCLUDED.tenant_id,
         session_family_id = EXCLUDED.session_family_id,
         stable_device_id  = EXCLUDED.stable_device_id`,
      userUid,
      jti,
      deviceType,
      deviceLabel,
      ipAddress,
      userAgent,
      expiresAt,
      tenantId,
      sessionFamilyId,
      stableDeviceId,
    );
  } catch (err) {
    // If the insert fails, the new token is still valid (we generated it
    // already) — the user just won't be tracked here. Log and continue;
    // the next login will catch up.
    logger.error('claimUserSession: upsert failed', { userUid, error: err.message });
  }

  return {
    revokedPrior: shouldRevokePrior,
    priorDeviceType: prior?.device_type ?? null,
  };
}

/**
 * Look up the device_type recorded for the user's current active session.
 *
 * Used by refresh-token rotation paths that need to preserve the deviceType
 * claim across rotation but don't have it from the (refresh) token.
 *
 * @param {string} userUid
 * @returns {Promise<string|null>} the recorded device_type, or null if no row.
 */
export async function getUserSessionDeviceType(userUid) {
  if (!userUid) return null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      'SELECT device_type FROM user_active_sessions WHERE user_uid = $1::uuid LIMIT 1',
      userUid,
    );
    if (rows.length > 0) return rows[0].device_type ?? null;
  } catch (err) {
    logger.warn('getUserSessionDeviceType failed', { userUid, error: err.message });
  }
  return null;
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
