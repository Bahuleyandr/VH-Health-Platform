/**
 * Encryption key registry (Phase E3).
 *
 * Tracks KEK (Key Encryption Key) versions: which one is active for
 * new writes, which are retiring, which are retired. Enables rotation
 * without losing access to data encrypted under older KEKs.
 *
 * The actual key material lives in the KMS provider — this table only
 * stores metadata + provider references.
 *
 * Migration 129.
 */

import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenantService.js';

const SHORT_MAX = 255;

export const KMS_PROVIDERS = ['env', 'aws-kms', 'gcp-kms', 'vault', 'azure-keyvault'];
export const KEY_STATUSES = ['active', 'retiring', 'retired', 'compromised'];

function resolveTenantId(options = {}) {
  return options.tenantId || DEFAULT_TENANT_ID;
}

function isMissingSchemaError(err) {
  return /does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

function isUniqueViolation(err) {
  return /duplicate key value/i.test(String(err?.message || ''));
}

function safeText(value, max = SHORT_MAX) {
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

const RETURNING = `id, tenant_id, key_id, provider, provider_reference,
  algorithm, status, rotated_from, activated_at, retiring_at, retired_at,
  metadata, created_by, created_at, updated_at`;

export async function registerEncryptionKey({
  tenantId = null, keyId, provider = 'env', providerReference = null,
  algorithm = 'aes-256-gcm', metadata = null, createdBy = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanKid = safeText(keyId, 64);
  if (!cleanKid) throw AppError.badRequest('key_id is required');
  const cleanProv = normalizeEnum(provider, KMS_PROVIDERS, 'provider') || 'env';
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO encryption_keys
         (tenant_id, key_id, provider, provider_reference, algorithm,
          status, metadata, created_by)
       VALUES ($1::uuid, $2, $3, $4, $5, 'active', $6::jsonb, $7::uuid)
       RETURNING ${RETURNING}`,
      tid, cleanKid, cleanProv, safeText(providerReference, 512), safeText(algorithm, 40),
      JSON.stringify(metadata || {}),
      maybeUuid(createdBy, 'created_by'),
    );
    return rows[0];
  } catch (err) {
    if (isUniqueViolation(err)) throw AppError.conflict('key_id already registered for this tenant');
    throw err;
  }
}

export async function listEncryptionKeys({ tenantId = null, status = null } = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['(tenant_id = $1::uuid OR tenant_id IS NULL)'];
  const params = [tid];
  if (status) {
    params.push(normalizeEnum(status, KEY_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${RETURNING} FROM encryption_keys
       WHERE ${filters.join(' AND ')}
       ORDER BY activated_at DESC`,
      ...params,
    );
    return { keys: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { keys: [], count: 0 };
    throw err;
  }
}

/**
 * Begin rotation: mark the current 'active' key as 'retiring' and
 * register a new 'active' key with `rotated_from` linking back to it.
 * Returns the new key row. Reads still work against the retiring key
 * for as long as records remain unrotated.
 */
export async function rotateActiveKey({
  tenantId = null, newKeyId, provider = 'env', providerReference = null,
  algorithm = 'aes-256-gcm', metadata = null, createdBy = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanNew = safeText(newKeyId, 64);
  if (!cleanNew) throw AppError.badRequest('newKeyId is required');
  const cleanProv = normalizeEnum(provider, KMS_PROVIDERS, 'provider') || 'env';

  const active = await prisma.$queryRawUnsafe(
    `SELECT id, key_id FROM encryption_keys
     WHERE tenant_id = $1::uuid AND status = 'active'
     ORDER BY activated_at DESC LIMIT 1`,
    tid,
  );
  const previousId = active[0]?.id || null;

  const inserted = await prisma.$queryRawUnsafe(
    `INSERT INTO encryption_keys
       (tenant_id, key_id, provider, provider_reference, algorithm,
        status, rotated_from, metadata, created_by)
     VALUES ($1::uuid, $2, $3, $4, $5, 'active', $6, $7::jsonb, $8::uuid)
     RETURNING ${RETURNING}`,
    tid, cleanNew, cleanProv, safeText(providerReference, 512), safeText(algorithm, 40),
    previousId, JSON.stringify(metadata || {}),
    maybeUuid(createdBy, 'created_by'),
  );
  if (previousId) {
    await prisma.$queryRawUnsafe(
      `UPDATE encryption_keys
       SET status = 'retiring', retiring_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      previousId,
    );
  }
  return inserted[0];
}

export async function retireEncryptionKey({ tenantId = null, id } = {}) {
  const tid = resolveTenantId({ tenantId });
  const keyRowId = normalizeId(id, 'encryption_keys id');
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE encryption_keys
     SET status = 'retired', retired_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2::uuid AND status IN ('active', 'retiring')
     RETURNING ${RETURNING}`,
    keyRowId, tid,
  );
  if (!rows[0]) throw AppError.notFound('Encryption key not found or already retired');
  return rows[0];
}

export async function markKeyCompromised({ tenantId = null, id, reason = null } = {}) {
  const tid = resolveTenantId({ tenantId });
  const keyRowId = normalizeId(id, 'encryption_keys id');
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE encryption_keys
     SET status = 'compromised', updated_at = NOW(),
         metadata = metadata || jsonb_build_object('compromised_reason', $1::text, 'compromised_at', NOW()::text)
     WHERE id = $2 AND tenant_id = $3::uuid AND status <> 'compromised'
     RETURNING ${RETURNING}`,
    safeText(reason), keyRowId, tid,
  );
  if (!rows[0]) throw AppError.notFound('Encryption key not found or already compromised');
  return rows[0];
}

export const __testing__ = { KMS_PROVIDERS, KEY_STATUSES };

export default {
  registerEncryptionKey,
  listEncryptionKeys,
  rotateActiveKey,
  retireEncryptionKey,
  markKeyCompromised,
};
