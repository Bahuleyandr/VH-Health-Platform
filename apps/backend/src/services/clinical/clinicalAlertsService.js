// src/services/clinical/clinicalAlertsService.js
//
// Read-only hydration for the admin Clinical Alerts & Code Blue board. The
// live feed comes over WS (staff:clinical-alerts / staff:code-blue); this
// seeds recent history on page load because there is no other list endpoint
// for clinical_alerts. Tenant-scoped by explicit tenant_id filter.

import prisma from '../../lib/prisma.js';
import { requireTenantId } from '../tenant/tenantService.js';

/**
 * Recent vital-sign alerts for the requesting tenant, newest first.
 * Normalized to the staff:clinical-alerts WS payload shape (+ id/acknowledged)
 * so the frontend merges history and live events uniformly.
 */
export async function listRecentAlerts({ tenantId, hours, limit } = {}) {
  const tid = requireTenantId(tenantId);
  const h = Math.min(Math.max(Number(hours) || 8, 1), 72);       // default 8h, clamp 1..72
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 200);  // default 100, clamp 1..200

  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, patient_id, vital_name, vital_value, severity, message, acknowledged, created_at
       FROM clinical_alerts
      WHERE tenant_id = $1::uuid
        AND created_at > (now() - make_interval(hours => $2::int))
      ORDER BY created_at DESC
      LIMIT $3::int`,
    tid, h, lim,
  );

  return rows.map((r) => ({
    kind: 'vital-anomaly',
    id: Number(r.id),
    patientId: r.patient_id == null ? null : String(r.patient_id),
    vitalName: r.vital_name,
    value: r.vital_value == null ? null : Number(r.vital_value),
    unit: null, // clinical_alerts has no unit column; live WS events carry it
    severity: r.severity,
    message: r.message,
    acknowledged: !!r.acknowledged,
    at: r.created_at,
  }));
}
