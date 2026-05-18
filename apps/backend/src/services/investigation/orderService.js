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
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';

// Subset of investigations columns the caller gets back. Shared between the
// clinical + legacy paths so the API surface stays consistent.
const INVESTIGATION_SELECT = {
  id: true,
  uid: true,
  phone: true,
  patient_id: true,
  patient_uid: true,
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
    patient_id, doctor_uid, test_name, test_code, type,
    priority = 'NORMAL', notes, orderedBy,
    collection_location, collection_deadline_at,
    fasting_required, fasting_instructions,
  } = orderData;

  if (!patient_id || !(doctor_uid || orderedBy) || !test_name || !type) {
    throw new Error('MISSING_REQUIRED_FIELDS');
  }
  if (!Object.values(INVESTIGATION_TYPES).includes(type.toUpperCase())) {
    throw new Error('INVALID_TYPE');
  }
  if (!Object.values(PRIORITY_LEVELS).includes(priority.toUpperCase())) {
    throw new Error('INVALID_PRIORITY');
  }

  // Prisma ORM — column names checked at runtime against schema.prisma so a
  // typo like `.findUnique({ where: { user_id: ... } })` fails loudly.
  const patient = await prisma.users.findUnique({
    where: { id: parseInt(patient_id) },
    select: { id: true, uid: true, name: true, phone: true },
  });
  if (!patient) throw new Error('PATIENT_NOT_FOUND');

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
        const e = new Error('UNKNOWN_TEST_CODE');
        e.code = 'UNKNOWN_TEST_CODE';
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
  const priorityUpper = priority.toUpperCase();
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

  const investigation = await prisma.investigations.create({
    data: {
      phone: patient.phone || 'unknown',
      patient_id: parseInt(patient_id),
      patient_uid: patient.uid || null,
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
    select: INVESTIGATION_SELECT,
  });

  // Notification is best-effort. uid is populated client-side via randomUUID
  // (matches the legacy gen_random_uuid() behavior but avoids the DB
  // round-trip Prisma can't model via @default).
  await prisma.notifications.create({
    data: {
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

export const createLegacyInvestigation = async ({ phone, test_name, file_key, createdBy }) => {
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
  if (phone) {
    const patient = await prisma.users.findFirst({
      where: { phone },
      select: { id: true, uid: true },
      orderBy: { id: 'asc' },
    });
    if (patient) {
      patientId = patient.id;
      patientUid = patient.uid || null;
    }
  }

  const investigation = await prisma.investigations.create({
    data: {
      phone,
      patient_id: patientId,
      patient_uid: patientUid,
      test_name,
      file_key: file_key ?? null,
      status: 'REQUESTED',
      requested_by: createdBy ?? null,
      updated_at: now,
    },
    select: {
      id: true,
      phone: true,
      patient_id: true,
      patient_uid: true,
      test_name: true,
      file_key: true,
      status: true,
      requested_by: true,
      requested_at: true,
    },
  });

  await prisma.notifications.create({
    data: {
      uid: randomUUID(),
      phone,
      title: 'Investigation Report Ready',
      body: `Your investigation report for "${test_name}" is now available.`,
      type: 'investigation_ready',
      is_read: false,
      updated_at: now,
    },
  }).catch((err) => logger.warn(`legacy investigation notification failed: ${err.message}`));

  logger.info(`Legacy investigation created: ${test_name} for ${phone}`);
  return investigation;
};

export const canOrderInvestigations = (userRole) => {
  return ['DOCTOR', 'ADMIN', 'SUPER_ADMIN'].includes(userRole);
};
