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
import { normalizePhone } from '../../utils/phoneUtils.js';

function asNumericOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeLabUnit(unit) {
  if (unit == null || unit === '') return '';
  return String(unit)
    .trim()
    .toLowerCase()
    .replace(/μ/g, 'u')
    .replace(/µ/g, 'u')
    .replace(/\s+/g, '');
}

function valueForCriticalThreshold(value, resultUnit, thresholdUnit) {
  const v = Number(value);
  const result = normalizeLabUnit(resultUnit);
  const threshold = normalizeLabUnit(thresholdUnit);
  const thresholdIsThousandsPerMicroliter = ['10^3/ul', 'x10^3/ul', '10^9/l'].includes(threshold);
  const resultIsPerMicroliter = ['/ul', 'cells/ul', 'count/ul'].includes(result);

  if (thresholdIsThousandsPerMicroliter && resultIsPerMicroliter) {
    return v / 1000;
  }
  return v;
}

// Stage-3 chip G — investigations.status values from which the order
// is considered "pre-result" and should advance to IN_PROGRESS once a
// lab_results row is filed. Terminal states (COMPLETED/CANCELLED) and
// already-running (IN_PROGRESS) are left alone. See migration 217.
const INVESTIGATION_PRE_RESULT_STATUSES = ['REQUESTED', 'PENDING', 'SCHEDULED', 'COLLECTED'];

