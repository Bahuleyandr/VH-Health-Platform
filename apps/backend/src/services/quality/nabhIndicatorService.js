// src/services/quality/nabhIndicatorService.js
//
// Roadmap D4 — NABH quality-indicator pack. Every indicator is computed
// from data the platform already captures; each computation is isolated
// and schema-tolerant (an environment missing one source reports that
// indicator as unavailable instead of failing the pack).

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import PDFDocument from 'pdfkit';

export const ASSESSOR_EXPORT_CONTRACT = Object.freeze({
  pack_type: 'NABH_PERIOD_PACK',
  canonical_format_status: 'pending_assessor_format',
  evidence_control_code: 'NABH_AUDIT_EXPORT',
  supported_formats: ['json', 'csv', 'pdf'],
  phi_policy: 'Aggregate quality indicators only; no patient identifiers or raw clinical payloads.',
  acceptance_boundary: 'Hospital owner must confirm the assessor-required file format before marking evidence accepted.',
});

export const INDICATOR_DEFINITIONS = Object.freeze({
  ama_lama_discharge_pct: {
    chapter: 'QPS',
    source_tables: ['admissions'],
    numerator: 'Discharges with discharge_type AMA or LAMA in the period.',
    denominator: 'All discharges in the period.',
    assessor_note: 'Lower is better; period is based on discharged_at.',
  },
  medication_error_rate_per_1000: {
    chapter: 'QPS',
    source_tables: ['medication_safety_reviews', 'medication_administrations'],
    numerator: 'Medication safety reviews with blocked or overridden status in the period.',
    denominator: 'Administered medication administrations in the period.',
    assessor_note: 'Reported per 1000 administrations; lower is better.',
  },
  lab_tat_minutes: {
    chapter: 'QPS',
    source_tables: ['lab_results'],
    numerator: 'Median minutes from sample received to signed off.',
    denominator: 'Signed lab results in the period.',
    assessor_note: 'p50 and p90 are included in details.',
  },
  radiology_tat_minutes: {
    chapter: 'QPS',
    source_tables: ['radiology_orders'],
    numerator: 'Median minutes from order creation to completed radiology report.',
    denominator: 'Completed radiology reports in the period.',
    assessor_note: 'p50 and p90 are included in details.',
  },
  critical_alert_ack_minutes: {
    chapter: 'QPS',
    source_tables: ['lab_critical_alerts'],
    numerator: 'Median minutes from critical alert firing to acknowledgement.',
    denominator: 'Acknowledged critical alerts in the period.',
    assessor_note: 'p50 and p90 are included in details.',
  },
  hai_rate_per_1000_patient_days: {
    chapter: 'HIC',
    source_tables: ['hai_cases', 'admissions'],
    numerator: 'HAI numerator_count in the period.',
    denominator: 'Inpatient patient-days overlapping the period.',
    assessor_note: 'Reported per 1000 patient-days; lower is better.',
  },
  hai_device_rate_per_1000_device_days: {
    chapter: 'HIC',
    source_tables: ['hai_cases', 'device_presence_logs'],
    numerator: 'Device-associated HAI numerator_count in the period.',
    denominator: 'Device-days overlapping the period.',
    assessor_note: 'Reported per 1000 device-days and split by device type in details.',
  },
  incident_counts: {
    chapter: 'QPS',
    source_tables: ['quality_incidents'],
    numerator: 'Reported quality incidents in the period.',
    denominator: null,
    assessor_note: 'Counts are split by incident_type in details.',
  },
  patient_satisfaction_positive_pct: {
    chapter: 'PRE',
    source_tables: ['feedback', 'patient_feedback'],
    numerator: 'Patient feedback ratings greater than or equal to 4 on a 5-point scale.',
    denominator: 'Patient feedback ratings captured in the period.',
    assessor_note: 'Format remains pending owner confirmation; aggregate only.',
  },
  rca_completion_pct: {
    chapter: 'QPS',
    source_tables: ['quality_incidents'],
    numerator: 'Major/sentinel incidents closed or resolved with RCA, corrective action, and preventive action.',
    denominator: 'Major/sentinel incidents requiring RCA in the period.',
    assessor_note: 'RCA scope is explicitly limited to major and sentinel incidents.',
  },
  cath_case_volume: {
    chapter: 'QPS',
    source_tables: ['cath_lab_cases'],
    numerator: 'Cath-lab cases completed in the period.',
    denominator: null,
    assessor_note: 'Counts are split by urgency in details (NL13-P1f).',
  },
  cath_complication_rate_pct: {
    chapter: 'QPS',
    source_tables: ['cath_complication_registry', 'cath_lab_cases'],
    numerator: 'Completed cath cases with at least one complication registry entry in the period.',
    denominator: 'Cath-lab cases completed in the period.',
    assessor_note: 'Registry-derived; lower is better (NL13-P1f).',
  },
  cath_dose_outlier_count: {
    chapter: 'QPS',
    source_tables: ['cath_contrast_radiation_records', 'cath_dose_alert_settings'],
    numerator: 'Dose/contrast records exceeding an owner-configured alert threshold in the period.',
    denominator: null,
    assessor_note: 'Reports thresholds_pending until the owner configures thresholds — no default dose limits are assumed (NL13-P1f).',
  },
});

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

