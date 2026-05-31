// src/services/auth/loginSessionHelper.js
//
// One-stop helper used by every login service (staff / admin / patient) to:
//   1. Mint an access token with a pre-allocated jti and the deviceType claim.
//   2. Track the newest active session. Normal logins coexist by default so a
//      shared hospital workstation or parallel QA agent does not silently
//      revoke another fresh token; refresh-token rotation still revokes the
//      rotated access token.
//
// Centralising both steps here keeps the three auth services consistent and
// makes sure no login path forgets to claim the session.

import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { generateToken } from '../../utils/jwtUtils.js';
import { claimUserSession } from './userActiveSession.js';

const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';

/**
 * Resolve the tenant_id for a user from the users row.
 *
 * Cached per uid for the session lifetime (a user's tenant doesn't change
 * between logins; if it ever does, the migration that moves them will
 * invalidate by truncating the cache). Falls back to DEFAULT_TENANT_ID on
 * any lookup failure so a DB blip can never block a login — the failure
 * surfaces as the bearer being scoped to the default tenant, which is
 * fail-closed for multi-tenant deployments (the user gets their own
 * tenant's data on every other call, but their first login lands in the
 * default tenant — a clear, observable regression rather than a silent
 * cross-tenant read).
 *
 * Tenant RLS doc: docs/GAP_ANALYSIS_TENANT_RLS.md (Phase 1).
 */
const tenantCache = new Map();
const TENANT_CACHE_MAX = 50000;

async function resolveTenantIdForUid(uid) {
  if (!uid) return DEFAULT_TENANT_ID;
  if (tenantCache.has(uid)) return tenantCache.get(uid);
  let tenantId = DEFAULT_TENANT_ID;
  try {
    const rows = await prisma.$queryRawUnsafe(
      'SELECT tenant_id FROM users WHERE uid = $1::uuid LIMIT 1',
      String(uid),
    );
    if (rows.length > 0 && rows[0].tenant_id) {
      tenantId = String(rows[0].tenant_id);
    }
  } catch (err) {
    logger.warn(`tenant resolution fell back to default for uid=${uid}: ${err.message}`);
  }
  if (tenantCache.size >= TENANT_CACHE_MAX) {
    tenantCache.delete(tenantCache.keys().next().value);
  }
  tenantCache.set(uid, tenantId);
  return tenantId;
}

/**
 * Issue an access token and register it as the user's latest active session.
 *
 * @param {Object} args
 * @param {string} args.userUid - The user's UUID. Required.
 * @param {Object} args.tokenPayload - Claims for `generateToken` (uid, role, id?, phone?, ...).
 * @param {string} [args.expiresIn] - jsonwebtoken-style override ('8h', '7d'). Falls back to JWT_EXPIRES_IN.
 * @param {string} [args.deviceType] - 'mobile' | 'tablet' | 'desktop' | 'web'. Embedded as a JWT claim *only* when
 *                                     present, so old (unupdated) clients that don't send it get tokens
 *                                     without the claim — the requireDeviceType gate then forces re-login.
 * @param {Object} [args.req] - Express request, used for ip + user-agent.
 * @param {boolean} [args.pushRevoked=true] - Forward to {@link claimUserSession}. Pass `false` when
 *   minting a refreshed access token: the prior jti must still be blacklisted, but no
 *   `session:revoked` event should fire (the device is itself, just rotated).
 * @returns {Promise<{ accessToken: string, jti: string }>} The signed token and its jti.
 */
export async function issueAccessTokenAndClaimSession({
  userUid,
  tokenPayload,
  expiresIn,
  deviceType,
  req,
  pushRevoked = true,
}) {
  if (!userUid) throw new Error('issueAccessTokenAndClaimSession: userUid is required');
  if (!tokenPayload) throw new Error('issueAccessTokenAndClaimSession: tokenPayload is required');

  // Phase-1 RLS: every freshly issued token carries the bearer's tenant_id
  // so downstream middleware can scope reads/writes without a per-request DB
  // lookup. If the payload caller already set tenant_id explicitly (rare —
  // refresh-token rotation may carry the prior value) it wins; otherwise
  // we resolve from the users table. Fail-closed default = current single
  // tenant. See docs/GAP_ANALYSIS_TENANT_RLS.md.
  const tenantId = tokenPayload.tenant_id
    ?? tokenPayload.tenantId
    ?? await resolveTenantIdForUid(userUid);

  const jti = crypto.randomUUID();
  const accessToken = generateToken(
    {
      ...tokenPayload,
      tenant_id: tenantId,
      jti,
      ...(deviceType ? { deviceType } : {}),
    },
    expiresIn,
  );

  // Pull the exp out of the freshly-signed token so the session row's
  // expires_at matches the token's actual lifetime — avoids parsing the
  // expiresIn string ourselves.
  const decoded = jwt.decode(accessToken);
  const expiresAt = decoded?.exp ? new Date(decoded.exp * 1000) : new Date(Date.now() + 60 * 60 * 1000);

  await claimUserSession({
    userUid,
    jti,
    deviceType: deviceType || 'unknown',
    expiresAt,
    ipAddress: req?.ip ?? null,
    userAgent: req?.headers?.['user-agent'] ?? null,
    pushRevoked,
  });

  return { accessToken, jti };
}
