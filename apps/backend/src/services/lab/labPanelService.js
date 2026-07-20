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
import { requireTenantId } from '../tenant/tenantService.js';
import { recordCanonicalClinicalEvent } from '../clinical/canonicalClinicalPlatformService.js';
import { sendStaffNotifications } from '../notification/staffNotificationService.js';
import { materializeLabCriticalAlertGeneration } from './labCriticalAlertService.js';
import {
  assertConfiguredCriticalAnalytesNumeric,
  evaluateCriticalThreshold,
} from './labCriticalThresholdService.js';
import {
  claimLabResultIngestCommand,
  completeLabResultIngestCommand,
  finaliseHttpIdempotencyInTx,
} from './labResultIngestCommandService.js';

const VALID_PANEL_CODES = new Set([
  'CBC', 'LIPID', 'GLUCOSE', 'LFT', 'RFT', 'THYROID', 'CARDIAC',
  'COAG', 'URINE', 'STOOL', 'CRP', 'PROCAL', 'CUSTOM',
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PANEL_PRE_RESULT_STATUSES = ['REQUESTED', 'PENDING', 'SCHEDULED', 'COLLECTED'];
const PANEL_RESULTABLE_INVESTIGATION_STATUSES = new Set([
  ...PANEL_PRE_RESULT_STATUSES,
  'IN_PROGRESS',
]);
const PANEL_RESULTABLE_BOOKING_STATUSES = new Set([
  'BOOKED', 'CONFIRMED', 'DISPATCHED', 'COLLECTED', 'PROCESSING',
]);
const MANUAL_PANEL_SOURCE = 'manual_panel_entry';

function normalizeLabUnit(unit) {
  if (unit == null || unit === '') return '';
  return String(unit)
    .trim()
    .toLowerCase()
    .replace(/μ/g, 'u')
    .replace(/µ/g, 'u')
    .replace(/\s+/g, '');
}

function numericThreshold(value) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function withoutInternalCommandIdentity(result) {
  const response = { ...result };
  delete response.ingest_command_id;
  return response;
}

function referenceCriticalAssessment({ analyte, range, flag }) {
  const evaluatedValue = numericThreshold(analyte.value_numeric);
  const criticalLow = numericThreshold(range?.critical_low);
  const criticalHigh = numericThreshold(range?.critical_high);
  const matched = evaluatedValue != null && (criticalLow != null || criticalHigh != null);
  const breached = flag === 'LL' || flag === 'HH';
  return {
    matched,
    breached,
    breachedSide: breached ? (flag === 'LL' ? 'low' : 'high') : null,
    breachedValue: breached ? (flag === 'LL' ? criticalLow : criticalHigh) : null,
    evaluatedValue,
    criticalLow,
    criticalHigh,
    thresholdUnit: range?.unit || analyte.unit || null,
  };
}

function nullableNumbersEqual(left, right) {
  if (left == null || right == null) return left == null && right == null;
  return Number(left) === Number(right);
}

function assertCriticalPolicyAgreement({ result, referenceAssessment, canonicalAssessment }) {
  const reasons = [];
  if (referenceAssessment.matched !== canonicalAssessment.matched) {
    reasons.push('policy_presence');
  }
  if (!nullableNumbersEqual(referenceAssessment.criticalLow, canonicalAssessment.criticalLow)) {
    reasons.push('critical_low');
  }
  if (!nullableNumbersEqual(referenceAssessment.criticalHigh, canonicalAssessment.criticalHigh)) {
    reasons.push('critical_high');
  }

  if (referenceAssessment.matched || canonicalAssessment.matched) {
    const referenceUnit = normalizeLabUnit(referenceAssessment.thresholdUnit);
    const canonicalUnit = normalizeLabUnit(canonicalAssessment.thresholdUnit);
    const resultUnit = normalizeLabUnit(result.unit);
    if (
      !referenceUnit
      || !canonicalUnit
      || !resultUnit
      || referenceUnit !== canonicalUnit
      || referenceUnit !== resultUnit
    ) {
      reasons.push('threshold_unit');
    }
  }
  if (referenceAssessment.breached !== canonicalAssessment.breached) {
    reasons.push('boundary_or_breach_decision');
  }
  if (
    referenceAssessment.breached
    && canonicalAssessment.breached
    && referenceAssessment.breachedSide !== canonicalAssessment.breachedSide
  ) {
    reasons.push('breached_side');
  }
  if (
    referenceAssessment.breached
    && canonicalAssessment.breached
    && !nullableNumbersEqual(
      referenceAssessment.breachedValue,
      canonicalAssessment.breachedValue,
    )
  ) {
    reasons.push('breached_threshold');
  }
  if (!reasons.length) return canonicalAssessment;

  throw AppError.badRequest(
    'Lab critical-threshold policies disagree; result was not recorded',
    'LAB_CRITICAL_POLICY_MISMATCH',
    {
      reasons: [...new Set(reasons)],
      test_code: result.test_code || null,
      loinc_code: result.loinc_code || null,
      reference_range_policy: {
        matched: referenceAssessment.matched,
        critical_low: referenceAssessment.criticalLow,
        critical_high: referenceAssessment.criticalHigh,
        unit: referenceAssessment.thresholdUnit,
        low_comparator: 'less_than',
        high_comparator: 'greater_than',
      },
      canonical_policy: {
        matched: canonicalAssessment.matched,
        critical_low: canonicalAssessment.criticalLow ?? null,
        critical_high: canonicalAssessment.criticalHigh ?? null,
        unit: canonicalAssessment.thresholdUnit ?? null,
        low_comparator: 'less_than',
        high_comparator: 'greater_than',
      },
    },
  );
}

function panelSourceMismatch() {
  return AppError.badRequest(
    'Lab panel source does not match the patient or investigation',
    'LAB_PANEL_SOURCE_MISMATCH',
  );
}

function panelSourceRequired() {
  return AppError.badRequest(
    'A lab investigation order or investigation booking is required',
    'LAB_PANEL_SOURCE_REQUIRED',
  );
}

async function resolvePanelSourceTx({
  tx,
  tenantId,
  assertedPatientUid,
  bookingId,
  investigationId,
}) {
  if (bookingId == null) {
    const rows = await tx.$queryRawUnsafe(
      `SELECT NULL::bigint AS booking_id,
              investigation.id AS investigation_id,
              investigation.status AS investigation_status,
              investigation.requested_by AS ordering_clinician_uid,
              patient.uid AS patient_uid,
              patient.name AS patient_name,
              patient.gender,
              patient.birthday
         FROM investigations AS investigation
         JOIN users AS patient
           ON patient.uid = investigation.patient_uid
           AND patient.tenant_id = investigation.tenant_id
           AND patient.role = 'PATIENT'
           AND patient.is_active = TRUE
           AND patient.status = 'active'
           AND patient.is_deleted = FALSE
           AND (investigation.patient_id IS NULL OR investigation.patient_id = patient.id)
        WHERE investigation.id = $1::int
          AND investigation.tenant_id = $2::uuid
        LIMIT 1
        FOR UPDATE OF investigation
        FOR SHARE OF patient`,
      investigationId,
      tenantId,
    );
    const source = rows[0];
    if (
      !source
      || String(source.patient_uid).toLowerCase() !== String(assertedPatientUid).toLowerCase()
      || !PANEL_RESULTABLE_INVESTIGATION_STATUSES.has(
        String(source.investigation_status || '').toUpperCase(),
      )
    ) {
      throw panelSourceMismatch();
    }
    return {
      bookingId: null,
      investigationId: Number(source.investigation_id),
      patientUid: String(source.patient_uid),
      patientName: source.patient_name ?? null,
      gender: source.gender ?? null,
      birthday: source.birthday ?? null,
      orderingClinicianUid: source.ordering_clinician_uid || null,
      investigationStatus: String(source.investigation_status).toUpperCase(),
    };
  }

  const rows = await tx.$queryRawUnsafe(
    `SELECT booking.id AS booking_id,
            booking.status AS booking_status,
            investigation.id AS investigation_id,
            investigation.status AS investigation_status,
            investigation.requested_by AS ordering_clinician_uid,
            patient.uid AS patient_uid,
            patient.name AS patient_name,
            patient.gender,
            patient.birthday
       FROM investigation_bookings AS booking
       JOIN users AS patient
         ON patient.id = booking.patient_id
         AND patient.tenant_id = booking.tenant_id
         AND patient.role = 'PATIENT'
         AND patient.is_active = TRUE
         AND patient.status = 'active'
         AND patient.is_deleted = FALSE
       JOIN investigations AS investigation
         ON investigation.id = booking.investigation_id
        AND investigation.tenant_id = booking.tenant_id
        AND investigation.patient_uid = patient.uid
        AND (investigation.patient_id IS NULL OR investigation.patient_id = patient.id)
      WHERE booking.id = $1::bigint
        AND booking.tenant_id = $2::uuid
        AND ($3::int IS NULL OR investigation.id = $3::int)
      LIMIT 1
      FOR UPDATE OF investigation
      FOR SHARE OF booking, patient`,
    bookingId,
    tenantId,
    investigationId,
  );
  const source = rows[0];
  if (
    !source
    || String(source.patient_uid).toLowerCase() !== String(assertedPatientUid).toLowerCase()
    || !PANEL_RESULTABLE_BOOKING_STATUSES.has(String(source.booking_status || '').toUpperCase())
    || !PANEL_RESULTABLE_INVESTIGATION_STATUSES.has(
      String(source.investigation_status || '').toUpperCase(),
    )
  ) {
    throw panelSourceMismatch();
  }
  return {
    bookingId: Number(source.booking_id),
    investigationId: Number(source.investigation_id),
    patientUid: String(source.patient_uid),
    patientName: source.patient_name ?? null,
    gender: source.gender ?? null,
    birthday: source.birthday ?? null,
    orderingClinicianUid: source.ordering_clinician_uid || null,
    investigationStatus: String(source.investigation_status).toUpperCase(),
  };
}

async function lookupReferenceRangeWithClient(
  db,
  { tenantId, testCode, sex = null, ageYears = null },
) {
  if (!testCode) return null;
  const candidates = await db.lab_reference_ranges.findMany({
    where: {
      tenant_id: tenantId,
      test_code: testCode,
      is_active: true,
    },
  });
  if (!candidates.length) return null;

  function matchesAge(row) {
    if (row.age_band_min_y == null && row.age_band_max_y == null) return null;
    if (ageYears == null) return false;
    if (row.age_band_min_y != null && ageYears < row.age_band_min_y) return false;
    if (row.age_band_max_y != null && ageYears >= row.age_band_max_y) return false;
    return true;
  }

  const scored = candidates.map((row) => {
    const sexMatch = row.sex == null ? 'generic'
      : (sex && row.sex.toUpperCase() === sex.toUpperCase()) ? 'match' : 'mismatch';
    const ageMatch = matchesAge(row);
    if (sexMatch === 'mismatch' || ageMatch === false) return { row, score: -1 };
    let score = 0;
    if (sexMatch === 'match') score += 2;
    if (ageMatch === true) score += 1;
    return { row, score };
  }).filter((candidate) => candidate.score >= 0);
  if (!scored.length) return null;
  scored.sort((left, right) => right.score - left.score);
  return scored[0].row;
}

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
  const tid = requireTenantId(tenantId);
  return lookupReferenceRangeWithClient(prisma, {
    tenantId: tid,
    testCode,
    sex,
    ageYears,
  });
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
  if (cl != null && v < cl) return 'LL';
  if (ch != null && v > ch) return 'HH';
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
 * @param {number} [args.bookingId]       booking or investigationId is required
 * @param {number} [args.investigationId]
 * @param {Date}   [args.performedAt]  defaults to now
 * @param {string} args.performedByUid  staff uid
 * @param {Array<Object>} args.analytes  [{ test_code, test_name, loinc_code?, value_numeric, value_text, unit?, comments? }]
 * @param {string} args.tenantId
 * @returns {{ panel_id, panel_code, results: Array, criticals_fired: number }}
 */
export async function recordLabPanel({
  panelCode, patientUid, bookingId = null, investigationId = null,
  performedAt = null,
  performedByUid, performedByRole = null, analytes, tenantId,
  idempotencyKey, requestBodySha256, httpIdempotencyClaimId = null,
  requestId = null,
}) {
  if (!panelCode) throw AppError.badRequest('panelCode is required');
  if (!VALID_PANEL_CODES.has(panelCode)) {
    throw AppError.badRequest(`Invalid panelCode: ${panelCode}. Must be one of: ${[...VALID_PANEL_CODES].join(', ')}`);
  }
  if (!patientUid || !UUID_PATTERN.test(String(patientUid))) {
    throw AppError.badRequest('A valid patientUid is required');
  }
  if (!performedByUid) throw AppError.badRequest('performedByUid is required');
  if (!Array.isArray(analytes) || analytes.length === 0) {
    throw AppError.badRequest('analytes must be a non-empty array');
  }
  const seenTestCodes = new Set();
  const seenLoincCodes = new Set();
  const normalizedAnalytes = analytes.map((analyte) => {
    const testCode = String(analyte?.test_code || '').trim().toUpperCase();
    const testName = String(analyte?.test_name || '').trim();
    const loincCode = analyte?.loinc_code == null
      ? null
      : String(analyte.loinc_code).trim().toUpperCase();
    if (!testCode || !testName) {
      throw AppError.badRequest('Each analyte requires test_code and test_name');
    }
    if (seenTestCodes.has(testCode) || (loincCode && seenLoincCodes.has(loincCode))) {
      throw AppError.badRequest(
        `Analyte ${testCode}: duplicate test_code or LOINC identity`,
        'LAB_PANEL_DUPLICATE_ANALYTE',
      );
    }
    seenTestCodes.add(testCode);
    if (loincCode) seenLoincCodes.add(loincCode);

    const rawText = analyte?.value_text == null ? '' : String(analyte.value_text).trim();
    const hasNumeric = analyte?.value_numeric != null
      && String(analyte.value_numeric).trim() !== '';
    if (!hasNumeric && !rawText) {
      throw AppError.badRequest(`Analyte ${testCode}: value_numeric or value_text is required`);
    }

    let valueNumeric = null;
    let valueText = rawText || null;
    if (hasNumeric) {
      valueNumeric = Number(analyte.value_numeric);
      if (!Number.isFinite(valueNumeric)) {
        throw AppError.badRequest(
          `Analyte ${testCode}: value_numeric must be finite`,
          'LAB_PANEL_INVALID_NUMERIC_VALUE',
        );
      }
      if (rawText) {
        const textNumeric = Number(rawText);
        if (!Number.isFinite(textNumeric) || textNumeric !== valueNumeric) {
          throw AppError.badRequest(
            `Analyte ${testCode}: value_text contradicts value_numeric`,
            'LAB_PANEL_VALUE_MISMATCH',
          );
        }
      } else {
        valueText = String(valueNumeric);
      }
    }

    return {
      ...analyte,
      test_code: testCode,
      test_name: testName,
      loinc_code: loincCode || null,
      value_numeric: valueNumeric,
      value_text: valueText,
      unit: analyte?.unit == null ? null : String(analyte.unit).trim() || null,
    };
  });

  const tid = requireTenantId(tenantId);
  const assertedBookingId = bookingId == null || bookingId === '' ? null : Number(bookingId);
  if (
    assertedBookingId != null
    && (
      !Number.isSafeInteger(assertedBookingId)
      || assertedBookingId <= 0
      || assertedBookingId > 2_147_483_647
    )
  ) {
    throw AppError.badRequest('bookingId must be a positive integer');
  }
  const assertedInvestigationId = investigationId == null || investigationId === ''
    ? null
    : Number(investigationId);
  if (
    assertedInvestigationId != null
    && (
      !Number.isSafeInteger(assertedInvestigationId)
      || assertedInvestigationId <= 0
      || assertedInvestigationId > 2_147_483_647
    )
  ) {
    throw AppError.badRequest('investigationId must be a positive integer');
  }
  if (assertedBookingId == null && assertedInvestigationId == null) {
    throw panelSourceRequired();
  }

  const performedAtTs = performedAt ? new Date(performedAt) : new Date();
  if (Number.isNaN(performedAtTs.getTime())) {
    throw AppError.badRequest('performedAt must be a valid date');
  }

  const phaseOne = await setTenantTx(tid, async (tx) => {
    const commandClaim = await claimLabResultIngestCommand({
      tx,
      tenantId: tid,
      actorUid: performedByUid,
      scope: 'panel_result',
      commandKey: idempotencyKey,
      requestBodySha256,
    });
    if (commandClaim.replayed) {
      const responseData = commandClaim.command.response_data;
      await finaliseHttpIdempotencyInTx({
        tx,
        claimId: httpIdempotencyClaimId,
        responseData,
        requestId,
      });
      return {
        responseData,
        criticalNotifications: [],
        replayed: true,
      };
    }

    const panelId = crypto.randomUUID();
    const source = await resolvePanelSourceTx({
      tx,
      tenantId: tid,
      assertedPatientUid: String(patientUid),
      bookingId: assertedBookingId,
      investigationId: assertedInvestigationId,
    });
    const sex = source.gender ? String(source.gender).slice(0, 1).toUpperCase() : null;
    const ageYears = source.birthday
      ? Math.max(0, Math.floor(
          (Date.now() - new Date(source.birthday).getTime()) / (365.25 * 86400000),
        ))
      : null;
    await assertConfiguredCriticalAnalytesNumeric({
      client: tx,
      tenantId: tid,
      results: normalizedAnalytes,
    });
    const enriched = [];
    for (const analyte of normalizedAnalytes) {
      const range = await lookupReferenceRangeWithClient(tx, {
        tenantId: tid,
        testCode: analyte.test_code,
        sex,
        ageYears,
      });
      const flag = computeAbnormalFlag(analyte.value_numeric, range);
      enriched.push({
        analyte,
        range,
        flag,
        referenceCriticality: referenceCriticalAssessment({ analyte, range, flag }),
      });
    }

    const rows = [];
    const criticalNotifications = [];
    for (const {
      analyte,
      range,
      flag,
      referenceCriticality,
    } of enriched) {
      const created = await tx.lab_results.create({
        data: {
          tenant_id: tid,
          booking_id: source.bookingId,
          investigation_id: source.investigationId,
          patient_uid: source.patientUid,
          patient_name: source.patientName,
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
          // Panel entry is a manual lab-authoring path. As with single-result
          // entry, only the pathologist sign-off workflow may make a result
          // final/corrected; a payload cannot bypass that release rail.
          status: 'preliminary',
          is_critical: false,
          performed_by_lab: MANUAL_PANEL_SOURCE,
          performed_at: performedAtTs,
          comments: analyte.comments ?? null,
          panel_id: panelId,
          panel_code: panelCode,
          ingest_command_id: commandClaim.command.id,
        },
      });

      const generation = await materializeLabCriticalAlertGeneration({
        tx,
        tenantId: tid,
        resultId: created.id,
        expectedPatientUid: source.patientUid,
        evaluateCriticality: async ({ tx: evaluationTx, result }) => {
          const canonicalCriticality = await evaluateCriticalThreshold({
            client: evaluationTx,
            tenantId: tid,
            result,
          });
          return assertCriticalPolicyAgreement({
            result,
            referenceAssessment: referenceCriticality,
            canonicalAssessment: canonicalCriticality,
          });
        },
        orderingClinicianUid: source.orderingClinicianUid,
        source: 'lab_panel',
      });

      const isCritical = referenceCriticality.breached;
      let recordedResult = withoutInternalCommandIdentity(created);
      if (isCritical) {
        const thresholdValue = referenceCriticality.breachedValue;
        if (
          generation?.created !== true
          || !generation.alert
          || !generation.task?.taskId
          || !generation.task?.slaInstanceId
        ) {
          throw new Error('Critical lab panel result did not materialize an exact alert/task/SLA generation');
        }
        recordedResult = { ...recordedResult, is_critical: true };
        criticalNotifications.push({
          alert: generation.alert,
          result: recordedResult,
          thresholdValue,
          assignedToUid: generation.task.assignedToUid || null,
          assignedToRole: generation.task.assignedToRole || null,
        });
      } else if (generation?.created || generation?.alert || generation?.task) {
        throw new Error('Non-critical lab panel result unexpectedly materialized critical rails');
      }

      await recordCanonicalClinicalEvent({
        tenantId: tid,
        patientUid: source.patientUid,
        encounterId: null,
        eventType: 'lab.result_recorded',
        eventSubtype: 'lab',
        eventStatus: recordedResult.status,
        sourceTable: 'lab_results',
        sourceId: String(recordedResult.id),
        resourceType: 'lab_result',
        resourceId: String(recordedResult.id),
        actorUid: String(performedByUid),
        actorRole: performedByRole || null,
        occurredAt: recordedResult.performed_at
          || recordedResult.received_at
          || recordedResult.created_at
          || null,
        visibleToPatient: false,
        summary: `Structured lab result recorded: ${recordedResult.test_name}`,
        payload: {
          panel_id: panelId,
          panel_code: panelCode,
          booking_id: source.bookingId,
          investigation_id: source.investigationId,
          test_code: recordedResult.test_code,
          test_name: recordedResult.test_name,
          value_text: recordedResult.value_text,
          unit: recordedResult.unit,
          abnormal_flag: recordedResult.abnormal_flag,
          status: recordedResult.status,
        },
        metadata: {
          panel_id: panelId,
          panel_code: panelCode,
          booking_id: source.bookingId,
          investigation_id: source.investigationId,
        },
        afterState: {
          status: recordedResult.status,
          is_critical: recordedResult.is_critical,
        },
        tags: ['lab', 'lab_result', 'lab_panel'],
        timelineIdempotencyKey: `lab_results:${recordedResult.id}:lab.result_recorded:${recordedResult.status}`,
        auditIdempotencyKey: `lab_results:${recordedResult.id}:audit:lab.result_recorded:${recordedResult.status}`,
      }, { db: tx, strict: true });
      rows.push(recordedResult);
    }

    await tx.audit_logs.create({
      data: {
        uid: performedByUid,
        action: 'RECORD_LAB_PANEL',
        resource: 'lab_results',
        resource_id: panelId,
        metadata: {
          panel_code: panelCode,
          patient_uid: source.patientUid,
          booking_id: source.bookingId,
          investigation_id: source.investigationId,
          analyte_count: rows.length,
          critical_count: enriched.filter((entry) => entry.referenceCriticality.breached).length,
        },
        ip_address: null,
      },
    });

    if (PANEL_PRE_RESULT_STATUSES.includes(source.investigationStatus)) {
      const advanced = await tx.$executeRawUnsafe(
        `UPDATE investigations
            SET status = 'IN_PROGRESS',
                result_uploaded_at = COALESCE(result_uploaded_at, NOW()),
                updated_at = NOW()
          WHERE id = $1::int
            AND tenant_id = $3::uuid
            AND status = ANY($2::text[])`,
        source.investigationId,
        PANEL_PRE_RESULT_STATUSES,
        tid,
      );
      if (Number(advanced) !== 1) {
        throw AppError.conflict(
          'Lab panel source changed before result completion',
          'LAB_PANEL_SOURCE_STATE_CHANGED',
        );
      }
    }

    const responseData = {
      panel_id: panelId,
      panel_code: panelCode,
      results: rows,
      criticals_fired: criticalNotifications.length,
    };
    await completeLabResultIngestCommand({
      tx,
      tenantId: tid,
      commandId: commandClaim.command.id,
      resultIds: rows.map((row) => row.id),
      panelId,
      responseData,
    });
    await finaliseHttpIdempotencyInTx({
      tx,
      claimId: httpIdempotencyClaimId,
      responseData,
      requestId,
    });

    return { responseData, criticalNotifications, replayed: false };
  });

  for (const critical of phaseOne.criticalNotifications) {
    const alertBody = `${critical.result.test_name} = ${critical.result.value_text ?? critical.result.value_numeric ?? ''}${critical.result.unit ? ` ${critical.result.unit}` : ''} (threshold ${critical.result.abnormal_flag} ${critical.thresholdValue}).`;
    try {
      await sendStaffNotifications({
        tenantId: tid,
        recipientUids: critical.assignedToUid ? [critical.assignedToUid] : [],
        recipientRoles: critical.assignedToRole ? [critical.assignedToRole] : [],
        title: `CRITICAL lab: ${critical.result.test_name}`,
        body: alertBody,
        type: 'LAB_CRITICAL_ALERT',
        priority: 'HIGH',
        relatedId: critical.alert.id,
        data: {
          panel_id: phaseOne.responseData.panel_id,
          result_id: critical.result.id,
          alert_id: critical.alert.id,
          patient_uid: critical.result.patient_uid,
          threshold: critical.thresholdValue,
        },
        dedupe: true,
      });
    } catch (err) {
      logger.warn('Structured lab-panel critical notification failed after commit', {
        alertId: critical.alert.id,
        error: err?.message,
      });
    }
  }

  logger.info('Structured lab panel recorded', {
    tenantId: tid,
    panelCode,
    panelId: phaseOne.responseData.panel_id,
    analyteCount: phaseOne.responseData.results.length,
    criticalCount: phaseOne.criticalNotifications.length,
    replayed: phaseOne.replayed,
  });
  return phaseOne.responseData;
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
  const tid = requireTenantId(tenantId);
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
  const tid = requireTenantId(tenantId);
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
  const tid = requireTenantId(tenantId);
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
  const tid = requireTenantId(tenantId);
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
  const tid = requireTenantId(tenantId);
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
