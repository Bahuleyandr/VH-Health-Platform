// src/services/dashboards/snapshotService.js
//
// Direct snapshot queries for admin dashboard widgets.
// Aggregate tenant-owned source tables directly because the BI views do not
// expose tenant_id for request-time isolation.

import prisma from '../../lib/prisma.js';
import { requireTenantId } from '../tenant/tenantService.js';

function tenant(tenantId) {
  return requireTenantId(tenantId);
}

export async function getDailyOpsSnapshot({ tenantId } = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT
       CURRENT_DATE AS d,
       (SELECT COUNT(*)::int
          FROM appointments
         WHERE tenant_id = $1::uuid
           AND appointment_date = CURRENT_DATE) AS opd_today,
       (SELECT COUNT(*)::int
          FROM appointments
         WHERE tenant_id = $1::uuid
           AND appointment_date = CURRENT_DATE
           AND UPPER(status) IN ('COMPLETED','CHECKED_OUT')) AS opd_completed_today,
       (SELECT COUNT(*)::int
          FROM admissions
         WHERE tenant_id = $1::uuid
           AND LOWER(status) = 'admitted') AS ip_in_house,
       (SELECT COUNT(*)::int
          FROM ot_schedules
         WHERE tenant_id = $1::uuid
           AND scheduled_date = CURRENT_DATE
           AND LOWER(status) NOT IN ('cancelled')) AS or_cases_today,
       (SELECT COUNT(*)::int
         FROM lab_critical_alerts
         WHERE tenant_id = $1::uuid
           AND acknowledged_at IS NULL
           AND superseded_at IS NULL) AS open_critical_alerts,
       (SELECT COALESCE(SUM(amount), 0)
          FROM billing_payments
         WHERE tenant_id = $1::uuid
           AND collected_at::date = CURRENT_DATE
           AND reversed = false) AS collections_today,
       (SELECT COUNT(*)::int
          FROM insurance_preauth
         WHERE tenant_id = $1::uuid
           AND LOWER(status) = 'submitted') AS preauth_pending,
       (SELECT COUNT(*)::int
          FROM tpa_claims
         WHERE tenant_id = $1::uuid
           AND LOWER(status) IN ('submitted','queried')) AS claims_outstanding`,
    tenant(tenantId),
  );
  return rows[0] || null;
}

export async function getOpdDaily({ tenantId, from, to, doctor_id }) {
  const fromD = from || new Date(Date.now() - 14 * 86400 * 1000).toISOString().split('T')[0];
  const toD = to || new Date().toISOString().split('T')[0];
  const params = [tenant(tenantId), fromD, toD];
  let where = `tenant_id = $1::uuid AND appointment_date BETWEEN $2::date AND $3::date`;
  if (doctor_id) {
    params.push(Number(doctor_id));
    where += ` AND doctor_id = $${params.length}::int`;
  }
  return prisma.$queryRawUnsafe(
    `SELECT appointment_date AS d,
            doctor_id,
            doctor_name,
            COUNT(*)::int AS total_appointments,
            SUM(CASE WHEN UPPER(status) IN ('COMPLETED','CHECKED_OUT') THEN 1 ELSE 0 END)::int AS completed,
            SUM(CASE WHEN UPPER(status) IN ('NO_SHOW','MISSED') THEN 1 ELSE 0 END)::int AS no_shows,
            SUM(CASE WHEN UPPER(status) = 'CANCELLED' THEN 1 ELSE 0 END)::int AS cancelled,
            ROUND(
              100.0 * SUM(CASE WHEN UPPER(status) IN ('NO_SHOW','MISSED') THEN 1 ELSE 0 END) /
              NULLIF(COUNT(*), 0), 1
            ) AS no_show_rate_pct
       FROM appointments
      WHERE ${where}
      GROUP BY appointment_date, doctor_id, doctor_name
      ORDER BY d DESC, doctor_name`,
    ...params,
  );
}

export async function getIpOccupancy({ tenantId, from, to, ward }) {
  const fromD = from || new Date(Date.now() - 14 * 86400 * 1000).toISOString().split('T')[0];
  const toD = to || new Date().toISOString().split('T')[0];
  const params = [tenant(tenantId), fromD, toD];
  let where = `a.tenant_id = $1::uuid AND d::date BETWEEN $2::date AND $3::date`;
  if (ward) {
    params.push(ward);
    where += ` AND COALESCE(a.ward, 'unassigned') = $${params.length}`;
  }
  return prisma.$queryRawUnsafe(
    `SELECT d::date AS d,
            COALESCE(a.ward, 'unassigned') AS ward,
            COUNT(*)::int AS patients_in_house
       FROM admissions a
       JOIN LATERAL generate_series(
         a.created_at::date,
         COALESCE((a.created_at + INTERVAL '7 days')::date, CURRENT_DATE),
         INTERVAL '1 day'
       ) AS d ON true
      WHERE ${where}
        AND LOWER(a.status) = 'admitted'
      GROUP BY d::date, COALESCE(a.ward, 'unassigned')
      ORDER BY d DESC, ward`,
    ...params,
  );
}

export async function getDoctorProductivity30d({ tenantId } = {}) {
  return prisma.$queryRawUnsafe(
    `SELECT doctor_id,
            doctor_name,
            COUNT(*)::int AS opd_appointments_30d,
            SUM(CASE WHEN UPPER(status) IN ('COMPLETED','CHECKED_OUT') THEN 1 ELSE 0 END)::int AS opd_completed_30d,
            COUNT(DISTINCT appointment_date)::int AS days_seen_patients,
            ROUND(
              COUNT(*)::numeric / NULLIF(COUNT(DISTINCT appointment_date), 0), 1
            ) AS avg_appointments_per_day
       FROM appointments
      WHERE tenant_id = $1::uuid
        AND appointment_date >= CURRENT_DATE - INTERVAL '30 days'
      GROUP BY doctor_id, doctor_name
      ORDER BY opd_appointments_30d DESC`,
    tenant(tenantId),
  );
}

export async function getPayerMixMonthly({ tenantId, months = 6 } = {}) {
  const safeMonths = Math.max(1, Math.min(60, Number.parseInt(months, 10) || 6));
  return prisma.$queryRawUnsafe(
    `SELECT DATE_TRUNC('month', c.created_at)::date AS month,
            c.claim_type,
            c.status,
            COUNT(*)::int AS claim_count,
            SUM(c.total_billed) AS total_billed,
            SUM(c.claimed_amount) AS total_claimed,
            SUM(COALESCE(c.approved_amount, 0)) AS total_approved,
            SUM(COALESCE(c.paid_amount, 0)) AS total_paid
       FROM tpa_claims c
      WHERE c.tenant_id = $1::uuid
        AND DATE_TRUNC('month', c.created_at)::date >= (CURRENT_DATE - ($2 || ' months')::interval)::date
      GROUP BY DATE_TRUNC('month', c.created_at)::date, c.claim_type, c.status
      ORDER BY month DESC, claim_type, status`,
    tenant(tenantId), String(safeMonths),
  );
}

export async function getLabTatSummary({ tenantId, from, to }) {
  const fromD = from || new Date(Date.now() - 14 * 86400 * 1000).toISOString().split('T')[0];
  const toD = to || new Date().toISOString().split('T')[0];
  return prisma.$queryRawUnsafe(
    `SELECT DATE_TRUNC('day', received_at)::date AS d,
            COUNT(*)::int AS results_received,
            SUM(CASE WHEN signed_off_at IS NOT NULL THEN 1 ELSE 0 END)::int AS results_signed,
            AVG(EXTRACT(EPOCH FROM (signed_off_at - received_at)) / 60)::int AS avg_tat_minutes,
            PERCENTILE_CONT(0.5) WITHIN GROUP (
              ORDER BY EXTRACT(EPOCH FROM (signed_off_at - received_at)) / 60
            )::int AS median_tat_minutes,
            PERCENTILE_CONT(0.95) WITHIN GROUP (
              ORDER BY EXTRACT(EPOCH FROM (signed_off_at - received_at)) / 60
            )::int AS p95_tat_minutes
       FROM lab_results
      WHERE tenant_id = $1::uuid
        AND received_at IS NOT NULL
        AND DATE_TRUNC('day', received_at)::date BETWEEN $2::date AND $3::date
      GROUP BY DATE_TRUNC('day', received_at)::date
      ORDER BY d DESC`,
    tenant(tenantId), fromD, toD,
  );
}
