// src/services/quality/nabhIndicatorService.js
//
// Roadmap D4 — NABH quality-indicator pack. Every indicator is computed
// from data the platform already captures; each computation is isolated
// and schema-tolerant (an environment missing one source reports that
// indicator as unavailable instead of failing the pack).

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';

function isMissingSchema(err) {
  return /does not exist/i.test(String(err?.message || ''));
}

function pct(numerator, denominator) {
  if (!denominator) return null;
  return Number(((numerator / denominator) * 100).toFixed(2));
}

function per1000(numerator, denominator) {
  if (!denominator) return null;
  return Number(((numerator / denominator) * 1000).toFixed(2));
}

function requireTenantId(tenantId) {
  if (!tenantId) {
    throw AppError.forbidden('Tenant context is required for NABH indicators', 'NABH_TENANT_REQUIRED');
  }
  return tenantId;
}

/** Build one indicator result row. Pure-ish shape helper. */
function indicator(code, label, unit, value, numerator, denominator, details = {}) {
  return { code, label, unit, value, numerator, denominator, details };
}

async function tatIndicator({ code, label, sql, params }) {
  const rows = await prisma.$queryRawUnsafe(sql, ...params);
  const row = rows[0] || {};
  const p50 = row.p50 != null ? Number(row.p50) : null;
  return indicator(code, label, 'minutes (median)', p50, Number(row.n) || 0, null, {
    p50_minutes: p50,
    p90_minutes: row.p90 != null ? Number(row.p90) : null,
    n: Number(row.n) || 0,
  });
}

