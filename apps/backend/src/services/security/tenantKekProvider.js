// src/services/security/tenantKekProvider.js
//
// W3 (multi-tenancy program) WS5 — per-tenant Key-Encryption-Keys.
//
// Envelope: master KEK -> per-tenant KEK -> per-record DEK -> data.
//   - The master KEK is derived (scrypt) from FIELD_ENCRYPTION_MASTER_KEK.
//   - Each tenant gets a RANDOM 32-byte KEK, stored wrapped (AES-256-GCM under
//     the master KEK) as encryption_keys.wrapped_key_material with a VERSIONED
//     key id `t:<tenantId>:v<n>` (v1 for the first one).
//   - Crypto-shred = drop the wrapped_key_material of every version -> that
//     tenant's ciphertext is unrecoverable; every other tenant is untouched.
//
// Random (not derived) per-tenant keys are what make crypto-shred meaningful —
// a derived key could always be re-derived from the master + tenantId.
//
// === Versioning (why a key id is never reused) ===
// The key id is stamped into every enc:v2 payload, so a key id must denote the
// same key material forever: replacing the material behind `t:<tenant>:v1`
// would strand every payload already wrapped under the old key. Migration 672's
// `payroll_tenant_kek_replacement_guard` enforces that at the database — tenant
// KEK material may only ever be CLEARED (the shred), never replaced or refilled.
//
// So re-provisioning never writes over an existing row; it INSERTs the next
// version:
//
//     v1 active ──crypto-shred──▶ v1 retired (material NULL)
//                                      │
//                                      └─ provision ─▶ v2 active (rotated_from = v1)
//
//   - NEW writes are wrapped under the highest ACTIVE version.
//   - READS use the version stamped in the payload, so payloads written under an
//     older, still-active version keep decrypting (that is what makes a real,
//     non-destructive rotation possible later).
//   - Payloads written under a SHREDDED version stay unrecoverable — the point.
//
// The KEK provider (fieldKeyProvider.LocalKekProvider) is synchronous, but
// loading a tenant KEK is async (DB). So we load + unwrap here, then REGISTER the
// raw KEK into the provider's in-process map under its keyId; the sync
// encrypt/decrypt path then wraps/unwraps tenant DEKs by keyId. Call
// preloadAllTenantKeks() at startup (or loadTenantKekIntoProvider per tenant)
// before encrypting/decrypting tenant-scoped ciphertext.

import crypto from 'crypto';
import prisma from '../../lib/prisma.js';
import { getKekProvider, parseTenantKeyId } from '../../utils/fieldKeyProvider.js';

const KEK_LENGTH = 32;
const WRAP_IV_LENGTH = 12;
const MASTER_KDF_SALT = 'vh-field-master-kek-v1';
const MAX_PROVISION_ATTEMPTS = 3;

let _cachedMaster = null;
const _tenantKekCache = new Map(); // tenantId -> { keyId, version, kek }

function masterKek() {
  if (_cachedMaster) return _cachedMaster;
  const material = process.env.FIELD_ENCRYPTION_MASTER_KEK;
  if (!material) {
    throw new Error('FIELD_ENCRYPTION_MASTER_KEK must be set for per-tenant field-encryption KEKs');
  }
  _cachedMaster = crypto.scryptSync(String(material), MASTER_KDF_SALT, KEK_LENGTH);
  return _cachedMaster;
}

/**
 * The encryption_keys.key_id for one version of a tenant's KEK. Version 1 is the
 * id every pre-versioning payload carries, so it stays the default.
 */
export function tenantKeyId(tenantId, version = 1) {
  return `t:${tenantId}:v${version}`;
}

/** Split `t:<tenantId>:v<n>` back into its parts (null if it is not one). */
export { parseTenantKeyId };

