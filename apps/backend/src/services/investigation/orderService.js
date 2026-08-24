// src/services/investigation/orderService.js
// Investigation order service — aligned to the canonical `investigations` DB schema:
// - `requested_by` uuid (NOT `doctor_id`)
// - `test_type` (NOT `type`)
// - `requested_at` (NOT `ordered_date`)
// - status default 'REQUESTED' (the DB default), then 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'.

import { randomUUID } from 'node:crypto';
import {
  INVESTIGATION_TYPES,
  PRIORITY_LEVELS,
  PRIORITY_TURNAROUND_HOURS,
} from '../../config/investigationConfig.js';
import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { maskPhoneForLog } from '../../utils/logMasking.js';
import { recordCanonicalClinicalEvent } from '../clinical/canonicalClinicalPlatformService.js';
import { publishInpatientDiagnosticResourceLinkedTx } from '../emr/inpatientPathwayDomainService.js';
import { publishOpChildResourceLinkedTx } from '../appointment/opChildResourceEventService.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';

async function recordRequiredInvestigationEvent(input, tx) {
  const event = await recordCanonicalClinicalEvent(input, { db: tx });
  if (!event?.timeline?.id || !event?.audit?.id) {
    throw AppError.internal(
      'Investigation write requires canonical timeline and audit events',
      'INVESTIGATION_CANONICAL_EVENT_REQUIRED',
    );
  }
  return event;
}

// Subset of investigations columns the caller gets back. Shared between the
// clinical + legacy paths so the API surface stays consistent.
const INVESTIGATION_SELECT = {
  id: true,
  uid: true,
  phone: true,
  patient_id: true,
  patient_uid: true,
  admission_id: true,
  appointment_id: true,
  test_name: true,
  test_type: true,
  status: true,
  priority: true,
  file_key: true,
  requested_by: true,
  requested_at: true,
  updated_at: true,
  turnaround_target_hours: true,
  notes: true,
  collection_location: true,
  collection_deadline_at: true,
  fasting_required: true,
  fasting_instructions: true,
};

