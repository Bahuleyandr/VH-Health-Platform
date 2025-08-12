// src/middleware/jwtMiddleware.js
import { verifyToken } from '../utils/jwtUtils.js';
import logger from '../logging/logger.js';

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
 * - Attaches req.user = { uid, role, roles?, phone?, email? }
 * - 401 for missing/invalid token; 400 if UID cannot be derived
 */
export default function jwtMiddleware(req, res, next) {
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
    logger.warn('JWT denied: invalid or expired token');
    return res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }

  const hasura = getHasuraClaims(decoded);

  // Derive UID
  const uidRaw =
    decoded.uid ??
    decoded.user_id ??
    decoded.userId ??
    decoded.id ??
    decoded.sub ??
    hasura?.['x-hasura-user-id'];

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

  req.user = {
    uid: String(uidRaw),
    role,
    roles: rolesAllowed.length ? rolesAllowed : undefined,
    phone,
    email,
  };

  logger.info(`JWT OK: uid=${req.user.uid} role=${req.user.role}`);
  return next();
}
