// apps/backend/src/services/featureFlags/featureFlagService.js
//
// ★ THIS SERVICE IS INERT. FLIPPING A FLAG CHANGES NO RUNTIME BEHAVIOUR. ★
//
// `isEnabled()` below is the only function that could gate anything, and it
// has ZERO call sites in the product (the `isEnabled(` hits elsewhere in the
// tree belong to utils/websocket/wsRedisAdapter.js, an unrelated local
// function). So the whole chain — the `feature_flags` table (migration 148),
// the SUPER_ADMIN CRUD routes in routes/admin/featureFlagRoutes.js, and the
// /dashboard/feature-flags console in the admin portal — reads and writes a
// row that nothing consults. An operator reaching for it mid-incident gets a
// silent no-op.
//
// THAT IS THE DELIBERATE END STATE, NOT AN OVERSIGHT WAITING FOR WIRING.
// Two migrations already rejected this table by name when they needed a real
// runtime switch:
//   - 429_patient_flow_kiosk_settings.sql: "...fail-closed, and never use the
//     global feature_flags table."
//   - 351_composition_search_settings.sql: "The global feature_flags table is
//     insufficient: coverage/readiness differ per <tenant>."
// The reason is structural: `feature_flags` has NO tenant column and a
// process-wide cache, so one tenant's toggle would change every tenant's
// behaviour. Every switch the product actually wants is per-tenant, and the
// platform grew three purpose-built, tenant-scoped mechanisms instead —
// entitlements (services/entitlements/entitlementService.js), per-domain
// settings tables (engagement_settings.enabled / .emergency_stop, kiosk
// settings, composition-search settings), and env/config kill switches for
// infrastructure. There is no flag left for this table to own.
//
// The console is therefore queued for RETIREMENT, not for wiring; the decision,
// the file list and the ordering constraints are recorded in docs/ROADMAP.md
// ("Feature-flag console + `feature_flags` table"). Retirement spans the admin
// portal, the admin route module and the entitlement catalog, none of which
// this module may edit, so until that lands the honest thing this module can do
// is refuse to imply an effect it does not have:
//   - every row `getFlags()` returns is stamped `inert: true`,
//     `runtime_effect: 'none'` and a `runtime_note` naming this file;
//   - a cache refresh that finds any rows warns that they gate nothing;
//   - an upsert warns, at the moment the operator flips something, that the
//     flip is a no-op.
//
// DO NOT "fix" the inertness by adding an isEnabled() gate to a working code
// path. The table ships empty (no migration seeds a row), so any new gate would
// consult a missing flag and — with isEnabled()'s unknown-flag-is-false
// semantics — turn a feature OFF for every tenant on deploy. If a genuine
// runtime switch is needed, add a tenant-scoped one next to the feature it
// governs, the way 351 and 429 did.

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';

// In-memory cache
const flagCache = new Map();
let lastRefresh = 0;
const REFRESH_INTERVAL_MS = 60 * 1000; // 60 seconds

/**
 * Flag names that a real code path consults via `isEnabled()`.
 *
 * Empty on purpose — see the header. This list is the single place to look to
 * answer "does flipping X do anything?", and the only reason a flag may claim
 * `inert: false`. If you ever wire a gate, add its name here in the same commit
 * so the console stops calling it inert.
 */
export const WIRED_FEATURE_FLAGS = Object.freeze([]);

const INERT_RUNTIME_NOTE =
  'No code path consults this flag. Toggling it changes no runtime behaviour. '
  + 'See services/featureFlags/featureFlagService.js and the retirement entry in docs/ROADMAP.md.';

let inertWarningLogged = false;

/**
 * Annotate a stored row with its true runtime effect. Applied on read only —
 * the cache keeps raw rows so `isEnabled()` semantics are untouched.
 */
function withRuntimeStatus(row) {
  const wired = WIRED_FEATURE_FLAGS.includes(row?.name);
  return {
    ...row,
    inert: !wired,
    runtime_effect: wired ? 'gated' : 'none',
    ...(wired ? {} : { runtime_note: INERT_RUNTIME_NOTE }),
  };
}

