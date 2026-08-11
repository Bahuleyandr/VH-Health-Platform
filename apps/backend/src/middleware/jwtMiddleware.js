// src/middleware/jwtMiddleware.js
import logger from '../logging/logger.js';
import prisma from '../lib/prisma.js';
import { verifyToken } from '../utils/jwtUtils.js';
import { canonicalizeRequestRole } from '../utils/roles.js';
import {
  isTokenBlacklisted,
  isUserTokensRevoked,
  RevocationCheckUnavailableError,
} from '../utils/tokenBlacklist.js';

// Token scopes that are deliberately NARROWER than full REST access. We preserve
// these onto `req.user.scope` (rather than collapsing them to 'full') so the
// downstream scope guards can enforce them:
//   - 'mfa_setup' — first-time MFA enrollment; accepted only by the two
//     /mfa/setup-* routes via `requireSetupScope`, rejected elsewhere by
//     `enforceFullScope`.
//   - 'ws'        — short-lived WebSocket handshake ticket (minted by
//     /realtime/ticket). Its ONLY legitimate consumer is the WS upgrade path
//     (src/utils/websocket/wsServer.js), which verifies the token directly and
//     never runs this middleware. A 'ws' token therefore must never authenticate
//     a normal REST request — jwtMiddleware hard-rejects it below.
// A present scope can only originate from one of our own signed tokens, so an
// absent/unknown scope still safely defaults to 'full'.
const NARROW_TOKEN_SCOPES = new Set(['mfa_setup', 'ws']);

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
  const rows = await prisma.$queryRawUnsafe(
    'SELECT id FROM users WHERE uid = $1::uuid LIMIT 1',
    uid
  );
  if (rows.length > 0 && Number.isInteger(rows[0].id)) {
    resolved = rows[0].id;
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

  // A refresh token (type:'refresh') is a long-lived credential minted ONLY for
  // the /auth/*/refresh endpoint, which verifies it directly and rotates it.
  // It must never be accepted as an access bearer on protected routes — else a
  // copied refresh secret becomes a full-access session for its (30-day)
  // remaining life, skipping refresh rotation + session-state checks (Sol Ultra
  // #17). The refresh routes are public (/api/v1/auth/*) and do not run this
  // middleware, so rejecting here is safe. Generic message (no kind disclosure).
  if (decoded.type === 'refresh') {
    logger.warn('JWT denied: refresh token presented as access bearer');
    return res.status(401).json({
      success: false,
      error: 'Invalid or expired token',
      code: 'TOKEN_INVALID'
    });
  }

  // Check token blacklist (jti-based revocation) + revoke-all. FAIL CLOSED
  // (audit finding M2): when no revocation store can answer, deny with 503
  // instead of honouring a possibly-revoked token.
  try {
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
      const revoked = await isUserTokensRevoked(String(uid), decoded.iat, decoded.token_epoch);
      if (revoked) {
        logger.warn(`JWT denied: all tokens revoked for user ${uid}`);
        return res.status(401).json({
          success: false,
          error: 'All sessions have been revoked. Please log in again.',
          code: 'TOKEN_REVOKED'
        });
      }
    }
  } catch (err) {
    if (err instanceof RevocationCheckUnavailableError) {
      logger.error('JWT denied (fail closed): revocation stores unreachable', {
        error: err.message,
      });
      return res.status(503).json({
        success: false,
        error: 'Authentication service temporarily unavailable. Please retry.',
        code: 'REVOCATION_CHECK_UNAVAILABLE',
      });
    }
    throw err;
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

  const role = canonicalizeRequestRole(roleRaw);

  const rolesAllowed =
    (hasura?.['x-hasura-allowed-roles'] || [])
      .map((r) => canonicalizeRequestRole(r))
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

  // Narrow-scope tokens (e.g. first-time MFA enrollment, or the WebSocket
  // handshake ticket) must never be mistaken for full-access tokens. PRESERVE
  // the token's real scope instead of collapsing every non-'mfa_setup' value to
  // 'full' — that collapse let a `ws` ticket act as a full-access REST bearer.
  // Only recognised narrow scopes are kept; an absent/unknown scope defaults to
  // 'full' (see NARROW_TOKEN_SCOPES). We also preserve the original role on
  // `rawRole` so the MFA setup controller can persist the correct record without
  // relying on the normalized ADMIN label.
  const rawScope = typeof decoded.scope === 'string' ? decoded.scope.trim() : '';
  const scope = NARROW_TOKEN_SCOPES.has(rawScope) ? rawScope : 'full';
  const rawRole = String(roleRaw || '').trim().toUpperCase();

  // A `ws` ticket is minted solely for the WebSocket upgrade handshake, which
  // verifies the token directly (wsServer.verifyToken) and never runs this
  // middleware. So a `ws` ticket reaching ANY normal HTTP route is illegitimate
  // — historically it was silently widened to full access here. Reject it at
  // this single JWT chokepoint so the guard holds uniformly across every REST
  // surface, including routers that mount jwtAuth locally WITHOUT
  // `enforceFullScope` (HL7 generate, health, infrastructure). WS
  // tickets are passed in `?token=` query params that proxies/referrers log, so
  // leakage is realistic and the blast radius (full REST access for 60s) is high.
  if (scope === 'ws') {
    logger.warn(
      `JWT denied: ws-scope ticket presented to REST route ${req.method} ${req.path}`,
    );
    return res.status(403).json({
      success: false,
      error: 'WebSocket ticket is not valid for this endpoint',
      code: 'WS_SCOPE_NOT_ALLOWED',
    });
  }

  // Device-type claim, set at login by every auth realm (staff/admin/patient).
  // Read here so route-level middleware like `requireDeviceType('mobile')` can
  // gate sensitive actions (e.g. attendance must be marked from the phone).
  // Old tokens issued before this claim was introduced have `deviceType` =
  // null; the gate middleware then rejects with a clear "please re-login" 403.
  const deviceType = decoded.deviceType ?? null;
  const stableDeviceId = decoded.stableDeviceId ?? null;
  const sessionFamilyId = decoded.sessionFamilyId ?? null;

  // 2FA step-up claim — stamped only by the admin MFA challenge-verify path
  // (mfaVerifyChallenge). Carried through so `requireSuperAdminStepUp` can scope
  // the SUPER_ADMIN bypass to 2FA-verified sessions on sensitive namespaces
  // (audit 2026-06-18 — SUPER_ADMIN un-scoped bypass). Strictly boolean: a
  // missing/odd claim is never treated as verified.
  const mfa = decoded.mfa === true;

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
    deviceType,
    stableDeviceId,
    sessionFamilyId,
    tokenExpiresAt: decoded.exp
      ? new Date(decoded.exp * 1000).toISOString()
      : null,
    mfa,
    jti: decoded.jti ?? null,
  };

  logger.info(`JWT OK: uid=${req.user.uid} role=${req.user.role} scope=${scope}`);

  // ── Acting-as delegation hop ──────────────────────────────────────────────
  // If the client sent X-Acting-As-Uid, verify the JWT actor is a guardian
  // of that dependent + same-tenant, then rewrite req.user to the
  // dependent's identity. Original actor is preserved on req.acting so the
  // audit trail captures both. Every downstream IDOR check that compares
  // against req.user.id / req.user.uid now scopes to the dependent without
  // the call sites needing to know about delegation.
  const actingAsHeader =
    req.headers?.['x-acting-as-uid'] ?? req.headers?.['X-Acting-As-Uid'];
  if (actingAsHeader) {
    const denial = await applyActingAsHop(req, String(actingAsHeader).trim());
    if (denial) return res.status(denial.status).json(denial.body);
  }

  return next();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function applyActingAsHop(req, dependentUidRaw) {
  // Narrow-scope tokens (e.g. mfa_setup) must never act-as — they exist
  // only to complete enrollment of the bearer's own account.
  if (req.user?.scope && req.user.scope !== 'full') {
    logger.warn(`Acting-as denied: token scope=${req.user.scope} cannot delegate`);
    return {
      status: 403,
      body: {
        success: false,
        error: 'Acting-as not permitted for this token',
        code: 'NOT_AUTHORISED_TO_ACT_AS',
      },
    };
  }

  if (!UUID_RE.test(dependentUidRaw)) {
    logger.warn('Acting-as denied: malformed X-Acting-As-Uid');
    return {
      status: 403,
      body: {
        success: false,
        error: 'Not authorised to act as that user',
        code: 'NOT_AUTHORISED_TO_ACT_AS',
      },
    };
  }

  // No-op when the header points at the JWT bearer themselves — keep
  // req.user as-is rather than fail the request.
  if (String(dependentUidRaw).toLowerCase() === String(req.user.uid).toLowerCase()) {
    return null;
  }

  // Single query: load dependent + guardian, enforce
  //   - dependent.guardian_user_id = guardian.id
  //   - dependent.is_minor = TRUE
  //   - dependent.role = 'PATIENT'
  //   - tenant parity (fail-closed if guardian.tenant_id != dependent.tenant_id)
  // The query joins guardian by uid (the JWT-supplied actor) so a stolen /
  // mismatched X-Acting-As-Uid can't bypass the guardian check.
  let rows;
  try {
    rows = await prisma.$queryRawUnsafe(
      `SELECT dep.id          AS dep_id,
              dep.uid         AS dep_uid,
              dep.phone       AS dep_phone,
              dep.email       AS dep_email,
              dep.role        AS dep_role,
              dep.is_minor    AS dep_is_minor,
              dep.tenant_id   AS dep_tenant_id,
              g.id            AS g_id,
              g.uid           AS g_uid,
              g.tenant_id     AS g_tenant_id
         FROM users dep
         JOIN users g ON g.id = dep.guardian_user_id
        WHERE dep.uid = $1::uuid
          AND g.uid = $2::uuid
        LIMIT 1`,
      dependentUidRaw,
      req.user.uid,
    );
  } catch (err) {
    logger.warn(`Acting-as lookup failed: ${err.message}`);
    return {
      status: 403,
      body: {
        success: false,
        error: 'Not authorised to act as that user',
        code: 'NOT_AUTHORISED_TO_ACT_AS',
      },
    };
  }

  if (!rows || rows.length === 0) {
    // Don't leak whether the dependent exists or whether the link is
    // missing — both surface as the same 403.
    logger.warn(
      `Acting-as denied: guardian=${req.user.uid} not linked to dependent=${dependentUidRaw}`,
    );
    return {
      status: 403,
      body: {
        success: false,
        error: 'Not authorised to act as that user',
        code: 'NOT_AUTHORISED_TO_ACT_AS',
      },
    };
  }

  const row = rows[0];

  // Hard gates: minor + PATIENT role + same tenant. Each fails closed.
  if (!row.dep_is_minor) {
    logger.warn(`Acting-as denied: dependent ${row.dep_uid} not a minor`);
    return {
      status: 403,
      body: {
        success: false,
        error: 'Not authorised to act as that user',
        code: 'NOT_AUTHORISED_TO_ACT_AS',
      },
    };
  }
  if (row.dep_role && row.dep_role !== 'PATIENT') {
    logger.warn(`Acting-as denied: dependent ${row.dep_uid} role=${row.dep_role}`);
    return {
      status: 403,
      body: {
        success: false,
        error: 'Not authorised to act as that user',
        code: 'NOT_AUTHORISED_TO_ACT_AS',
      },
    };
  }
  if (
    row.g_tenant_id != null
    && row.dep_tenant_id != null
    && String(row.g_tenant_id) !== String(row.dep_tenant_id)
  ) {
    logger.warn(
      `Acting-as denied: tenant mismatch — guardian.tenant=${row.g_tenant_id} dep.tenant=${row.dep_tenant_id}`,
    );
    return {
      status: 403,
      body: {
        success: false,
        error: 'Not authorised to act as that user',
        code: 'NOT_AUTHORISED_TO_ACT_AS',
      },
    };
  }

  // All gates passed — record the actor on req.acting and rewrite req.user
  // to the dependent's identity. Downstream IDOR checks now scope to the
  // dependent automatically.
  req.acting = {
    actorUid: req.user.uid,
    actorId: req.user.id,
    actorRole: req.user.role,
    actorRawRole: req.user.rawRole,
    actorPhone: req.user.phone,
    actorEmail: req.user.email,
  };
  req.user = {
    ...req.user,
    uid: String(row.dep_uid),
    id: Number.isInteger(row.dep_id) ? row.dep_id : parseInt(row.dep_id, 10),
    phone: row.dep_phone ?? null,
    email: row.dep_email ?? null,
    role: 'PATIENT',
    // Tenant matches by precondition above — pick the dependent's tenant.
    tenant_id: row.dep_tenant_id ?? req.user.tenant_id,
  };

  logger.info(
    `Acting-as OK: actor=${req.acting.actorUid} -> subject=${req.user.uid}`,
  );
  return null;
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
