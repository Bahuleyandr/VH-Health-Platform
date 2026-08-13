import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { isDefaultTenantAllowed } from '../../config/tenantRlsConfig.js';
import {
  DEFAULT_CARE_TEAM_ENFORCEMENT_MODE,
  RESERVED_CARE_PATHWAYS_SETTINGS_KEY,
  RESERVED_CARE_TEAM_ENFORCEMENT_SETTINGS_KEY,
  serializeGenericTenantSettings,
} from './tenantSettingsMutationPolicy.js';

export const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';

const VALID_REGIONS = new Set(['IN', 'EU', 'US', 'AP', 'OTHER']);
const VALID_COMPLIANCE_PROFILES = new Set(['DPDP', 'HIPAA', 'GDPR', 'NONE']);
const VALID_STATUSES = new Set(['active', 'suspended', 'offboarding']);

const TENANT_CACHE = new Map();
const TENANT_CACHE_TTL_MS = 60 * 1000;

function cacheKey(id) {
  return `id:${id}`;
}

function cacheGet(id) {
  const hit = TENANT_CACHE.get(cacheKey(id));
  if (!hit) return null;
  if (hit.expires < Date.now()) {
    TENANT_CACHE.delete(cacheKey(id));
    return null;
  }
  return hit.value;
}

function cacheSet(id, tenant) {
  TENANT_CACHE.set(cacheKey(id), {
    value: tenant,
    expires: Date.now() + TENANT_CACHE_TTL_MS,
  });
}

function invalidateCache(id) {
  if (id) TENANT_CACHE.delete(cacheKey(id));
  else TENANT_CACHE.clear();
}

function clean(value) {
  return String(value ?? '').trim();
}

function validateRegion(region) {
  if (!VALID_REGIONS.has(region)) {
    throw AppError.badRequest(`Invalid region: ${region}`);
  }
  return region;
}

function validateProfile(profile) {
  if (!VALID_COMPLIANCE_PROFILES.has(profile)) {
    throw AppError.badRequest(`Invalid compliance profile: ${profile}`);
  }
  return profile;
}

function validateStatus(status) {
  if (!VALID_STATUSES.has(status)) {
    throw AppError.badRequest(`Invalid tenant status: ${status}`);
  }
  return status;
}

export async function getTenantById(tenantId) {
  if (!tenantId) return null;
  const cached = cacheGet(tenantId);
  if (cached) return cached;

  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, slug, name, region, compliance_profile, status, settings, created_at, updated_at
     FROM tenants
     WHERE id = $1::uuid
     LIMIT 1`,
    tenantId
  );
  const tenant = rows[0] || null;
  if (tenant) cacheSet(tenantId, tenant);
  return tenant;
}

export async function getTenantBySlug(slug) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, slug, name, region, compliance_profile, status, settings, created_at, updated_at
     FROM tenants
     WHERE slug = $1
     LIMIT 1`,
    clean(slug)
  );
  return rows[0] || null;
}

export async function listTenants({ status = null, region = null, limit = 100 } = {}) {
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, slug, name, region, compliance_profile, status, settings, created_at, updated_at
     FROM tenants
     WHERE ($1::text IS NULL OR status = $1)
       AND ($2::text IS NULL OR region = $2)
     ORDER BY created_at DESC
     LIMIT $3`,
    status,
    region,
    safeLimit
  );
  return { tenants: rows, count: rows.length };
}

export async function createTenant(data = {}) {
  const slug = clean(data.slug);
  const name = clean(data.name);
  if (!slug) throw AppError.badRequest('slug is required');
  if (!name) throw AppError.badRequest('name is required');

  const region = validateRegion(clean(data.region || 'IN').toUpperCase());
  const compliance = validateProfile(clean(data.compliance_profile || 'DPDP').toUpperCase());
  const genericSettings = JSON.parse(serializeGenericTenantSettings(
    Object.prototype.hasOwnProperty.call(data, 'settings') ? data.settings : {},
  ));
  const serializedSettings = JSON.stringify({
    ...genericSettings,
    [RESERVED_CARE_TEAM_ENFORCEMENT_SETTINGS_KEY]: DEFAULT_CARE_TEAM_ENFORCEMENT_MODE,
  });

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO tenants (slug, name, region, compliance_profile, settings, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, NOW(), NOW())
     ON CONFLICT (slug) DO NOTHING
     RETURNING id, slug, name, region, compliance_profile, status, settings, created_at, updated_at`,
    slug,
    name,
    region,
    compliance,
    serializedSettings
  );
  if (!rows[0]) {
    throw AppError.conflict(`Tenant slug already exists: ${slug}`);
  }
  invalidateCache(rows[0].id);
  return rows[0];
}