async function refreshCache() {
  try {
    const rows = await prisma.$queryRawUnsafe(`
      SELECT id, name, enabled, enabled AS is_enabled, description,
             rollout_percentage, allowed_roles, created_at, updated_at
      FROM feature_flags
      ORDER BY name
    `);
    flagCache.clear();
    for (const row of rows) {
      flagCache.set(row.name, row);
    }
    lastRefresh = Date.now();
    logger.info(`Feature flag cache refreshed: ${rows.length} flags loaded`);

    // Say it plainly, once per process, at the moment there is something to be
    // wrong about: rows exist and nothing reads them.
    const unwired = rows.filter((row) => !WIRED_FEATURE_FLAGS.includes(row.name));
    if (unwired.length > 0 && !inertWarningLogged) {
      inertWarningLogged = true;
      logger.warn(
        `Feature flag console is inert: ${unwired.length} flag(s) are stored but no code path `
        + `consults them (${unwired.map((row) => row.name).join(', ')}). `
        + 'Toggling them changes no runtime behaviour — see docs/ROADMAP.md.',
      );
    }
  } catch (err) {
    logger.error(`Feature flag cache refresh failed: ${err.message}`);
  }
}

async function ensureCache() {
  if (Date.now() - lastRefresh > REFRESH_INTERVAL_MS) {
    await refreshCache();
  }
}

/**
 * Check if a feature flag is enabled for a given user context.
 *
 * ★ NO CALLERS. Retained as the mechanism a future tenant-scoped replacement
 * would model itself on, and because the admin console's contract test mocks
 * this export. Behaviour is deliberately unchanged: an unknown flag is
 * `false`, so wiring this into an existing working path would disable that
 * path on deploy (the table ships empty). Read the header before you do.
 *
 * @param {string} flagName
 * @param {{ role?: string, id?: number }} [userContext]
 * @returns {Promise<boolean>}
 */
export async function isEnabled(flagName, userContext = null) {
  await ensureCache();

  const flag = flagCache.get(flagName);
  if (!flag || !flag.enabled) return false;

  // Role check — if allowed_roles is non-empty, user must have a matching role
  if (flag.allowed_roles && flag.allowed_roles.length > 0 && userContext?.role) {
    if (!flag.allowed_roles.includes(userContext.role)) {
      return false;
    }
  }

  // Rollout percentage check — deterministic per user id
  if (flag.rollout_percentage < 100 && userContext?.id) {
    const bucket = userContext.id % 100;
    if (bucket >= flag.rollout_percentage) {
      return false;
    }
  }

  return true;
}

/**
 * Get all feature flags.
 *
 * Each row carries `inert` / `runtime_effect` / `runtime_note` so the response
 * body states, in itself, whether the flag gates anything. Every row is
 * currently inert (`WIRED_FEATURE_FLAGS` is empty).
 *
 * @returns {Promise<object[]>}
 */
export async function getFlags() {
  await ensureCache();
  return Array.from(flagCache.values()).map((row) => withRuntimeStatus(row));
}

/**
 * Create or update a feature flag.
 * @param {string} name
 * @param {{ description?: string, enabled?: boolean, rollout_percentage?: number, allowed_roles?: string[] }} data
 * @returns {Promise<object>}
 */
export async function setFlag(name, data) {
  const { description = null, enabled = false, rollout_percentage = 100, allowed_roles = [] } = data;

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO feature_flags (name, description, enabled, rollout_percentage, allowed_roles, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (name)
     DO UPDATE SET
       description = COALESCE($2, feature_flags.description),
       enabled = $3,
       rollout_percentage = $4,
       allowed_roles = $5,
       updated_at = NOW()
     RETURNING id, name, enabled, enabled AS is_enabled, description,
               rollout_percentage, allowed_roles, created_at, updated_at`,
    name, description, enabled, rollout_percentage, allowed_roles
  );

  // Update cache immediately
  flagCache.set(name, rows[0]);
  logger.info(`Feature flag upserted: ${name} (enabled=${enabled})`);
  if (!WIRED_FEATURE_FLAGS.includes(name)) {
    logger.warn(
      `Feature flag "${name}" has no runtime consumer — this change is a no-op. `
      + 'The feature_flags console is inert; see docs/ROADMAP.md.',
    );
  }
  return withRuntimeStatus(rows[0]);
}

/**
 * Delete a feature flag by name.
 * @param {string} name
 * @returns {Promise<boolean>}
 */
export async function deleteFlag(name) {
  const deleted = await prisma.$executeRawUnsafe('DELETE FROM feature_flags WHERE name = $1', name);
  flagCache.delete(name);
  logger.info(`Feature flag deleted: ${name}`);
  return deleted > 0;
}
