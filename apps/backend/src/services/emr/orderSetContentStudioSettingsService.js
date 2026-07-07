import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';

const REFRESH_INTERVAL_MS = 60 * 1000;
const enabledCache = new Map();

export async function isContentStudioEnabled(tenantId) {
  if (!tenantId) return false;
  const key = String(tenantId);
  const cached = enabledCache.get(key);
  if (cached && Date.now() - cached.fetchedAt <= REFRESH_INTERVAL_MS) {
    return cached.value;
  }

  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT enabled FROM content_studio_settings WHERE tenant_id = $1::uuid`,
      tenantId,
    );
    const value = rows[0]?.enabled === true;
    enabledCache.set(key, { value, fetchedAt: Date.now() });
    return value;
  } catch (err) {
    logger.warn(`isContentStudioEnabled failed for tenant ${tenantId}: ${err.message}`);
    return false;
  }
}

export async function setContentStudioEnabled(
  tenantId,
  enabled,
  { actorUid = null, snapshot = null } = {},
) {
  if (!tenantId) {
    throw new Error('setContentStudioEnabled requires a tenantId');
  }

  const enabledBool = enabled === true;
  const snapshotJson = snapshot == null ? null : JSON.stringify(snapshot);
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO content_studio_settings
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
       enabled_at = CASE WHEN $2 THEN NOW() ELSE content_studio_settings.enabled_at END,
       enabled_by = CASE WHEN $2 THEN $3::uuid ELSE content_studio_settings.enabled_by END,
       acceptance_snapshot = CASE WHEN $2 THEN $4::jsonb ELSE content_studio_settings.acceptance_snapshot END,
       updated_at = NOW()
     RETURNING tenant_id, enabled, enabled_at, enabled_by, acceptance_snapshot,
               created_at, updated_at`,
    tenantId,
    enabledBool,
    actorUid,
    snapshotJson,
  );

  enabledCache.set(String(tenantId), { value: enabledBool, fetchedAt: Date.now() });
  logger.info(`Content-studio flag set: tenant=${tenantId} enabled=${enabledBool}`);
  return rows[0];
}

export function __clearContentStudioSettingsCacheForTests() {
  enabledCache.clear();
}
