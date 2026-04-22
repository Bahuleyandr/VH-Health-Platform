import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';

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

export async function resolveTenantForUser(userUid) {
  if (!userUid) return DEFAULT_TENANT_ID;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT tenant_id FROM users WHERE uid = $1::uuid LIMIT 1`,
      userUid
    );
    return rows[0]?.tenant_id || DEFAULT_TENANT_ID;
  } catch (err) {
    logger.debug('resolveTenantForUser fallback to default', { error: err.message });
    return DEFAULT_TENANT_ID;
  }
}

export default {
  createTenant,
  getTenantById,
  getTenantBySlug,
  listTenants,
  resolveTenantForUser,
  updateTenant,
  DEFAULT_TENANT_ID,
};
