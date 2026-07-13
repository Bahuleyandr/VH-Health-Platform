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
import { requireTenantId } from '../tenant/tenantService.js';

const VALID_STATUSES = new Set([
  'scheduled', 'given', 'missed', 'refused', 'contraindicated',
]);
const VALID_INJECTION_SITES = new Set([
  'left_thigh', 'right_thigh', 'left_deltoid', 'right_deltoid', 'oral', 'sc',
]);

function tenantOr(t) { return requireTenantId(t); }

async function assertPatientInTenant(patientUid, tenantId) {
  const tid = tenantOr(tenantId);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT uid, birthday::text AS birthday
       FROM users
      WHERE uid = $1::uuid
        AND tenant_id = $2::uuid
      LIMIT 1`,
    patientUid, tid,
  );
  if (!rows.length) throw AppError.notFound('Patient not found', 'PAEDIATRIC_PATIENT_NOT_FOUND');
  return rows[0];
}

function dateOnly(value) {
  if (!value) return null;
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

async function latestSignedUpToDateReview({ patientUid, tenantId }) {
  const tid = tenantOr(tenantId);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id,
            COALESCE(content->>'as_of', signed_at::date::text, created_at::date::text) AS as_of,
            signed_at,
            signed_by
       FROM clinical_notes
      WHERE patient_uid = $1::uuid
        AND note_type = 'immunisation_review'
        AND COALESCE(is_signed, false) = true
        AND COALESCE(content->>'status', '') = 'up_to_date'
        AND (tenant_id = $2::uuid OR content->>'tenant_id' = $2::text)
      ORDER BY COALESCE(signed_at, created_at) DESC, created_at DESC
      LIMIT 1`,
    patientUid, tid,
  );
  if (!rows.length) return null;
  const asOf = dateOnly(rows[0].as_of);
  if (!asOf) return null;
  return { ...rows[0], as_of: asOf };
}

