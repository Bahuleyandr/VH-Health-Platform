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
import { generateToken } from '../../utils/jwtUtils.js';
import { claimUserSession } from './userActiveSession.js';

/**
 * Issue an access token and register it as the user's latest active session.
 *
 * @param {Object} args
 * @param {string} args.userUid - The user's UUID. Required.
 * @param {Object} args.tokenPayload - Claims for `generateToken` (uid, role, id?, phone?, ...).
 * @param {string} [args.expiresIn] - jsonwebtoken-style override ('8h', '7d'). Falls back to JWT_EXPIRES_IN.
 * @param {string} [args.deviceType] - 'mobile' | 'desktop' | 'web'. Embedded as a JWT claim *only* when
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

  const jti = crypto.randomUUID();
  const accessToken = generateToken(
    {
      ...tokenPayload,
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