export async function updateTenant(tenantId, patch = {}) {
  if (!tenantId) throw AppError.badRequest('tenantId is required');
  if (tenantId === DEFAULT_TENANT_ID && (patch.status || patch.slug)) {
    throw AppError.forbidden('Default tenant cannot be renamed or suspended');
  }

  const fields = [];
  const values = [];
  let idx = 1;
  if (patch.name != null) {
    fields.push(`name = $${idx}`);
    values.push(clean(patch.name));
    idx += 1;
  }
  if (patch.region != null) {
    fields.push(`region = $${idx}`);
    values.push(validateRegion(clean(patch.region).toUpperCase()));
    idx += 1;
  }
  if (patch.compliance_profile != null) {
    fields.push(`compliance_profile = $${idx}`);
    values.push(validateProfile(clean(patch.compliance_profile).toUpperCase()));
    idx += 1;
  }
  if (patch.status != null) {
    fields.push(`status = $${idx}`);
    values.push(validateStatus(clean(patch.status).toLowerCase()));
    idx += 1;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'settings')) {
    fields.push(
      `settings = $${idx}::jsonb
        || CASE
             WHEN jsonb_typeof(settings) = 'object'
              AND settings ? '${RESERVED_CARE_PATHWAYS_SETTINGS_KEY}'
             THEN jsonb_build_object(
                    '${RESERVED_CARE_PATHWAYS_SETTINGS_KEY}',
                    settings -> '${RESERVED_CARE_PATHWAYS_SETTINGS_KEY}'
                  )
             ELSE '{}'::jsonb
           END
        || CASE
             WHEN jsonb_typeof(settings) = 'object'
              AND settings ? '${RESERVED_CARE_TEAM_ENFORCEMENT_SETTINGS_KEY}'
             THEN jsonb_build_object(
                    '${RESERVED_CARE_TEAM_ENFORCEMENT_SETTINGS_KEY}',
                    settings -> '${RESERVED_CARE_TEAM_ENFORCEMENT_SETTINGS_KEY}'
                  )
             ELSE '{}'::jsonb
           END`
    );
    values.push(serializeGenericTenantSettings(patch.settings));
    idx += 1;
  }

  if (!fields.length) {
    const current = await getTenantById(tenantId);
    if (!current) throw AppError.notFound('Tenant not found');
    return current;
  }

  fields.push('updated_at = NOW()');
  values.push(tenantId);
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE tenants SET ${fields.join(', ')}
     WHERE id = $${idx}::uuid
     RETURNING id, slug, name, region, compliance_profile, status, settings, created_at, updated_at`,
    ...values
  );
  if (!rows[0]) throw AppError.notFound('Tenant not found');
  invalidateCache(tenantId);
  return rows[0];
}

export async function resolveTenantForUser(userUid, { failClosed = false } = {}) {
  // When failClosed, a missing uid or a lookup MISS returns null (not the
  // default tenant) so the caller's fail-closed gate can fire — silently
  // defaulting here would mask a missing-tenant bug as default-tenant activity
  // (W1, multi-tenancy program). Single-tenant installs (failClosed=false) keep
  // the legacy default floor.
  const onMiss = failClosed ? null : DEFAULT_TENANT_ID;
  if (!userUid) return onMiss;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT tenant_id FROM users WHERE uid = $1::uuid LIMIT 1`,
      userUid
    );
    if (rows[0]?.tenant_id) return rows[0].tenant_id;
    // Admins are a separate identity realm (not in `users`). A bare admin token
    // (the MFA-enroll / challenge-verify mints in adminAuthController carry no
    // tenant_id claim) lands here — resolve their tenant from the admins table
    // (mig 334; NULL for platform SUPER_ADMINs → onMiss, overridden per-request).
    // Symmetric with resolveTenantIdForUid's admin fallback. (W4 C5)
    const adminRows = await prisma.$queryRawUnsafe(
      `SELECT tenant_id FROM admins WHERE uid = $1::uuid LIMIT 1`,
      userUid
    );
    return adminRows[0]?.tenant_id || onMiss;
  } catch (err) {
    if (failClosed) {
      throw AppError.internal('Tenant context lookup failed', 'TENANT_CONTEXT_LOOKUP_FAILED');
    }
    logger.debug('resolveTenantForUser fallback to default', { error: err.message });
    return DEFAULT_TENANT_ID;
  }
}

