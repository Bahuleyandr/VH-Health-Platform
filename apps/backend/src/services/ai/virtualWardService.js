/**
 * Virtual ward — post-discharge remote monitoring.
 *
 * Patients "graduate" from a hospital admission to the virtual ward.
 * They (or their wearable) submit daily check-ins — symptoms, vitals,
 * pain/mood scores, medication adherence. Every check-in is triaged:
 *
 *    green  — stable, no action
 *    amber  — needs care-manager follow-up today
 *    red    — call patient now / escalate to on-call
 *
 * Red and amber check-ins auto-create a virtual_ward_escalations row
 * with severity + a structured reason list; care manager acknowledges
 * and resolves each. Decision-support only — never auto-actions care.
 */

import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { isAdmin } from '../../utils/roleHelpers.js';
import notificationOutbox from '../../utils/notifications/notificationOutbox.js'; // eslint-disable-line import/no-named-as-default
import {
  recordCanonicalClinicalEvent,
  recordClinicalAuditEvent,
} from '../clinical/canonicalClinicalPlatformService.js';
import { safeCanonical } from '../clinical/canonicalOperationalBridgeService.js';

const MODULE_KEY = 'virtual_ward_triage';

function resolveTenantId(options = {}) {
  return requireTenantId(options.tenantId);
}

function isMissingSchemaError(err) {
  return /does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

function clamp(value, min, max) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(n, max));
}

/**
 * Pure triage function. Returns { score, band, reasons } where band is
 * one of 'green' | 'amber' | 'red'. Reasons are structured { code,
 * message } so the admin UI can render them without re-parsing text.
 */
export function triageCheckIn({ symptoms = {}, vitals = {}, medicationAdherencePct = null, moodScore = null, painScore = null } = {}) {
  const reasons = [];
  let score = 0;

  // Vital bands closely mirror the deterioration early-warning thresholds.
  const hr = clamp(vitals.heart_rate, 0, 300);
  const sbp = clamp(vitals.systolic_bp, 0, 300);
  const spo2 = clamp(vitals.spo2, 0, 100);
  const rr = clamp(vitals.respiratory_rate, 0, 80);
  const temp = clamp(vitals.temperature, 30, 45);
  const glucose = clamp(vitals.blood_glucose, 0, 600);

  if (spo2 != null && spo2 < 92) {
    const add = spo2 < 88 ? 50 : 25;
    score += add;
    reasons.push({ code: 'LOW_SPO2', severity: spo2 < 88 ? 'red' : 'amber', message: `SpO2 ${spo2}%` });
  }
  if (hr != null && (hr >= 120 || hr <= 45)) {
    score += 30;
    reasons.push({ code: 'HEART_RATE_OUT_OF_RANGE', severity: 'amber', message: `HR ${hr}` });
  }
  if (sbp != null && (sbp <= 90 || sbp >= 180)) {
    score += sbp <= 90 ? 40 : 30;
    reasons.push({ code: 'BP_OUT_OF_RANGE', severity: sbp <= 85 ? 'red' : 'amber', message: `SBP ${sbp}` });
  }
  if (rr != null && (rr >= 24 || rr <= 8)) {
    score += 30;
    reasons.push({ code: 'RESPIRATORY_RATE_OUT_OF_RANGE', severity: 'amber', message: `RR ${rr}` });
  }
  if (temp != null && (temp >= 38.5 || temp <= 35.5)) {
    score += 20;
    reasons.push({ code: 'TEMPERATURE_ABNORMAL', severity: 'amber', message: `Temp ${temp}°C` });
  }
  if (glucose != null && (glucose <= 60 || glucose >= 300)) {
    score += 35;
    reasons.push({ code: 'GLUCOSE_CRITICAL', severity: glucose <= 50 || glucose >= 400 ? 'red' : 'amber', message: `Glucose ${glucose}` });
  }

  // Symptoms — a curated red-flag list.
  const redFlags = new Set(['chest_pain', 'shortness_of_breath', 'syncope', 'hematemesis', 'melena', 'severe_headache', 'slurred_speech', 'weakness_one_side', 'severe_abdominal_pain']);
  const amberFlags = new Set(['fever', 'cough', 'nausea', 'vomiting', 'diarrhea', 'rash', 'worsening_pain', 'dizziness']);
  for (const [symptom, reported] of Object.entries(symptoms || {})) {
    if (!reported) continue;
    const key = String(symptom).toLowerCase();
    if (redFlags.has(key)) {
      score += 50;
      reasons.push({ code: `SYMPTOM_${key.toUpperCase()}`, severity: 'red', message: `Red-flag symptom: ${symptom.replace(/_/g, ' ')}` });
    } else if (amberFlags.has(key)) {
      // 30 pts crosses the amber threshold on its own — an isolated new
      // fever or worsening cough post-discharge warrants a care-manager
      // call-back today.
      score += 30;
      reasons.push({ code: `SYMPTOM_${key.toUpperCase()}`, severity: 'amber', message: `Concerning symptom: ${symptom.replace(/_/g, ' ')}` });
    }
  }

  const pain = clamp(painScore, 0, 10);
  if (pain != null && pain >= 7) {
    score += pain >= 9 ? 25 : 15;
    reasons.push({ code: 'HIGH_PAIN', severity: pain >= 9 ? 'red' : 'amber', message: `Self-reported pain ${pain}/10` });
  }

  const mood = clamp(moodScore, 0, 10);
  if (mood != null && mood <= 3) {
    score += 10;
    reasons.push({ code: 'LOW_MOOD', severity: 'amber', message: `Mood score ${mood}/10 — check for decompensation + suicidality` });
  }

  const adherence = clamp(medicationAdherencePct, 0, 100);
  if (adherence != null && adherence < 60) {
    // <30% adherence is a red flag on its own; <60% is amber. Scores are
    // chosen so each threshold crosses the corresponding band alone.
    score += adherence < 30 ? 70 : 30;
    reasons.push({ code: 'LOW_ADHERENCE', severity: adherence < 30 ? 'red' : 'amber', message: `Medication adherence ${adherence}%` });
  }

  const hasRed = reasons.some((r) => r.severity === 'red');
  const band = hasRed || score >= 70 ? 'red' : score >= 30 ? 'amber' : 'green';
  return { score: Math.min(score, 100), band, reasons };
}