export const createInvestigationOrder = async (orderData) => {
  const {
    patient_id, appointment_id, admission_id, admissionId, doctor_uid, test_name, test_code, type,
    priority = 'NORMAL', notes, orderedBy, actorRole = null,
    collection_location, collection_deadline_at,
    fasting_required, fasting_instructions,
    tenantId = null,
  } = orderData;

  if (!patient_id || !(doctor_uid || orderedBy) || !test_name || !type) {
    // Stamp .statusCode = 400 so the lab-route `wrap` middleware
    // (which honours err.statusCode) returns a clean 4xx instead of
    // a generic 500. The orderController already matches by message
    // and returns its own 400 — both paths now stay consistent.
    const e = new Error('MISSING_REQUIRED_FIELDS');
    e.statusCode = 400;
    e.code = 'MISSING_REQUIRED_FIELDS';
    throw e;
  }
  if (!Object.values(INVESTIGATION_TYPES).includes(type.toUpperCase())) {
    const e = new Error('INVALID_TYPE');
    e.statusCode = 400;
    e.code = 'INVALID_TYPE';
    throw e;
  }
  // ROUTINE is the clinical-language alias for NORMAL — accept either
  // and persist as NORMAL so storage stays consistent. Mirrors the
  // sanitizer at the validator layer for callers that bypass it.
  // Finding: 2026-05-09-obstetric-anc-doctor-investigation-priority-enum-mismatch.
  // (`priority` is a const destructure, so we use a separate variable
  // and thread that through to the downstream `priorityUpper` site —
  // reassigning the destructured const tripped no-const-assign in
  // PR #131 CI.)
  let priorityNormalised = String(priority).toUpperCase();
  if (priorityNormalised === 'ROUTINE') priorityNormalised = 'NORMAL';
  if (!Object.values(PRIORITY_LEVELS).includes(priorityNormalised)) {
    const e = new Error('INVALID_PRIORITY');
    e.statusCode = 400;
    e.code = 'INVALID_PRIORITY';
    throw e;
  }

  // Prisma ORM — column names checked at runtime against schema.prisma so a
  // typo like `.findUnique({ where: { user_id: ... } })` fails loudly.
  const patient = await prisma.users.findFirst({
    where: {
      id: parseInt(patient_id),
      role: 'PATIENT',
      ...(tenantId ? { tenant_id: tenantId } : {}),
    },
    select: { id: true, uid: true, name: true, phone: true, tenant_id: true },
  });
  if (!patient) {
    const e = new Error('PATIENT_NOT_FOUND');
    e.statusCode = 404;
    e.code = 'PATIENT_NOT_FOUND';
    throw e;
  }

  let appointmentIdNum = null;
  if (appointment_id !== undefined && appointment_id !== null && String(appointment_id).trim() !== '') {
    appointmentIdNum = Number(appointment_id);
    if (!Number.isInteger(appointmentIdNum) || appointmentIdNum < 1) {
      const e = new Error('INVALID_APPOINTMENT_ID');
      e.statusCode = 400;
      e.code = 'INVALID_APPOINTMENT_ID';
      throw e;
    }
    const appointment = await prisma.appointments.findFirst({
      where: { id: appointmentIdNum, tenant_id: patient.tenant_id },
      select: { id: true, patient_id: true, doctor_id: true, status: true },
    });
    if (!appointment) {
      const e = new Error('APPOINTMENT_NOT_FOUND');
      e.statusCode = 404;
      e.code = 'APPOINTMENT_NOT_FOUND';
      throw e;
    }
    if (appointment.patient_id !== patient.id) {
      const e = new Error('APPOINTMENT_PATIENT_MISMATCH');
      e.statusCode = 400;
      e.code = 'APPOINTMENT_PATIENT_MISMATCH';
      throw e;
    }
  }

  // E-6 — validate test_code against the catalog when supplied.
  // Free-text test_name is still accepted (lots of legitimate cases:
  // ad-hoc imaging requests, custom panels), but if a code IS passed,
  // it must exist in investigation_test_catalog. Stops "ECG12" + a
  // lookalike "ECG-12" from competing as separate codes for the
  // same test. Finding:
  // 2026-05-08-emergency-walk-in-doctor-catalog-no-ecg-free-text-bypass.
  let resolvedTestCode = null;
  if (test_code && String(test_code).trim()) {
    try {
      const catalog = await prisma.$queryRawUnsafe(
        `SELECT id, name FROM investigation_test_catalog
          WHERE is_active = TRUE AND LOWER(code) = LOWER($1) LIMIT 1`,
        String(test_code).trim(),
      );
      if (!catalog.length) {
        // 400 (NOT 500) — surfacing the missing test_code as a generic
        // 500 made the doctor's acute-abdomen lab-order shortcut look
        // broken to the clinician (RFT/ABDPNL/LFT etc. that aren't in
        // the seed catalog → opaque 500). Throw the structured form so
        // both the route wrap (which honours .statusCode) and the
        // controller path get a clear 400 with the failing code.
        // Finding: 2026-05-22-dynamic-acute-abdomen-doctor-0e597b54.
        const e = new Error('UNKNOWN_TEST_CODE');
        e.code = 'UNKNOWN_TEST_CODE';
        e.statusCode = 400;
        e.details = { provided: test_code };
        throw e;
      }
      resolvedTestCode = String(test_code).trim();
    } catch (err) {
      // Catalog table missing (under-migrated tenant) → fall through
      // and accept the order without code validation.
      if (err?.code !== 'UNKNOWN_TEST_CODE' && err?.meta?.code !== '42P01') {
        throw err;
      }
      if (err?.code === 'UNKNOWN_TEST_CODE') throw err;
    }
  }

  const requesterUuid = doctor_uid || orderedBy;
  const now = new Date();

  // Migration 203: collection_location / collection_deadline_at /
  // fasting_required / fasting_instructions are patient-actionable
  // intake instructions surfaced on the patient investigations list.
  // Parse the deadline once so a malformed string fails fast at order
  // time instead of stamping NULL silently.
  let parsedDeadline = null;
  if (collection_deadline_at) {
    const d = new Date(collection_deadline_at);
    if (!Number.isNaN(d.getTime())) parsedDeadline = d;
  }

  // STAT/URGENT door-to-decision orders need an hours-scale clock at the
  // worklist, not the catch-all 24h default. Drive turnaround_target_hours
  // from priority so the lab worklist sort by SLA puts the chest-pain
  // troponin above a routine fasting glucose ordered an hour earlier.
  // patient_uid mirrors the integer patient_id so downstream timelines
  // (ER visits, admissions, telemetry) keyed off UUID can join cleanly.
  // Both gaps were observed when ER STAT orders dropped notes + UID and
  // showed as generic URGENT/24h rows in the lab-facing view. Finding:
  // 2026-05-10-emergency-walk-in-doctor-stat-investigation-context-lost.
  // Use the already-normalised value so ROUTINE → NORMAL flows through
  // to the persisted row (per the comment block above).
  const priorityUpper = priorityNormalised;
  const typeUpper = type.toUpperCase();
  const turnaroundHours = PRIORITY_TURNAROUND_HOURS[priorityUpper] ?? 24;
  const trimmedNotes = notes != null && String(notes).trim()
    ? String(notes).trim()
    : null;
  const needsSampleCollection = typeUpper === 'LAB' || typeUpper === 'PATHOLOGY';
  const cleanCollectionLocation = collection_location != null && String(collection_location).trim()
    ? String(collection_location).trim().slice(0, 255)
    : (needsSampleCollection ? 'Main Laboratory Sample Collection' : null);
  const effectiveDeadline = parsedDeadline
    ?? (needsSampleCollection ? new Date(now.getTime() + turnaroundHours * 60 * 60 * 1000) : null);
  const effectiveFastingRequired = fasting_required === true || fasting_required === 'true';
  const cleanFastingInstructions = fasting_instructions != null && String(fasting_instructions).trim()
    ? String(fasting_instructions).trim()
    : (!effectiveFastingRequired && needsSampleCollection ? 'No fasting required unless the care team tells you otherwise.' : null);
  const effectiveTenantId = requireTenantId(patient.tenant_id || tenantId);
  const inpatientAdmissionId = admission_id ?? admissionId ?? null;

  // Soft duplicate-order guard — warn, never block. OB investigation
  // order sets are gestational-age-specific (18w anomaly scan, 24w GDM
  // screen, growth scans): a doctor opening the 24-week visit screen
  // with no "done at 18w" indicator will re-order the anomaly scan.
  // Keyed on patient + test (code when present, else name) within a
  // 60-day window. Best-effort — a check failure must not block the
  // order. Finding:
  // 2026-05-09-obstetric-anc-doctor-no-duplicate-order-guard.
  let duplicateWarning = null;
  try {
    const priorRows = await prisma.$queryRawUnsafe(
      `SELECT id, test_name, test_code, test_type, status,
              requested_at, completed_at
         FROM investigations
        WHERE patient_id = $1::int
          AND tenant_id = $4::uuid
          AND requested_at >= NOW() - INTERVAL '60 days'
          AND status <> 'CANCELLED'
          AND (
            ($2::text IS NOT NULL AND LOWER(test_code) = LOWER($2))
            OR LOWER(test_name) = LOWER($3)
          )
        ORDER BY requested_at DESC
        LIMIT 1`,
      parseInt(patient_id, 10),
      resolvedTestCode,
      String(test_name).trim(),
      effectiveTenantId,
    );
    if (priorRows.length) {
      const prior = priorRows[0];
      const when = new Date(prior.completed_at || prior.requested_at)
        .toISOString().slice(0, 10);
      duplicateWarning = {
        recent_order_id: prior.id,
        test_name: prior.test_name,
        test_code: prior.test_code,
        status: prior.status,
        requested_at: prior.requested_at,
        completed_at: prior.completed_at,
        message: `A similar test ("${prior.test_name}") was `
          + `${prior.status === 'COMPLETED' ? 'completed' : 'ordered'} for `
          + `this patient on ${when}. Confirm this re-order is intentional.`,
      };
    }
  } catch (err) {
    logger.warn(`investigation duplicate-order check failed: ${err.message}`);
  }

  const investigation = await setTenantTx(effectiveTenantId, async (tx) => {
    const created = await tx.investigations.create({
      data: {
        phone: patient.phone || 'unknown',
        patient_id: parseInt(patient_id),
        patient_uid: patient.uid,
        tenant_id: effectiveTenantId,
        admission_id: inpatientAdmissionId == null ? null : Number(inpatientAdmissionId),
        appointment_id: appointmentIdNum,
        test_name,
        test_code: resolvedTestCode,
        test_type: typeUpper,
        status: 'REQUESTED',
        priority: priorityUpper,
        turnaround_target_hours: turnaroundHours,
        requested_by: requesterUuid,
        updated_at: now,
        notes: trimmedNotes,
        collection_location: cleanCollectionLocation,
        collection_deadline_at: effectiveDeadline,
        fasting_required: effectiveFastingRequired,
        fasting_instructions: cleanFastingInstructions,
      },
      select: { ...INVESTIGATION_SELECT, tenant_id: true },
    });

    const canonical = await recordRequiredInvestigationEvent({
      tenantId: created.tenant_id,
      patientUid: created.patient_uid,
      eventType: 'investigation.ordered',
      eventSubtype: created.test_type,
      eventStatus: created.status,
      sourceTable: 'investigations',
      sourceId: created.id,
      resourceType: 'investigation',
      resourceId: created.id,
      actorUid: created.requested_by,
      actorRole,
      summary: `${created.test_name} ordered`,
      payload: {
        test_name: created.test_name,
        test_code: resolvedTestCode,
        test_type: created.test_type,
        priority: created.priority,
        appointment_id: created.appointment_id,
        duplicate_warning: duplicateWarning,
      },
      afterState: created,
    }, tx);
    if (created.admission_id != null) {
      await publishInpatientDiagnosticResourceLinkedTx({
        tx,
        tenantId: effectiveTenantId,
        admissionId: created.admission_id,
        patientUid: created.patient_uid,
        resourceType: 'investigation',
        resourceId: created.id,
        canonicalTimelineEventId: canonical.timeline.id,
        canonicalAuditEventId: canonical.audit.id,
        occurredAt: created.requested_at,
      });
    }
    if (created.appointment_id != null) {
      await publishOpChildResourceLinkedTx(tx, {
        tenantId: effectiveTenantId,
        appointmentId: created.appointment_id,
        patientUid: created.patient_uid,
        resourceType: 'investigation',
        resourceId: created.id,
        source: 'investigations.create',
      });
    }
    return created;
  });

  // Notification is best-effort. uid is populated client-side via randomUUID
  // (matches the legacy gen_random_uuid() behavior but avoids the DB
  // round-trip Prisma can't model via @default).
  // tenant_id bound from the resolved order tenant, not left to the column
  // DEFAULT — that DEFAULT reads app.current_tenant_id and falls back to the
  // literal default tenant whenever the GUC is unset, which would hide the
  // notice from the patient's tenant-filtered notification list.
  await prisma.notifications.create({
    data: {
      tenant_id: effectiveTenantId,
      uid: randomUUID(),
      phone: patient.phone || 'unknown',
      title: 'New Investigation Ordered',
      body: `Your doctor has ordered: ${test_name}. Please check your appointments.`,
      type: 'investigation_ordered',
      is_read: false,
      updated_at: now,
    },
  }).catch((err) => logger.warn(`investigation notification insert failed: ${err.message}`));

  logger.info(`Investigation ordered: ${test_name} for patient ${patient_id} by ${requesterUuid}`);

  return {
    investigation,
    patient_name: patient.name,
    duplicate_warning: duplicateWarning,
  };
};