function normalizeForWire(value) {
  if (value == null) return value;
  if (typeof value.toNumber === 'function') return value.toNumber();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => normalizeForWire(item));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeForWire(item)]));
  }
  return value;
}

function dateOnly(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function requireTenantId(tenantId) {
  if (!tenantId) {
    throw AppError.forbidden('Tenant context is required for NABH indicators', 'NABH_TENANT_REQUIRED');
  }
  return tenantId;
}

/** Build one indicator result row. Pure-ish shape helper. */
function indicator(code, label, unit, value, numerator, denominator, details = {}) {
  const definition = INDICATOR_DEFINITIONS[code] || {};
  return {
    code,
    label,
    unit,
    value,
    numerator,
    denominator,
    definition,
    details: {
      ...details,
      definition_status: ASSESSOR_EXPORT_CONTRACT.canonical_format_status,
      source_tables: definition.source_tables || [],
      assessor_note: definition.assessor_note || null,
    },
  };
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
        `SELECT COALESCE(SUM(numerator_count), 0)::int AS n FROM hai_cases
          WHERE tenant_id = $1::uuid
            AND onset_date >= $2::date AND onset_date <= $3::date`,
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

  async hai_device_rate_per_1000_device_days({ from, to, tenantId }) {
    const rows = await prisma.$queryRawUnsafe(
      `WITH hai_counts AS (
         SELECT COALESCE(device_type,
                CASE hai_type
                  WHEN 'CAUTI' THEN 'urinary_catheter'
                  WHEN 'CLABSI' THEN 'central_line'
                  WHEN 'VAP' THEN 'ventilator'
                  ELSE NULL
                END) AS device_type,
                SUM(numerator_count)::int AS numerator
           FROM hai_cases
          WHERE tenant_id = $1::uuid
            AND onset_date >= $2::date
            AND onset_date <= $3::date
          GROUP BY 1
       ),
       device_days AS (
         SELECT device_type,
                COALESCE(SUM(
                  GREATEST(0, EXTRACT(EPOCH FROM (
                    LEAST(COALESCE(stopped_at, ($3::date + 1)::timestamptz), ($3::date + 1)::timestamptz)
                    - GREATEST(started_at, $2::date::timestamptz)
                  )) / 86400)
                ), 0)::numeric(14,2) AS denominator
           FROM device_presence_logs
          WHERE tenant_id = $1::uuid
            AND started_at < ($3::date + 1)
            AND COALESCE(stopped_at, ($3::date + 1)::timestamptz) >= $2::date
          GROUP BY device_type
       )
       SELECT hc.device_type,
              hc.numerator,
              COALESCE(dd.denominator, 0)::numeric(14,2) AS denominator
         FROM hai_counts hc
         LEFT JOIN device_days dd ON dd.device_type = hc.device_type
        WHERE hc.device_type IS NOT NULL
        ORDER BY hc.device_type`,
      tenantId, from, to,
    );
    const byDevice = Object.fromEntries(rows.map((row) => {
      const numerator = Number(row.numerator) || 0;
      const denominator = Number(row.denominator) || 0;
      return [row.device_type, {
        numerator,
        denominator,
        rate_per_1000_device_days: per1000(numerator, denominator),
      }];
    }));
    const numerator = rows.reduce((sum, row) => sum + (Number(row.numerator) || 0), 0);
    const denominator = rows.reduce((sum, row) => sum + (Number(row.denominator) || 0), 0);
    return indicator(
      'hai_device_rate_per_1000_device_days',
      'Device-associated HAI cases per 1000 device-days',
      'per 1000 device-days',
      per1000(numerator, denominator),
      numerator,
      Number(denominator.toFixed(2)),
      { by_device_type: byDevice },
    );
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

  async patient_satisfaction_positive_pct({ from, to, tenantId }) {
    const rows = await prisma.$queryRawUnsafe(
      `WITH survey_rows AS (
         SELECT rating::numeric AS rating
           FROM feedback
          WHERE tenant_id = $1::uuid
            AND created_at >= $2::date
            AND created_at < ($3::date + 1)
            AND rating BETWEEN 1 AND 5
         UNION ALL
         SELECT rating::numeric AS rating
           FROM patient_feedback
          WHERE tenant_id = $1::uuid
            AND created_at >= $2::date
            AND created_at < ($3::date + 1)
            AND rating BETWEEN 1 AND 5
       )
       SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE rating >= 4)::int AS positive,
              ROUND(AVG(rating), 2) AS average_rating
         FROM survey_rows`,
      tenantId, from, to,
    );
    const row = rows[0] || {};
    const numerator = Number(row.positive) || 0;
    const denominator = Number(row.total) || 0;
    return indicator(
      'patient_satisfaction_positive_pct',
      'Patient satisfaction positive responses',
      '%',
      pct(numerator, denominator),
      numerator,
      denominator,
      { average_rating: row.average_rating != null ? Number(row.average_rating) : null },
    );
  },

  async rca_completion_pct({ from, to, tenantId }) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*) FILTER (
                WHERE severity IN ('major', 'sentinel')
              )::int AS required,
              COUNT(*) FILTER (
                WHERE severity IN ('major', 'sentinel')
                  AND status IN ('resolved', 'closed')
                  AND NULLIF(BTRIM(COALESCE(root_cause, '')), '') IS NOT NULL
                  AND NULLIF(BTRIM(COALESCE(corrective_action, '')), '') IS NOT NULL
                  AND NULLIF(BTRIM(COALESCE(preventive_action, '')), '') IS NOT NULL
              )::int AS completed
         FROM quality_incidents
        WHERE tenant_id = $1::uuid
          AND date_occurred >= $2::date
          AND date_occurred < ($3::date + 1)`,
      tenantId, from, to,
    );
    const row = rows[0] || {};
    const numerator = Number(row.completed) || 0;
    const denominator = Number(row.required) || 0;
    return indicator(
      'rca_completion_pct',
      'RCA completion for major/sentinel incidents',
      '%',
      pct(numerator, denominator),
      numerator,
      denominator,
      {
        rca_required_scope: 'quality_incidents.severity IN (major, sentinel)',
        completion_requires: ['root_cause', 'corrective_action', 'preventive_action', 'status resolved/closed'],
      },
    );
  },

  async cath_case_volume({ from, to, tenantId }) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT COALESCE(urgency, 'unspecified') AS urgency, COUNT(*)::int AS n
         FROM cath_lab_cases
        WHERE tenant_id = $1::uuid
          AND status = 'completed'
          AND COALESCE(actual_end_at, updated_at) >= $2::date
          AND COALESCE(actual_end_at, updated_at) < ($3::date + 1)
        GROUP BY 1 ORDER BY n DESC`,
      tenantId, from, to,
    );
    const total = rows.reduce((sum, r) => sum + Number(r.n), 0);
    return indicator('cath_case_volume', 'Cath-lab case volume (completed)', 'count', total, total, null, {
      by_urgency: Object.fromEntries(rows.map((r) => [r.urgency, Number(r.n)])),
    });
  },

  async cath_complication_rate_pct({ from, to, tenantId }) {
    const rows = await prisma.$queryRawUnsafe(
      `WITH completed AS (
         SELECT id
           FROM cath_lab_cases
          WHERE tenant_id = $1::uuid
            AND status = 'completed'
            AND COALESCE(actual_end_at, updated_at) >= $2::date
            AND COALESCE(actual_end_at, updated_at) < ($3::date + 1)
       )
       SELECT (SELECT COUNT(*)::int FROM completed) AS total,
              COUNT(DISTINCT reg.case_id)::int AS with_complication
         FROM cath_complication_registry reg
        WHERE reg.tenant_id = $1::uuid
          AND reg.case_id IN (SELECT id FROM completed)`,
      tenantId, from, to,
    );
    const row = rows[0] || {};
    const numerator = Number(row.with_complication) || 0;
    const denominator = Number(row.total) || 0;
    return indicator(
      'cath_complication_rate_pct',
      'Cath cases with a registered complication',
      '%',
      pct(numerator, denominator),
      numerator,
      denominator,
    );
  },

  async cath_dose_outlier_count({ from, to, tenantId }) {
    const settingsRows = await prisma.$queryRawUnsafe(
      `SELECT fluoro_time_alert_min, dap_alert_gy_cm2, air_kerma_alert_mgy, contrast_volume_alert_ml
         FROM cath_dose_alert_settings
        WHERE tenant_id = $1::uuid`,
      tenantId,
    );
    const settings = normalizeForWire(settingsRows[0] || null);
    const configured = Boolean(settings && [
      settings.fluoro_time_alert_min,
      settings.dap_alert_gy_cm2,
      settings.air_kerma_alert_mgy,
      settings.contrast_volume_alert_ml,
    ].some((v) => v != null));
    if (!configured) {
      // Fail-closed: never fabricate dose limits — surface the pending state.
      return indicator('cath_dose_outlier_count', 'Cath dose records above owner thresholds', 'count',
        null, null, null, { thresholds_status: 'thresholds_pending' });
    }
    const rows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n
         FROM cath_contrast_radiation_records d
        WHERE d.tenant_id = $1::uuid
          AND d.recorded_at >= $2::date
          AND d.recorded_at < ($3::date + 1)
          AND (
            (d.fluoroscopy_time_min IS NOT NULL AND $4::numeric IS NOT NULL AND d.fluoroscopy_time_min > $4::numeric)
            OR (d.dose_area_product_gy_cm2 IS NOT NULL AND $5::numeric IS NOT NULL AND d.dose_area_product_gy_cm2 > $5::numeric)
            OR (d.air_kerma_mgy IS NOT NULL AND $6::numeric IS NOT NULL AND d.air_kerma_mgy > $6::numeric)
            OR (d.contrast_volume_ml IS NOT NULL AND $7::numeric IS NOT NULL AND d.contrast_volume_ml > $7::numeric)
          )`,
      tenantId, from, to,
      settings.fluoro_time_alert_min,
      settings.dap_alert_gy_cm2,
      settings.air_kerma_alert_mgy,
      settings.contrast_volume_alert_ml,
    );
    const count = Number(rows[0]?.n) || 0;
    return indicator('cath_dose_outlier_count', 'Cath dose records above owner thresholds', 'count',
      count, count, null, { thresholds_status: 'configured' });
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
  return {
    period: { from, to },
    export_contract: ASSESSOR_EXPORT_CONTRACT,
    indicator_dictionary: INDICATOR_DEFINITIONS,
    indicators: results,
  };
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
  const rows = await prisma.$queryRawUnsafe(
    `SELECT period_start, period_end, indicator_code, label, value, numerator, denominator,
            unit, details, computed_at
       FROM nabh_indicator_snapshots WHERE ${where}
      ORDER BY period_start DESC, indicator_code`,
    ...params,
  );
  return rows.map((row) => normalizeForWire(row));
}

async function listFrozenSnapshotRows({ from, to, tenantId }) {
  return prisma.$queryRawUnsafe(
    `SELECT period_start, period_end, indicator_code, label, value, numerator, denominator,
            unit, details, computed_at
       FROM nabh_indicator_snapshots
      WHERE tenant_id = $1::uuid
        AND period_start = $2::date
        AND period_end = $3::date
      ORDER BY indicator_code`,
    tenantId, from, to,
  );
}

function snapshotRowToIndicator(row) {
  const shaped = normalizeForWire(row);
  const definition = INDICATOR_DEFINITIONS[shaped.indicator_code] || {};
  return {
    code: shaped.indicator_code,
    label: shaped.label,
    value: shaped.value,
    unit: shaped.unit,
    numerator: shaped.numerator,
    denominator: shaped.denominator,
    available: true,
    definition,
    details: normalizeForWire(shaped.details || {}),
    computed_at: shaped.computed_at,
  };
}

export async function getFrozenPeriodPack({ from, to, tenantId } = {}) {
  if (!from || !to) throw AppError.badRequest('from and to dates are required', 'NABH_PERIOD_REQUIRED');
  if (new Date(from) > new Date(to)) throw AppError.badRequest('from must be <= to', 'NABH_PERIOD_INVERTED');
  const resolvedTenantId = requireTenantId(tenantId);
  const rows = await listFrozenSnapshotRows({ from, to, tenantId: resolvedTenantId });
  if (!rows.length) {
    throw AppError.notFound('NABH period pack has not been frozen for this period', 'NABH_PERIOD_PACK_NOT_FROZEN');
  }
  const indicators = rows.map(snapshotRowToIndicator)
    .sort((a, b) => INDICATOR_CODES.indexOf(a.code) - INDICATOR_CODES.indexOf(b.code));
  const present = new Set(indicators.map((item) => item.code));
  const missing = INDICATOR_CODES.filter((code) => !present.has(code));
  const frozenAt = indicators.reduce((latest, item) => {
    if (!item.computed_at) return latest;
    return !latest || item.computed_at > latest ? item.computed_at : latest;
  }, null);
  return {
    pack_type: 'NABH_PERIOD_PACK',
    status: 'frozen',
    tenant_id: resolvedTenantId,
    period: { from: dateOnly(from), to: dateOnly(to) },
    frozen_at: frozenAt,
    generated_at: new Date().toISOString(),
    export_contract: ASSESSOR_EXPORT_CONTRACT,
    evidence_attachment: {
      control_code: 'NABH_AUDIT_EXPORT',
      status: 'pending_operator_acceptance',
      evidence_table: 'india_compliance_evidence',
      attach_files: ['json', 'csv', 'pdf'],
      note: ASSESSOR_EXPORT_CONTRACT.acceptance_boundary,
    },
    indicator_dictionary: INDICATOR_DEFINITIONS,
    indicator_count: indicators.length,
    expected_indicator_count: INDICATOR_CODES.length,
    missing_indicator_codes: missing,
    indicators,
  };
}

export async function freezePeriodPack({ from, to } = {}, context = {}) {
  const snapshot = await snapshotIndicators({ from, to }, context);
  const pack = await getFrozenPeriodPack({ from, to, tenantId: context.tenantId });
  return { ...pack, snapshot_saved: snapshot.snapshot_saved };
}

/** Assessor CSV: one row per indicator. Pure given a pack — unit-tested. */
export function packToCsv(pack) {
  const header = 'indicator_code,label,value,unit,numerator,denominator,period_start,period_end,available,definition_status,evidence_control,source_tables,assessor_note';
  const escape = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const lines = pack.indicators.map((i) => [
    i.code, i.label, i.value, i.unit, i.numerator, i.denominator,
    pack.period.from, pack.period.to, i.available,
    i.details?.definition_status || pack.export_contract?.canonical_format_status || '',
    pack.evidence_attachment?.control_code || pack.export_contract?.evidence_control_code || '',
    (i.definition?.source_tables || i.details?.source_tables || []).join(';'),
    i.definition?.assessor_note || i.details?.assessor_note || '',
  ].map(escape).join(','));
  return [header, ...lines].join('\n');
}

export async function packToPdfBuffer(pack) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 36, size: 'A4' });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(16).text('NABH Indicator Period Pack');
    doc.moveDown(0.4);
    doc.fontSize(10).text(`Period: ${pack.period.from} to ${pack.period.to}`);
    doc.text(`Status: ${pack.status || 'computed'}`);
    doc.text(`Assessor format: ${pack.export_contract?.canonical_format_status || 'pending_assessor_format'}`);
    doc.text(`Evidence control: ${pack.evidence_attachment?.control_code || 'NABH_AUDIT_EXPORT'}`);
    doc.text(`PHI policy: ${pack.export_contract?.phi_policy || ASSESSOR_EXPORT_CONTRACT.phi_policy}`);
    doc.moveDown();

    for (const item of pack.indicators) {
      const value = item.value == null ? 'n/a' : `${item.value} ${item.unit || ''}`.trim();
      const counts = [item.numerator, item.denominator]
        .map((part) => (part == null ? 'n/a' : String(part)))
        .join(' / ');
      doc.fontSize(10).text(`${item.code}: ${item.label}`, { continued: false });
      doc.fontSize(9).text(`Value: ${value}; numerator / denominator: ${counts}; available: ${item.available}`);
      if (item.definition?.assessor_note) {
        doc.fontSize(8).text(`Note: ${item.definition.assessor_note}`);
      }
      doc.moveDown(0.3);
    }

    doc.end();
  });
}

export default {
  ASSESSOR_EXPORT_CONTRACT,
  INDICATOR_DEFINITIONS,
  INDICATOR_CODES,
  computeIndicators,
  snapshotIndicators,
  listSnapshots,
  freezePeriodPack,
  getFrozenPeriodPack,
  packToCsv,
  packToPdfBuffer,
};