/**
 * Fail-closed tenant resolver for handlers/services. Returns the tenant already
 * resolved onto `req.tenantId` by tenantContextMiddleware; if absent, throws
 * 403 TENANT_CONTEXT_REQUIRED — UNLESS `ALLOW_DEFAULT_TENANT=true` (single-tenant
 * installs), in which case it returns the default tenant. This is the single
 * sanctioned replacement for the scattered `req.tenantId || … || DEFAULT_TENANT_ID`
 * resolvers (W1, multi-tenancy program).
 *
 * @param {import('express').Request} req
 * @returns {string} resolved tenant id
 */
export function resolveTenantOrThrow(req) {
  return requireTenantId(req?.tenantId);
}

/**
 * Value-level fail-closed guard for the service layer (W1, multi-tenancy
 * program). Returns the given tenantId if truthy; otherwise throws 403
 * TENANT_CONTEXT_REQUIRED — UNLESS `ALLOW_DEFAULT_TENANT=true` (single-tenant
 * installs), in which case it returns the default tenant. This is the sanctioned
 * replacement for `tenantId || DEFAULT_TENANT_ID` in service `scopedTx`/`tenantOr`
 * helpers: a falsy tenant on a clinical/money write must fail, not silently
 * scope to the default tenant.
 *
 * @param {string|null|undefined} tenantId
 * @returns {string} a valid tenant id
 */
export function requireTenantId(tenantId) {
  if (tenantId) return tenantId;
  if (isDefaultTenantAllowed()) return DEFAULT_TENANT_ID;
  throw AppError.forbidden('Tenant context required', 'TENANT_CONTEXT_REQUIRED');
}

/**
 * Resolve the tenant a *pre-auth* request belongs to, BEFORE any user
 * identity is looked up.
 *
 * This exists for auth entrypoints (Firebase OTP login, profile
 * completion, account linking) that run before `tenantContextMiddleware`
 * has a `req.user` to key off. On those flows we must pin the tenant from
 * request-level signals so the identity lookup is scoped — otherwise a
 * phone number that exists in two tenants resolves arbitrarily and we
 * mint a JWT bound to the wrong tenant (SEC-5).
 *
 * W4 (edge routing): the tenant is derived from the request Host SUBDOMAIN via
 * `tenantFromHost` — the per-tenant subdomain is the authoritative, unspoofable
 * (trust-by-topology) signal. The bare base host resolves to DEFAULT_TENANT_ID
 * (single-tenant floor). Client `x-tenant-id` / `x-tenant-slug` headers are NOT
 * trusted here; a SUPER_ADMIN cross-tenant override is handled post-auth (with a
 * reason + audit) in tenantContextMiddleware.
 *
 * NOTE: we never let the *identity* decide the tenant — the tenant is pinned from
 * the Host before the user lookup, so a phone/username present in two tenants
 * resolves to the right one by subdomain.
 *
 * @param {import('express').Request} req
 * @returns {Promise<string>} resolved tenant id (always a valid uuid)
 */
