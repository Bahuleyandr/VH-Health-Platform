import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';

// Per-tenant feature flag for composition-based drug search (Phase 2).
//
// The cache is keyed PER TENANT — never a global refresh. composition_search_settings
// carries RLS, so a global `SELECT ... FROM composition_search_settings` executed
// while an ambient tenant GUC is set (inside a setTenant/setTenantTx scope) would
// return only that one tenant's rows; a `.clear()`+repopulate off that result would
// then evict every OTHER tenant's cached entry and stamp a fresh TTL, so for the
// next 60s every other tenant would read `false` even when enabled — latent
// multi-tenant cache poisoning. A per-tenant `WHERE tenant_id = $1::uuid` lookup is
// correct regardless of the ambient GUC and, crucially, reading one tenant never
// evicts or mutates another tenant's entry.

const REFRESH_INTERVAL_MS = 60 * 1000; // 60 seconds
const enabledCache = new Map(); // tenant_id (string) -> { value: boolean, fetchedAt: number }

/**
 * Is composition-based drug search enabled for this tenant?
 * Returns false for a falsy tenantId, when no row / enabled=false, or when the
 * query fails (never throws — the caller treats false as "feature off").
 *
 * Options use the canonical `{ db, bypassCache }` shape:
 *  - `db`: the Prisma client to read through. Passing an interactive
 *    transaction client (`db !== prisma`) means the read sees that
 *    transaction's uncommitted snapshot, so it must neither be served from nor
 *    written to the process-wide cache.
 *  - `bypassCache`: force a fresh read (and suppress the cache write) even on
 *    the ambient client — used where the flag is required safety evidence
 *    rather than a search optimisation, so a stale 60s TTL can never decide a
 *    fail-closed gate.
 *
 * @param {string|null|undefined} tenantId
 * @param {{ db?: object, bypassCache?: boolean }} [opts]
 * @returns {Promise<boolean>}
 */
export async function isCompositionSearchEnabled(
  tenantId,
  { db = prisma, bypassCache = false } = {},
) {
  if (!tenantId) return false;
  const key = String(tenantId);
  const transactionalRead = db !== prisma;
  // Either reason alone is sufficient to keep this read off the cache: a
  // transactional read must not publish an uncommitted value to every other
  // caller, and an explicit bypassCache caller must not be served a stale one.
  const skipCache = bypassCache || transactionalRead;

  if (!skipCache) {
    const cached = enabledCache.get(key);
    if (cached && Date.now() - cached.fetchedAt <= REFRESH_INTERVAL_MS) {
      return cached.value;
    }
  }

  try {
    // Scope by tenant_id so the read is correct under any ambient RLS GUC and
    // can never touch another tenant's cache entry.
    const rows = await db.$queryRawUnsafe(
      `SELECT enabled FROM composition_search_settings WHERE tenant_id = $1::uuid`,
      tenantId,
    );
    const value = rows[0]?.enabled === true;
    if (!skipCache) {
      enabledCache.set(key, { value, fetchedAt: Date.now() });
    }
    return value;
  } catch (err) {
    // Table missing (staggered deploy) or transient DB error — fail closed and
    // do NOT cache, so the next call retries rather than pinning `false` for 60s.
    logger.warn(`isCompositionSearchEnabled failed for tenant ${tenantId}: ${err.message}`);
    return false;
  }
}

/**
 * Enable or disable composition-based drug search for a tenant.
 * Upserts on the tenant_id PK. When enabling, records the flip metadata:
 * enabled_at = NOW(), enabled_by = actorUid, acceptance_snapshot = snapshot.
 * When disabling, sets enabled = false but preserves the historical
 * enabled_at / enabled_by / acceptance_snapshot for the audit trail (the last
 * successful acceptance gate remains visible).
 * Updates the cache entry synchronously so a subsequent read observes the flip.
 * @param {string} tenantId
 * @param {boolean} enabled
 * @param {{ actorUid?: string|null, snapshot?: object|null }} [opts]
 * @returns {Promise<object>} the upserted row
 */
export async function setCompositionSearchEnabled(
  tenantId,
  enabled,
  { actorUid = null, snapshot = null } = {},
) {
  if (!tenantId) {
    throw new Error('setCompositionSearchEnabled requires a tenantId');
  }

  const enabledBool = enabled === true;
  const snapshotJson = snapshot == null ? null : JSON.stringify(snapshot);

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO composition_search_settings
       (tenant_id, enabled, enabled_at, enabled_by, acceptance_snapshot, updated_at)
     VALUES (
       $1::uuid,
       $2,
       CASE WHEN $2 THEN NOW() ELSE NULL END,
       CASE WHEN $2 THEN $3::uuid ELSE NULL END,
       CASE WHEN $2 THEN $4::jsonb ELSE NULL END,
       NOW()
     )
     ON CONFLICT (tenant_id) DO UPDATE SET
       enabled = $2,
       -- On enable: stamp fresh flip metadata. On disable: keep the historical
       -- acceptance snapshot/actor so the last accepted gate stays auditable.
       enabled_at = CASE WHEN $2 THEN NOW() ELSE composition_search_settings.enabled_at END,
       enabled_by = CASE WHEN $2 THEN $3::uuid ELSE composition_search_settings.enabled_by END,
       acceptance_snapshot = CASE WHEN $2 THEN $4::jsonb ELSE composition_search_settings.acceptance_snapshot END,
       updated_at = NOW()
     RETURNING tenant_id, enabled, enabled_at, enabled_by, acceptance_snapshot,
               created_at, updated_at`,
    tenantId,
    enabledBool,
    actorUid,
    snapshotJson,
  );

  // Update this tenant's cache entry immediately so an immediate read observes
  // the flip (never a global refresh — other tenants' entries are untouched).
  enabledCache.set(String(tenantId), { value: enabledBool, fetchedAt: Date.now() });
  logger.info(`Composition-search flag set: tenant=${tenantId} enabled=${enabledBool}`);
  return rows[0];
}
