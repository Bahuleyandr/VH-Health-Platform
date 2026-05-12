// src/services/lab/labResultsService.js
//
// Sprint 3 — Lab results ingestion + critical alerts + pathologist
// worklist. Persists ORU^R01 messages from analyzers into lab_results,
// fires critical alerts based on lab_critical_thresholds, and exposes
// the pathologist sign-off workflow.

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { parseHL7 } from '../hl7/hl7Parser.js';
import { AppError } from '../../utils/AppError.js';
import { canSignOffLabResults } from '../../utils/roleHelpers.js';

function asNumericOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const CRITICAL_THRESHOLD_ALIASES = [
  {
    testCodes: ['TROP', 'TROPI'],
    loincCodes: ['6598-7', '10839-9'],
  },
];

function criticalThresholdLookupKeys(result) {
  const loincCodes = new Set();
  const testCodes = new Set();
  const loinc = result.loinc_code ? String(result.loinc_code).trim() : null;
  const testCode = result.test_code ? String(result.test_code).trim().toUpperCase() : null;

  if (loinc) loincCodes.add(loinc);
  if (testCode) testCodes.add(testCode);

  for (const alias of CRITICAL_THRESHOLD_ALIASES) {
    if (
      (loinc && alias.loincCodes.includes(loinc)) ||
      (testCode && alias.testCodes.includes(testCode))
    ) {
      alias.loincCodes.forEach((code) => loincCodes.add(code));
      alias.testCodes.forEach((code) => testCodes.add(code));
    }
  }

  return { loincCodes: [...loincCodes], testCodes: [...testCodes] };
}

/**
 * Parse an HL7 ORU^R01 message and persist its OBX rows into
 * lab_results. Returns the created result rows + any critical alerts
 * that fired.
 *
 * Maps each OBX to a lab_results row. Looks up the patient by
 * `patient_uid` (preferred) or by phone via PID-13 fallback.
 *
 * The booking_id linkage is best-effort: ORC-2 (placer order number)
 * is used as a key; if it matches an investigation_bookings.id we
 * link, otherwise we leave booking_id null and rely on patient_uid.
 *
 * Critical detection runs synchronously after persist; we don't fan
 * out notifications here (notification fan-out is the alert
 * consumer's job — see lab_critical_alerts subscribers).
 */
export async function ingestOruMessage(message, { tenantId, source }) {
  if (!message) throw AppError.badRequest('HL7 message is required');
  const parsed = parseHL7(message);
  if (!parsed.msh) throw AppError.badRequest('Missing MSH segment');
  const messageType = parsed.msh.messageType || '';
  if (!messageType.startsWith('ORU')) {
    throw AppError.badRequest(`Expected ORU message, got ${messageType}`);
  }

  const messageControlId = parsed.msh.messageControlId || null;
  const sendingApp = parsed.msh.sendingApp || source || null;

  // Patient identification — PID
  const patientUid = parsed.pid?.patientId || parsed.pid?.uid;
  if (!patientUid) throw AppError.badRequest('Missing patient identifier (PID-3)');
  const patientName = parsed.pid?.name || null;

  // Order linkage — ORC-2 (placer order number) → investigation_bookings
  let bookingId = null;
  const placerOrderId = parsed.orc?.placerOrderNumber;
  if (placerOrderId && /^\d+$/.test(String(placerOrderId))) {
    const matches = await prisma.$queryRawUnsafe(
      `SELECT id FROM investigation_bookings WHERE id = $1::int LIMIT 1`,
      Number(placerOrderId),
    );
    if (matches.length) bookingId = matches[0].id;
  }

  const obxRows = parsed.obx || [];
  if (!obxRows.length) {
    return { results: [], alerts: [], message: 'No OBX segments — nothing persisted' };
  }

  const results = [];
  for (const obx of obxRows) {
    const numeric = asNumericOrNull(obx.value);
    const r = await prisma.$queryRawUnsafe(
      `INSERT INTO lab_results
        (tenant_id, booking_id, patient_uid, patient_name,
         hl7_message_id, hl7_segment_index,
         loinc_code, test_code, test_name,
         value_text, value_numeric, unit, reference_range,
         abnormal_flag, status, performed_by_lab, performed_at, raw_obx)
       VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10,
               $11, $12, $13, $14, $15, $16, $17, $18)
       RETURNING *`,
      tenantId,
      bookingId,
      patientUid,
      patientName,
      messageControlId,
      obx.setId ? Number(obx.setId) : null,
      obx.observationIdentifier?.code || null,
      obx.observationIdentifier?.localCode || obx.observationIdentifier?.code || 'UNKNOWN',
      obx.observationIdentifier?.text || obx.observationIdentifier?.localText || 'Unknown analyte',
      obx.value || null,
      numeric,
      obx.units || null,
      obx.referenceRange || null,
      obx.abnormalFlags || null,
      obx.observationResultStatus === 'F' ? 'final' : 'preliminary',
      sendingApp,
      obx.observationDateTime || null,
      obx.raw || null,
    );
    results.push(r[0]);
  }

  // Critical detection
  const alerts = await detectCriticalsForResults({ tenantId, results });

  logger.info(`[lab] Ingested ORU ${messageControlId}: ${results.length} results, ${alerts.length} criticals`);
  return { results, alerts, messageControlId, bookingId };
}

