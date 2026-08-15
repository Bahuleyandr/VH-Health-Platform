// src/utils/jwtUtils.js

import crypto from 'crypto';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import logger from '../logging/logger.js';

// ✅ Aggressively try to load environment variables from multiple sources
if (!process.env.JWT_SECRET) {
  logger.info('🔄 JWT_SECRET not found, attempting to load .env files...');
  
  // Try multiple .env files in order of preference
  const envFiles = ['.env.local', '.env', '.env.render'];
  
  for (const envFile of envFiles) {
    try {
      const result = dotenv.config({ path: envFile });
      if (!result.error && process.env.JWT_SECRET) {
        logger.info(`✅ Successfully loaded JWT_SECRET from ${envFile}`);
        break;
      }
    } catch (_e) {
      // Continue to next file
    }
  }
  
  // If still no JWT_SECRET, try loading without specifying path (default .env)
  if (!process.env.JWT_SECRET) {
    try {
      dotenv.config();
      if (process.env.JWT_SECRET) {
        logger.info('✅ Loaded JWT_SECRET from default .env');
      }
    } catch (_e) {
      // Continue
    }
  }
}

// Get the JWT_SECRET after attempting to load it
const JWT_SECRET = process.env.JWT_SECRET;
// Default access-token TTL (audit finding L1, 2026-06-10): was '7d', which
// meant a stolen/revoked token stayed honourable for a week (and M2's old
// fail-open made that worse). Both patient and staff clients refresh
// transparently via /auth/refresh-token (single-flight in VHHttpClient), so
// short access tokens cost nothing. Override with JWT_EXPIRES_IN only for
// breakglass.
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1h';

// If still no JWT_SECRET, crash on startup — never use a hardcoded fallback
if (!JWT_SECRET) {
  logger.error('❌ FATAL: JWT_SECRET is missing from environment variables.');
  logger.error('🔍 Checked files: .env.local, .env, .env.render');
  logger.error('📁 Current working directory:', process.cwd());
  process.exit(1);
}

// ─── Audience / issuer (audit §3, Auth — defense-in-depth, 2026-06-19) ───
// Tokens carry an `iss` (issuer) + a per-realm `aud` (audience) so a token
// minted for one realm cannot be silently replayed against another even if the
// `role`/`requireRole` layer were ever bypassed. Realm separation still rests
// primarily on the role claim; this is a second, independent gate.
//
// CRITICAL backward-compat contract (see verifyToken below): these are
// validated ONLY WHEN PRESENT. A grandfathered token minted before this change
// carries no aud/iss and MUST still verify — it expires naturally. We therefore
// do NOT use jsonwebtoken's built-in `audience`/`issuer` verify options, which
// REJECT a token that lacks the claim. Instead we assert post-hoc only when the
// claim is present.
export const JWT_ISSUER = 'vh-health-backend';
export const JWT_AUDIENCES = Object.freeze({
  patient: 'vh-health-patient',
  staff: 'vh-health-staff',
  admin: 'vh-health-admin',
});
// Set of every accepted audience — a present `aud` must be one of these.
const ACCEPTED_AUDIENCES = new Set(Object.values(JWT_AUDIENCES));

// Roles that belong to the admin realm. Kept as a local literal set (rather than
// importing roleHelpers) so jwtUtils stays a leaf module with no app-graph
// imports — it is imported almost everywhere and must not pull in role config.
// SUPER_ADMIN is a real role in the codebase even though it is not on the ROLES
// enum; ADMIN covers the rest of the admin portal.
const ADMIN_REALM_ROLES = new Set(['ADMIN', 'SUPER_ADMIN']);

/**
 * Map a role to its realm audience. PATIENT → patient; admin roles → admin;
 * every other (staff/clinical/support/platform) role → staff. Unknown/blank
 * roles fall back to the patient audience, mirroring generateToken's
 * `role || 'PATIENT'` default so the issued aud always matches the issued role.
 * @param {string} [role]
 * @returns {string} one of JWT_AUDIENCES.*
 */
function audienceForRole(role) {
  const normalized = String(role || 'PATIENT').toUpperCase();
  if (normalized === 'PATIENT') return JWT_AUDIENCES.patient;
  if (ADMIN_REALM_ROLES.has(normalized)) return JWT_AUDIENCES.admin;
  return JWT_AUDIENCES.staff;
}

/**
 * Backward-compatible aud/iss assertion. Throws a jsonwebtoken-style error
 * (so the caller's existing catch sets lastError = 'JsonWebTokenError' and
 * returns null) ONLY when a claim is present AND wrong. A missing aud/iss is
 * always accepted — never reject a token solely for a missing realm claim.
 * @param {Object} decoded - verified JWT payload
 */
function assertAudienceAndIssuer(decoded) {
  if (!decoded || typeof decoded !== 'object') return;

  // `aud` may be a string or (per RFC 7519) an array of strings.
  if (decoded.aud !== undefined && decoded.aud !== null) {
    const auds = Array.isArray(decoded.aud) ? decoded.aud : [decoded.aud];
    const ok = auds.some((a) => ACCEPTED_AUDIENCES.has(a));
    if (!ok) {
      const err = new jwt.JsonWebTokenError('jwt audience invalid');
      throw err;
    }
  }

  if (decoded.iss !== undefined && decoded.iss !== null) {
    if (decoded.iss !== JWT_ISSUER) {
      const err = new jwt.JsonWebTokenError('jwt issuer invalid');
      throw err;
    }
  }
}

/**
 * Generates a JWT token with Supabase-compatible claims.
 * @param {Object} payload - { uid, phone, role, ...extraClaims } — all fields are included in the token.
 * @param {string} [expiresIn] - Optional expiry override (e.g. '30d' for refresh tokens).
 * @returns {string} - Signed JWT token.
 */
