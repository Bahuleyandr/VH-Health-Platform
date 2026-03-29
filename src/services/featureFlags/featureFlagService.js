import db from '../../config/database.js';
import logger from '../../logging/logger.js';

// In-memory cache
const flagCache = new Map();
let lastRefresh = 0;
const REFRESH_INTERVAL_MS = 60 * 1000; // 60 seconds

async function refreshCache() {
  try {
    const { rows } = await db.query('SELECT * FROM feature_flags');
    flagCache.clear();
    for (const row of rows) {
      flagCache.set(row.name, row);
    }
    lastRefresh = Date.now();
    logger.info(`Feature flag cache refreshed: ${rows.length} flags loaded`);
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
 * @returns {Promise<object[]>}
 */
export async function getFlags() {
  await ensureCache();
  return Array.from(flagCache.values());
}

/**
 * Create or update a feature flag.
 * @param {string} name
 * @param {{ description?: string, enabled?: boolean, rollout_percentage?: number, allowed_roles?: string[] }} data
 * @returns {Promise<object>}
 */
export async function setFlag(name, data) {
  const { description = null, enabled = false, rollout_percentage = 100, allowed_roles = [] } = data;

  const { rows } = await db.query(
    `INSERT INTO feature_flags (name, description, enabled, rollout_percentage, allowed_roles, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (name)
     DO UPDATE SET
       description = COALESCE($2, feature_flags.description),
       enabled = $3,
       rollout_percentage = $4,
       allowed_roles = $5,
       updated_at = NOW()
     RETURNING *`,
    [name, description, enabled, rollout_percentage, allowed_roles]
  );

  // Update cache immediately
  flagCache.set(name, rows[0]);
  logger.info(`Feature flag upserted: ${name} (enabled=${enabled})`);
  return rows[0];
}

/**
 * Delete a feature flag by name.
 * @param {string} name
 * @returns {Promise<boolean>}
 */
export async function deleteFlag(name) {
  const { rowCount } = await db.query('DELETE FROM feature_flags WHERE name = $1', [name]);
  flagCache.delete(name);
  logger.info(`Feature flag deleted: ${name}`);
  return rowCount > 0;
}