export async function enrollPatient({ tenantId = null, patientUid, admissionId = null, careManagerUid = null, pathway = 'generic_post_discharge', startDate = null, expectedCheckInCadenceHours = 24, metadata = {} } = {}) {
  if (!patientUid) throw AppError.badRequest('patientUid is required');
  const tid = resolveTenantId({ tenantId });
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO virtual_ward_enrollments
       (tenant_id, patient_uid, admission_id, care_manager_uid, pathway, start_date,
        expected_check_in_cadence_hours, metadata, status, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6::date, $7, $8::jsonb, 'active', NOW(), NOW())
     ON CONFLICT (tenant_id, patient_uid, start_date)
     DO UPDATE SET
       admission_id = COALESCE(EXCLUDED.admission_id, virtual_ward_enrollments.admission_id),
       care_manager_uid = COALESCE(EXCLUDED.care_manager_uid, virtual_ward_enrollments.care_manager_uid),
       pathway = EXCLUDED.pathway,
       expected_check_in_cadence_hours = EXCLUDED.expected_check_in_cadence_hours,
       metadata = virtual_ward_enrollments.metadata || EXCLUDED.metadata,
       status = 'active',
       updated_at = NOW()
     RETURNING id, tenant_id, patient_uid, admission_id, care_manager_uid, pathway,
               start_date, status, expected_check_in_cadence_hours, created_at`,
    tid,
    patientUid,
    admissionId ? Number.parseInt(admissionId, 10) : null,
    careManagerUid,
    pathway,
    startDate || new Date().toISOString().slice(0, 10),
    Math.max(Number.parseInt(expectedCheckInCadenceHours, 10) || 24, 1),
    JSON.stringify(metadata || {})
  );
  return rows[0];
}

async function resolveEnrollment({ tenantId, patientUid, enrollmentId }) {
  if (enrollmentId) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, patient_uid, status, care_manager_uid FROM virtual_ward_enrollments
       WHERE id = $1 AND tenant_id = $2::uuid LIMIT 1`,
      Number.parseInt(enrollmentId, 10),
      tenantId
    );
    return rows[0] || null;
  }
  if (patientUid) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, patient_uid, status, care_manager_uid FROM virtual_ward_enrollments
       WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid AND status = 'active'
       ORDER BY start_date DESC LIMIT 1`,
      tenantId,
      patientUid
    );
    return rows[0] || null;
  }
  return null;
}

export async function submitCheckIn({ req, enrollmentId = null, patientUid = null, symptoms = {}, vitals = {}, medicationAdherencePct = null, moodScore = null, painScore = null, wearablePayload = {}, source = 'patient_self_report' } = {}) {
  const tenantId = resolveTenantId({ tenantId: req?.tenantId });
  const callerUid = req?.user?.uid || null;
  const callerRole = String(req?.user?.role || '').toUpperCase();

  // Patients can only submit for themselves — locking the JWT uid to the
  // check-in's patient_uid prevents cross-patient submissions.
  const effectivePatientUid = patientUid || callerUid;
  if (!effectivePatientUid) throw AppError.badRequest('patient_uid required');
  if (callerRole === 'PATIENT' && callerUid && callerUid !== effectivePatientUid) {
    throw AppError.forbidden('Patients can only submit check-ins for themselves');
  }

  const enrollment = await resolveEnrollment({
    tenantId,
    patientUid: effectivePatientUid,
    enrollmentId,
  });
  if (!enrollment) throw AppError.notFound('Active virtual-ward enrollment not found for patient');

  // Staff IDOR guard (#7): a non-patient caller may submit a check-in only for a
  // patient they are responsible for — the enrollment's assigned care manager,
  // or an admin/super-admin with oversight. Without this, any in-scope staff
  // role could fabricate symptoms/vitals for an ARBITRARY enrolled patient and
  // trigger (or noise-suppress) clinical escalations. (The PATIENT self-only
  // lock above covers patient callers.)
  if (callerRole !== 'PATIENT') {
    const isCareManager = enrollment.care_manager_uid
      && callerUid
      && String(enrollment.care_manager_uid) === String(callerUid);
    if (!isCareManager && !isAdmin(callerRole)) {
      throw AppError.forbidden(
        'Only the assigned care manager (or an admin) may submit a check-in for this patient',
        'VIRTUAL_WARD_NOT_CARE_MANAGER',
      );
    }
  }

  const triage = triageCheckIn({ symptoms, vitals, medicationAdherencePct, moodScore, painScore });

  const patientGenerated = callerRole === 'PATIENT' || !callerRole;

  // Insert the check-in row + its canonical timeline/audit pair inside the
  // caller-provided transaction (canonical clinical timeline invariant: the
  // detail row and the timeline+audit pair commit together or not at all).
  const persistCheckInTx = async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO virtual_ward_check_ins
         (tenant_id, enrollment_id, patient_uid, submitted_at, symptoms, vitals,
          medication_adherence_pct, mood_score, pain_score, wearable_payload, source,
          triage_score, triage_band, triage_reasons)
       VALUES ($1::uuid, $2, $3::uuid, NOW(), $4::jsonb, $5::jsonb, $6, $7, $8,
               $9::jsonb, $10, $11, $12, $13::jsonb)
       RETURNING id, submitted_at`,
      tenantId,
      enrollment.id,
      effectivePatientUid,
      JSON.stringify(symptoms || {}),
      JSON.stringify(vitals || {}),
      medicationAdherencePct != null ? clamp(medicationAdherencePct, 0, 100) : null,
      moodScore != null ? clamp(moodScore, 0, 10) : null,
      painScore != null ? clamp(painScore, 0, 10) : null,
      JSON.stringify(wearablePayload || {}),
      source,
      triage.score,
      triage.band,
      JSON.stringify(triage.reasons)
    );
    const row = rows[0];
    await recordCanonicalClinicalEvent({
      tenantId,
      patientUid: effectivePatientUid,
      eventType: 'virtual_ward.check_in_recorded',
      eventStatus: triage.band,
      eventSubtype: source,
      sourceTable: 'virtual_ward_check_ins',
      sourceId: row.id,
      resourceType: 'virtual_ward_check_in',
      resourceId: row.id,
      actorUid: callerUid,
      actorRole: callerRole || null,
      occurredAt: row.submitted_at,
      visibleToPatient: true,
      summary: `Virtual ward check-in triaged ${triage.band} (score ${triage.score})`,
      payload: {
        check_in_id: row.id,
        enrollment_id: enrollment.id,
        triage_band: triage.band,
        triage_score: triage.score,
        triage_reason_codes: triage.reasons.map((r) => r.code),
        source,
        source_kind: patientGenerated ? 'patient_generated' : 'staff_recorded',
        verification_status: 'unverified',
      },
      afterState: { triage_band: triage.band, triage_score: triage.score },
      tags: patientGenerated
        ? ['virtual_ward', 'patient_generated', 'unverified']
        : ['virtual_ward', 'staff_recorded', 'unverified'],
      // Fixed insert-once keys: check-in rows are append-only (no UPDATE
      // path in product code); corrections are new check-ins.
      timelineIdempotencyKey: `virtual_ward_check_ins:${row.id}:recorded`,
      auditIdempotencyKey: `virtual_ward_check_ins:${row.id}:audit:recorded`,
    }, { db: tx, strict: true });
    return row;
  };

  let checkInId = null;
  let escalationId = null;

  if (triage.band !== 'green') {
    // Red/amber — a deteriorating patient. Check-in persist + escalation row
    // (+ enrollment escalation and the in-tx care-team outbox alert for red)
    // are ONE transaction, and any failure THROWS: the previous shape caught
    // the INSERT failure, skipped escalation (it was gated on checkInId) and
    // returned HTTP 200 with check_in_id null — a red-band check-in was
    // "accepted" with nothing persisted and nobody escalated. The virtual-ward
    // tables ship in the migrations (026 + baseline), so there is deliberately
    // NO missing-schema grace on this path: a missing table is an environment
    // defect and must surface as an error, never a silent 200.
    try {
      const result = await setTenantTx(tenantId, async (tx) => {
        const row = await persistCheckInTx(tx);
        const escRows = await tx.$queryRawUnsafe(
          `INSERT INTO virtual_ward_escalations
             (tenant_id, enrollment_id, check_in_id, patient_uid, severity, reason, created_at)
           VALUES ($1::uuid, $2, $3, $4::uuid, $5, $6, NOW())
           RETURNING id`,
          tenantId,
          enrollment.id,
          row.id,
          effectivePatientUid,
          triage.band,
          triage.reasons.map((r) => `${r.code}: ${r.message}`).join(' | ').slice(0, 2000)
        );
        const escId = escRows[0].id;

        if (triage.band === 'red') {
          // Escalation canonical pair — red is the "call patient now" band;
          // the escalation itself is a patient-facing clinical event.
          await recordCanonicalClinicalEvent({
            tenantId,
            patientUid: effectivePatientUid,
            eventType: 'virtual_ward.escalation_raised',
            eventStatus: 'red',
            sourceTable: 'virtual_ward_escalations',
            sourceId: escId,
            resourceType: 'virtual_ward_escalation',
            resourceId: escId,
            actorUid: callerUid,
            actorRole: callerRole || null,
            occurredAt: row.submitted_at,
            visibleToPatient: false,
            summary: 'Virtual ward RED escalation — contact patient now',
            payload: {
              escalation_id: escId,
              check_in_id: row.id,
              enrollment_id: enrollment.id,
              care_manager_uid: enrollment.care_manager_uid || null,
              triage_score: triage.score,
              triage_reason_codes: triage.reasons.map((r) => r.code),
            },
            afterState: { severity: 'red', enrollment_status: 'escalated' },
            tags: ['virtual_ward', 'escalation', 'critical'],
            timelineIdempotencyKey: `virtual_ward_escalations:${escId}:raised`,
            auditIdempotencyKey: `virtual_ward_escalations:${escId}:audit:raised`,
          }, { db: tx, strict: true });

          // No .catch(() => {}) — the enrollment flip is part of the atomic
          // escalation, not a discardable side note.
          await tx.$queryRawUnsafe(
            `UPDATE virtual_ward_enrollments
             SET status = 'escalated', updated_at = NOW()
             WHERE id = $1 AND tenant_id = $2::uuid`,
            enrollment.id,
            tenantId
          );

          // Durable care-team alert, in the SAME transaction: the escalation
          // must never be only a DB row nobody is told about. The outbox
          // drain retries delivery; source_event_key dedupes exact retries.
          await notificationOutbox.queue({
            type: 'push',
            recipientId: enrollment.care_manager_uid ? String(enrollment.care_manager_uid) : null,
            tenantId,
            title: 'Virtual ward RED escalation — contact patient now',
            body: `A virtual-ward check-in triaged RED (score ${triage.score}): ${triage.reasons.map((r) => r.message).join('; ').slice(0, 500)}`,
            data: {
              source_event_key: `virtual_ward_escalations:${escId}:red_alert`,
              escalation_id: escId,
              check_in_id: row.id,
              enrollment_id: enrollment.id,
              patient_uid: effectivePatientUid,
              triage_band: triage.band,
              triage_score: triage.score,
            },
            channel: 'clinical_alert',
          }, { tx, strict: true });
        }

        return { checkInId: row.id, escalationId: escId };
      });
      checkInId = result.checkInId;
      escalationId = result.escalationId;
    } catch (err) {
      logger.error('Virtual ward check-in persist/escalation FAILED — rolled back', {
        error: err.message,
        code: err?.code || null,
        enrollment_id: enrollment.id,
        patient_uid: effectivePatientUid,
        triage_band: triage.band,
      });
      if (err instanceof AppError) throw err;
      throw AppError.internal(
        'Check-in could not be recorded — please retry, and contact your care team directly if symptoms are severe.',
        'VIRTUAL_WARD_CHECKIN_PERSIST_FAILED',
      );
    }
  } else {
    // Green — stable, no action needed. Persistence stays best-effort (a
    // stable patient's check-in should not error the app over a transient
    // fault), but a failure is no longer a silent warn: it writes a
    // clinical_audit_events 'failed' row (post-commit policy: 42P01 -> warn,
    // other faults -> ERROR log) and the response carries check_in_id null.
    try {
      const row = await setTenantTx(tenantId, (tx) => persistCheckInTx(tx));
      checkInId = row.id;
    } catch (err) {
      logger.error('Virtual ward green check-in persist failed', {
        error: err.message,
        enrollment_id: enrollment.id,
        patient_uid: effectivePatientUid,
      });
      await safeCanonical(`virtual ward green check-in persist failure audit (enrollment ${enrollment.id})`, () =>
        recordClinicalAuditEvent({
          tenantId,
          patientUid: effectivePatientUid,
          action: 'virtual_ward_check_in_persist_failed',
          actionStatus: 'failed',
          actorUid: callerUid,
          resourceType: 'virtual_ward_check_in',
          resourceTable: 'virtual_ward_check_ins',
          resourceId: `enrollment:${enrollment.id}`,
          metadata: {
            enrollment_id: enrollment.id,
            triage_band: triage.band,
            triage_score: triage.score,
            error: err?.message || String(err),
          },
          // Each distinct failure occurrence gets its own audit row — this is
          // a failure trail, not an insert-once lifecycle event.
          idempotencyKey: `virtual_ward_enrollments:${enrollment.id}:check_in_persist_failed:${Date.now()}`,
        }));
    }
  }

  return {
    check_in_id: checkInId,
    enrollment_id: enrollment.id,
    patient_uid: effectivePatientUid,
    triage_score: triage.score,
    triage_band: triage.band,
    triage_reasons: triage.reasons,
    escalation_id: escalationId,
    module_key: MODULE_KEY,
    decision_support_only: true,
  };
}