const INDICATORS = {
  async ama_lama_discharge_pct({ from, to, tenantId }) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*) FILTER (WHERE UPPER(COALESCE(discharge_type, '')) IN ('AMA', 'LAMA'))::int AS ama,
              COUNT(*)::int AS total
         FROM admissions
        WHERE tenant_id = $1::uuid
          AND discharged_at >= $2::date AND discharged_at < ($3::date + 1)`,
      tenantId, from, to,
    );
    const { ama = 0, total = 0 } = rows[0] || {};
    return indicator('ama_lama_discharge_pct', 'Discharges against medical advice (AMA/LAMA)', '%',
      pct(Number(ama), Number(total)), Number(ama), Number(total));
  },

  async medication_error_rate_per_1000({ from, to, tenantId }) {
    const [errors, administrations] = await Promise.all([
      prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS n FROM medication_safety_reviews
          WHERE tenant_id = $1::uuid
            AND created_at >= $2::date AND created_at < ($3::date + 1)
            AND status IN ('blocked', 'overridden')`,
        tenantId, from, to,
      ),
      prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS n FROM medication_administrations
          WHERE tenant_id = $1::uuid
            AND administered_at >= $2::date AND administered_at < ($3::date + 1)
            AND status = 'administered'`,
        tenantId, from, to,
      ),
    ]);
    const numerator = Number(errors[0]?.n) || 0;
    const denominator = Number(administrations[0]?.n) || 0;
    return indicator('medication_error_rate_per_1000', 'Medication safety interventions per 1000 administrations',
      'per 1000', per1000(numerator, denominator), numerator, denominator);
  },

  async lab_tat_minutes({ from, to, tenantId }) {
    return tatIndicator({
      code: 'lab_tat_minutes',
      label: 'Lab turnaround (received → signed off)',
      sql: `SELECT COUNT(*)::int AS n,
                   PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (signed_off_at - received_at)) / 60) AS p50,
                   PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (signed_off_at - received_at)) / 60) AS p90
             FROM lab_results
             WHERE signed_off_at IS NOT NULL
               AND tenant_id = $1::uuid
               AND received_at >= $2::date AND received_at < ($3::date + 1)`,
      params: [tenantId, from, to],
    });
  },

  async radiology_tat_minutes({ from, to, tenantId }) {
    return tatIndicator({
      code: 'radiology_tat_minutes',
      label: 'Radiology turnaround (ordered → report completed)',
      sql: `SELECT COUNT(*)::int AS n,
                   PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (report_completed_at - created_at)) / 60) AS p50,
                   PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (report_completed_at - created_at)) / 60) AS p90
              FROM radiology_orders
             WHERE report_completed_at IS NOT NULL
               AND tenant_id = $1::uuid
               AND created_at >= $2::date AND created_at < ($3::date + 1)`,
      params: [tenantId, from, to],
    });
  },

  async critical_alert_ack_minutes({ from, to, tenantId }) {
    return tatIndicator({
      code: 'critical_alert_ack_minutes',
      label: 'Critical lab alert acknowledgement time',
      sql: `SELECT COUNT(*)::int AS n,
                   PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (acknowledged_at - fired_at)) / 60) AS p50,
                   PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (acknowledged_at - fired_at)) / 60) AS p90
              FROM lab_critical_alerts
             WHERE acknowledged_at IS NOT NULL
               AND tenant_id = $1::uuid
               AND fired_at >= $2::date AND fired_at < ($3::date + 1)`,
      params: [tenantId, from, to],
    });
  },

  async hai_rate_per_1000_patient_days({ from, to, tenantId }) {
    const [cases, days] = await Promise.all([
      prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS n FROM infection_cases
          WHERE tenant_id = $1::uuid
            AND detection_date >= $2::date AND detection_date <= $3::date`,
        tenantId, from, to,
      ),
      prisma.$queryRawUnsafe(
        `SELECT COALESCE(SUM(
                  GREATEST(0, EXTRACT(EPOCH FROM (
                    LEAST(COALESCE(discharged_at, NOW()), ($3::date + 1)::timestamptz)
                    - GREATEST(admitted_at, $2::date::timestamptz)
                  )) / 86400)
                ), 0)::numeric(14,2) AS patient_days
           FROM admissions
          WHERE tenant_id = $1::uuid
            AND admitted_at < ($3::date + 1)
            AND COALESCE(discharged_at, NOW()) >= $2::date`,
        tenantId, from, to,
      ),
    ]);
    const numerator = Number(cases[0]?.n) || 0;
    const denominator = Number(days[0]?.patient_days) || 0;
    return indicator('hai_rate_per_1000_patient_days', 'Healthcare-associated infection cases per 1000 patient-days',
      'per 1000 patient-days', per1000(numerator, denominator), numerator, denominator);
  },

  async incident_counts({ from, to, tenantId }) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT COALESCE(NULLIF(TRIM(incident_type), ''), 'uncategorised') AS category, COUNT(*)::int AS n
         FROM quality_incidents
        WHERE tenant_id = $1::uuid
          AND created_at >= $2::date AND created_at < ($3::date + 1)
        GROUP BY 1 ORDER BY n DESC`,
      tenantId, from, to,
    );
    const total = rows.reduce((sum, r) => sum + Number(r.n), 0);
    return indicator('incident_counts', 'Reported quality incidents', 'count', total, total, null, {
      by_category: Object.fromEntries(rows.map((r) => [r.category, Number(r.n)])),
    });
  },
};

export const INDICATOR_CODES = Object.freeze(Object.keys(INDICATORS));

export async function computeIndicators({ from, to, tenantId } = {}) {
  if (!from || !to) throw AppError.badRequest('from and to dates are required', 'NABH_PERIOD_REQUIRED');
  if (new Date(from) > new Date(to)) throw AppError.badRequest('from must be <= to', 'NABH_PERIOD_INVERTED');
  const resolvedTenantId = requireTenantId(tenantId);
  const results = [];
  for (const [code, compute] of Object.entries(INDICATORS)) {
    try {
      results.push({ ...(await compute({ from, to, tenantId: resolvedTenantId })), available: true });
    } catch (err) {
      if (!isMissingSchema(err)) {
        logger.warn(`NABH indicator ${code} failed`, { error: err.message });
      }
      results.push({
        code, label: code, unit: null, value: null, numerator: null, denominator: null,
        available: false, details: { error: isMissingSchema(err) ? 'source_table_missing' : 'computation_failed' },
      });
    }
  }
  return { period: { from, to }, indicators: results };
}

export async function snapshotIndicators({ from, to } = {}, context = {}) {
  const tenantId = requireTenantId(context.tenantId);
  const pack = await computeIndicators({ from, to, tenantId });
  let saved = 0;
  for (const item of pack.indicators) {
    if (!item.available) continue;
    await prisma.$queryRawUnsafe(
      `INSERT INTO nabh_indicator_snapshots
         (tenant_id, period_start, period_end, indicator_code, label, value, numerator, denominator, unit, details, computed_by)
       VALUES ($1::uuid, $2::date, $3::date, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::uuid)
       ON CONFLICT (tenant_id, period_start, period_end, indicator_code)
       DO UPDATE SET value = EXCLUDED.value, numerator = EXCLUDED.numerator,
                     denominator = EXCLUDED.denominator, details = EXCLUDED.details,
                     computed_by = EXCLUDED.computed_by, computed_at = NOW()
       RETURNING id`,
      tenantId, from, to, item.code, item.label, item.value, item.numerator, item.denominator,
      item.unit, JSON.stringify(item.details || {}), context.actorUid || null,
    );
    saved += 1;
  }
  return { ...pack, snapshot_saved: saved };
}

export async function listSnapshots({ from = null, to = null, tenantId } = {}) {
  const resolvedTenantId = requireTenantId(tenantId);
  const params = [resolvedTenantId];
  let where = 'tenant_id = $1::uuid';
  if (from) { params.push(from); where += ` AND period_start >= $${params.length}::date`; }
  if (to) { params.push(to); where += ` AND period_end <= $${params.length}::date`; }
  return prisma.$queryRawUnsafe(
    `SELECT period_start, period_end, indicator_code, label, value, numerator, denominator,
            unit, details, computed_at
       FROM nabh_indicator_snapshots WHERE ${where}
      ORDER BY period_start DESC, indicator_code`,
    ...params,
  );
}

/** Assessor CSV: one row per indicator. Pure given a pack — unit-tested. */
export function packToCsv(pack) {
  const header = 'indicator_code,label,value,unit,numerator,denominator,period_start,period_end,available';
  const escape = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const lines = pack.indicators.map((i) => [
    i.code, i.label, i.value, i.unit, i.numerator, i.denominator,
    pack.period.from, pack.period.to, i.available,
  ].map(escape).join(','));
  return [header, ...lines].join('\n');
}

export default { INDICATOR_CODES, computeIndicators, snapshotIndicators, listSnapshots, packToCsv };