/**
 * For each result row, look up the matching threshold (preferring
 * LOINC, falling back to test_code) and create a critical alert if
 * the value is out of bounds. Marks the lab_results row is_critical.
 */
export async function detectCriticalsForResults({ tenantId, results }) {
  const alerts = [];
  for (const r of results) {
    if (r.value_numeric == null) continue;

    const { loincCodes, testCodes } = criticalThresholdLookupKeys(r);
    const ths = await prisma.$queryRawUnsafe(
      `SELECT critical_low, critical_high, test_name
         FROM lab_critical_thresholds
        WHERE tenant_id = $1::uuid
          AND is_active = true
          AND (
            (loinc_code IS NOT NULL AND loinc_code = ANY($2::text[])) OR
            (test_code IS NOT NULL AND UPPER(test_code) = ANY($3::text[]))
          )
        ORDER BY
          CASE
            WHEN loinc_code = $4 THEN 0
            WHEN UPPER(test_code) = $5 THEN 1
            WHEN loinc_code = ANY($2::text[]) THEN 2
            ELSE 3
          END,
          id ASC
        LIMIT 1`,
      tenantId, loincCodes, testCodes,
      r.loinc_code || null,
      r.test_code ? String(r.test_code).trim().toUpperCase() : null,
    );
    if (!ths.length) continue;
    const { critical_low: lo, critical_high: hi } = ths[0];
    let breachedSide = null;
    let breachedValue = null;
    const v = Number(r.value_numeric);
    if (lo != null && v < Number(lo)) {
      breachedSide = 'low';
      breachedValue = Number(lo);
    } else if (hi != null && v > Number(hi)) {
      breachedSide = 'high';
      breachedValue = Number(hi);
    }
    if (!breachedSide) continue;

    // Mark the result + create the alert.
    await prisma.$executeRawUnsafe(
      `UPDATE lab_results SET is_critical = true, updated_at = NOW() WHERE id = $1::int`,
      r.id,
    );
    r.is_critical = true;

    const alert = await prisma.$queryRawUnsafe(
      `INSERT INTO lab_critical_alerts
        (tenant_id, result_id, patient_uid, test_name, value_text,
         value_numeric, unit, threshold_breached, threshold_value)
       VALUES ($1::uuid, $2::int, $3::uuid, $4, $5, $6::numeric, $7, $8, $9::numeric)
       RETURNING *`,
      tenantId, r.id, r.patient_uid, r.test_name, r.value_text,
      v, r.unit, breachedSide, breachedValue,
    );
    alerts.push(alert[0]);

    // E-5 — push the critical alert to the ordering doctor (and any
    // other staff who should know). Best-effort; failure here doesn't
    // abort the result write because the alert row itself is the
    // canonical record. Finding:
    // 2026-05-08-emergency-walk-in-lab-tech-critical-alert-no-push.
    try {
      const { default: outbox } = await import('../../utils/notifications/notificationOutbox.js');
      const recipients = await prisma.$queryRawUnsafe(
        `SELECT DISTINCT u.id, u.phone, u.name
           FROM users u
          WHERE u.uid IN (
                  SELECT DISTINCT requested_by FROM investigations
                   WHERE patient_uid = $1::uuid
                     AND status NOT IN ('CANCELLED')
                  UNION
                  SELECT DISTINCT attending_doctor FROM admissions
                   WHERE patient_uid = $1::uuid
                     AND status IN ('admitted', 'transferred')
                )
            AND u.phone IS NOT NULL
          LIMIT 5`,
        r.patient_uid,
      );
      for (const recipient of recipients) {
        await outbox.queue({
          type: 'lab_critical_alert',
          recipientId: recipient.id,
          recipientPhone: recipient.phone,
          title: `CRITICAL lab: ${r.test_name}`,
          body: `${r.test_name} = ${r.value_text}${r.unit ? ' ' + r.unit : ''} (threshold ${breachedSide} ${breachedValue}). Patient: ${r.patient_uid}.`,
          data: {
            result_id: r.id,
            alert_id: alert[0].id,
            patient_uid: r.patient_uid,
            breachedSide,
            value: v,
            threshold: breachedValue,
          },
        }).catch((e) => logger.warn(`Critical lab alert notify failed: ${e.message}`));
      }
    } catch (e) {
      logger.warn(`Critical lab alert push hook failed: ${e?.message}`);
    }
  }
  return alerts;
}

