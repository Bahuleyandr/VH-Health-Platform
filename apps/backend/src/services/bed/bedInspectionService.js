// src/services/bed/bedInspectionService.js
//
// D1 — bed inspection / consumer-choice flow.
//
// Records which beds the receptionist walked an attender through after
// the patient was advised admission, plus the bed they ended up
// choosing. Migration 180.
//
// Lifecycle: pending -> chosen | declined | expired
//   - 'chosen' is the success path; the admission counter passes
//     chosen_bed_id into admitPatient.
//   - 'declined' means the attender walked away without picking
//     (will-go-elsewhere, wants to think). Re-startable.
//   - 'expired' is set by a periodic sweep when a pending row outlives
//     its expires_at — prevents stale shortlists from littering the UI.

import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenantService.js';

const VALID_DECISIONS = new Set(['pending', 'chosen', 'declined', 'expired']);

const TENANT_DEFAULT = '00000000-0000-4000-8000-000000000001';

/**
 * Begin an inspection — receptionist records which beds the attender
 * was shown. Validates that all bed ids exist and resolves to a
 * minimal snapshot (id, ward_name, bed_number, bed_type, status) so
 * the caller doesn't need a second round-trip.
 */
export async function startInspection({
  appointmentId = null,
  patientUid,
  shownBedIds,
  inspectedByAttender = null,
  attenderPhone = null,
  notes = null,
  initiatedBy,
  expiresInHours = 24,
  tenantId,
}) {
  if (!patientUid) throw AppError.badRequest('patientUid is required');
  if (!Array.isArray(shownBedIds) || shownBedIds.length === 0) {
    throw AppError.badRequest('shownBedIds must be a non-empty array');
  }
  if (!initiatedBy) throw AppError.badRequest('initiatedBy is required');
  const ids = shownBedIds.map((b) => Number.parseInt(b, 10)).filter(Number.isFinite);
  if (ids.length !== shownBedIds.length) {
    throw AppError.badRequest('All shownBedIds must be positive integers');
  }
  const tid = tenantId || TENANT_DEFAULT;

  // Validate bed ids exist (prevents the GIN index getting orphan
  // values; cheap because beds is small).
  const beds = await prisma.beds.findMany({
    where: { id: { in: ids } },
    select: { id: true, ward_name: true, bed_number: true, bed_type: true, status: true },
  });
  if (beds.length !== ids.length) {
    const found = new Set(beds.map((b) => b.id));
    const missing = ids.filter((i) => !found.has(i));
    throw AppError.badRequest(`Unknown bed_id(s): ${missing.join(', ')}`);
  }

  const expiresAt = new Date(Date.now() + Math.max(1, Math.min(168, expiresInHours)) * 3600_000);

  const inspection = await setTenantTx(tid || DEFAULT_TENANT_ID, async (tx) => {
    const inserted = await tx.$queryRawUnsafe(
      `INSERT INTO bed_inspections
        (appointment_id, patient_uid, shown_bed_ids, inspected_by_attender,
         attender_phone, notes, initiated_by, expires_at, tenant_id)
       VALUES ($1, $2::uuid, $3::int[], $4, $5, $6, $7::uuid, $8::timestamptz, $9::uuid)
       RETURNING id, appointment_id, patient_uid, shown_bed_ids, decision,
                 chosen_bed_id, inspected_by_attender, attender_phone,
                 initiated_at, expires_at`,
      appointmentId, patientUid, ids,
      inspectedByAttender, attenderPhone, notes,
      initiatedBy, expiresAt.toISOString(), tid,
    );
    await tx.audit_logs.create({
      data: {
        uid: initiatedBy,
        action: 'START_BED_INSPECTION',
        resource: 'bed_inspections',
        resource_id: String(inserted[0].id),
        metadata: { patient_uid: patientUid, shown_bed_ids: ids, appointment_id: appointmentId },
        ip_address: null,
      },
    });
    return inserted[0];
  });

  logger.info(`Bed inspection ${inspection.id} started: patient=${patientUid} shown=${ids.join(',')}`);
  return { ...inspection, beds };
}

/**
 * Record the patient's choice (or declination). chosen_bed_id is
 * required when decision='chosen' and must be in shown_bed_ids[]
 * (we don't allow choosing a bed that wasn't shown — protects against
 * "they picked one we didn't actually offer" data corruption).
 */
