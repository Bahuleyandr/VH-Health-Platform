import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';

// Per-tenant feature flag for composition-based drug search (Phase 2).
// Mirrors src/services/featureFlags/featureFlagService.js: an in-memory Map
// cache with a 60s TTL, guarded refresh that logs + degrades on failure, and a
// synchronous cache update on every write so a flip is observable immediately.

const enabledCache = new Map(); // tenant_id (string) -> boolean
let lastRefresh = 0;
const REFRESH_INTERVAL_MS = 60 * 1000; // 60 seconds

/**
 * Reload the enabled state for every tenant that currently has a settings row.
 * Never throws — during a staggered deploy the table may not exist yet, in which
 * case the cache stays empty and every tenant degrades to `false`.
 */
async function refreshCache() {
  try {
    const rows = await prisma.$queryRawUnsafe(`
      SELECT tenant_id, enabled
      FROM composition_search_settings
    `);
    enabledCache.clear();
    for (const row of rows) {
      enabledCache.set(String(row.tenant_id), row.enabled === true);
    }
    lastRefresh = Date.now();
    logger.info(`Composition-search flag cache refreshed: ${rows.length} tenant(s) loaded`);
  } catch (err) {
    // Table missing (staggered deploy) or transient DB error — degrade to
    // "no tenant enabled" rather than crash the read path.
    logger.warn(`Composition-search flag cache refresh failed: ${err.message}`);
  }
}

async function ensureCache() {
  if (Date.now() - lastRefresh > REFRESH_INTERVAL_MS) {
    await refreshCache();
  }
}

/**
 * Is composition-based drug search enabled for this tenant?
 * Returns false for a falsy tenantId, when no row / enabled=false, or when the
 * query fails (never throws — the caller treats false as "feature off").
 * @param {string|null|undefined} tenantId
 * @returns {Promise<boolean>}
 */
export async function isCompositionSearchEnabled(tenantId) {
  if (!tenantId) return false;
  try {
    await ensureCache();
    return enabledCache.get(String(tenantId)) === true;
  } catch (err) {
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

  // Update cache immediately so an immediate read observes the flip.
  enabledCache.set(String(tenantId), enabledBool);
  logger.info(`Composition-search flag set: tenant=${tenantId} enabled=${enabledBool}`);
  return rows[0];
}
