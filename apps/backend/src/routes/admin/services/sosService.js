// src/routes/admin/services/sosService.js
//
// Read models for the admin SOS console (/api/v1/admin/sos/*).
//
// Audit F1: every function here used to be fake. The three mutators were
// log-only stubs that returned success without touching a table, and all four
// readers ran SQL that could not execute against this schema — sos_alerts has no
// is_test_alert / user_uid / notes / description / address column, its statuses
// are uppercase, and neither emergency_services nor sos_services exists. Every
// one of those queries threw and was swallowed by safeQuery, so the console
// rendered zeros and empty tables as if they were readings.
//
// The mutators now live in services/sosService.js, shared with the sosController
// surface at /api/v1/sos/admin/*. What remains is reads, executed directly (a
// failed read must surface as a 500, never as a plausible zero) and scoped with
// an explicit tenant predicate — provable in every environment, unlike RLS,
// which is off outside production.
import prisma from '../../../lib/prisma.js';

/**
 * Aggregated SOS alert metrics for one tenant:
 * totalAlerts, activeAlerts, resolvedAlerts, cancelledAlerts,
 * severityCounts {critical, high, medium, low}, last24Hours,
 * last7Days: array of { date, count }.
 *
 * Severity and status are compared case-insensitively: patient-app alerts store
 * lowercase values (config/sosConfig.js SOS_SEVERITY) while the column default
 * and staff paths write uppercase.
 */
export async function getSosAnalytics(tenantId) {
  const core = await prisma.$queryRawUnsafe(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE UPPER(status) = 'ACTIVE')::int AS active,
       COUNT(*) FILTER (WHERE UPPER(status) = 'RESPONDING')::int AS responding,
       COUNT(*) FILTER (WHERE UPPER(status) IN ('RESOLVED','CLOSED'))::int AS resolved,
       COUNT(*) FILTER (WHERE UPPER(status) = 'CANCELLED')::int AS cancelled,
       COUNT(*) FILTER (WHERE UPPER(severity) = 'CRITICAL')::int AS critical,
       COUNT(*) FILTER (WHERE UPPER(severity) = 'HIGH')::int AS high,
       COUNT(*) FILTER (WHERE UPPER(severity) = 'MEDIUM')::int AS medium,
       COUNT(*) FILTER (WHERE UPPER(severity) = 'LOW')::int AS low,
       COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours')::int AS last24h
     FROM sos_alerts
     WHERE tenant_id = $1::uuid`,
    tenantId,
  );

  const row = core[0] || {};
  const trend = await prisma.$queryRawUnsafe(
    `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS date,
            COUNT(*)::int AS count
     FROM sos_alerts
     WHERE tenant_id = $1::uuid
       AND created_at >= CURRENT_DATE - INTERVAL '7 days'
     GROUP BY 1
     ORDER BY 1`,
    tenantId,
  );

  return {
    totalAlerts: row.total ?? 0,
    activeAlerts: row.active ?? 0,
    respondingAlerts: row.responding ?? 0,
    resolvedAlerts: row.resolved ?? 0,
    cancelledAlerts: row.cancelled ?? 0,
    severityCounts: {
      critical: row.critical ?? 0,
      high: row.high ?? 0,
      medium: row.medium ?? 0,
      low: row.low ?? 0,
    },
    last24Hours: row.last24h ?? 0,
    last7Days: trend,
  };
}

/**
 * Paginated SOS alerts for one tenant, newest first.
 * The users join is tenant-scoped too, so a patient name can never be resolved
 * across a tenant boundary.
 */
export async function getAllAlerts(tenantId, limit = 50, offset = 0) {
  return prisma.$queryRawUnsafe(
    `SELECT sa.id, sa.uid, sa.phone, sa.latitude, sa.longitude, sa.location_name,
            sa.alert_type, sa.severity, sa.status, sa.message,
            u.name AS patient_name,
            sa.raised_at, sa.created_at, sa.responded_at, sa.resolved_at
     FROM sos_alerts sa
     LEFT JOIN users u ON u.uid = sa.uid AND u.tenant_id = sa.tenant_id
     WHERE sa.tenant_id = $1::uuid
     ORDER BY sa.created_at DESC
     LIMIT $2 OFFSET $3`,
    tenantId, limit, offset,
  );
}

/**
 * Emergency services the console can direct responders to.
 *
 * `hospitals` is a global reference table with no tenant_id, so this is
 * deliberately not tenant-scoped. A hospital counts as usable for SOS only when
 * it is both active and flagged as offering emergency services.
 */
export async function getEmergencyServices() {
  return prisma.$queryRawUnsafe(
    `SELECT id, name, phone, address, latitude, longitude,
            'hospital' AS kind,
            (status = 'active' AND COALESCE(emergency_services, false)) AS enabled
     FROM hospitals
     ORDER BY name
     LIMIT 100`,
  );
}

/**
 * Responder timing for one tenant, in the milliseconds the console renders.
 * Acknowledgement is raised_at → responded_at; resolution is raised_at →
 * resolved_at. Milliseconds are returned as double precision, not bigint —
 * the BigInt JSON serializer only exists in bin/www.js, which tests never load.
 */
export async function getPerformanceReport(tenantId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT
       COUNT(*) FILTER (WHERE responded_at IS NOT NULL)::int AS total_acked,
       COUNT(*) FILTER (WHERE resolved_at IS NOT NULL)::int AS total_resolved,
       (AVG(EXTRACT(EPOCH FROM (responded_at - raised_at)) * 1000)
          FILTER (WHERE responded_at IS NOT NULL))::float8 AS average_ack_ms,
       (PERCENTILE_CONT(0.95) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (responded_at - raised_at)) * 1000)
          FILTER (WHERE responded_at IS NOT NULL))::float8 AS p95_ack_ms,
       (AVG(EXTRACT(EPOCH FROM (resolved_at - raised_at)) * 1000)
          FILTER (WHERE resolved_at IS NOT NULL))::float8 AS average_resolve_ms,
       (PERCENTILE_CONT(0.95) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (resolved_at - raised_at)) * 1000)
          FILTER (WHERE resolved_at IS NOT NULL))::float8 AS p95_resolve_ms
     FROM sos_alerts
     WHERE tenant_id = $1::uuid`,
    tenantId,
  );

  const row = rows[0] || {};
  return {
    totalAcked: row.total_acked ?? 0,
    totalResolved: row.total_resolved ?? 0,
    // null (not 0) when nothing has been acknowledged or resolved yet — the
    // console renders an em dash rather than claiming a zero-millisecond response.
    averageAckMs: row.average_ack_ms ?? null,
    p95AckMs: row.p95_ack_ms ?? null,
    averageResolveMs: row.average_resolve_ms ?? null,
    p95ResolveMs: row.p95_resolve_ms ?? null,
  };
}

export default {
  getSosAnalytics,
  getAllAlerts,
  getEmergencyServices,
  getPerformanceReport,
};
