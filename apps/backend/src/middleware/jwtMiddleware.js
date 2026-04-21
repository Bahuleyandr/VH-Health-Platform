// src/middleware/jwtMiddleware.js
import logger from '../logging/logger.js';
import { verifyToken } from '../utils/jwtUtils.js';
import { isTokenBlacklisted, isUserTokensRevoked } from '../utils/tokenBlacklist.js';

/**
 * Normalize role names to what the RBAC layer expects.
 * SUPER_ADMIN → ADMIN, NURSE → NURSING_STAFF, etc.
 */
function normalizeRole(raw) {
  const r = String(raw || '').trim().toUpperCase();
  if (r === 'SUPER_ADMIN') return 'ADMIN';
  if (r === 'NURSE') return 'NURSING_STAFF';
  return r;
}

/**
 * Pull Hasura-style custom claims (key usually ends with "/jwt/claims").
 */
function getHasuraClaims(decoded) {
  if (!decoded || typeof decoded !== 'object') return null;
  const k = Object.keys(decoded).find((key) => key.endsWith('/jwt/claims'));
  return k ? decoded[k] : null;
}

/**
 * JWT authentication middleware
 * - Accepts tokens that may use uid | user_id | userId | id | sub | x-hasura-user-id
 * - Normalizes role; maps SUPER_ADMIN->ADMIN etc.; falls back to PATIENT
 * - Attaches req.user = { uid, role, roles?, phone?, email?, id? }
 *   `id` is the DB integer id (from decoded.id / decoded.userId / hasura), when present.
 *   Callers that need int-FK comparisons (e.g. appointments.patient_id) should use `id`.
 * - 401 for missing/invalid token; 400 if UID cannot be derived
 */
export default async function jwtMiddleware(req, res, next) {
  const authHeader = req.headers?.authorization || req.headers?.Authorization || '';

  if (!authHeader.startsWith('Bearer ')) {
    logger.warn('JWT denied: missing/malformed Authorization header');
    return res.status(401).json({
      success: false,
      error: 'Authorization header missing or invalid',
    });
  }

  const token = authHeader.slice(7).trim();
  const decoded = verifyToken(token);

  if (!decoded) {
    const isExpired = verifyToken.lastError === 'TokenExpiredError';
    logger.warn(`JWT denied: ${isExpired ? 'expired token' : 'invalid token signature'}`);
    return res.status(401).json({
      success: false,
      error: isExpired ? 'Token has expired' : 'Invalid or expired token',
      code: isExpired ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID'
    });
  }

  // Check token blacklist (jti-based revocation)
  if (decoded.jti) {
    const blacklisted = await isTokenBlacklisted(decoded.jti);
    if (blacklisted) {
      logger.warn(`JWT denied: token ${decoded.jti} is blacklisted`);
      return res.status(401).json({
        success: false,
        error: 'Token has been revoked',
        code: 'TOKEN_REVOKED'
      });
    }
  }

  // Check if all user tokens were revoked (force-logout)
  const uid = decoded.uid ?? decoded.user_id ?? decoded.userId ?? decoded.sub ?? decoded.id;
  if (uid && decoded.iat) {
    const revoked = await isUserTokensRevoked(String(uid), decoded.iat);
    if (revoked) {
      logger.warn(`JWT denied: all tokens revoked for user ${uid}`);
      return res.status(401).json({
        success: false,
        error: 'All sessions have been revoked. Please log in again.',
        code: 'TOKEN_REVOKED'
      });
    }
  }

  const hasura = getHasuraClaims(decoded);

  // Derive UID
  const uidRaw =
    decoded.uid ??
    decoded.user_id ??
    decoded.userId ??
    decoded.sub ??
    hasura?.['x-hasura-user-id'] ??
    decoded.id;

  if (!uidRaw) {
    logger.warn('JWT denied: no uid-like claim present');
    return res.status(400).json({ success: false, error: 'Missing or invalid UID' });
  }

  // Derive role (primary) and allowed roles (if any)
  const roleRaw =
    decoded.role ??
    decoded.user_role ??
    decoded.claims?.role ??
    hasura?.['x-hasura-default-role'] ??
    'PATIENT';

  const role = normalizeRole(roleRaw);

  const rolesAllowed =
    (hasura?.['x-hasura-allowed-roles'] || [])
      .map((r) => normalizeRole(r))
      .filter(Boolean);

  // Optional fields
  const phone = decoded.phone ?? decoded.phone_number ?? decoded.phoneNumber ?? null;
  const email = decoded.email ?? null;
  // Preserve the int DB id when the token carries one (distinct from uid, which is a uuid).
  const idRaw = decoded.id ?? decoded.userId ?? decoded.user_id ?? hasura?.['x-hasura-user-int-id'] ?? null;
  const idInt = idRaw != null && /^\d+$/.test(String(idRaw)) ? parseInt(String(idRaw), 10) : null;

  req.user = {
    uid: String(uidRaw),
    role,
    roles: rolesAllowed.length ? rolesAllowed : undefined,
    phone,
    email,
    id: idInt,
  };

  logger.info(`JWT OK: uid=${req.user.uid} role=${req.user.role}`);
  return next();
}
