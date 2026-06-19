import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { isDefaultTenantAllowed } from '../../config/tenantRlsConfig.js';

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

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO tenants (slug, name, region, compliance_profile, settings, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, NOW(), NOW())
     ON CONFLICT (slug) DO NOTHING
     RETURNING id, slug, name, region, compliance_profile, status, settings, created_at, updated_at`,
    slug,
    name,
    region,
    compliance,
    JSON.stringify(data.settings || {})
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
  if (patch.settings != null) {
    fields.push(`settings = $${idx}::jsonb`);
    values.push(JSON.stringify(patch.settings));
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
    return rows[0]?.tenant_id || onMiss;
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

const TENANT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
 * Resolution order (first signal wins):
 *   1. `x-tenant-id` header — an explicit tenant UUID (SaaS clients /
 *      per-tenant ingress). Validated against the tenants table; an
 *      unknown or non-active tenant is rejected.
 *   2. `x-tenant-slug` header — a human-friendly tenant slug, resolved
 *      via `getTenantBySlug`. Same active-status check.
 *   3. DEFAULT_TENANT_ID — the single-tenant production floor. Today the
 *      platform ships single-tenant, so absent any signal this is the
 *      correct (and safe) answer. Documented so a future SaaS rollout
 *      knows to start sending one of the headers above rather than
 *      relying on this fallback.
 *
 * NOTE: we deliberately do NOT silently pick the first matching user row
 * across tenants. When there is no tenant signal we use the configured
 * default; we never let the *identity* decide the tenant.
 *
 * @param {import('express').Request} req
 * @returns {Promise<string>} resolved tenant id (always a valid uuid)
 */
export async function resolveTenantForRequest(req) {
  const headerGet = typeof req?.get === 'function'
    ? (name) => req.get(name)
    : (name) => req?.headers?.[String(name).toLowerCase()];

  // 1. Explicit tenant UUID header.
  const rawTenantId = clean(headerGet('x-tenant-id'));
  if (rawTenantId && TENANT_UUID_RE.test(rawTenantId)) {
    const tenant = await getTenantById(rawTenantId.toLowerCase());
    if (tenant && tenant.status === 'active') return tenant.id;
    throw AppError.badRequest('Unknown or inactive tenant', 'TENANT_NOT_RESOLVED');
  }

  // 2. Tenant slug header.
  const rawSlug = clean(headerGet('x-tenant-slug'));
  if (rawSlug) {
    const tenant = await getTenantBySlug(rawSlug);
    if (tenant && tenant.status === 'active') return tenant.id;
    throw AppError.badRequest('Unknown or inactive tenant', 'TENANT_NOT_RESOLVED');
  }

  // 3. Single-tenant production floor.
  return DEFAULT_TENANT_ID;
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
  updateTenant,
  DEFAULT_TENANT_ID,
};