export async function resolveTenantForRequest(req) {
  // W4 (edge routing): Host-derived, trust-by-topology. The per-tenant subdomain
  // is the authoritative pre-auth tenant signal — the only path to the backend is
  // via the Cloudflare tunnel + per-tenant TLS, so the Host cannot be spoofed to
  // another tenant. Client x-tenant-id / x-tenant-slug headers are NOT trusted
  // here (a SUPER_ADMIN cross-tenant override is a post-auth concern, validated +
  // audited in tenantContextMiddleware). Bare base host → default tenant, so
  // single-tenant operation is unchanged.
  return tenantFromHost(req);
}

// W4 (edge routing): the per-tenant subdomain is the authoritative tenant signal.
// The base host(s) the subdomains sit under (TENANT_BASE_HOST, comma list for
// prod/staging/dev/localhost). Default 'localhost' keeps tests + local dev working.
function tenantBaseHosts() {
  return String(process.env.TENANT_BASE_HOST || 'localhost')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Pure: extract the tenant slug from a Host string, or null for the bare base
 * host / apex / a host not under any base host (→ default tenant).
 *
 * Flat 1st-level model (no Cloudflare ACM): the per-tenant API host is
 * `<slug>-api.<base>` (e.g. `acme-api.vhhealth.app`), a SINGLE label under the
 * apex so Cloudflare Universal SSL `*.<base>` covers it for free. ONLY a
 * leftmost label ending in `-api` marks a tenant host — its `-api` suffix is
 * stripped to yield the slug. The apex hosts (`api`, `admin`), `www`, and any
 * other label resolve to the default tenant. The admin app stays single-host
 * (`admin.<base>`, tenant driven by the token), so no `-admin` form is needed.
 * Case-insensitive; strips the port. No DB access.
 *
 * @param {string} host
 * @param {string[]} [baseHosts]
 * @returns {string|null}
 */
export function parseTenantSlug(host, baseHosts = tenantBaseHosts()) {
  const h = String(host || '').toLowerCase().split(':')[0].trim();
  if (!h) return null;
  for (const base of baseHosts) {
    if (h === base) return null;                       // bare base host → default
    if (h.endsWith('.' + base)) {
      const label = h.slice(0, -(base.length + 1)).split('.')[0] || '';
      if (label.endsWith('-api') && label.length > 4) {
        return label.slice(0, -4);                     // <slug>-api → <slug>
      }
      return null;                                     // apex/other label → default
    }
  }
  return null;                                         // not our domain → default
}

/**
 * Resolve the tenant a request belongs to from its Host subdomain (W4 trust-by-
 * topology). Bare base host / unknown domain → default tenant. A configured
 * subdomain → that tenant; an unknown or inactive subdomain is rejected (mirrors
 * the resolveTenantForRequest contract). Always returns a valid tenant id (or throws).
 *
 * @param {import('express').Request} req
 * @returns {Promise<string>}
 */
export async function tenantFromHost(req) {
  const host = (typeof req?.hostname === 'string' && req.hostname)
    || req?.headers?.host
    || '';
  const slug = parseTenantSlug(host);
  if (!slug) return DEFAULT_TENANT_ID;
  const tenant = await getTenantBySlug(slug);
  if (!tenant || tenant.status !== 'active') {
    throw AppError.badRequest('Unknown or inactive tenant', 'TENANT_NOT_RESOLVED');
  }
  return tenant.id;
}

export default {
  createTenant,
  getTenantById,
  getTenantBySlug,
  listTenants,
  resolveTenantForRequest,
  resolveTenantForUser,
  resolveTenantOrThrow,
  requireTenantId,
  parseTenantSlug,
  tenantFromHost,
  updateTenant,
  DEFAULT_TENANT_ID,
};
