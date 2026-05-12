// src/middleware/jwtMiddleware.js
import logger from '../logging/logger.js';
import prisma from '../lib/prisma.js';
import { verifyToken } from '../utils/jwtUtils.js';
import { isTokenBlacklisted, isUserTokensRevoked } from '../utils/tokenBlacklist.js';

// Process-local memo for the uid→users.id fallback below. The mapping is
// stable for the lifetime of a uid (users.id is never reassigned), so
// caching forever is safe; FIFO-evict at 50k entries to cap memory.
// `null` is a valid cached value — it means "no users row for this uid"
// (admin/Hasura-only token), and we want to skip the DB hit on subsequent
// requests too.
const UID_TO_ID_CACHE_MAX = 50000;
const uidToIdCache = new Map();

async function resolveUserIdFromUid(uid) {
  if (!uid) return null;
  if (uidToIdCache.has(uid)) return uidToIdCache.get(uid);

  let resolved = null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      'SELECT id FROM users WHERE uid = $1::uuid LIMIT 1',
      uid
    );
    if (rows.length > 0 && Number.isInteger(rows[0].id)) {
      resolved = rows[0].id;
    }
  } catch (err) {
    // Bad uuid format / DB blip: don't fail the request, just leave id null.
    logger.warn(`uid→id fallback lookup failed for ${uid}: ${err.message}`);
    return null;
  }

  if (uidToIdCache.size >= UID_TO_ID_CACHE_MAX) {
    const oldestKey = uidToIdCache.keys().next().value;
    uidToIdCache.delete(oldestKey);
  }
  uidToIdCache.set(uid, resolved);
  return resolved;
}

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
  // Many token-issuance paths (admin login, MFA verify, staff PIN login) omit
  // the int `id` claim, so we fall back to a cached `users.uid → id` lookup
  // when the token doesn't carry one. Without the fallback every IDOR check
  // that compares `req.user.id` against an int FK column (e.g.
  // `appointments.doctor_id`) silently fails closed for any role whose token
  // path skipped the claim — see finding
  // 2026-05-08-walk-in-opd-doctor-idor-check-always-fails-for-staff-jwt.
  const idRaw = decoded.id ?? decoded.userId ?? decoded.user_id ?? hasura?.['x-hasura-user-int-id'] ?? null;
  let idInt = idRaw != null && /^\d+$/.test(String(idRaw)) ? parseInt(String(idRaw), 10) : null;
  if (idInt == null) {
    idInt = await resolveUserIdFromUid(String(uidRaw));
  }

  // tenant_id is optional in the token — tenantContextMiddleware will
  // resolve/default downstream if the claim is missing.
  const tenantId = decoded.tenant_id || decoded.tenantId || null;

  // Narrow-scope tokens (e.g. first-time MFA enrollment) must never be
  // mistaken for full-access admin tokens. We preserve the original role on
  // `rawRole` so the MFA setup controller can persist the correct record
  // without relying on the normalized ADMIN label.
  const scope = decoded.scope === 'mfa_setup' ? 'mfa_setup' : 'full';
  const rawRole = String(roleRaw || '').trim().toUpperCase();

  req.user = {
    uid: String(uidRaw),
    role,
    rawRole,
    roles: rolesAllowed.length ? rolesAllowed : undefined,
    phone,
    email,
    id: idInt,
    tenant_id: tenantId,
    scope,
  };

  logger.info(`JWT OK: uid=${req.user.uid} role=${req.user.role} scope=${scope}`);
  return next();
}

/**
 * Gate for the /mfa/setup-enroll + /mfa/setup-confirm endpoints.
 *
 * Pairs with `issueSetupToken()` — only tokens carrying `scope: 'mfa_setup'`
 * are accepted. Full-access tokens are rejected with 403 so that an admin
 * with an already-valid JWT cannot accidentally re-run the enrollment flow
 * through these endpoints (they should use /mfa/enroll instead).
 */
export function requireSetupScope(req, res, next) {
  if (req.user?.scope !== 'mfa_setup') {
    return res.status(403).json({
      success: false,
      message: 'Setup token required',
      code: 'SETUP_SCOPE_REQUIRED',
    });
  }
  return next();
}

/**
 * Rejects narrow-scope tokens (e.g. `scope: 'mfa_setup'`) on any protected
 * endpoint. Apply after `jwtAuth` wherever a router mounts authenticated
 * routes that are NOT part of the first-time-MFA-enrollment flow.
 *
 * Narrow-scope tokens carry `scope !== 'full'`; their only legitimate use is
 * the two setup routes gated by `requireSetupScope`. If `req.user.scope` is
 * unset or equals 'full', this is a pass-through.
 */
export function enforceFullScope(req, res, next) {
  if (req.user?.scope && req.user.scope !== 'full') {
    return res.status(403).json({
      success: false,
      error: 'Insufficient token scope',
      code: 'INSUFFICIENT_SCOPE',
    });
  }
  return next();
}