function versionOf(keyId) {
  return parseTenantKeyId(keyId)?.version ?? 0;
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
 * Every `t:<tenantId>:v<n>` row for a tenant, highest version first — including
 * retired/shredded ones, because a burnt version number must never be reissued.
 */
async function listTenantKekVersions(tenantId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, key_id, status, wrapped_key_material
       FROM encryption_keys
      WHERE tenant_id = $1::uuid
        AND key_id ~ ('^t:' || tenant_id::text || ':v[0-9]+$')
      ORDER BY (substring(key_id from '^t:.+:v([0-9]+)$'))::int DESC`,
    tenantId,
  );
  return rows.map(row => ({ ...row, version: versionOf(row.key_id) }));
}

/** The highest version that can actually wrap/unwrap today. */
function pickUsableVersion(versions) {
  return versions.find(row => row.status === 'active' && row.wrapped_key_material) || null;
}

function cacheAndRegister(tenantId, keyId, kek) {
  _tenantKekCache.set(tenantId, { keyId, version: versionOf(keyId), kek });
  getKekProvider().registerTenantKek(keyId, kek);
  return kek;
}

/**
 * Provision a tenant KEK and register it for immediate use.
 *
 * Idempotent: if the tenant already has a usable active version this REUSES it —
 * material is never replaced, because the key id is stamped into ciphertext that
 * already exists. If there is no usable version (never provisioned, or every
 * version was crypto-shredded) it allocates the NEXT version number and inserts
 * a fresh random key, so a shredded tenant can be re-provisioned without ever
 * resurrecting a burnt key id. This is the only sanctioned re-provision path;
 * `scripts/onboard-tenant.mjs` re-run is its operator entry point.
 */
export async function provisionTenantKek(tenantId, { attempt = 1 } = {}) {
  const versions = await listTenantKekVersions(tenantId);
  const usable = pickUsableVersion(versions);
  if (usable) {
    const kek = unwrapUnderMaster(usable.wrapped_key_material);
    cacheAndRegister(tenantId, usable.key_id, kek);
    return { tenantId, keyId: usable.key_id, version: usable.version, provisioned: false };
  }

  const predecessor = versions[0] || null; // highest version ever allocated, shredded or not
  const version = (predecessor?.version ?? 0) + 1;
  const kid = tenantKeyId(tenantId, version);
  const kek = crypto.randomBytes(KEK_LENGTH);
  const wrapped = wrapUnderMaster(kek);
  const inserted = await prisma.$queryRawUnsafe(
    `INSERT INTO encryption_keys
       (tenant_id, key_id, provider, algorithm, status, wrapped_key_material,
        rotated_from, activated_at, created_at, updated_at)
     VALUES ($1::uuid, $2, 'local-tenant', 'aes-256-gcm', 'active', $3, $4::int, NOW(), NOW(), NOW())
     ON CONFLICT (tenant_id, key_id) DO NOTHING
     RETURNING key_id`,
    tenantId, kid, wrapped, predecessor?.id ?? null,
  );
  if (inserted.length === 0) {
    // Another process allocated this version first. Never overwrite it — go back
    // and either reuse what it wrote or allocate the version after it.
    kek.fill(0);
    if (attempt >= MAX_PROVISION_ATTEMPTS) {
      throw new Error(
        `Tenant ${tenantId} KEK provisioning lost ${MAX_PROVISION_ATTEMPTS} races on ${kid}`,
      );
    }
    return provisionTenantKek(tenantId, { attempt: attempt + 1 });
  }
  cacheAndRegister(tenantId, kid, kek);
  return { tenantId, keyId: kid, version, provisioned: true };
}

/**
 * Load (and cache + register) a tenant's current KEK: the highest active
 * version. Throws if there is none (never provisioned, or crypto-shredded).
 */
export async function loadTenantKek(tenantId) {
  const cached = _tenantKekCache.get(tenantId);
  if (cached) return { keyId: cached.keyId, kek: cached.kek };
  const usable = pickUsableVersion(await listTenantKekVersions(tenantId));
  if (!usable) {
    throw new Error(`No active KEK for tenant ${tenantId} (provision it, or it was crypto-shredded)`);
  }
  const kek = unwrapUnderMaster(usable.wrapped_key_material);
  cacheAndRegister(tenantId, usable.key_id, kek);
  return { keyId: usable.key_id, kek };
}

/** The raw 32-byte KEK a tenant's new writes are wrapped under. */
export async function getTenantKek(tenantId) {
  return (await loadTenantKek(tenantId)).kek;
}

/**
 * The key id new writes for this tenant must be stamped with — loading it if the
 * sync provider has not seen it yet. Callers compare ciphertext key ids against
 * this instead of assuming v1.
 */
export async function activeTenantKeyId(tenantId) {
  return (await loadTenantKek(tenantId)).keyId;
}

/** Ensure the tenant's KEK is registered in the sync provider (idempotent). */
export async function loadTenantKekIntoProvider(tenantId) {
  const { keyId, kek } = await loadTenantKek(tenantId);
  const provider = getKekProvider();
  if (!provider.hasKek(keyId)) provider.registerTenantKek(keyId, kek);
  return { keyId, kek };
}

/**
 * Crypto-shred a tenant: drop the wrapped KEK material of EVERY version + retire
 * the rows, and evict them from every cache. The tenant's ciphertext is now
 * unrecoverable. Re-provisioning afterwards allocates the next version — it
 * never refills these rows (migration 672 refuses that at the database).
 */
export async function cryptoShredTenant(tenantId) {
  const shredded = await prisma.$queryRawUnsafe(
    `UPDATE encryption_keys
        SET status = 'compromised', wrapped_key_material = NULL,
            retired_at = NOW(), updated_at = NOW()
      WHERE tenant_id = $1::uuid
        AND key_id ~ ('^t:' || tenant_id::text || ':v[0-9]+$')
      RETURNING key_id`,
    tenantId,
  );
  _tenantKekCache.delete(tenantId);
  const provider = getKekProvider();
  for (const row of shredded) provider.evictKek(row.key_id);
  // Belt and braces for a provider that was registered from a payload key id we
  // never saw in the table (and for the v1-only callers that predate versioning).
  provider.evictKek(tenantKeyId(tenantId));
  return shredded.map(row => row.key_id);
}

/**
 * Preload every active tenant KEK into the sync provider (call at startup).
 * Registers each row under its OWN key id, so older still-active versions stay
 * unwrappable while new writes use the highest one.
 */
export async function preloadAllTenantKeks() {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT tenant_id, key_id, wrapped_key_material FROM encryption_keys
      WHERE provider = 'local-tenant' AND status = 'active' AND wrapped_key_material IS NOT NULL
        AND key_id ~ ('^t:' || tenant_id::text || ':v[0-9]+$')
      ORDER BY (substring(key_id from '^t:.+:v([0-9]+)$'))::int ASC`,
  );
  let loaded = 0;
  for (const row of rows) {
    try {
      const kek = unwrapUnderMaster(row.wrapped_key_material);
      // Rows arrive version-ascending, so the last write per tenant is the
      // highest version — the one new writes must be stamped with.
      cacheAndRegister(row.tenant_id, row.key_id, kek);
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
  parseTenantKeyId,
  provisionTenantKek,
  getTenantKek,
  loadTenantKek,
  activeTenantKeyId,
  loadTenantKekIntoProvider,
  cryptoShredTenant,
  preloadAllTenantKeks,
};