export async function recordDecision({
  inspectionId,
  decision,
  chosenBedId = null,
  notes = null,
  actorUid,
  tenantId = null,
}) {
  const id = Number.parseInt(inspectionId, 10);
  if (!Number.isInteger(id) || id <= 0) throw AppError.badRequest('inspectionId must be a positive integer');
  if (!VALID_DECISIONS.has(decision)) {
    throw AppError.badRequest(`Invalid decision: ${decision}`);
  }
  if (decision === 'chosen' && !chosenBedId) {
    throw AppError.badRequest('chosen_bed_id is required when decision=chosen');
  }
  if (!actorUid) throw AppError.badRequest('actorUid is required');

  const existing = await prisma.$queryRawUnsafe(
    `SELECT id, decision, shown_bed_ids, expires_at
       FROM bed_inspections WHERE id = $1`,
    id,
  );
  if (!existing.length) throw AppError.notFound(`Inspection ${id} not found`);
  const row = existing[0];
  if (row.decision !== 'pending') {
    throw AppError.conflict(`Inspection ${id} is already ${row.decision} — start a new one if the attender came back`);
  }
  if (decision === 'chosen' && !row.shown_bed_ids.includes(Number(chosenBedId))) {
    throw AppError.badRequest(`chosen_bed_id ${chosenBedId} was not in this inspection's shown_bed_ids`);
  }

  const updated = await setTenantTx(tenantId || DEFAULT_TENANT_ID, async (tx) => {
    const result = await tx.$queryRawUnsafe(
      `UPDATE bed_inspections
          SET decision = $2,
              chosen_bed_id = $3,
              notes = COALESCE(NULLIF($4, ''), notes),
              decided_at = NOW(),
              updated_at = NOW()
        WHERE id = $1
        RETURNING id, decision, chosen_bed_id, decided_at, notes`,
      id, decision, chosenBedId ? Number(chosenBedId) : null, notes ?? '',
    );
    await tx.audit_logs.create({
      data: {
        uid: actorUid,
        action: 'DECIDE_BED_INSPECTION',
        resource: 'bed_inspections',
        resource_id: String(id),
        metadata: { decision, chosen_bed_id: chosenBedId },
        ip_address: null,
      },
    });
    return result[0];
  });

  logger.info(`Bed inspection ${id} decided: ${decision}${chosenBedId ? ` bed=${chosenBedId}` : ''}`);
  return updated;
}

/**
 * The active (non-expired, non-decided) inspection for a patient, if
 * any. Returns null otherwise. The admission counter shows this so a
 * receptionist resumes the same shortlist when the attender returns.
 */
export async function getActiveForPatient(patientUid) {
  if (!patientUid) throw AppError.badRequest('patientUid is required');
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, appointment_id, patient_uid, shown_bed_ids, chosen_bed_id,
            decision, inspected_by_attender, attender_phone, initiated_by,
            initiated_at, expires_at, notes
       FROM bed_inspections
      WHERE patient_uid = $1::uuid
        AND decision = 'pending'
        AND expires_at > NOW()
      ORDER BY initiated_at DESC
      LIMIT 1`,
    patientUid,
  );
  return rows[0] || null;
}

export async function listForAppointment(appointmentId) {
  const id = Number.parseInt(appointmentId, 10);
  if (!Number.isInteger(id) || id <= 0) {
    throw AppError.badRequest('appointmentId must be a positive integer');
  }
  return prisma.$queryRawUnsafe(
    `SELECT id, patient_uid, shown_bed_ids, chosen_bed_id, decision,
            inspected_by_attender, attender_phone, initiated_at,
            decided_at, expires_at, notes
       FROM bed_inspections
      WHERE appointment_id = $1
      ORDER BY initiated_at DESC`,
    id,
  );
}

/**
 * Periodic sweep: mark all pending rows past expires_at as 'expired'.
 * Returns the count of rows expired. Cron-safe (idempotent).
 */
export async function expireStaleInspections() {
  const result = await prisma.$queryRawUnsafe(
    `UPDATE bed_inspections
        SET decision = 'expired', updated_at = NOW()
      WHERE decision = 'pending' AND expires_at < NOW()
      RETURNING id`,
  );
  if (result.length > 0) {
    logger.info(`Bed inspection sweep: expired ${result.length} stale inspection(s)`);
  }
  return { expired: result.length };
}

export default {
  startInspection,
  recordDecision,
  getActiveForPatient,
  listForAppointment,
  expireStaleInspections,
};
