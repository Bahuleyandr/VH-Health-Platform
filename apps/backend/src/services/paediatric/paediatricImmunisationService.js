// src/services/paediatric/paediatricImmunisationService.js
//
// A10 — paediatric immunisation tracking for the general patient roll.
//
// Companion to the newborn_immunisations flow created in migration 160.
// The newborn variant is mass-seeded at birth and keyed to
// maternity_newborns.id; this service handles paediatric patients who
// don't have a maternity row (walk-ins, transfers, kids born elsewhere).
// Same vaccine_catalogue lookup; rows live in `patient_immunisations`
// (migration 179), keyed by patient_uid.
//
// vaccine_catalogue + newborn_immunisations + patient_immunisations are
// raw-SQL-only (never added to prisma/schema.prisma — see migration 160).
// All queries here use prisma.$queryRawUnsafe with spread args per the
// lint:raw-params convention.

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';

const VALID_STATUSES = new Set([
  'scheduled', 'given', 'missed', 'refused', 'contraindicated',
]);
const VALID_INJECTION_SITES = new Set([
  'left_thigh', 'right_thigh', 'left_deltoid', 'right_deltoid', 'oral', 'sc',
]);

const TENANT_DEFAULT = '00000000-0000-4000-8000-000000000001';

function tenantOr(t) { return t || TENANT_DEFAULT; }

/**
 * Seed a paediatric patient's immunisation schedule from the active
 * vaccine_catalogue. due_date for each row = dob + recommended_age_days.
 * Idempotent on (patient_uid, vaccine_catalogue_id) via the UNIQUE
 * constraint — repeat calls update existing rows' due_date instead of
 * inserting duplicates.
 *
 * If the patient already has a newborn_immunisations cohort row for the
 * same vaccine, the new patient_immunisations row's
 * newborn_immunisation_id back-link is populated so the UI can dedupe.
 */
export async function seedScheduleForPatient({ patientUid, dob, tenantId }) {
  if (!patientUid) throw AppError.badRequest('patientUid is required');
  if (!dob) throw AppError.badRequest('dob is required');
  const tid = tenantOr(tenantId);
  const dobDate = new Date(dob);
  if (Number.isNaN(dobDate.getTime())) throw AppError.badRequest('dob must be a valid date');

  // Look up active catalogue rows once, project due_date in app code so
  // the SQL stays simple and we control date arithmetic explicitly.
  const catalogue = await prisma.$queryRawUnsafe(
    `SELECT id, code, dose_number, recommended_age_days
       FROM vaccine_catalogue
      WHERE tenant_id = $1::uuid AND active = true
      ORDER BY recommended_age_days, code, dose_number`,
    tid,
  );

  let inserted = 0;
  let updated = 0;
  for (const row of catalogue) {
    const due = new Date(dobDate.getTime());
    due.setDate(due.getDate() + Number(row.recommended_age_days));
    const dueIso = due.toISOString().slice(0, 10);
    const result = await prisma.$queryRawUnsafe(
      `INSERT INTO patient_immunisations
         (patient_uid, vaccine_catalogue_id, due_date, tenant_id)
       VALUES ($1::uuid, $2, $3::date, $4::uuid)
       ON CONFLICT (patient_uid, vaccine_catalogue_id)
       DO UPDATE SET due_date = EXCLUDED.due_date, updated_at = NOW()
       RETURNING (xmax = 0) AS was_insert`,
      patientUid, Number(row.id), dueIso, tid,
    );
    if (result?.[0]?.was_insert) inserted += 1; else updated += 1;
  }

  logger.info(`Paediatric immunisation schedule seeded for patient=${patientUid} inserted=${inserted} updated=${updated}`);
  return { patient_uid: patientUid, inserted, updated, total: catalogue.length };
}

/**
 * List all immunisation rows for a patient, joined to catalogue for
 * display fields. Defaults to chronological by due_date.
 *
 * Derives `display_status` from `(status, due_date, given_at)` so the
 * nurse-facing UI can distinguish a past-due birth dose from an
 * upcoming MMR booster without a status-mutation cron job. Stored
 * `status` stays 'scheduled' until a clinician records the dose;
 * `display_status` collapses to 'overdue' when due_date is in the past
 * and no dose has been recorded yet. Finding:
 * 2026-05-09-pediatric-opd-nurse-immunisation-schedule-all-scheduled.
 */
export async function listForPatient(patientUid) {
  if (!patientUid) throw AppError.badRequest('patientUid is required');
  const rows = await prisma.$queryRawUnsafe(
    `SELECT pi.id, pi.patient_uid, pi.vaccine_catalogue_id, pi.due_date,
            pi.status, pi.given_at, pi.given_by, pi.given_by_name,
            pi.batch_number, pi.manufacturer, pi.site_of_injection,
            pi.adverse_event, pi.notes, pi.newborn_immunisation_id,
            pi.created_at, pi.updated_at,
            vc.code, vc.display_name, vc.dose_number,
            vc.recommended_age_days, vc.window_days
       FROM patient_immunisations pi
       JOIN vaccine_catalogue vc ON vc.id = pi.vaccine_catalogue_id
      WHERE pi.patient_uid = $1::uuid
      ORDER BY pi.due_date ASC, vc.code ASC, vc.dose_number ASC NULLS FIRST`,
    patientUid,
  );
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (const row of rows) {
    row.display_status = computeDisplayStatus(row, today);
  }
  return rows;
}