async function ensureScheduleSeededForPatient({ patientUid, tenantId }) {
  const tid = tenantOr(tenantId);
  const existing = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS count
       FROM patient_immunisations
      WHERE patient_uid = $1::uuid
        AND tenant_id = $2::uuid`,
    patientUid, tid,
  );
  if (Number(existing?.[0]?.count || 0) > 0) {
    return { seeded: false, reason: 'already_seeded' };
  }

  const patient = await assertPatientInTenant(patientUid, tid);
  const dob = patient?.birthday;
  if (!dob) {
    return { seeded: false, reason: 'missing_dob' };
  }

  const result = await seedScheduleForPatient({ patientUid, dob, tenantId: tid });
  return { seeded: true, ...result };
}

/**
 * O1 — resolve the EXACT newborn immunisation back-links for a paediatric
 * patient about to be seeded. A link is only ever produced when the patient's
 * identity is unambiguous: exactly one maternity newborn in this tenant carries
 * `newborn_patient_uid = patientUid`. When zero or more than one newborn shares
 * the uid, nothing is linked — ambiguous identity is never auto-resolved. For
 * the single matched newborn, each of its `newborn_immunisations` doses maps its
 * `vaccine_catalogue_id` to that dose id; a vaccine that (defensively) resolves
 * to more than one dose is dropped.
 *
 * Matching is on exact uuid + exact vaccine_catalogue_id only — never on vaccine
 * name/code equivalence. Strictly tenant-scoped, so a dose in another tenant can
 * never be returned.
 *
 * @returns {Promise<Map<number, number>>} vaccine_catalogue_id -> newborn_immunisation_id
 */
async function resolveNewbornDoseLinks({ patientUid, tenantId }) {
  const tid = tenantOr(tenantId);
  const newborns = await prisma.$queryRawUnsafe(
    `SELECT id
       FROM maternity_newborns
      WHERE tenant_id = $1::uuid
        AND newborn_patient_uid = $2::uuid
      ORDER BY id`,
    tid, patientUid,
  );
  // Absent or ambiguous identity → link nothing.
  if (newborns.length !== 1) return new Map();
  const newbornId = Number(newborns[0].id);

  const doses = await prisma.$queryRawUnsafe(
    `SELECT vaccine_catalogue_id, id
       FROM newborn_immunisations
      WHERE tenant_id = $1::uuid
        AND newborn_id = $2::int
      ORDER BY vaccine_catalogue_id, id`,
    tid, newbornId,
  );
  const counts = new Map();
  const linkByVaccine = new Map();
  for (const dose of doses) {
    const vaccineId = Number(dose.vaccine_catalogue_id);
    counts.set(vaccineId, (counts.get(vaccineId) || 0) + 1);
    linkByVaccine.set(vaccineId, Number(dose.id));
  }
  // UNIQUE(newborn_id, vaccine_catalogue_id) makes >1 impossible for a single
  // newborn, but guard anyway: never link a vaccine with multiple candidates.
  for (const [vaccineId, count] of counts) {
    if (count > 1) linkByVaccine.delete(vaccineId);
  }
  return linkByVaccine;
}

/**
 * Seed a paediatric patient's immunisation schedule from the active
 * vaccine_catalogue. due_date for each row = dob + recommended_age_days.
 * Idempotent on (patient_uid, vaccine_catalogue_id) via the UNIQUE
 * constraint. Existing rows keep their original due_date because pack
 * timing changes apply only to future seeds.
 *
 * O1 — for FUTURE seeds only, each newly inserted row's newborn_immunisation_id
 * back-link is populated when, and only when, the patient's identity resolves
 * to exactly one maternity newborn with exactly one matching newborn dose for
 * that vaccine (see resolveNewbornDoseLinks). Any ambiguity leaves the row
 * unlinked and reported by scripts/immunisation-linkage-report.mjs. Rows that
 * already exist are never re-linked here (no backfill): the ON CONFLICT branch
 * does not touch newborn_immunisation_id.
 */
export async function seedScheduleForPatient({ patientUid, dob, tenantId }) {
  if (!patientUid) throw AppError.badRequest('patientUid is required');
  if (!dob) throw AppError.badRequest('dob is required');
  const tid = tenantOr(tenantId);
  const dobDate = new Date(dob);
  if (Number.isNaN(dobDate.getTime())) throw AppError.badRequest('dob must be a valid date');
  await assertPatientInTenant(patientUid, tid);

  // Look up active catalogue rows once, project due_date in app code so
  // the SQL stays simple and we control date arithmetic explicitly.
  const catalogue = await prisma.$queryRawUnsafe(
    `SELECT id, code, dose_number, recommended_age_days
       FROM vaccine_catalogue
      WHERE tenant_id = $1::uuid AND active = true
      ORDER BY recommended_age_days, code, dose_number`,
    tid,
  );

  // Resolve exact newborn-dose back-links once for this patient (tenant-scoped).
  const newbornLinks = await resolveNewbornDoseLinks({ patientUid, tenantId: tid });

  let inserted = 0;
  let updated = 0;
  let linked = 0;
  for (const row of catalogue) {
    const due = new Date(dobDate.getTime());
    due.setDate(due.getDate() + Number(row.recommended_age_days));
    const dueIso = due.toISOString().slice(0, 10);
    // Exact link (or null). Only applied on INSERT — the ON CONFLICT branch
    // never rewrites an existing row's link, so already-seeded schedules are
    // left exactly as they are (no backfill).
    const newbornImmunId = newbornLinks.get(Number(row.id)) ?? null;
    const result = await prisma.$queryRawUnsafe(
      `INSERT INTO patient_immunisations
         (patient_uid, vaccine_catalogue_id, due_date, newborn_immunisation_id, tenant_id)
       VALUES ($1::uuid, $2, $3::date, $4::int, $5::uuid)
       ON CONFLICT (patient_uid, vaccine_catalogue_id)
       DO UPDATE SET updated_at = patient_immunisations.updated_at
       WHERE patient_immunisations.tenant_id = EXCLUDED.tenant_id
       RETURNING (xmax = 0) AS was_insert`,
      patientUid, Number(row.id), dueIso, newbornImmunId, tid,
    );
    if (!result.length) {
      throw AppError.conflict(
        'Patient immunisation row conflicts with another tenant',
        'PAEDIATRIC_IMMUNISATION_TENANT_CONFLICT',
      );
    }
    if (result?.[0]?.was_insert) {
      inserted += 1;
      if (newbornImmunId != null) linked += 1;
    } else {
      updated += 1;
    }
  }

  logger.info(`Paediatric immunisation schedule seeded for patient=${patientUid} inserted=${inserted} updated=${updated} linked=${linked}`);
  return { patient_uid: patientUid, inserted, updated, linked, total: catalogue.length };
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
export async function listForPatient(patientUid, { tenantId } = {}) {
  if (!patientUid) throw AppError.badRequest('patientUid is required');
  await ensureScheduleSeededForPatient({ patientUid, tenantId });
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
        AND vc.tenant_id = pi.tenant_id
      WHERE pi.patient_uid = $1::uuid
        AND pi.tenant_id = $2::uuid
        -- O1 deduped read: a row exactly linked to a newborn dose is owned by
        -- the newborn immunisation schedule and must not surface here as a
        -- second, independent patient dose.
        AND pi.newborn_immunisation_id IS NULL
      ORDER BY pi.due_date ASC, vc.code ASC, vc.dose_number ASC NULLS FIRST`,
    patientUid, tenantOr(tenantId),
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
export async function listDueForPatient(patientUid, { asOf = null, tenantId = null } = {}) {
  if (!patientUid) throw AppError.badRequest('patientUid is required');
  await ensureScheduleSeededForPatient({ patientUid, tenantId });
  const checkpoint = asOf ? new Date(asOf) : new Date();
  const checkpointIso = checkpoint.toISOString().slice(0, 10);
  const review = await latestSignedUpToDateReview({ patientUid, tenantId });
  const reviewCutoffIso = review && review.as_of <= checkpointIso ? review.as_of : null;
  return prisma.$queryRawUnsafe(
    `SELECT pi.id, pi.due_date, pi.status, vc.code, vc.display_name,
            vc.dose_number, vc.window_days,
            (CASE WHEN pi.due_date <= $2::date THEN 'due_or_overdue'
                  ELSE 'upcoming' END) AS bucket
       FROM patient_immunisations pi
       JOIN vaccine_catalogue vc ON vc.id = pi.vaccine_catalogue_id
        AND vc.tenant_id = pi.tenant_id
      WHERE pi.patient_uid = $1::uuid
        AND pi.tenant_id = $4::uuid
        AND pi.status = 'scheduled'
        -- O1 deduped read: linked doses belong to the newborn schedule, so they
        -- never appear as an independent "due" paediatric dose.
        AND pi.newborn_immunisation_id IS NULL
        AND ($3::date IS NULL OR pi.due_date > $3::date)
      ORDER BY pi.due_date ASC`,
    patientUid, checkpointIso, reviewCutoffIso, tenantOr(tenantId),
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
  tenantId,
}) {
  const tid = tenantOr(tenantId);
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
        AND tenant_id = $11::uuid
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
    tid,
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
