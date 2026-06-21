/**
 * Compliance dashboard aggregator (Phase E1).
 *
 * Pulls a single read-only snapshot for the admin compliance UI:
 *   - data_processing_activities counts grouped by lawful_basis
 *   - DPIA pending list (dpia_required = true AND dpia_completed_at IS NULL)
 *   - breach incidents grouped by severity + status
 *   - breaches awaiting regulator notification (high/critical, no
 *     regulator_notified_at) — surfaces the GDPR Art. 33 72h clock
 *   - gdpr_erasure_log + legal_holds counts (when those tables exist)
 *
 * Every read is best-effort; missing schemas degrade to zeroes so the
 * dashboard renders even on partially-migrated environments.
 */

import prisma from '../../lib/prisma.js';
import { requireTenantId } from '../tenant/tenantService.js';

function resolveTenantId(options = {}) {
  return requireTenantId(options.tenantId);
}

function isMissingSchemaError(err) {
  return /does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

async function safeQuery(sql, params, fallback) {
  try {
    return await prisma.$queryRawUnsafe(sql, ...params);
  } catch (err) {
    if (isMissingSchemaError(err)) return fallback;
    throw err;
  }
}

export async function getComplianceDashboard({ tenantId = null } = {}) {
  const tid = resolveTenantId({ tenantId });

  const dpaByLawful = await safeQuery(
    `SELECT lawful_basis, COUNT(*)::int AS count
     FROM data_processing_activities
     WHERE tenant_id = $1::uuid AND status = 'active'
     GROUP BY lawful_basis
     ORDER BY lawful_basis`,
    [tid],
    [],
  );

  const dpiaPending = await safeQuery(
    `SELECT id, activity_code, display_name
     FROM data_processing_activities
     WHERE tenant_id = $1::uuid AND dpia_required = true
       AND dpia_completed_at IS NULL AND status = 'active'
     ORDER BY display_name
     LIMIT 50`,
    [tid],
    [],
  );

  const breachBySeverity = await safeQuery(
    `SELECT severity, status, COUNT(*)::int AS count
     FROM data_breaches
     GROUP BY severity, status
     ORDER BY severity, status`,
    [],
    [],
  );

  // Breaches that have crossed the discovery threshold but have no
  // regulator notification recorded — Art. 33 says 72 hours.
  const regulatorNotificationsPending = await safeQuery(
    `SELECT breach_id, severity, discovered_at,
            EXTRACT(EPOCH FROM (NOW() - discovered_at))/3600 AS hours_since_discovery
     FROM data_breaches
     WHERE severity IN ('high', 'critical')
       AND regulator_notified_at IS NULL
       AND status NOT IN ('resolved', 'notified')
     ORDER BY discovered_at ASC
     LIMIT 50`,
    [],
    [],
  );

  const erasureCounts = await safeQuery(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')::int AS last_30d
     FROM gdpr_erasure_log
     WHERE tenant_id = $1::uuid`,
    [tid],
    [{ total: 0, last_30d: 0 }],
  );

  const legalHolds = await safeQuery(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE released_at IS NULL)::int AS active
     FROM legal_holds
     WHERE tenant_id = $1::uuid`,
    [tid],
    [{ total: 0, active: 0 }],
  );

  return {
    data_processing_activities: {
      by_lawful_basis: dpaByLawful,
      dpia_pending: dpiaPending,
      dpia_pending_count: dpiaPending.length,
    },
    breach_incidents: {
      by_severity_status: breachBySeverity,
      regulator_notifications_pending: regulatorNotificationsPending,
      regulator_notifications_pending_count: regulatorNotificationsPending.length,
    },
    gdpr_erasure: erasureCounts[0] || { total: 0, last_30d: 0 },
    legal_holds: legalHolds[0] || { total: 0, active: 0 },
    generated_at: new Date().toISOString(),
  };
}

export default { getComplianceDashboard };