export async function listOpenEscalations({ tenantId = null, severity = null, limit = 50 } = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT e.id, e.enrollment_id, e.check_in_id, e.patient_uid, u.name AS patient_name,
              e.severity, e.reason, e.acknowledged_by, e.acknowledged_at, e.resolution,
              e.resolution_note, e.resolved_at, e.created_at,
              enr.pathway, enr.care_manager_uid
       FROM virtual_ward_escalations e
       LEFT JOIN users u ON u.uid = e.patient_uid
       LEFT JOIN virtual_ward_enrollments enr ON enr.id = e.enrollment_id
       WHERE e.tenant_id = $1::uuid
         AND e.resolved_at IS NULL
         AND ($2::text IS NULL OR e.severity = $2)
       ORDER BY
         CASE e.severity WHEN 'red' THEN 0 ELSE 1 END,
         e.created_at DESC
       LIMIT $3`,
      tid,
      severity,
      safeLimit
    );
    return { escalations: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { escalations: [], count: 0 };
    throw err;
  }
}

export async function acknowledgeEscalation({ escalationId, acknowledgedBy = null, tenantId = null } = {}) {
  const tid = resolveTenantId({ tenantId });
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE virtual_ward_escalations
     SET acknowledged_by = $2::uuid, acknowledged_at = NOW()
     WHERE id = $1 AND tenant_id = $3::uuid AND acknowledged_at IS NULL
     RETURNING id, severity, acknowledged_at, acknowledged_by`,
    Number.parseInt(escalationId, 10),
    acknowledgedBy,
    tid
  );
  if (!rows[0]) throw AppError.notFound('Open escalation not found');
  return rows[0];
}