// ── Manual entry path (when an analyzer doesn't speak HL7) ────────────

export async function recordResultManual({ tenantId, performed_by, result }) {
  const fields = [
    'booking_id', 'patient_uid', 'patient_name', 'loinc_code',
    'test_code', 'test_name', 'value_text', 'unit', 'reference_range',
    'abnormal_flag', 'status', 'comments',
  ];
  for (const f of ['patient_uid', 'test_code', 'test_name']) {
    if (!result[f]) throw AppError.badRequest(`${f} is required`);
  }
  // B-3 — lab techs cannot finalise a result by setting status='final'
  // in the manual-entry payload. The signoff path is the only way to
  // flip the status, and that path checks pathologist tier. The caller-
  // supplied status is downgraded to 'preliminary' here. Findings:
  // 2026-05-08-inpatient-admission-lab-tech-results-final-without-verification
  // 2026-05-08-inpatient-admission-lab-tech-signoff-no-pathologist-tier-check
  const sanitised = { ...result };
  if (sanitised.status === 'final' || sanitised.status === 'corrected') {
    sanitised.status = 'preliminary';
  }
  const values = fields.map((f) => sanitised[f] ?? null);
  const numeric = asNumericOrNull(sanitised.value_text);
  values.push(numeric, performed_by ? String(performed_by) : null, tenantId);

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO lab_results
      (booking_id, patient_uid, patient_name, loinc_code, test_code,
       test_name, value_text, unit, reference_range, abnormal_flag,
       status, comments, value_numeric, performed_by_lab, tenant_id)
     VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
             $13::numeric, $14, $15::uuid)
     RETURNING *`,
    ...values,
  );
  const created = rows[0];
  const alerts = await detectCriticalsForResults({ tenantId, results: [created] });
  return { result: created, alerts };
}

// ── Pathologist worklist ──────────────────────────────────────────────

export async function listPendingSignOff({ tenantId, limit = 100 }) {
  return prisma.$queryRawUnsafe(
    `SELECT id, booking_id, patient_uid, patient_name, test_code, test_name,
            value_text, unit, reference_range, abnormal_flag, is_critical,
            received_at, status
       FROM lab_results
      WHERE tenant_id = $1::uuid
        AND signed_off_at IS NULL
        AND status IN ('preliminary', 'final')
      ORDER BY is_critical DESC, received_at ASC
      LIMIT $2::int`,
    tenantId, Number(limit),
  );
}

export async function signOffResults({
  tenantId, signed_off_by, signed_off_by_role, signed_off_by_name,
  signed_off_by_reg, result_ids, decision = 'verified', comments,
  booking_id, patient_uid,
}) {
  if (!Array.isArray(result_ids) || !result_ids.length) {
    throw AppError.badRequest('result_ids[] is required');
  }
  if (!signed_off_by) throw AppError.badRequest('signed_off_by is required');
  // B-3 — pathologist tier check. The route layer also checks but the
  // service guards independently in case a future caller bypasses the
  // route (cron, internal script). Findings:
  // 2026-05-08-inpatient-admission-lab-tech-signoff-no-pathologist-tier-check.
  if (!canSignOffLabResults(signed_off_by_role)) {
    throw AppError.forbidden(
      `Lab signoff requires pathologist tier (got role=${signed_off_by_role || 'unknown'})`,
      'PATHOLOGIST_REQUIRED',
    );
  }

  // Verify ownership: all results must belong to the tenant.
  const ids = result_ids.map(Number).filter(Boolean);
  const owned = await prisma.$queryRawUnsafe(
    `SELECT id, patient_uid, booking_id FROM lab_results
      WHERE id = ANY($1::int[]) AND tenant_id = $2::uuid`,
    ids, tenantId,
  );
  if (owned.length !== ids.length) {
    throw AppError.badRequest('Some result_ids are not in this tenant');
  }

  // Insert sign-off record.
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO lab_pathologist_signoffs
      (tenant_id, booking_id, patient_uid, result_ids, signed_off_by,
       signed_off_by_name, signed_off_by_reg, decision, comments)
     VALUES ($1::uuid, $2, $3::uuid, $4::int[], $5::uuid, $6, $7, $8, $9)
     RETURNING *`,
    tenantId,
    booking_id ? Number(booking_id) : null,
    patient_uid || owned[0].patient_uid,
    ids, String(signed_off_by), signed_off_by_name || null,
    signed_off_by_reg || null, decision, comments || null,
  );

  // Stamp signed_off on the result rows.
  await prisma.$executeRawUnsafe(
    `UPDATE lab_results
        SET signed_off_at = NOW(),
            signed_off_by = $1::uuid,
            status = CASE WHEN $2 = 'verified' THEN 'final' ELSE status END,
            updated_at = NOW()
      WHERE id = ANY($3::int[]) AND tenant_id = $4::uuid`,
    String(signed_off_by), decision, ids, tenantId,
  );

  return rows[0];
}