async function resolveInvestigationIdForBooking(client, bookingId) {
  if (bookingId == null) return null;
  const rows = await client.$queryRawUnsafe(
    `SELECT investigation_id FROM investigation_bookings WHERE id = $1 LIMIT 1`,
    Number(bookingId),
  );
  return rows[0]?.investigation_id ?? null;
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

  // Order linkage — ORC-2 (placer order number) → investigation_bookings,
  // then bookings.investigation_id → investigations. Investigation
  // linkage on the result row lets us advance investigations.status
  // out of REQUESTED on result entry (chip-G / migration 217).
  let bookingId = null;
  const placerOrderId = parsed.orc?.placerOrderNumber;
  if (placerOrderId && /^\d+$/.test(String(placerOrderId))) {
    const matches = await prisma.$queryRawUnsafe(
      `SELECT id, investigation_id FROM investigation_bookings WHERE id = $1::int LIMIT 1`,
      Number(placerOrderId),
    );
    if (matches.length) bookingId = matches[0].id;
  }
  const investigationId = await resolveInvestigationIdForBooking(prisma, bookingId);

  const obxRows = parsed.obx || [];
  if (!obxRows.length) {
    return { results: [], alerts: [], message: 'No OBX segments — nothing persisted' };
  }

  const results = [];
  for (const obx of obxRows) {
    const numeric = asNumericOrNull(obx.value);
    const r = await prisma.$queryRawUnsafe(
      `INSERT INTO lab_results
        (tenant_id, booking_id, investigation_id, patient_uid, patient_name,
         hl7_message_id, hl7_segment_index,
         loinc_code, test_code, test_name,
         value_text, value_numeric, unit, reference_range,
         abnormal_flag, status, performed_by_lab, performed_at, raw_obx)
       VALUES ($1::uuid, $2, $3, $4::uuid, $5, $6, $7, $8, $9, $10,
               $11, $12, $13, $14, $15, $16, $17, $18, $19)
       RETURNING *`,
      tenantId,
      bookingId,
      investigationId,
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

  if (investigationId != null) {
    await prisma.$executeRawUnsafe(
      `UPDATE investigations
          SET status = 'IN_PROGRESS',
              result_uploaded_at = COALESCE(result_uploaded_at, NOW()),
              updated_at = NOW()
        WHERE id = $1
          AND status = ANY($2::text[])`,
      investigationId,
      INVESTIGATION_PRE_RESULT_STATUSES,
    );
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
      `SELECT critical_low, critical_high, test_name, unit
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
    const { critical_low: lo, critical_high: hi, unit: thresholdUnit } = ths[0];
    let breachedSide = null;
    let breachedValue = null;
    const v = valueForCriticalThreshold(r.value_numeric, r.unit, thresholdUnit);
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
    // canonical record. Recipient sources, in order of clinical relevance:
    //   - investigations.requested_by (OPD/IPD lab orders)
    //   - clinical_orders.ordered_by (ER orders — stored separately)
    //   - admissions.attending_doctor (currently admitted)
    //   - emergency_visits.attending_doctor_uid (active ER visit)
    // Findings:
    //   2026-05-08-emergency-walk-in-lab-tech-critical-alert-no-push
    //   2026-05-09-emergency-walk-in-lab-tech-critical-alert-no-er-notification
    try {
      const { default: outbox } = await import('../../utils/notifications/notificationOutbox.js');
      const recipients = await prisma.$queryRawUnsafe(
        `SELECT DISTINCT u.id, u.uid, u.phone, u.name
           FROM users u
          WHERE u.uid IN (
                  SELECT DISTINCT requested_by FROM investigations
                   WHERE patient_uid = $1::uuid
                     AND requested_by IS NOT NULL
                     AND status NOT IN ('CANCELLED')
                  UNION
                  SELECT DISTINCT ordered_by FROM clinical_orders
                   WHERE patient_uid = $1::uuid
                     AND ordered_by IS NOT NULL
                     AND status NOT IN ('cancelled')
                  UNION
                  SELECT DISTINCT attending_doctor FROM admissions
                   WHERE patient_uid = $1::uuid
                     AND attending_doctor IS NOT NULL
                     AND status IN ('admitted', 'transferred')
                  UNION
                  SELECT DISTINCT attending_doctor_uid FROM emergency_visits
                   WHERE patient_uid = $1::uuid
                     AND attending_doctor_uid IS NOT NULL
                     AND status NOT IN ('discharged', 'left_without_being_seen')
                )
            AND u.phone IS NOT NULL
          LIMIT 10`,
        r.patient_uid,
      );
      const alertTitle = `CRITICAL lab: ${r.test_name}`;
      const alertBody = `${r.test_name} = ${r.value_text}${r.unit ? ' ' + r.unit : ''} (threshold ${breachedSide} ${breachedValue}). Patient: ${r.patient_uid}.`;
      const alertData = {
        result_id: r.id,
        alert_id: alert[0].id,
        patient_uid: r.patient_uid,
        breachedSide,
        value: v,
        threshold: breachedValue,
      };
      for (const recipient of recipients) {
        // External delivery queue (FCM/SMS retry) — see notificationOutbox.js.
        await outbox.queue({
          type: 'lab_critical_alert',
          recipientId: recipient.id,
          recipientPhone: recipient.phone,
          title: alertTitle,
          body: alertBody,
          data: alertData,
        }).catch((e) => logger.error(`Critical lab alert outbox queue failed for user ${recipient.id}: ${e.message}`));

        // In-app feed row — what GET /api/v1/notifications/my reads via
        // notificationService.getNotificationsByPhone (matches on
        // normalizePhone(users.phone)). The outbox alone is invisible to
        // the doctor's feed because the feed reads `notifications`, not
        // `notification_outbox`. See finding
        // 2026-05-13-emergency-walk-in-lab-tech-1e24f95f.
        try {
          await prisma.$executeRawUnsafe(
            `INSERT INTO notifications
               (uid, user_id, phone, title, body, type, priority,
                data, is_read, created_at, updated_at)
             VALUES ($1::uuid, $2::int, $3, $4, $5, 'lab_critical_alert',
                     'HIGH', $6::jsonb, false, NOW(), NOW())`,
            recipient.uid,
            recipient.id,
            normalizePhone(recipient.phone),
            alertTitle,
            alertBody,
            JSON.stringify(alertData),
          );
        } catch (e) {
          // logger.error (not warn) because a missing in-app row leaves a
          // patient-safety alert invisible to the treating doctor.
          logger.error(`Critical lab alert in-app feed insert failed for user ${recipient.id}: ${e.message}`);
        }
      }
    } catch (e) {
      logger.error(`Critical lab alert recipient fan-out failed for result ${r.id}: ${e?.message}`);
    }
  }
  return alerts;
}

// ── Manual entry path (when an analyzer doesn't speak HL7) ────────────

export async function recordResultManual({ tenantId, performed_by, result }) {
  const fields = [
    'booking_id', 'investigation_id', 'patient_uid', 'patient_name', 'loinc_code',
    'test_code', 'test_name', 'value_text', 'unit', 'reference_range',
    'reference_range_low', 'reference_range_high',
    'abnormal_flag', 'status', 'comments',
  ];
  for (const f of ['patient_uid', 'test_code', 'test_name']) {
    if (!result[f]) throw AppError.badRequest(`${f} is required`);
  }
  // value_text is required — a result row with no value is not a result.
  // Previously the column was nullable in the payload and the row would
  // be inserted with value_text=null + value_numeric=null, which the
  // critical-detection loop silently skips (it gates on value_numeric).
  // That manifested as "lab endpoint accepts garbage, never fires
  // critical alerts" — see finding
  // 2026-05-08-lab-walk-in-lab-tech-results-no-validation-no-critical-alert.
  if (result.value_text === undefined || result.value_text === null
      || String(result.value_text).trim() === '') {
    throw AppError.badRequest('value_text is required');
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
  // lab_results.status is NOT NULL with a DB default of 'preliminary'; an
  // explicit INSERT that lists the column overrides the default, so an
  // omitted caller status would have landed null and tripped 23502.
  // Mirror the DB default in the service so the route caller doesn't
  // need to know the storage detail.
  if (sanitised.status === undefined || sanitised.status === null
      || sanitised.status === '') {
    sanitised.status = 'preliminary';
  }
  const numeric = asNumericOrNull(sanitised.value_text);

  // If the test has a configured critical threshold (LOINC or test_code
  // match in lab_critical_thresholds), a non-numeric value_text is
  // unacceptable — the critical-detection loop only fires when
  // value_numeric is set, so accepting "elevated" / "positive" /
  // free-text for a troponin or potassium would silently bypass the
  // critical-value alarm. Reject up-front so the lab tech corrects
  // the entry instead of losing the alert. Free-text values remain
  // valid for tests without a configured threshold (cultures,
  // microscopy, etc.). Finding:
  // 2026-05-08-lab-walk-in-lab-tech-results-no-validation-no-critical-alert.
  if (numeric === null) {
    const { loincCodes, testCodes } = criticalThresholdLookupKeys(sanitised);
    const thresholdRows = await prisma.$queryRawUnsafe(
      `SELECT 1
         FROM lab_critical_thresholds
        WHERE tenant_id = $1::uuid
          AND is_active = true
          AND (
            (loinc_code IS NOT NULL AND loinc_code = ANY($2::text[])) OR
            (test_code IS NOT NULL AND UPPER(test_code) = ANY($3::text[]))
          )
        LIMIT 1`,
      tenantId, loincCodes, testCodes,
    );
    if (thresholdRows.length > 0) {
      throw AppError.badRequest(
        `value_text for ${sanitised.test_code || sanitised.loinc_code || 'this test'} must be numeric — a configured critical threshold cannot be evaluated against a free-text value.`,
        'NON_NUMERIC_FOR_CRITICAL_THRESHOLD',
      );
    }
  }

  // Resolve investigation_id: explicit > booking_id lookup. The result
  // row needs an FK back to the doctor's order so investigations.status
  // can advance and the lab worklist can drop the fulfilled order
  // (chip-G / migration 217 / finding
  // 2026-05-09-inpatient-admission-lab-tech-no-investigation-result-linkage).
  let resolvedInvestigationId = sanitised.investigation_id != null
    ? Number(sanitised.investigation_id)
    : null;
  if (resolvedInvestigationId == null && sanitised.booking_id != null) {
    resolvedInvestigationId = await resolveInvestigationIdForBooking(prisma, sanitised.booking_id);
  }
  sanitised.investigation_id = Number.isFinite(resolvedInvestigationId)
    ? resolvedInvestigationId : null;

  const values = fields.map((f) => sanitised[f] ?? null);
  values.push(numeric, performed_by ? String(performed_by) : null, tenantId);

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO lab_results
      (booking_id, investigation_id, patient_uid, patient_name, loinc_code, test_code,
       test_name, value_text, unit, reference_range,
       reference_range_low, reference_range_high,
       abnormal_flag, status, comments, value_numeric, performed_by_lab, tenant_id)
     VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10,
             $11::numeric, $12::numeric,
             $13, $14, $15, $16::numeric, $17, $18::uuid)
     RETURNING *`,
    ...values,
  );
  const created = rows[0];

  if (created.investigation_id != null) {
    await prisma.$executeRawUnsafe(
      `UPDATE investigations
          SET status = 'IN_PROGRESS',
              result_uploaded_at = COALESCE(result_uploaded_at, NOW()),
              updated_at = NOW()
        WHERE id = $1
          AND status = ANY($2::text[])`,
      created.investigation_id,
      INVESTIGATION_PRE_RESULT_STATUSES,
    );
  }

  const alerts = await detectCriticalsForResults({ tenantId, results: [created] });

  // detectCriticalsForResults UPDATEs lab_results.is_critical as a side
  // effect when a threshold breach fires. The `created` row returned
  // here is the pre-update snapshot from the INSERT, so without re-
  // reading it would expose is_critical=false to clients even when an
  // alert just fired — a mobile app or QA tool inspecting `result.is_critical`
  // alone would miss the panic value. Re-read so the response reflects
  // post-detection state. Finding:
  // 2026-05-09-obstetric-anc-lab-tech-critical-flag-stale-in-response.
  let finalResult = created;
  if (alerts.length > 0) {
    const refreshed = await prisma.$queryRawUnsafe(
      `SELECT * FROM lab_results WHERE id = $1::int LIMIT 1`,
      created.id,
    );
    if (refreshed.length) finalResult = refreshed[0];
  }

  return { result: finalResult, alerts };
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

  // Tell the patient (and the guardian, for a dependent minor) that their
  // verified results are ready to view. Until now nothing notified the
  // patient on sign-off — only the critical-alert path fires, and that
  // targets the ordering clinician, so a patient whose results were
  // finalised was never told they could view them. Best-effort: a
  // notification failure must never abort the sign-off (the result rows are
  // the canonical record). Guardian fan-out mirrors the dependent-minor
  // model from migration 202 (users.guardian_user_id).
  // Finding 2026-05-21-lab-walk-in-lab-tech-65aded1a.
  if (decision === 'verified') {
    try {
      const resultPatientUid = patient_uid || owned[0].patient_uid;
      const recipients = await prisma.$queryRawUnsafe(
        `SELECT u.id, u.uid, u.phone, u.name, false AS is_guardian
           FROM users u
          WHERE u.uid = $1::uuid AND u.phone IS NOT NULL
          UNION
         SELECT g.id, g.uid, g.phone, g.name, true AS is_guardian
           FROM users p
           JOIN users g ON g.id = p.guardian_user_id
          WHERE p.uid = $1::uuid AND g.phone IS NOT NULL`,
        resultPatientUid,
      );
      const { default: outbox } = await import('../../utils/notifications/notificationOutbox.js');
      const title = 'Lab results ready';
      const count = ids.length;
      const noun = count === 1 ? 'result' : 'results';
      const data = {
        booking_id: booking_id ? Number(booking_id) : null,
        result_ids: ids,
        patient_uid: resultPatientUid,
      };
      for (const rcpt of recipients) {
        const body = rcpt.is_guardian
          ? `Lab ${noun} for your dependent are ready to view (${count}).`
          : `Your lab ${noun} are ready to view (${count}).`;
        await outbox.queue({
          type: 'lab_result_ready',
          recipientId: rcpt.id,
          recipientPhone: rcpt.phone,
          title,
          body,
          data,
        }).catch((e) => logger.warn(`Lab result-ready outbox queue failed for user ${rcpt.id}: ${e.message}`));

        // In-app feed row — what GET /api/v1/notifications/my reads.
        try {
          await prisma.$executeRawUnsafe(
            `INSERT INTO notifications
               (uid, user_id, phone, title, body, type, priority,
                data, is_read, created_at, updated_at)
             VALUES ($1::uuid, $2::int, $3, $4, $5, 'lab_result_ready',
                     'NORMAL', $6::jsonb, false, NOW(), NOW())`,
            rcpt.uid, rcpt.id, normalizePhone(rcpt.phone),
            title, body, JSON.stringify(data),
          );
        } catch (e) {
          logger.warn(`Lab result-ready in-app insert failed for user ${rcpt.id}: ${e.message}`);
        }
      }
    } catch (e) {
      logger.warn(`Lab result-ready notification fan-out failed: ${e?.message}`);
    }
  }

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

export async function getResultsForPatient({
  tenantId, patient_uid, limit = 200, include_preliminary = false,
}) {
  // Wave-2 fix: a preliminary (unsigned) lab result is medico-legally
  // unverified and must not be returned on the patient-lookup read API
  // unless the caller explicitly asks for it via include_preliminary.
  // Every returned row now carries `verified` so any consumer (patient
  // app, clinical UI) can plainly distinguish signed from unsigned.
  // Finding:
  // 2026-05-09-inpatient-admission-lab-tech-preliminary-results-visible-before-signoff.
  const wantPreliminary = include_preliminary === true
    || include_preliminary === 'true'
    || include_preliminary === 1
    || include_preliminary === '1';
  const filters = ['tenant_id = $1::uuid', 'patient_uid = $2::uuid'];
  if (!wantPreliminary) {
    filters.push(`status NOT IN ('preliminary')`);
    filters.push('signed_off_at IS NOT NULL');
  }
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, tenant_id, booking_id, patient_uid, patient_name,
            hl7_message_id, hl7_segment_index,
            loinc_code, test_code, test_name,
            value_text, value_numeric, unit, reference_range,
            abnormal_flag, status, is_critical,
            performed_by_lab, performed_at, received_at,
            signed_off_at, signed_off_by,
            comments, raw_obx, panel_id, panel_code,
            reference_range_low, reference_range_high,
            created_at, updated_at
       FROM lab_results
      WHERE ${filters.join(' AND ')}
      ORDER BY received_at DESC
      LIMIT $3::int`,
    tenantId, String(patient_uid), Number(limit),
  );
  return rows.map((r) => ({
    ...r,
    verified: r.status === 'final' && r.signed_off_at != null,
  }));
}

/**
 * E-5 — IPD lab worklist. Pending lab orders for currently-admitted
 * patients only. Joins investigations -> admissions(active) so the
 * lab tech sees only inpatients, not the OPD walk-ins. Finding:
 * 2026-05-08-inpatient-admission-lab-tech-ipd-orders-not-on-worklist.
 *
 * Excludes radiology orders — without the test_type filter the lab
 * worklist surfaced ultrasounds/CT scans alongside CBC samples, forcing
 * the lab tech to triage radiology work that wasn't theirs. Findings:
 *   2026-05-10-inpatient-admission-lab-tech-ipd-worklist-includes-radiology
 *   2026-05-12-dynamic-acute-abdomen-lab-tech-a1b49f2b
 *
 * COALESCEs bed_number from admissions.bed_number (legacy) → beds.bed_number
 * (current source-of-truth, since IPD admit flow stores bed_id rather
 * than the bed_number string). Without this the phlebotomist hit a
 * null bed_number on the worklist even when bed assignment was complete.
 * Finding: 2026-05-12-inpatient-admission-lab-tech-48e85048.
 */
// TODO: tenantId is accepted but not yet scoped into the query — see
// the in-flight finding about tenant isolation on lab worklists.
export async function listIpdLabWorklist({ tenantId: _tenantId, limit = 100 } = {}) {
  const lim = Math.max(1, Math.min(500, Number(limit) || 100));
  return prisma.$queryRawUnsafe(
    `SELECT i.id, i.test_name, i.test_type, i.status, i.priority,
            i.requested_at, i.created_at,
            u.name AS patient_name, u.phone AS patient_phone, u.uid AS patient_uid,
            a.id AS admission_id, a.ward,
            COALESCE(a.bed_number, b.bed_number) AS bed_number,
            a.bed_id, a.room_category, a.attending_doctor
       FROM investigations i
       JOIN users u ON u.id = i.patient_id
       JOIN admissions a ON a.patient_uid = u.uid
            AND a.status IN ('admitted', 'transferred')
  LEFT JOIN beds b ON b.id = a.bed_id
      WHERE i.status NOT IN ('COMPLETED', 'CANCELLED')
        AND UPPER(COALESCE(i.test_type, 'LAB')) IN ('LAB', 'PATHOLOGY', 'BLOOD',
                                                     'BIOCHEM', 'BIOCHEMISTRY',
                                                     'HEMATOLOGY', 'HAEMATOLOGY',
                                                     'MICROBIOLOGY', 'SEROLOGY', 'URINE')
      ORDER BY
        CASE i.priority WHEN 'URGENT' THEN 1 WHEN 'HIGH' THEN 2
                       WHEN 'NORMAL' THEN 3 ELSE 4 END,
        i.requested_at ASC
      LIMIT $1::int`,
    lim,
  );
}

/**
 * General lab worklist — surfaces every open investigation regardless
 * of admission state, so an ER STAT troponin (no admission yet) or an
 * OPD walk-in CBC shows up alongside the IPD orders. The IPD-only
 * worklist had filtered them out via the inner join on admissions,
 * leaving the lab tech blind to anything ordered before admission.
 *
 * Joined left to admissions so the ward / bed columns are present
 * when the patient is admitted (helpful for sample-collection routing)
 * and null otherwise. The `source` column distinguishes ER / IPD /
 * OPD so the lab UI can colour-code the row. STAT/URGENT orders sort
 * to the top regardless of source.
 *
 * Findings:
 *   2026-05-10-emergency-walk-in-lab-tech-stat-er-order-not-on-worklist
 *   2026-05-08-obstetric-anc-lab-tech-no-worklist-endpoint
 */
export async function listLabWorklist({
  tenantId: _tenantId,
  limit = 100,
  priority,
  source,
} = {}) {
  const lim = Math.max(1, Math.min(500, Number(limit) || 100));
  const params = [];
  // Lab worklist is lab-only — radiology orders belong on the radiology
  // worklist, and surfacing them here forces lab techs to triage work
  // that isn't theirs. Same defence as listIpdLabWorklist. Finding:
  // 2026-05-10-inpatient-admission-lab-tech-ipd-worklist-includes-radiology.
  const filters = [
    `i.status NOT IN ('COMPLETED', 'CANCELLED')`,
    // Lab worklist allowlist — matches what the manual driver findings
    // call "laboratory/pathology" while preserving the legacy lowercase
    // 'blood' / 'urine' values older test seeds and walk-in tooling
    // emit. Default of LAB so investigations with NULL test_type still
    // land on the lab worklist (historic OPD walk-ins where the column
    // was never populated). Excludes RADIOLOGY/CARDIOLOGY/PULMONARY/
    // ENDOSCOPY, which have their own worklists.
    `UPPER(COALESCE(i.test_type, 'LAB')) IN ('LAB', 'PATHOLOGY', 'BLOOD',
                                              'BIOCHEM', 'BIOCHEMISTRY',
                                              'HEMATOLOGY', 'HAEMATOLOGY',
                                              'MICROBIOLOGY', 'SEROLOGY',
                                              'URINE')`,
  ];

  if (priority) {
    params.push(String(priority).toUpperCase());
    filters.push(`UPPER(COALESCE(i.priority, 'NORMAL')) = $${params.length}`);
  }
  if (source) {
    const src = String(source).toLowerCase();
    if (!['ipd', 'er', 'opd'].includes(src)) {
      throw AppError.badRequest('source must be one of: ipd, er, opd');
    }
    if (src === 'ipd') {
      filters.push(`a.id IS NOT NULL AND a.status IN ('admitted', 'transferred')`);
    } else if (src === 'er') {
      filters.push(`ev.id IS NOT NULL`);
    } else {
      filters.push(
        `a.id IS NULL AND ev.id IS NULL`,
      );
    }
  }

  params.push(lim);
  const limitPos = params.length;

  return prisma.$queryRawUnsafe(
    `SELECT i.id, i.test_name, i.test_type, i.status, i.priority,
            i.requested_at, i.created_at,
            u.name AS patient_name, u.phone AS patient_phone, u.uid AS patient_uid,
            a.id AS admission_id, a.ward,
            COALESCE(a.bed_number, b.bed_number) AS bed_number,
            a.bed_id, a.room_category, a.attending_doctor,
            ev.id AS er_visit_id, ev.visit_number AS er_visit_number,
            CASE
              WHEN a.id IS NOT NULL AND a.status IN ('admitted', 'transferred') THEN 'ipd'
              WHEN ev.id IS NOT NULL THEN 'er'
              ELSE 'opd'
            END AS source
       FROM investigations i
       JOIN users u ON u.id = i.patient_id
  LEFT JOIN admissions a
         ON a.patient_uid = u.uid
        AND a.status IN ('admitted', 'transferred')
  LEFT JOIN beds b ON b.id = a.bed_id
  LEFT JOIN emergency_visits ev
         ON ev.patient_uid = u.uid
        AND ev.status NOT IN ('discharged', 'transferred', 'left_against_advice',
                              'lwbs', 'expired', 'archived')
      WHERE ${filters.join(' AND ')}
      ORDER BY
        CASE UPPER(COALESCE(i.priority, 'NORMAL'))
          WHEN 'URGENT' THEN 1
          WHEN 'STAT' THEN 1
          WHEN 'HIGH' THEN 2
          WHEN 'NORMAL' THEN 3
          ELSE 4
        END,
        i.requested_at ASC
      LIMIT $${limitPos}::int`,
    ...params,
  );
}
