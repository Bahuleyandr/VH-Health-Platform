import prisma from '../lib/prisma.js';
import { isDefaultTenantAllowed } from '../config/tenantRlsConfig.js';
import logger from '../logging/logger.js';
import {
  DEFAULT_TENANT_ID,
  getTenantById,
  resolveTenantForUser,
  parseTenantSlug,
  tenantFromHost,
} from '../services/tenant/tenantService.js';
import { AppError } from '../utils/AppError.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_TENANT_REGION = 'IN';
const UNKNOWN_TENANT_REGION = 'OTHER';
const DEFAULT_COMPLIANCE_PROFILE = 'DPDP';

function isSuperAdmin(req) {
  // jwtMiddleware.normalizeRole collapses 'SUPER_ADMIN' → 'ADMIN' for
  // route-RBAC simplicity, but stashes the original on `rawRole`. We
  // check both so the override path works whether the caller arrived
  // through the JWT chain (role='ADMIN', rawRole='SUPER_ADMIN') or
  // a non-JWT auth path that set role directly.
  const role = String(req.user?.role || '').toUpperCase();
  const rawRole = String(req.user?.rawRole || '').toUpperCase();
  return role === 'SUPER_ADMIN' || rawRole === 'SUPER_ADMIN';
}

function normalizeUuid(value) {
  const text = String(value || '').trim();
  return UUID_RE.test(text) ? text.toLowerCase() : null;
}

function normalizeToken(value) {
  return String(value ?? '').trim().toUpperCase();
}

export function buildTenantContext(tenantId, tenant) {
  const hasTenantRow = Boolean(tenant);
  const region = normalizeToken(tenant?.region) || (hasTenantRow ? UNKNOWN_TENANT_REGION : DEFAULT_TENANT_REGION);
  const complianceProfile = normalizeToken(tenant?.compliance_profile) || DEFAULT_COMPLIANCE_PROFILE;

  return {
    ...(tenant || {}),
    id: tenant?.id || tenantId,
    region,
    compliance_profile: complianceProfile,
    status: tenant?.status || 'active',
    region_resolution: normalizeToken(tenant?.region)
      ? 'tenant_row'
      : (hasTenantRow ? 'missing_tenant_region' : 'default_tenant_fallback'),
  };
}

// Phase-3 SUPER_ADMIN override controls (docs/GAP_ANALYSIS_TENANT_RLS.md).
//
// When a SUPER_ADMIN passes `x-tenant-id` to act inside another tenant,
// require a `x-tenant-override-reason` header (>= MIN_OVERRIDE_REASON_LEN
// chars of free text) AND log the override to audit_logs with original
// + target tenant + reason + request id. Without this, the override was
// invisible — a regulator auditing the access log couldn't tell whether
// a cross-tenant read was a deliberate platform-ops action or a
// confused admin.
//
// The header is preferred over a body field because the same middleware
// runs for GET / DELETE / etc. that don't carry a JSON body. UI tooling
// surfacing this control should prompt the operator for the reason and
// echo it back in the header.
const MIN_OVERRIDE_REASON_LEN = 8;
const MAX_OVERRIDE_REASON_LEN = 500;

function extractOverrideReason(req) {
  const raw = req.get('x-tenant-override-reason')
    ?? req.body?.tenant_override_reason
    ?? '';
  return String(raw).trim().slice(0, MAX_OVERRIDE_REASON_LEN);
}

/**
 * Fire-and-forget audit-log writer for cross-tenant overrides.
 *
 * Failure is logged at warn level but never blocks the request — the
 * override is rejected up front when the reason is missing, so a write
 * failure here is a downstream observability issue, not a security gap.
 */