// ── Critical-alert acknowledgement workflow ───────────────────────────

export async function listOpenCriticalAlerts({ tenantId, limit = 50 }) {
  return prisma.$queryRawUnsafe(
    `SELECT id, result_id, patient_uid, test_name, value_text,
            value_numeric, unit, threshold_breached, threshold_value, fired_at
       FROM lab_critical_alerts
      WHERE tenant_id = $1::uuid AND acknowledged_at IS NULL
      ORDER BY fired_at DESC
      LIMIT $2::int`,
    tenantId, Number(limit),
  );
}

export async function acknowledgeAlert(alertId, {
  acknowledged_by, acknowledged_by_name, read_back_method, notes,
}) {
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE lab_critical_alerts
        SET acknowledged_at = NOW(),
            acknowledged_by = $1::uuid,
            acknowledged_by_name = $2,
            read_back_method = $3,
            notes = COALESCE($4, notes)
      WHERE id = $5::int AND acknowledged_at IS NULL
      RETURNING *`,
    String(acknowledged_by), acknowledged_by_name || null,
    read_back_method || null, notes || null, Number(alertId),
  );
  if (!rows.length) throw AppError.notFound('Alert not found or already acknowledged');
  return rows[0];
}

export async function getResultsForBooking({ tenantId, booking_id }) {
  return prisma.$queryRawUnsafe(
    `SELECT * FROM lab_results
      WHERE tenant_id = $1::uuid AND booking_id = $2::int
      ORDER BY received_at ASC, hl7_segment_index ASC`,
    tenantId, Number(booking_id),
  );
}

export async function getResultsForPatient({ tenantId, patient_uid, limit = 200 }) {
  return prisma.$queryRawUnsafe(
    `SELECT * FROM lab_results
      WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid
      ORDER BY received_at DESC
      LIMIT $3::int`,
    tenantId, String(patient_uid), Number(limit),
  );
}

/**
 * E-5 — IPD lab worklist. Pending lab orders for currently-admitted
 * patients only. Joins investigations -> admissions(active) so the
 * lab tech sees only inpatients, not the OPD walk-ins. Finding:
 * 2026-05-08-inpatient-admission-lab-tech-ipd-orders-not-on-worklist.
 */
export async function listIpdLabWorklist({ tenantId, limit = 100 } = {}) {
  const lim = Math.max(1, Math.min(500, Number(limit) || 100));
  return prisma.$queryRawUnsafe(
    `SELECT i.id, i.test_name, i.test_type, i.status, i.priority,
            i.requested_at, i.created_at,
            u.name AS patient_name, u.phone AS patient_phone, u.uid AS patient_uid,
            a.id AS admission_id, a.ward, a.bed_number, a.room_category,
            a.attending_doctor
       FROM investigations i
       JOIN users u ON u.id = i.patient_id
       JOIN admissions a ON a.patient_uid = u.uid
            AND a.status IN ('admitted', 'transferred')
      WHERE i.status NOT IN ('COMPLETED', 'CANCELLED')
      ORDER BY
        CASE i.priority WHEN 'URGENT' THEN 1 WHEN 'HIGH' THEN 2
                       WHEN 'NORMAL' THEN 3 ELSE 4 END,
        i.requested_at ASC
      LIMIT $1::int`,
    lim,
  );
}
