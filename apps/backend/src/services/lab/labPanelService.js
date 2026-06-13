// src/services/lab/labPanelService.js
//
// Architectural item A5 — structured manual lab-result entry, with
// panel grouping + per-sex / per-age reference-range lookup.
//
// Companion to the existing labResultsService (HL7 ORU ingestion).
// This module is the manual-entry path: a lab tech types in CBC values
// from an analyzer that doesn't speak HL7, and gets one panel-id'd
// row per analyte with reference ranges + abnormal flags auto-applied.
//
// Migration 175. See finding
// 2026-05-08-lab-walk-in-lab-tech-no-structured-results.

import crypto from 'node:crypto';
import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';

const VALID_RESULT_STATUS = new Set(['preliminary', 'final', 'corrected', 'cancelled']);
const VALID_PANEL_CODES = new Set([
  'CBC', 'LIPID', 'GLUCOSE', 'LFT', 'RFT', 'THYROID', 'CARDIAC',
  'COAG', 'URINE', 'STOOL', 'CRP', 'PROCAL', 'CUSTOM',
]);

/**
 * Pick the most specific reference range row for a given test + patient
 * context. Specificity order:
 *   1. Sex-and-age-band match
 *   2. Sex-only match
 *   3. Age-band-only match
 *   4. Fully generic (sex=null, age_band=null)
 * Active rows only. Tenant-scoped.
 *
 * @param {Object} args { tenantId, testCode, sex, ageYears }
 * @returns {Object|null} the best-matching row, or null if none
 */
export async function lookupReferenceRange({ tenantId, testCode, sex = null, ageYears = null }) {
  if (!testCode) return null;
  const tid = tenantId ?? '00000000-0000-4000-8000-000000000001';
  const candidates = await prisma.lab_reference_ranges.findMany({
    where: {
      tenant_id: tid,
      test_code: testCode,
      is_active: true,
    },
  });
  if (!candidates.length) return null;

  function matchesAge(row) {
    if (row.age_band_min_y == null && row.age_band_max_y == null) return null; // generic
    if (ageYears == null) return false;
    if (row.age_band_min_y != null && ageYears < row.age_band_min_y) return false;
    if (row.age_band_max_y != null && ageYears >= row.age_band_max_y) return false;
    return true;
  }

  const scored = candidates.map((row) => {
    const sexMatch = row.sex == null ? 'generic'
      : (sex && row.sex.toUpperCase() === sex.toUpperCase()) ? 'match' : 'mismatch';
    const ageMatch = matchesAge(row); // true | false | null (generic)
    if (sexMatch === 'mismatch') return { row, score: -1 };
    if (ageMatch === false) return { row, score: -1 };
    let score = 0;
    if (sexMatch === 'match') score += 2;
    if (ageMatch === true) score += 1;
    return { row, score };
  }).filter((s) => s.score >= 0);
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);
  return scored[0].row;
}

/**
 * Compute abnormal_flag from a numeric value + range row.
 * Returns one of: 'N' | 'L' | 'H' | 'LL' | 'HH' | null.
 * If the value or range is missing, returns null.
 */
export function computeAbnormalFlag(valueNumeric, range) {
  if (!range || valueNumeric == null) return null;
  const v = Number(valueNumeric);
  if (!Number.isFinite(v)) return null;
  const cl = range.critical_low != null ? Number(range.critical_low) : null;
  const ch = range.critical_high != null ? Number(range.critical_high) : null;
  if (cl != null && v <= cl) return 'LL';
  if (ch != null && v >= ch) return 'HH';
  const rl = range.range_low != null ? Number(range.range_low) : null;
  const rh = range.range_high != null ? Number(range.range_high) : null;
  if (rl != null && v < rl) return 'L';
  if (rh != null && v > rh) return 'H';
  if (rl != null || rh != null) return 'N';
  return null;
}

/**
 * Record a panel of analytes in one bulk write. Reference ranges are
 * looked up per-analyte by test_code + patient context (sex + age) and
 * applied to each row. abnormal_flag is auto-computed; is_critical
 * fires when value crosses critical_low/critical_high.
 *
 * @param {Object} args
 * @param {string} args.panelCode  CBC | LIPID | LFT | …
 * @param {string} args.patientUid
 * @param {number} [args.bookingId]
 * @param {Date}   [args.performedAt]  defaults to now
 * @param {string} [args.performedByLab]
 * @param {string} args.performedByUid  staff uid
 * @param {Array<Object>} args.analytes  [{ test_code, test_name, loinc_code?, value_numeric, value_text, unit?, comments? }]
 * @param {string} args.tenantId
 * @returns {{ panel_id, panel_code, results: Array, criticals_fired: number }}
 */
