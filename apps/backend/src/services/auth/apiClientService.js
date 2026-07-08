/**
 * DB-backed API client + key registry (Phase B4).
 *
 * Replaces the env-var-only API_KEY_PATIENT/STAFF/ADMIN model from
 * the legacy validateApiKey middleware with a tenant-scoped registry:
 *   - api_clients   — first-class machine consumer with scopes + IPs
 *   - api_keys      — per-client keys; key_hash only (never plaintext)
 *
 * Decision-support only: this service never bypasses the existing JWT
 * + RBAC stack. Keys gate API surface access; user authorisation still
 * runs through jwtMiddleware + requireRole().
 *
 * Plaintext keys are returned EXACTLY ONCE on issue. After that, only
 * the prefix + last_used metadata are visible. Rotation = revoke old +
 * issue new (do not edit a key in place).
 */

import crypto from 'crypto';

import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';

const TEXT_MAX = 8000;
const SHORT_MAX = 255;
const KEY_BYTE_LENGTH = 32; // 256-bit
const KEY_PREFIX_LEN = 8;

export const CLIENT_KINDS = [
  'integration', 'webhook', 'mobile_app', 'partner', 'internal_service', 'other',
];
export const CLIENT_STATUSES = ['active', 'paused', 'revoked', 'archived'];
export const CLIENT_ENVIRONMENTS = ['sandbox', 'production'];
export const KEY_STATUSES = ['active', 'revoked', 'expired'];

function resolveTenantId(options = {}) {
  return requireTenantId(options.tenantId);
}

function isMissingSchemaError(err) {
  return /does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

function isUniqueViolation(err) {
  return /duplicate key value/i.test(String(err?.message || ''));
}

function isFkViolation(err) {
  return /foreign key constraint/i.test(String(err?.message || ''));
}

function safeText(value, max = TEXT_MAX) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return max ? text.slice(0, max) : text;
}

function normalizeId(value, label = 'id') {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw AppError.badRequest(`${label} must be a positive integer`);
  }
  return parsed;
}

function maybeUuid(value, label = 'uid') {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw AppError.badRequest(`${label} must be a UUID`);
  }
  return text;
}

function normalizeEnum(value, allowed, label, { required = false } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw AppError.badRequest(`${label} is required`);
    return null;
  }
  const text = String(value).trim();
  if (!allowed.includes(text)) {
    throw AppError.badRequest(`${label} must be one of: ${allowed.join(', ')}`);
  }
  return text;
}

function normalizeStringArray(value, label, max = 100) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw AppError.badRequest(`${label} must be an array of strings`);
  if (value.length > max) throw AppError.badRequest(`${label} max length is ${max}`);
  return value.map((v) => safeText(v, 120)).filter(Boolean);
}

function normalizeJsonObject(value, label) {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw AppError.badRequest(`${label} must be a JSON object`);
  }
  return value;
}

function hashApiKey(plaintext) {
  return crypto.createHash('sha256').update(`vhapi:${plaintext}`).digest('hex');
}

