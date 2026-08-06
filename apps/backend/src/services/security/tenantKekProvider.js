// src/services/security/tenantKekProvider.js
//
// W3 (multi-tenancy program) WS5 — per-tenant Key-Encryption-Keys.
//
// Envelope: master KEK -> per-tenant KEK -> per-record DEK -> data.
//   - The master KEK is derived (scrypt) from FIELD_ENCRYPTION_MASTER_KEK.
//   - Each tenant gets a RANDOM 32-byte KEK, stored wrapped (AES-256-GCM under
//     the master KEK) as encryption_keys.wrapped_key_material with key_id
//     `t:<tenantId>:v1`.
//   - Crypto-shred = drop a tenant's wrapped_key_material -> that tenant's
//     ciphertext is unrecoverable; every other tenant is untouched.
//
// Random (not derived) per-tenant keys are what make crypto-shred meaningful —
// a derived key could always be re-derived from the master + tenantId.
//
// The KEK provider (fieldKeyProvider.LocalKekProvider) is synchronous, but
// loading a tenant KEK is async (DB). So we load + unwrap here, then REGISTER the
// raw KEK into the provider's in-process map under its keyId; the sync
// encrypt/decrypt path then wraps/unwraps tenant DEKs by keyId. Call
// preloadAllTenantKeks() at startup (or loadTenantKekIntoProvider per tenant)
// before encrypting/decrypting tenant-scoped ciphertext.

import crypto from 'crypto';
import prisma from '../../lib/prisma.js';
import { getKekProvider } from '../../utils/fieldKeyProvider.js';

const KEK_LENGTH = 32;
const WRAP_IV_LENGTH = 12;
const MASTER_KDF_SALT = 'vh-field-master-kek-v1';

let _cachedMaster = null;
const _tenantKekCache = new Map(); // tenantId -> raw 32-byte KEK Buffer

function masterKek() {
  if (_cachedMaster) return _cachedMaster;
  const material = process.env.FIELD_ENCRYPTION_MASTER_KEK;
  if (!material) {
    throw new Error('FIELD_ENCRYPTION_MASTER_KEK must be set for per-tenant field-encryption KEKs');
  }
  _cachedMaster = crypto.scryptSync(String(material), MASTER_KDF_SALT, KEK_LENGTH);
  return _cachedMaster;
}

/** The encryption_keys.key_id stamped into every per-tenant enc:v2 payload. */
export function tenantKeyId(tenantId) {
  return `t:${tenantId}:v1`;
}

function wrapUnderMaster(kek) {
  const wiv = crypto.randomBytes(WRAP_IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKek(), wiv);
  const edek = Buffer.concat([cipher.update(kek), cipher.final()]);
  const wtag = cipher.getAuthTag();
  return Buffer.from(
    JSON.stringify({
      edek: edek.toString('base64'),
      wiv: wiv.toString('base64'),
      wtag: wtag.toString('base64'),
    }),
    'utf8',
  ).toString('base64url');
}

function unwrapUnderMaster(wrapped) {
  const { edek, wiv, wtag } = JSON.parse(Buffer.from(String(wrapped), 'base64url').toString('utf8'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', masterKek(), Buffer.from(wiv, 'base64'));
  decipher.setAuthTag(Buffer.from(wtag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(edek, 'base64')), decipher.final()]);
}

/**
 * Provision a fresh random KEK for a tenant: store it wrapped under the master
 * KEK and register it for immediate use. Idempotent on (tenant_id, key_id) —
 * re-running re-provisions (rotates) the KEK. Returns { tenantId, keyId }.
 */
export async function provisionTenantKek(tenantId) {
  const kek = crypto.randomBytes(KEK_LENGTH);
  const wrapped = wrapUnderMaster(kek);
  const kid = tenantKeyId(tenantId);
  await prisma.$executeRawUnsafe(
    `INSERT INTO encryption_keys
       (tenant_id, key_id, provider, algorithm, status, wrapped_key_material, activated_at, created_at, updated_at)
     VALUES ($1::uuid, $2, 'local-tenant', 'aes-256-gcm', 'active', $3, NOW(), NOW(), NOW())
     ON CONFLICT (tenant_id, key_id) DO UPDATE SET
       wrapped_key_material = EXCLUDED.wrapped_key_material,
       status = 'active',
       updated_at = NOW()`,
    tenantId, kid, wrapped,
  );
  _tenantKekCache.set(tenantId, kek);
  getKekProvider().registerTenantKek(kid, kek);
  return { tenantId, keyId: kid };
}

/**
 * Load (and cache + register) a tenant's KEK. Throws if there is no active
 * wrapped KEK for the tenant (never provisioned, or crypto-shredded).
 */
export async function getTenantKek(tenantId) {
  if (_tenantKekCache.has(tenantId)) return _tenantKekCache.get(tenantId);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT wrapped_key_material FROM encryption_keys
      WHERE tenant_id = $1::uuid AND key_id = $2 AND status = 'active'
        AND wrapped_key_material IS NOT NULL
      LIMIT 1`,
    tenantId, tenantKeyId(tenantId),
  );
  if (!rows[0]?.wrapped_key_material) {
    throw new Error(`No active KEK for tenant ${tenantId} (provision it, or it was crypto-shredded)`);
  }
  const kek = unwrapUnderMaster(rows[0].wrapped_key_material);
  _tenantKekCache.set(tenantId, kek);
  getKekProvider().registerTenantKek(tenantKeyId(tenantId), kek);
  return kek;
}

/** Ensure the tenant's KEK is registered in the sync provider (idempotent). */
export async function loadTenantKekIntoProvider(tenantId) {
  const kek = await getTenantKek(tenantId);
  const kid = tenantKeyId(tenantId);
  const provider = getKekProvider();
  if (!provider.hasKek(kid)) provider.registerTenantKek(kid, kek);
  return kek;
}

/**
 * Crypto-shred a tenant: drop the wrapped KEK material + retire the row, and
 * evict it from every cache. The tenant's ciphertext is now unrecoverable.
 */
export async function cryptoShredTenant(tenantId) {
  await prisma.$executeRawUnsafe(
    `UPDATE encryption_keys SET status = 'compromised', wrapped_key_material = NULL, updated_at = NOW()
      WHERE tenant_id = $1::uuid AND key_id = $2`,
    tenantId, tenantKeyId(tenantId),
  );
  _tenantKekCache.delete(tenantId);
  getKekProvider().evictKek(tenantKeyId(tenantId));
}

/** Preload every active tenant KEK into the sync provider (call at startup). */
export async function preloadAllTenantKeks() {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT tenant_id, wrapped_key_material FROM encryption_keys
      WHERE provider = 'local-tenant' AND status = 'active' AND wrapped_key_material IS NOT NULL`,
  );
  let loaded = 0;
  for (const row of rows) {
    try {
      const kek = unwrapUnderMaster(row.wrapped_key_material);
      _tenantKekCache.set(row.tenant_id, kek);
      getKekProvider().registerTenantKek(tenantKeyId(row.tenant_id), kek);
      loaded += 1;
    } catch {
      // Unreadable under the current master KEK — skip rather than crash startup.
    }
  }
  return loaded;
}

/** Test hook — clear the in-process caches. */
export function resetTenantKekCacheForTesting() {
  _tenantKekCache.clear();
  _cachedMaster = null;
}

export default {
  tenantKeyId,
  provisionTenantKek,
  getTenantKek,
  loadTenantKekIntoProvider,
  cryptoShredTenant,
  preloadAllTenantKeks,
};
