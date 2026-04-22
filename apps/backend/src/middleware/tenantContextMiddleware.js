import logger from '../logging/logger.js';
import {
  DEFAULT_TENANT_ID,
  getTenantById,
  resolveTenantForUser,
} from '../services/tenant/tenantService.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isSuperAdmin(req) {
  const role = String(req.user?.role || '').toUpperCase();
  return role === 'SUPER_ADMIN';
}

function normalizeUuid(value) {
  const text = String(value || '').trim();
  return UUID_RE.test(text) ? text.toLowerCase() : null;
}

/**
 * tenantContextMiddleware
 *
 * Populates req.tenantId for downstream services. Resolution order:
 *   1. JWT claim (preferred — set at token-issue time when login flows are
 *      upgraded).
 *   2. `x-tenant-id` header, if present AND the caller is SUPER_ADMIN.
 *      Lets platform operators cross-tenant debug without switching accounts.
 *   3. `users.tenant_id` lookup keyed by `req.user.uid`.
 *   4. DEFAULT_TENANT_ID — single-tenant backwards-compatibility floor.
 *
 * Mounts AFTER jwtMiddleware. Unauthenticated routes silently get the
 * default tenant so public endpoints (health, version) keep working.
 */
export default async function tenantContextMiddleware(req, _res, next) {
  try {
    let tenantId = null;

    if (req.user?.tenant_id) {
      tenantId = normalizeUuid(req.user.tenant_id);
    } else if (req.user?.tenantId) {
      tenantId = normalizeUuid(req.user.tenantId);
    }

    if (!tenantId && isSuperAdmin(req)) {
      const header = req.get('x-tenant-id');
      const override = normalizeUuid(header);
      if (override) tenantId = override;
    }

    if (!tenantId && req.user?.uid) {
      tenantId = await resolveTenantForUser(req.user.uid);
    }

    tenantId = tenantId || DEFAULT_TENANT_ID;

    const tenant = await getTenantById(tenantId);
    if (tenant && tenant.status !== 'active' && !isSuperAdmin(req)) {
      return next(new Error(`Tenant is not active: ${tenant.status}`));
    }

    req.tenantId = tenantId;
    req.tenant = tenant || { id: tenantId, region: 'IN', compliance_profile: 'DPDP', status: 'active' };

    if (req.user) {
      req.user.tenantId = tenantId;
      req.user.tenantRegion = req.tenant.region;
      req.user.complianceProfile = req.tenant.compliance_profile;
    }

    return next();
  } catch (err) {
    logger.warn('tenantContextMiddleware failed, using default tenant', { error: err.message });
    req.tenantId = DEFAULT_TENANT_ID;
    return next();
  }
}