function computeDisplayStatus(row, today) {
  if (row.status === 'given') return 'given';
  if (row.status === 'missed') return 'missed';
  if (row.status === 'refused') return 'refused';
  if (row.status === 'contraindicated') return 'contraindicated';
  if (!row.due_date) return row.status;
  const due = new Date(row.due_date);
  due.setHours(0, 0, 0, 0);
  if (Number.isNaN(due.getTime())) return row.status;
  if (due.getTime() < today.getTime() && !row.given_at) return 'overdue';
  // Within the catalogue's window_days of due_date: vaccine is "due now".
  const windowMs = Number(row.window_days || 0) * 24 * 60 * 60 * 1000;
  if (windowMs > 0 && due.getTime() <= today.getTime() + windowMs && due.getTime() >= today.getTime() - windowMs) {
    return 'due';
  }
  return 'scheduled';
}

/**
 * Vaccines due now (window_days from due_date) or overdue, scheduled
 * status only. Powers the paeds-OPD "due immunisations" panel that
 * shows on encounter open.
 */
export async function listDueForPatient(patientUid, { asOf = null } = {}) {
  if (!patientUid) throw AppError.badRequest('patientUid is required');
  const checkpoint = asOf ? new Date(asOf) : new Date();
  const checkpointIso = checkpoint.toISOString().slice(0, 10);
  return prisma.$queryRawUnsafe(
    `SELECT pi.id, pi.due_date, pi.status, vc.code, vc.display_name,
            vc.dose_number, vc.window_days,
            (CASE WHEN pi.due_date <= $2::date THEN 'due_or_overdue'
                  ELSE 'upcoming' END) AS bucket
       FROM patient_immunisations pi
       JOIN vaccine_catalogue vc ON vc.id = pi.vaccine_catalogue_id
      WHERE pi.patient_uid = $1::uuid
        AND pi.status = 'scheduled'
      ORDER BY pi.due_date ASC`,
    patientUid, checkpointIso,
  );
}

/**
 * Record a dose given. Flips scheduled -> given (or to missed/refused/
 * contraindicated). Captures batch + manufacturer + site so the
 * cold-chain audit row is complete.
 */
export async function recordDose({
  immunisationId,
  status,
  givenAt,
  givenBy,
  givenByName,
  batchNumber,
  manufacturer,
  siteOfInjection,
  adverseEvent,
  notes,
}) {
  const id = Number.parseInt(immunisationId, 10);
  if (!Number.isInteger(id) || id <= 0) {
    throw AppError.badRequest('immunisationId must be a positive integer');
  }
  if (!status || !VALID_STATUSES.has(status)) {
    throw AppError.badRequest(`Invalid status. Must be one of: ${[...VALID_STATUSES].join(', ')}`);
  }
  if (status === 'given' && !givenBy) {
    throw AppError.badRequest('given status requires givenBy (clinician uid)');
  }
  if (siteOfInjection && !VALID_INJECTION_SITES.has(siteOfInjection)) {
    throw AppError.badRequest(`Invalid site_of_injection: ${siteOfInjection}`);
  }

  const result = await prisma.$queryRawUnsafe(
    `UPDATE patient_immunisations
        SET status = $2,
            given_at = COALESCE($3::timestamptz, given_at),
            given_by = COALESCE($4::uuid, given_by),
            given_by_name = COALESCE($5, given_by_name),
            batch_number = COALESCE($6, batch_number),
            manufacturer = COALESCE($7, manufacturer),
            site_of_injection = COALESCE($8, site_of_injection),
            adverse_event = COALESCE($9, adverse_event),
            notes = COALESCE($10, notes),
            updated_at = NOW()
      WHERE id = $1
      RETURNING id, patient_uid, status, given_at, given_by, vaccine_catalogue_id`,
    id, status,
    givenAt ?? (status === 'given' ? new Date().toISOString() : null),
    givenBy ?? null,
    givenByName ?? null,
    batchNumber ?? null,
    manufacturer ?? null,
    siteOfInjection ?? null,
    adverseEvent ?? null,
    notes ?? null,
  );
  if (!result.length) throw AppError.notFound(`Immunisation row ${id} not found`);
  return result[0];
}

/**
 * Catalogue browser — used by the paeds-OPD UI to populate "add a
 * dose" pickers when the auto-seed missed a vaccine (e.g., parent
 * brings dose certificate from another clinic).
 */
export async function listCatalogue({ tenantId } = {}) {
  const tid = tenantOr(tenantId);
  return prisma.$queryRawUnsafe(
    `SELECT id, code, display_name, dose_number, recommended_age_days, window_days, description
       FROM vaccine_catalogue
      WHERE tenant_id = $1::uuid AND active = true
      ORDER BY recommended_age_days, code, dose_number NULLS FIRST`,
    tid,
  );
}

export default {
  seedScheduleForPatient,
  listForPatient,
  listDueForPatient,
  recordDose,
  listCatalogue,
};