function recordTenantOverride({ actorUid, originalTenant, targetTenant, reason, requestId, ip }) {
  setImmediate(async () => {
    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO audit_logs (uid, action, resource, resource_id, metadata, created_at)
         VALUES ($1::uuid, 'TENANT_OVERRIDE_USED', 'tenants', $2::text,
                 jsonb_build_object(
                   'original_tenant_id', $3::text,
                   'target_tenant_id', $2::text,
                   'reason', $4::text,
                   'request_id', $5::text,
                   'ip', $6::text
                 ),
                 NOW())`,
        actorUid,
        targetTenant,
        originalTenant ?? null,
        reason,
        requestId ?? null,
        ip ?? null,
      );
    } catch (err) {
      logger.warn('tenantContextMiddleware: TENANT_OVERRIDE_USED audit write failed', { error: err.message });
    }
  });
}

/**
 * tenantContextMiddleware
 *
 * Populates req.tenantId for downstream services. Resolution order:
 *   1. JWT claim (preferred — set at token-issue time when login flows
 *      are upgraded).
 *   2. `x-tenant-id` header, if present AND the caller is SUPER_ADMIN
 *      AND a `x-tenant-override-reason` (>= 8 chars) is also present.
 *      Lets platform operators cross-tenant debug without switching
 *      accounts; every use is logged to audit_logs.
 *   3. `users.tenant_id` lookup keyed by `req.user.uid`.
 *   4. DEFAULT_TENANT_ID — single-tenant backwards-compatibility floor.
 *
 * Mounts AFTER jwtMiddleware. Unauthenticated routes silently get the
 * default tenant so public endpoints (health, version) keep working.
 */
export default async function tenantContextMiddleware(req, _res, next) {
  try {
    // Resolution policy (W1): may a request with no resolvable tenant fall back
    // to the default tenant? Independent of DB-RLS enforcement. Default = no
    // (fail closed); single-tenant installs set ALLOW_DEFAULT_TENANT=true.
    const allowDefault = isDefaultTenantAllowed();
    let tenantId = null;
    let overrideUsed = false;
    let originalTenantBeforeOverride = null;

    if (req.user?.tenant_id) {
      tenantId = normalizeUuid(req.user.tenant_id);
    } else if (req.user?.tenantId) {
      tenantId = normalizeUuid(req.user.tenantId);
    }

    if (isSuperAdmin(req)) {
      const headerOverride = normalizeUuid(req.get('x-tenant-id'));
      if (headerOverride && headerOverride !== tenantId) {
        const reason = extractOverrideReason(req);
        if (reason.length < MIN_OVERRIDE_REASON_LEN) {
          // Reject the override with a structured 400 — the request would
          // otherwise succeed but invisibly. The error code lets the admin
          // UI prompt the operator for a reason and retry. AppError is
          // required for the global error handler to surface `code` in
          // the JSON response body (a plain Error drops it).
          return next(
            AppError.badRequest(
              `x-tenant-id override requires x-tenant-override-reason (>= ${MIN_OVERRIDE_REASON_LEN} chars)`,
              'TENANT_OVERRIDE_REASON_REQUIRED',
            ),
          );
        }
        originalTenantBeforeOverride = tenantId;
        tenantId = headerOverride;
        overrideUsed = true;
        recordTenantOverride({
          actorUid: req.user?.uid,
          originalTenant: originalTenantBeforeOverride,
          targetTenant: tenantId,
          reason,
          requestId: req.id,
          ip: req.ip,
        });
      }
    }

    if (!tenantId && req.user?.uid) {
      tenantId = await resolveTenantForUser(req.user.uid, { failClosed: !allowDefault });
    }

    // Fail closed: an authenticated request that resolves no tenant must 403
    // rather than silently act as the default tenant — unless ALLOW_DEFAULT_TENANT
    // (single-tenant installs).
    if (!tenantId && req.user && !allowDefault) {
      return next(
        AppError.forbidden(
          'Authenticated request has no tenant context',
          'TENANT_CONTEXT_REQUIRED',
        ),
      );
    }

    // Single-tenant escape (covers authenticated-miss above and public routes).
    if (!tenantId && allowDefault) {
      tenantId = DEFAULT_TENANT_ID;
    }

    // In fail-closed mode a public / pre-auth route (no req.user) may legitimately
    // have no tenant — it proceeds with req.tenantId = null; any tenant-scoped
    // access downstream is gated by resolveTenantOrThrow / RLS. Pre-auth
    // tenant-aware login (per-tenant subdomain) is W4.
    let tenant = null;
    if (tenantId) {
      tenant = await getTenantById(tenantId);
      if (tenant && tenant.status !== 'active' && !isSuperAdmin(req)) {
        return next(new Error(`Tenant is not active: ${tenant.status}`));
      }
    }

    req.tenantId = tenantId;
    req.tenant = tenantId ? buildTenantContext(tenantId, tenant) : null;
    req.tenantOverrideUsed = overrideUsed;

    if (req.user && tenantId) {
      req.user.tenantId = tenantId;
      req.user.tenantRegion = req.tenant.region;
      req.user.complianceProfile = req.tenant.compliance_profile;
    }

    // W4 C4: a token minted for tenant X must not be used on tenant Y's subdomain.
    // The Host subdomain is the unspoofable tenant signal (trust-by-topology); if
    // it names a real tenant that differs from the bearer's resolved tenant,
    // reject. SUPER_ADMIN (platform) + an active x-tenant-id override legitimately
    // cross tenants and are exempt; a bare host (no subdomain — single-tenant +
    // non-subdomained internal calls) skips the check, so no extra DB lookup runs
    // unless a real subdomain is present.
    if (req.user && tenantId && !overrideUsed && !isSuperAdmin(req)) {
      const hostSlug = parseTenantSlug(req.hostname || req.headers?.host);
      if (hostSlug) {
        let hostTenantId = null;
        try {
          hostTenantId = await tenantFromHost(req);
        } catch {
          hostTenantId = null; // unknown subdomain → don't block here (login already rejects it)
        }
        if (hostTenantId && String(hostTenantId) !== String(tenantId)) {
          return next(
            AppError.forbidden('Tenant host/token mismatch', 'TENANT_HOST_TOKEN_MISMATCH'),
          );
        }
      }
    }

    return next();
  } catch (err) {
    if (!isDefaultTenantAllowed()) {
      logger.warn('tenantContextMiddleware failed in fail-closed mode', { error: err.message });
      return next(
        err instanceof AppError
          ? err
          : AppError.forbidden('Tenant context could not be resolved', 'TENANT_CONTEXT_UNAVAILABLE'),
      );
    }
    logger.warn('tenantContextMiddleware failed, using default tenant', { error: err.message });
    req.tenantId = DEFAULT_TENANT_ID;
    req.tenant = buildTenantContext(DEFAULT_TENANT_ID, null);
    if (req.user) {
      req.user.tenantId = DEFAULT_TENANT_ID;
      req.user.tenantRegion = req.tenant.region;
      req.user.complianceProfile = req.tenant.compliance_profile;
    }
    return next();
  }
}
