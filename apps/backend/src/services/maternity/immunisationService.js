// src/services/maternity/immunisationService.js
//
// Sprint 7 follow-through — newborn immunisation schedule. Calling
// `seedScheduleForNewborn(newbornId)` creates one row per active
// vaccine catalogue entry, pre-computing each dose's due_date from
// the newborn's birth_datetime + recommended_age_days.

import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';

export async function listCatalogue({ tenantId, includeInactive = false }) {
  const params = [tenantId];
  let where = `tenant_id = $1::uuid`;
  if (!includeInactive) where += ` AND active = true`;
  return prisma.$queryRawUnsafe(
    `SELECT id, code, display_name, dose_number, recommended_age_days,
            window_days, description, active
       FROM vaccine_catalogue
      WHERE ${where}
      ORDER BY recommended_age_days, code, COALESCE(dose_number, 0)`,
    ...params,
  );
}

/**
 * Create the full immunisation schedule for a newborn. Idempotent —
 * skips doses that already exist (UNIQUE on newborn_id +
 * vaccine_catalogue_id).
 */
export async function seedScheduleForNewborn({ tenantId, newborn_id }) {
  if (!newborn_id) throw AppError.badRequest('newborn_id is required');

  const newbornRows = await prisma.$queryRawUnsafe(
    `SELECT id, birth_datetime, outcome FROM maternity_newborns
      WHERE id = $1::int AND tenant_id = $2::uuid`,
    Number(newborn_id), tenantId,
  );
  if (!newbornRows.length) throw AppError.notFound('Newborn not found');
  if (newbornRows[0].outcome !== 'live') {
    throw AppError.badRequest(
      'Cannot schedule immunisations for a non-live outcome',
    );
  }
  const birth = new Date(newbornRows[0].birth_datetime);

  const catalogue = await prisma.$queryRawUnsafe(
    `SELECT id, recommended_age_days FROM vaccine_catalogue
      WHERE tenant_id = $1::uuid AND active = true`,
    tenantId,
  );

  let scheduled = 0;
  for (const v of catalogue) {
    const due = new Date(birth.getTime() + v.recommended_age_days * 86_400_000);
    const result = await prisma.$executeRawUnsafe(
      `INSERT INTO newborn_immunisations
         (newborn_id, vaccine_catalogue_id, due_date, status, tenant_id)
       VALUES ($1::int, $2::int, $3::date, 'scheduled', $4::uuid)
       ON CONFLICT (newborn_id, vaccine_catalogue_id) DO NOTHING`,
      Number(newborn_id),
      Number(v.id),
      due.toISOString().split('T')[0],
      tenantId,
    );
    if (Number(result) > 0) scheduled += 1;
  }

  return { newborn_id: Number(newborn_id), scheduled };
}

export async function getScheduleForNewborn({ tenantId, newborn_id }) {
  return prisma.$queryRawUnsafe(
    `SELECT i.id, i.due_date, i.status, i.given_at, i.given_by_name,
            i.batch_number, i.manufacturer, i.site_of_injection,
            i.adverse_event, i.notes,
            v.code, v.display_name, v.dose_number,
            v.recommended_age_days, v.window_days
       FROM newborn_immunisations i
       JOIN vaccine_catalogue v ON v.id = i.vaccine_catalogue_id
      WHERE i.tenant_id = $1::uuid AND i.newborn_id = $2::int
      ORDER BY i.due_date, v.code, COALESCE(v.dose_number, 0)`,
    tenantId, Number(newborn_id),
  );
}

export async function recordDose({
  tenantId, immunisation_id, status, given_by, given_by_name,
  batch_number, manufacturer, site_of_injection, adverse_event, notes,
}) {
  if (!immunisation_id) throw AppError.badRequest('immunisation_id is required');
  const allowed = ['given', 'missed', 'refused', 'contraindicated'];
  if (!allowed.includes(status)) {
    throw AppError.badRequest(`status must be one of: ${allowed.join(', ')}`);
  }
  if (status === 'given' && !given_by_name) {
    throw AppError.badRequest('given_by_name is required when recording a "given" dose');
  }

  const rows = await prisma.$queryRawUnsafe(
    `UPDATE newborn_immunisations
        SET status = $1,
            given_at = CASE WHEN $1 = 'given' THEN NOW() ELSE given_at END,
            given_by = COALESCE($2::uuid, given_by),
            given_by_name = COALESCE($3, given_by_name),
            batch_number = COALESCE($4, batch_number),
            manufacturer = COALESCE($5, manufacturer),
            site_of_injection = COALESCE($6, site_of_injection),
            adverse_event = COALESCE($7, adverse_event),
            notes = COALESCE($8, notes),
            updated_at = NOW()
      WHERE id = $9::int AND tenant_id = $10::uuid
      RETURNING *`,
    status,
    given_by ? String(given_by) : null,
    given_by_name || null,
    batch_number || null,
    manufacturer || null,
    site_of_injection || null,
    adverse_event || null,
    notes || null,
    Number(immunisation_id),
    tenantId,
  );
  if (!rows.length) throw AppError.notFound('Immunisation row not found');
  return rows[0];
}