export async function recordLabPanel({
  panelCode, patientUid, bookingId = null, performedAt = null, performedByLab = null,
  performedByUid, analytes, tenantId,
}) {
  if (!panelCode) throw AppError.badRequest('panelCode is required');
  if (!VALID_PANEL_CODES.has(panelCode)) {
    throw AppError.badRequest(`Invalid panelCode: ${panelCode}. Must be one of: ${[...VALID_PANEL_CODES].join(', ')}`);
  }
  if (!patientUid) throw AppError.badRequest('patientUid is required');
  if (!performedByUid) throw AppError.badRequest('performedByUid is required');
  if (!Array.isArray(analytes) || analytes.length === 0) {
    throw AppError.badRequest('analytes must be a non-empty array');
  }
  for (const a of analytes) {
    if (!a.test_code || !a.test_name) {
      throw AppError.badRequest('Each analyte requires test_code and test_name');
    }
    if (a.value_numeric == null && (a.value_text == null || a.value_text === '')) {
      throw AppError.badRequest(`Analyte ${a.test_code}: value_numeric or value_text is required`);
    }
  }

  // Pull patient sex + age once; both feed into reference-range lookup.
  const tid = tenantId ?? '00000000-0000-4000-8000-000000000001';
  const patient = await prisma.users.findFirst({
    where: { uid: patientUid, tenant_id: tid },
    select: { name: true, gender: true, birthday: true },
  });
  if (!patient) throw AppError.notFound('Patient not found');
  const sex = patient.gender ? String(patient.gender).slice(0, 1).toUpperCase() : null;
  const ageYears = patient.birthday
    ? Math.max(0, Math.floor((Date.now() - new Date(patient.birthday).getTime()) / (365.25 * 86400000)))
    : null;

  const panelId = crypto.randomUUID();
  const performedAtTs = performedAt ? new Date(performedAt) : new Date();

  // Per-analyte ranges + flag computation.
  const enriched = await Promise.all(
    analytes.map(async (a) => {
      const range = await lookupReferenceRange({
        tenantId: tid,
        testCode: a.test_code,
        sex,
        ageYears,
      });
      const flag = computeAbnormalFlag(a.value_numeric, range);
      const isCritical = flag === 'LL' || flag === 'HH';
      return { analyte: a, range, flag, isCritical };
    }),
  );

  const result = await setTenantTx(tid, async (tx) => {
    const rows = [];
    for (const { analyte, range, flag, isCritical } of enriched) {
      const created = await tx.lab_results.create({
        data: {
          tenant_id: tid,
          booking_id: bookingId,
          patient_uid: patientUid,
          patient_name: patient.name ?? null,
          loinc_code: analyte.loinc_code ?? range?.loinc_code ?? null,
          test_code: analyte.test_code,
          test_name: analyte.test_name,
          value_text: analyte.value_text ?? null,
          value_numeric: analyte.value_numeric != null ? analyte.value_numeric : null,
          unit: analyte.unit ?? range?.unit ?? null,
          // Render a human-readable string from the structured range so
          // legacy callers reading reference_range still get useful text.
          reference_range: range
            ? renderReferenceRangeText(range)
            : null,
          reference_range_low: range?.range_low ?? null,
          reference_range_high: range?.range_high ?? null,
          abnormal_flag: flag ?? null,
          status: analyte.status && VALID_RESULT_STATUS.has(analyte.status) ? analyte.status : 'final',
          is_critical: isCritical,
          performed_by_lab: performedByLab,
          performed_at: performedAtTs,
          comments: analyte.comments ?? null,
          panel_id: panelId,
          panel_code: panelCode,
        },
      });
      rows.push(created);

      // Fire a lab_critical_alerts row for each critical so the alert
      // pipeline picks it up — same structure as the HL7 ingestion path.
      if (isCritical && range) {
        await tx.lab_critical_alerts.create({
          data: {
            tenant_id: tid,
            result_id: created.id,
            patient_uid: patientUid,
            test_name: analyte.test_name,
            value_text: analyte.value_text ?? null,
            value_numeric: analyte.value_numeric != null ? analyte.value_numeric : null,
            unit: created.unit,
            threshold_breached: flag,
            threshold_value: flag === 'LL' ? range.critical_low : range.critical_high,
          },
        });
      }
    }

    await tx.audit_logs.create({
      data: {
        uid: performedByUid,
        action: 'RECORD_LAB_PANEL',
        resource: 'lab_results',
        resource_id: panelId,
        metadata: {
          panel_code: panelCode,
          patient_uid: patientUid,
          analyte_count: rows.length,
          critical_count: enriched.filter((e) => e.isCritical).length,
        },
        ip_address: null,
      },
    });

    return rows;
  });

  logger.info(`Lab panel ${panelCode} recorded for patient=${patientUid} panel_id=${panelId} analytes=${result.length}`);
  return {
    panel_id: panelId,
    panel_code: panelCode,
    results: result,
    criticals_fired: enriched.filter((e) => e.isCritical).length,
  };
}

function renderReferenceRangeText(range) {
  const lo = range.range_low != null ? Number(range.range_low) : null;
  const hi = range.range_high != null ? Number(range.range_high) : null;
  const unit = range.unit || '';
  if (lo != null && hi != null) return `${lo}–${hi} ${unit}`.trim();
  if (lo != null) return `> ${lo} ${unit}`.trim();
  if (hi != null) return `< ${hi} ${unit}`.trim();
  return '';
}

/**
 * Fetch a panel by panel_id — returns header + all analyte rows.
 */