export const createLegacyInvestigation = async ({
  phone,
  test_name,
  file_key,
  createdBy,
  actorRole = null,
  tenantId = null,
  admissionId = null,
  admission_id = null,
  result_summary = null,
  results = null,
  notes = null,
  completed = false,
}) => {
  const now = new Date();

  // Resolve patient by phone so legacy investigation rows still get
  // patient_id + patient_uid populated. Without these, results filed
  // via /lab/results (which requires patient_uid) couldn't be linked
  // back to the row. Best-effort: a stale legacy caller may pass a
  // phone with no matching users row; we keep the row but leave the
  // FKs null in that case. Finding:
  // 2026-05-09-inpatient-admission-lab-tech-ipd-orders-patient-uid-null.
  let patientId = null;
  let patientUid = null;
  let patientTenantId = null;
  if (phone) {
    const patient = await prisma.users.findFirst({
      where: {
        phone,
        ...(tenantId ? { tenant_id: tenantId } : {}),
        role: 'PATIENT',
      },
      select: { id: true, uid: true, tenant_id: true },
      orderBy: { id: 'asc' },
    });
    if (patient) {
      patientId = patient.id;
      patientUid = patient.uid || null;
      patientTenantId = patient.tenant_id;
    }
  }

  if (!patientUid) {
    const err = new Error('PATIENT_NOT_FOUND');
    err.statusCode = 404;
    err.code = 'PATIENT_NOT_FOUND';
    throw err;
  }

  const effectiveTenantId = requireTenantId(patientTenantId || tenantId);
  const investigation = await setTenantTx(effectiveTenantId, async (tx) => {
    const created = await tx.investigations.create({
      data: {
        phone,
        patient_id: patientId,
        patient_uid: patientUid,
        tenant_id: effectiveTenantId,
        admission_id: admission_id ?? admissionId ?? null,
        test_name,
        file_key: file_key ?? null,
        status: completed ? 'COMPLETED' : 'REQUESTED',
        requested_by: createdBy ?? null,
        result_summary: result_summary || null,
        results: results || null,
        notes: notes || null,
        completed_at: completed ? now : null,
        result_uploaded_at: completed ? now : null,
        updated_at: now,
      },
      select: {
        id: true,
        phone: true,
        patient_id: true,
        patient_uid: true,
        tenant_id: true,
        admission_id: true,
        test_name: true,
        file_key: true,
        status: true,
        result_summary: true,
        results: true,
        notes: true,
        requested_by: true,
        requested_at: true,
        completed_at: true,
      },
    });
    const eventType = completed ? 'investigation.result_ready' : 'investigation.ordered';
    const canonical = await recordRequiredInvestigationEvent({
      tenantId: created.tenant_id,
      patientUid: created.patient_uid,
      eventType,
      eventStatus: created.status,
      sourceTable: 'investigations',
      sourceId: created.id,
      resourceType: 'investigation',
      resourceId: created.id,
      actorUid: created.requested_by,
      actorRole,
      summary: completed ? `${created.test_name} result ready` : `${created.test_name} ordered`,
      payload: {
        test_name: created.test_name,
        file_key: created.file_key,
        result_summary: created.result_summary,
        source: 'staff_app_legacy',
      },
      afterState: created,
    }, tx);
    if (created.admission_id != null) {
      await publishInpatientDiagnosticResourceLinkedTx({
        tx,
        tenantId: effectiveTenantId,
        admissionId: created.admission_id,
        patientUid: created.patient_uid,
        resourceType: 'investigation',
        resourceId: created.id,
        canonicalTimelineEventId: canonical.timeline.id,
        canonicalAuditEventId: canonical.audit.id,
        occurredAt: created.requested_at,
      });
    }
    return created;
  });

  // Same reason as the order-placed notice above: bind the tenant explicitly.
  await prisma.notifications.create({
    data: {
      tenant_id: effectiveTenantId,
      uid: randomUUID(),
      phone,
      title: 'Investigation Report Ready',
      body: `Your investigation report for "${test_name}" is now available.`,
      type: 'investigation_ready',
      is_read: false,
      updated_at: now,
    },
  }).catch((err) => logger.warn(`legacy investigation notification failed: ${err.message}`));

  logger.info(`Legacy investigation created: ${test_name} for ${maskPhoneForLog(phone)}`);
  return investigation;
};

export const canOrderInvestigations = (userRole) => {
  return ['DOCTOR', 'ADMIN', 'SUPER_ADMIN'].includes(userRole);
};