export function generateToken(payload, expiresIn) {
  const { uid, phone, role, ...extraClaims } = payload;
  const tokenPayload = {
    jti: crypto.randomUUID(),  // Unique token ID for revocation/blacklisting
    sub: uid,
    role: role || 'PATIENT',
    // Defense-in-depth (audit §3): stamp issuer + a per-realm audience on every
    // token. A caller that set iss/aud explicitly (e.g. admin login) wins via
    // the ...extraClaims spread below; otherwise we default from the role. This
    // is additive only — verification grandfathers tokens that lack them.
    iss: JWT_ISSUER,
    aud: audienceForRole(role),
    ...(phone && { phone }),
    ...extraClaims,  // Include email, type, sub overrides, iss, aud, etc.
    [process.env.JWT_CLAIMS_NAMESPACE || 'https://vhhealth.app/jwt/claims']: {
      'x-hasura-default-role': role ? role.toLowerCase() : 'anonymous',
      'x-hasura-allowed-roles': [role ? role.toLowerCase() : 'anonymous'],
      'x-hasura-user-id': uid,
      ...(phone && { 'x-hasura-phone': phone })
    }
  };
  return jwt.sign(
    tokenPayload,
    JWT_SECRET,
    { expiresIn: expiresIn || JWT_EXPIRES_IN }
  );
}

/**
 * Verifies a JWT token (signature + expiry).
 * @param {string} token - JWT token to verify.
 * @returns {Object|null} - Decoded payload if valid, otherwise null.
 *   On failure, returns null. Check verifyToken.lastError for the reason.
 */
export function verifyToken(token) {
  verifyToken.lastError = null;
  try {
    // Explicit algorithm allowlist (audit finding M1): without it, adding
    // any RS/ES/JWKS verification path later opens the classic
    // alg-confusion hole. All first-party tokens are HS256.
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    // Defense-in-depth (audit §3): reject a token that carries a WRONG aud/iss.
    // No-op when the claims are absent — grandfathers pre-existing tokens.
    assertAudienceAndIssuer(decoded);
    return decoded;
  } catch (error) {
    verifyToken.lastError = error.name; // 'TokenExpiredError' | 'JsonWebTokenError' | 'NotBeforeError'
    logger.error('❌ JWT Verification Failed:', error.message || error);
    return null;
  }
}
verifyToken.lastError = null;

/**
 * Issue a short-lived, narrow-scope JWT for first-time MFA enrollment.
 *
 * Returned only when a SUPER_ADMIN account without `totp_enabled` attempts to
 * log in while REQUIRE_MFA_FOR_SUPER_ADMIN is on. The token carries
 * `scope: 'mfa_setup'` and is accepted only by the dedicated setup-enroll +
 * setup-confirm routes; `requireSetupScope` rejects any other use, and the
 * standard RBAC layer (see rbacMiddleware) treats non-'full' scopes as
 * insufficient for normal admin endpoints.
 *
 * R1 (issuance-time revocation gate, migration 650): the setup token is a
 * REST bearer on the /mfa/setup-* routes — it runs through jwtMiddleware's
 * fail-closed revocation gate like any other bearer, so an epoch-less mint
 * is treated as legacy epoch-0 and refused (401 TOKEN_REVOKED) for any
 * identity whose durable epoch is >= 1. That would lock an admin who ever
 * logged out (or was force-revoked) out of first-time MFA enrollment
 * entirely. The signer is synchronous and cannot read the durable store, so
 * the caller MUST resolve the identity's current epoch
 * (tokenBlacklist.getCurrentTokenEpoch — fails closed) and pass it in; a
 * missing/non-finite epoch throws rather than silently minting a token the
 * gate will refuse.
 *
 * @param {{ uid?: string, id?: number|string, role: string, username?: string }} admin
 * @param {number} tokenEpoch - the identity's current durable token epoch.
 * @returns {string} signed JWT (expires in 10 minutes)
 */
export function issueSetupToken(admin, tokenEpoch) {
  const sub = String(admin.uid ?? admin.id ?? '');
  const epoch = Number(tokenEpoch);
  if (!Number.isFinite(epoch)) {
    throw new Error(
      'issueSetupToken: a finite tokenEpoch is required (resolve it via getCurrentTokenEpoch)',
    );
  }
  return jwt.sign(
    {
      jti: crypto.randomUUID(),
      sub,
      uid: sub,
      role: String(admin.role || '').toUpperCase(),
      scope: 'mfa_setup',
      token_epoch: epoch,
    },
    JWT_SECRET,
    { expiresIn: '10m' }
  );
}

/**
 * Verifies a JWT token's signature only — ignores expiry.
 *
 * Use ONLY for the refresh-token flow: an access token that has just
 * expired must still be rotatable if the signature is valid and the `jti`
 * is not blacklisted. Every other code path must use [verifyToken].
 *
 * @param {string} token - JWT token to verify.
 * @returns {Object|null} - Decoded payload on valid signature, otherwise null.
 */
export function verifyTokenAllowExpired(token) {
  try {
    // Algorithm allowlist — see verifyToken (audit finding M1).
    const decoded = jwt.verify(token, JWT_SECRET, { ignoreExpiration: true, algorithms: ['HS256'] });
    // Defense-in-depth (audit §3): a present-but-wrong aud/iss is rejected even
    // on the expiry-tolerant refresh path; absent claims still pass (legacy).
    assertAudienceAndIssuer(decoded);
    return decoded;
  } catch (error) {
    logger.error('❌ JWT signature verification failed:', error.message || error);
    return null;
  }
}