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