export async function resolveEscalation({ escalationId, resolution, note = null, resolvedBy = null, tenantId = null } = {}) {
  const tid = resolveTenantId({ tenantId });
  const normalized = String(resolution || '').toLowerCase();
  if (!['call_completed', 'referred_to_ed', 'resolved_remotely', 'enrollment_dropped', 'no_action_needed'].includes(normalized)) {
    throw AppError.badRequest('Invalid resolution');
  }
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE virtual_ward_escalations
     SET resolution = $2, resolution_note = $3, resolved_at = NOW(),
         acknowledged_by = COALESCE(acknowledged_by, $4::uuid),
         acknowledged_at = COALESCE(acknowledged_at, NOW())
     WHERE id = $1 AND tenant_id = $5::uuid AND resolved_at IS NULL
     RETURNING id, severity, resolution, resolution_note, resolved_at`,
    Number.parseInt(escalationId, 10),
    normalized,
    note,
    resolvedBy,
    tid
  );
  if (!rows[0]) throw AppError.notFound('Unresolved escalation not found');
  return rows[0];
}

export async function listActiveEnrollments({ tenantId = null, limit = 100 } = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 500);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT e.id, e.patient_uid, u.name AS patient_name, e.admission_id, e.pathway,
              e.start_date, e.status, e.expected_check_in_cadence_hours,
              (SELECT MAX(submitted_at) FROM virtual_ward_check_ins c WHERE c.enrollment_id = e.id) AS last_check_in_at,
              (SELECT COUNT(*)::int FROM virtual_ward_escalations x
                WHERE x.enrollment_id = e.id AND x.resolved_at IS NULL) AS open_escalations
       FROM virtual_ward_enrollments e
       LEFT JOIN users u ON u.uid = e.patient_uid
       WHERE e.tenant_id = $1::uuid
         AND e.status IN ('active', 'escalated')
       ORDER BY e.start_date DESC
       LIMIT $2`,
      tid,
      safeLimit
    );
    return { enrollments: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { enrollments: [], count: 0 };
    throw err;
  }
}

export default {
  acknowledgeEscalation,
  enrollPatient,
  listActiveEnrollments,
  listOpenEscalations,
  resolveEscalation,
  submitCheckIn,
  triageCheckIn,
};