// Allowed age groups for the up-to-date shortcut. Mirrors the IAP/UIP
// schedule milestones the receptionist + paeds-OPD nurse routinely
// affirm: at-birth (BCG/OPV0/HepB), six-week, ten-week, fourteen-week,
// nine-month (MMR), fifteen-month (MMR2/DPT-booster), and the catch-
// all 'current'. Free text rejected to keep the surface bounded.
const VALID_IMMUNISATION_AGE_GROUPS = new Set([
  'birth', '6_week', '10_week', '14_week', '6_month',
  '9_month', '12_month', '15_month', '18_month',
  '2_year', '5_year', '10_year', 'current',
]);

/**
 * Workflow shortcut — record that a patient's immunisation schedule
 * is up to date as of a given date without writing one
 * `newborn_immunisations` row per scheduled vaccine. Used by the
 * paediatric OPD nurse at chart-open when the parent affirms "all
 * caught up" but doesn't have the exact per-dose dates.
 *
 * The row lands in `clinical_notes` with `note_type='immunisation_review'`
 * and content carrying status / as_of / age_group / signed_by_name.
 * The patient app's immunisation card surface reads the most recent
 * such note via the partial index added in migration 215.
 *
 * Finding:
 *   2026-05-10-pediatric-opd-nurse-immunisation-up-to-date-requires-29-writes
 */
export async function markScheduleUpToDate({
  tenantId, patient_uid, as_of, age_group, signed_by, signed_by_name, notes,
}) {
  if (!patient_uid) throw AppError.badRequest('patient_uid is required');
  if (!signed_by) throw AppError.badRequest('signed_by (staff uid) is required');

  const today = new Date().toISOString().split('T')[0];
  const asOfDate = as_of && /^\d{4}-\d{2}-\d{2}$/.test(String(as_of)) ? String(as_of) : today;
  const ageGroup = age_group && VALID_IMMUNISATION_AGE_GROUPS.has(String(age_group))
    ? String(age_group)
    : 'current';

  // Defensive existence check on the patient — clinical_notes.patient_uid
  // is NOT NULL but has no FK in the baseline; without this probe a
  // typo would persist a dangling note.
  const patientRow = await prisma.$queryRawUnsafe(
    `SELECT uid FROM users WHERE uid = $1::uuid LIMIT 1`,
    String(patient_uid),
  );
  if (!patientRow.length) throw AppError.notFound('Patient not found');

  const content = {
    status: 'up_to_date',
    as_of: asOfDate,
    age_group: ageGroup,
    signed_by_name: signed_by_name || null,
    notes: notes || null,
    tenant_id: tenantId,
  };

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO clinical_notes
       (patient_uid, author_uid, author_role, note_type, title, content,
        is_signed, signed_at, signed_by, status, tenant_id)
     VALUES ($1::uuid, $2::uuid, $3, 'immunisation_review',
             'Immunisation up to date', $4::jsonb,
             true, NOW(), $2::uuid, 'current', $5::uuid)
     RETURNING id, patient_uid, author_uid, author_role, note_type,
               title, content, is_signed, signed_at, signed_by, created_at`,
    String(patient_uid),
    String(signed_by),
    'STAFF',
    JSON.stringify(content),
    tenantId,
  );
  return rows[0];
}

/**
 * Patient-facing immunisation status — the patient app's immunisation
 * card calls this to compute "up-to-date as of X" without scanning
 * the full newborn_immunisations table. Returns the most recent
 * immunisation_review note for the patient (if any).
 */
export async function getImmunisationStatus({ patient_uid }) {
  if (!patient_uid) throw AppError.badRequest('patient_uid is required');
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, content, signed_at, signed_by, created_at
       FROM clinical_notes
      WHERE patient_uid = $1::uuid
        AND note_type = 'immunisation_review'
      ORDER BY created_at DESC
      LIMIT 1`,
    String(patient_uid),
  );
  if (!rows.length) return { status: 'unknown', reviewed: false };
  const row = rows[0];
  const content = typeof row.content === 'string' ? JSON.parse(row.content) : (row.content || {});
  return {
    status: content.status || 'unknown',
    as_of: content.as_of || null,
    age_group: content.age_group || null,
    signed_by_name: content.signed_by_name || null,
    signed_by: row.signed_by,
    signed_at: row.signed_at,
    note_id: row.id,
    reviewed: true,
  };
}

/**
 * Cron-friendly: list doses due / overdue across the tenant. Useful
 * for the "well-baby clinic" reminder fan-out.
 */
export async function listDueOrOverdue({
  tenantId, from_date, to_date, limit = 200,
}) {
  const today = new Date().toISOString().split('T')[0];
  return prisma.$queryRawUnsafe(
    `SELECT i.id, i.newborn_id, i.due_date, i.status,
            v.code, v.display_name, v.dose_number,
            n.delivery_id, n.newborn_patient_uid,
            (CURRENT_DATE - i.due_date) AS days_overdue
       FROM newborn_immunisations i
       JOIN vaccine_catalogue v ON v.id = i.vaccine_catalogue_id
       JOIN maternity_newborns n ON n.id = i.newborn_id
      WHERE i.tenant_id = $1::uuid
        AND i.status = 'scheduled'
        AND i.due_date BETWEEN COALESCE($2::date, $3::date - INTERVAL '7 days')
                           AND COALESCE($4::date, $3::date + INTERVAL '14 days')
      ORDER BY i.due_date, v.code
      LIMIT $5::int`,
    tenantId,
    from_date || null, today, to_date || null, Number(limit),
  );
}
