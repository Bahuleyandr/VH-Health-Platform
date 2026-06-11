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
    return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
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
 * @param {{ uid?: string, id?: number|string, role: string, username?: string }} admin
 * @returns {string} signed JWT (expires in 10 minutes)
 */
export function issueSetupToken(admin) {
  const sub = String(admin.uid ?? admin.id ?? '');
  return jwt.sign(
    {
      jti: crypto.randomUUID(),
      sub,
      uid: sub,
      role: String(admin.role || '').toUpperCase(),
      scope: 'mfa_setup',
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
    return jwt.verify(token, JWT_SECRET, { ignoreExpiration: true, algorithms: ['HS256'] });
  } catch (error) {
    logger.error('❌ JWT signature verification failed:', error.message || error);
    return null;
  }
}