export async function getLabPanel(panelId, { tenantId } = {}) {
  if (!panelId) throw AppError.badRequest('panelId is required');
  const tid = tenantId ?? '00000000-0000-4000-8000-000000000001';
  const rows = await prisma.lab_results.findMany({
    where: { panel_id: panelId, tenant_id: tid },
    orderBy: { id: 'asc' },
  });
  if (!rows.length) return null;
  return {
    panel_id: panelId,
    panel_code: rows[0].panel_code,
    patient_uid: rows[0].patient_uid,
    patient_name: rows[0].patient_name,
    performed_at: rows[0].performed_at,
    performed_by_lab: rows[0].performed_by_lab,
    results: rows,
  };
}

/**
 * List recent panels for a patient (header summary only — not the
 * individual analyte rows). For the patient-app's "your lab history"
 * view.
 */
export async function listPatientPanels(patientUid, { tenantId, panelCode = null, limit = 50 } = {}) {
  const tid = tenantId ?? '00000000-0000-4000-8000-000000000001';
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  const rows = await prisma.lab_results.findMany({
    where: {
      tenant_id: tid,
      patient_uid: patientUid,
      panel_id: { not: null },
      ...(panelCode ? { panel_code: panelCode } : {}),
    },
    orderBy: { performed_at: 'desc' },
    take: safeLimit * 12, // over-fetch then group; assume max ~12 analytes/panel
  });
  // Group by panel_id, take first row's metadata as header.
  const byPanel = new Map();
  for (const r of rows) {
    if (!r.panel_id) continue;
    if (!byPanel.has(r.panel_id)) {
      byPanel.set(r.panel_id, {
        panel_id: r.panel_id,
        panel_code: r.panel_code,
        performed_at: r.performed_at,
        analyte_count: 0,
        critical_count: 0,
      });
    }
    const h = byPanel.get(r.panel_id);
    h.analyte_count += 1;
    if (r.is_critical) h.critical_count += 1;
  }
  return Array.from(byPanel.values()).slice(0, safeLimit);
}

/**
 * Time-series query: all values of a single analyte over a date range.
 * Powers the "Hb trend over the last 30 days" view in the patient app.
 */
export async function getAnalyteTrend(patientUid, testCode, { tenantId, fromDate = null, toDate = null, limit = 100 } = {}) {
  if (!patientUid) throw AppError.badRequest('patientUid is required');
  if (!testCode) throw AppError.badRequest('testCode is required');
  const tid = tenantId ?? '00000000-0000-4000-8000-000000000001';
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
  return prisma.lab_results.findMany({
    where: {
      tenant_id: tid,
      patient_uid: patientUid,
      test_code: testCode,
      ...(fromDate || toDate
        ? { performed_at: {
            ...(fromDate ? { gte: new Date(fromDate) } : {}),
            ...(toDate ? { lte: new Date(toDate) } : {}),
          } }
        : {}),
    },
    orderBy: { performed_at: 'asc' },
    take: safeLimit,
    select: {
      id: true,
      performed_at: true,
      value_numeric: true,
      value_text: true,
      unit: true,
      reference_range_low: true,
      reference_range_high: true,
      abnormal_flag: true,
      is_critical: true,
      panel_id: true,
      panel_code: true,
    },
  });
}

/**
 * Admin: list reference ranges with optional filters.
 */
export async function listReferenceRanges({ tenantId, testCode = null, includeInactive = false } = {}) {
  const tid = tenantId ?? '00000000-0000-4000-8000-000000000001';
  return prisma.lab_reference_ranges.findMany({
    where: {
      tenant_id: tid,
      ...(testCode ? { test_code: testCode } : {}),
      ...(includeInactive ? {} : { is_active: true }),
    },
    orderBy: [{ test_code: 'asc' }, { sex: 'asc' }, { age_band_min_y: 'asc' }],
  });
}

/**
 * Admin: upsert a reference range (manual config flow).
 */
export async function upsertReferenceRange(data, { tenantId }) {
  const tid = tenantId ?? '00000000-0000-4000-8000-000000000001';
  if (!data.test_code || !data.test_name || !data.unit) {
    throw AppError.badRequest('test_code, test_name, and unit are required');
  }
  const { id, tenant_id: _ignoredTenantId, ...rangeData } = data;
  if (id) {
    const rangeId = Number(id);
    const updated = await prisma.lab_reference_ranges.updateMany({
      where: { id: rangeId, tenant_id: tid },
      data: { ...rangeData, updated_at: new Date() },
    });
    if (updated.count === 0) throw AppError.notFound('Reference range not found');
    return prisma.lab_reference_ranges.findFirst({
      where: { id: rangeId, tenant_id: tid },
    });
  }
  return prisma.lab_reference_ranges.create({
    data: { ...rangeData, tenant_id: tid, source: rangeData.source ?? 'manual' },
  });
}

export default {
  recordLabPanel,
  getLabPanel,
  listPatientPanels,
  getAnalyteTrend,
  lookupReferenceRange,
  computeAbnormalFlag,
  listReferenceRanges,
  upsertReferenceRange,
};