function timingSafeEqualString(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// ---------------------------------------------------------------------------
// api_clients
// ---------------------------------------------------------------------------

const CLIENT_RETURNING = `id, tenant_id, client_code, display_name, description,
  client_kind, status, environment, scopes, allowed_ips, rate_limit_profile,
  contact_email, contact_phone, metadata, created_by, created_at, updated_at`;

export async function upsertApiClient({
  tenantId = null,
  id = null,
  clientCode,
  displayName,
  description = null,
  clientKind = 'integration',
  status = 'active',
  environment = 'sandbox',
  scopes = [],
  allowedIps = [],
  rateLimitProfile = null,
  contactEmail = null,
  contactPhone = null,
  metadata = null,
  createdBy = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanCode = safeText(clientCode, 120);
  if (!cleanCode) throw AppError.badRequest('client_code is required');
  const cleanName = safeText(displayName, SHORT_MAX);
  if (!cleanName) throw AppError.badRequest('display_name is required');
  const args = [
    cleanCode, cleanName, safeText(description),
    normalizeEnum(clientKind, CLIENT_KINDS, 'client_kind') || 'integration',
    normalizeEnum(status, CLIENT_STATUSES, 'status') || 'active',
    normalizeEnum(environment, CLIENT_ENVIRONMENTS, 'environment') || 'sandbox',
    normalizeStringArray(scopes, 'scopes'),
    normalizeStringArray(allowedIps, 'allowed_ips', 50),
    safeText(rateLimitProfile, 40),
    safeText(contactEmail, 255), safeText(contactPhone, 40),
    JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
  ];
  try {
    if (id) {
      const clientId = normalizeId(id, 'api_client id');
      const rows = await prisma.$queryRawUnsafe(
        `UPDATE api_clients SET
           client_code = $1, display_name = $2, description = $3, client_kind = $4,
           status = $5, environment = $6, scopes = $7::text[], allowed_ips = $8::text[],
           rate_limit_profile = $9, contact_email = $10, contact_phone = $11,
           metadata = $12::jsonb, updated_at = NOW()
         WHERE id = $13 AND tenant_id = $14::uuid
         RETURNING ${CLIENT_RETURNING}`,
        ...args, clientId, tid,
      );
      if (!rows[0]) throw AppError.notFound('API client not found');
      return rows[0];
    }
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO api_clients
         (tenant_id, client_code, display_name, description, client_kind, status,
          environment, scopes, allowed_ips, rate_limit_profile,
          contact_email, contact_phone, metadata, created_by)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::text[], $9::text[], $10, $11, $12, $13::jsonb, $14::uuid)
       RETURNING ${CLIENT_RETURNING}`,
      tid, ...args, maybeUuid(createdBy, 'created_by'),
    );
    return rows[0];
  } catch (err) {
    if (isUniqueViolation(err)) throw AppError.conflict('client_code already exists');
    throw err;
  }
}

export async function listApiClients({
  tenantId = null, status = null, clientKind = null, environment = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (status) {
    params.push(normalizeEnum(status, CLIENT_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  if (clientKind) {
    params.push(normalizeEnum(clientKind, CLIENT_KINDS, 'client_kind'));
    filters.push(`client_kind = $${params.length}`);
  }
  if (environment) {
    params.push(normalizeEnum(environment, CLIENT_ENVIRONMENTS, 'environment'));
    filters.push(`environment = $${params.length}`);
  }
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${CLIENT_RETURNING} FROM api_clients
       WHERE ${filters.join(' AND ')}
       ORDER BY display_name`,
      ...params,
    );
    return { clients: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { clients: [], count: 0 };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// api_keys
// ---------------------------------------------------------------------------

const KEY_RETURNING = `id, tenant_id, api_client_id, key_prefix, display_name,
  status, expires_at, last_used_at, last_used_ip, revoked_at, revoked_reason,
  created_by, created_at, updated_at`;

/**
 * Issue a new API key for a client. Returns the plaintext key ONCE
 * (the caller is expected to surface it back to the user). Subsequent
 * reads only see the prefix.
 */
export async function issueApiKey({
  tenantId = null,
  apiClientId,
  displayName = null,
  expiresAt = null,
  createdBy = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const clientId = normalizeId(apiClientId, 'api_client_id');
  const plaintext = `vh_${crypto.randomBytes(KEY_BYTE_LENGTH).toString('base64url')}`;
  const keyHash = hashApiKey(plaintext);
  const keyPrefix = plaintext.slice(0, KEY_PREFIX_LEN + 3); // include the "vh_" prefix
  let cleanExpires = null;
  if (expiresAt) {
    const dt = new Date(String(expiresAt));
    if (Number.isNaN(dt.getTime())) throw AppError.badRequest('expires_at must be a valid timestamp');
    cleanExpires = dt.toISOString();
  }
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO api_keys
         (tenant_id, api_client_id, key_hash, key_prefix, display_name,
          status, expires_at, created_by)
       SELECT $1::uuid, c.id, $3, $4, $5, 'active', $6::timestamptz, $7::uuid
       FROM api_clients c
       WHERE c.id = $2 AND c.tenant_id = $1::uuid
       RETURNING ${KEY_RETURNING}`,
      tid, clientId, keyHash, keyPrefix,
      safeText(displayName, SHORT_MAX), cleanExpires,
      maybeUuid(createdBy, 'created_by'),
    );
    if (!rows[0]) throw AppError.badRequest('Invalid api_client_id');
    return { plaintext, key: rows[0] };
  } catch (err) {
    if (isFkViolation(err)) throw AppError.badRequest('Invalid api_client_id');
    throw err;
  }
}

export async function rotateApiKey({
  tenantId = null,
  apiClientId,
  id,
  displayName = null,
  expiresAt = null,
  revokedReason = 'rotated',
  createdBy = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const clientId = normalizeId(apiClientId, 'api_client_id');
  const keyId = normalizeId(id, 'api_key id');
  const plaintext = `vh_${crypto.randomBytes(KEY_BYTE_LENGTH).toString('base64url')}`;
  const keyHash = hashApiKey(plaintext);
  const keyPrefix = plaintext.slice(0, KEY_PREFIX_LEN + 3);
  let cleanExpires = null;
  if (expiresAt) {
    const dt = new Date(String(expiresAt));
    if (Number.isNaN(dt.getTime())) throw AppError.badRequest('expires_at must be a valid timestamp');
    cleanExpires = dt.toISOString();
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const revokedRows = await tx.$queryRawUnsafe(
        `UPDATE api_keys
         SET status = 'revoked', revoked_at = NOW(), revoked_reason = $1, updated_at = NOW()
         WHERE id = $2 AND api_client_id = $3 AND tenant_id = $4::uuid AND status = 'active'
         RETURNING ${KEY_RETURNING}`,
        safeText(revokedReason), keyId, clientId, tid,
      );
      if (!revokedRows[0]) throw AppError.notFound('Active API key not found');

      const keyRows = await tx.$queryRawUnsafe(
        `INSERT INTO api_keys
           (tenant_id, api_client_id, key_hash, key_prefix, display_name,
            status, expires_at, created_by)
         SELECT $1::uuid, c.id, $3, $4, $5, 'active', $6::timestamptz, $7::uuid
         FROM api_clients c
         WHERE c.id = $2 AND c.tenant_id = $1::uuid
         RETURNING ${KEY_RETURNING}`,
        tid, clientId, keyHash, keyPrefix,
        safeText(displayName, SHORT_MAX), cleanExpires,
        maybeUuid(createdBy, 'created_by'),
      );
      if (!keyRows[0]) throw AppError.badRequest('Invalid api_client_id');
      return { plaintext, key: keyRows[0], revoked_key: revokedRows[0] };
    });
  } catch (err) {
    if (isFkViolation(err)) throw AppError.badRequest('Invalid api_client_id');
    throw err;
  }
}

export async function revokeApiKey({
  tenantId = null, id, revokedReason = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const keyId = normalizeId(id, 'api_key id');
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE api_keys
     SET status = 'revoked', revoked_at = NOW(), revoked_reason = $1, updated_at = NOW()
     WHERE id = $2 AND tenant_id = $3::uuid AND status = 'active'
     RETURNING ${KEY_RETURNING}`,
    safeText(revokedReason), keyId, tid,
  );
  if (!rows[0]) throw AppError.notFound('Active API key not found');
  return rows[0];
}

export async function listApiKeys({
  tenantId = null, apiClientId = null, status = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (apiClientId) {
    params.push(normalizeId(apiClientId, 'api_client_id'));
    filters.push(`api_client_id = $${params.length}`);
  }
  if (status) {
    params.push(normalizeEnum(status, KEY_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${KEY_RETURNING} FROM api_keys
       WHERE ${filters.join(' AND ')}
       ORDER BY created_at DESC`,
      ...params,
    );
    return { keys: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { keys: [], count: 0 };
    throw err;
  }
}

/**
 * Look up a plaintext key against the registry. Returns the parent
 * api_client row (with scopes + allowed_ips) on success, or null.
 * Stamps last_used_at + last_used_ip on hit. Times out cleanly on
 * schema-missing.
 */
export async function authenticateByApiKey({
  tenantId = null, plaintext, ipAddress = null,
} = {}) {
  if (!plaintext) return null;
  const tid = resolveTenantId({ tenantId });
  const keyHash = hashApiKey(String(plaintext).trim());
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT k.id AS key_id, k.api_client_id, k.status AS key_status, k.expires_at,
              c.tenant_id, c.client_code, c.display_name, c.client_kind, c.status AS client_status,
              c.environment, c.scopes, c.allowed_ips, c.rate_limit_profile
       FROM api_keys k
       JOIN api_clients c ON c.id = k.api_client_id AND c.tenant_id = k.tenant_id
       WHERE k.tenant_id = $1::uuid AND k.key_hash = $2
       LIMIT 1`,
      tid, keyHash,
    );
    const row = rows[0];
    if (!row) return null;
    if (row.key_status !== 'active' || row.client_status !== 'active') return null;
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return null;
    if (Array.isArray(row.allowed_ips) && row.allowed_ips.length > 0 && ipAddress) {
      if (!row.allowed_ips.some((allowed) => timingSafeEqualString(allowed, ipAddress))) {
        return null;
      }
    }
    await prisma.$queryRawUnsafe(
      `UPDATE api_keys
       SET last_used_at = NOW(), last_used_ip = $1, updated_at = NOW()
       WHERE id = $2 AND tenant_id = $3::uuid`,
      safeText(ipAddress, 64), row.key_id, tid,
    );
    return {
      api_client_id: row.api_client_id,
      tenant_id: row.tenant_id,
      client_code: row.client_code,
      display_name: row.display_name,
      client_kind: row.client_kind,
      environment: row.environment,
      scopes: row.scopes,
      allowed_ips: row.allowed_ips,
      rate_limit_profile: row.rate_limit_profile,
      key_id: row.key_id,
    };
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    throw err;
  }
}

/**
 * GLOBAL plaintext-key lookup, keyed on the UNIQUE api_keys.key_hash with NO
 * tenant filter. For the validateApiKey middleware, which runs pre-auth with no
 * tenant resolved yet — the key itself identifies the client + tenant. Runs as
 * plain prisma; api_keys RLS is permissive when the GUC is unset (early
 * middleware) so the unique key_hash returns the single matching row across
 * tenants. Returns the row (with tenant_id) on success, else null. Mirrors the
 * status/expiry/allowed-ip checks of the tenant-scoped authenticateByApiKey.
 */
export async function authenticateByApiKeyGlobal({ plaintext, ipAddress = null } = {}) {
  if (!plaintext) return null;
  const keyHash = hashApiKey(String(plaintext).trim());
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT k.id AS key_id, k.api_client_id, k.status AS key_status, k.expires_at, k.tenant_id,
              c.client_code, c.display_name, c.client_kind, c.status AS client_status,
              c.environment, c.scopes, c.allowed_ips, c.rate_limit_profile
       FROM api_keys k
       JOIN api_clients c ON c.id = k.api_client_id AND c.tenant_id = k.tenant_id
       WHERE k.key_hash = $1
       LIMIT 1`,
      keyHash,
    );
    const row = rows[0];
    if (!row) return null;
    if (row.key_status !== 'active' || row.client_status !== 'active') return null;
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return null;
    if (Array.isArray(row.allowed_ips) && row.allowed_ips.length > 0 && ipAddress) {
      if (!row.allowed_ips.some((allowed) => timingSafeEqualString(allowed, ipAddress))) {
        return null;
      }
    }
    await prisma.$queryRawUnsafe(
      `UPDATE api_keys
       SET last_used_at = NOW(), last_used_ip = $1, updated_at = NOW()
       WHERE id = $2 AND tenant_id = $3::uuid`,
      safeText(ipAddress, 64), row.key_id, row.tenant_id,
    );
    return {
      api_client_id: row.api_client_id,
      tenant_id: row.tenant_id,
      client_code: row.client_code,
      display_name: row.display_name,
      client_kind: row.client_kind,
      environment: row.environment,
      scopes: row.scopes,
      allowed_ips: row.allowed_ips,
      rate_limit_profile: row.rate_limit_profile,
      key_id: row.key_id,
    };
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    throw err;
  }
}

export const __testing__ = {
  hashApiKey, KEY_BYTE_LENGTH, KEY_PREFIX_LEN,
};

export default {
  upsertApiClient,
  listApiClients,
  issueApiKey,
  rotateApiKey,
  revokeApiKey,
  listApiKeys,
  authenticateByApiKey,
  authenticateByApiKeyGlobal,
};
