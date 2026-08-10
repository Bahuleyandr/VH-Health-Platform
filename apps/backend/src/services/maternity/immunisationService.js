// src/services/maternity/immunisationService.js
//
// Sprint 7 follow-through — newborn immunisation schedule. Calling
// `seedScheduleForNewborn(newbornId)` creates one row per active
// vaccine catalogue entry, pre-computing each dose's due_date from
// the newborn's birth_datetime + recommended_age_days.

import { createHash } from 'node:crypto';

import prisma, { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { boundedInteger } from '../../utils/pagination.js';
import { assertScheduleConfigured } from '../immunisation/catalogueStatus.js';
import {
  currentCanonicalTransactionRevision,
  recordCanonicalClinicalEvent,
} from '../clinical/canonicalClinicalPlatformService.js';
import {
  assertExclusiveNewbornLink,
  assertNewbornIdentitySubject,
  newbornIdentityRequired,
} from './newbornIdentity.js';

function dateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function canonicalDoseFingerprint(dose) {
  const persistedState = {
    status: dose.status == null ? null : String(dose.status),
    given_at: dose.given_at ? new Date(dose.given_at).toISOString() : null,
    given_by: dose.given_by == null ? null : String(dose.given_by),
    given_by_name: dose.given_by_name == null ? null : String(dose.given_by_name),
    batch_number: dose.batch_number == null ? null : String(dose.batch_number),
    manufacturer: dose.manufacturer == null ? null : String(dose.manufacturer),
    site_of_injection: dose.site_of_injection == null ? null : String(dose.site_of_injection),
    adverse_event: dose.adverse_event == null ? null : String(dose.adverse_event),
    notes: dose.notes == null ? null : String(dose.notes),
  };
  return createHash('sha256').update(JSON.stringify(persistedState)).digest('hex');
}

async function assertPatientInTenant(tenantId, patientUid) {
  const patientRow = await prisma.$queryRawUnsafe(
    `SELECT uid FROM users
      WHERE tenant_id = $1::uuid
        AND uid = $2::uuid
        AND role = 'PATIENT'
      LIMIT 1`,
    tenantId,
    String(patientUid),
  );
  if (!patientRow.length) throw AppError.notFound('Patient not found');
}

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
export async function seedScheduleForNewborn({
  tenantId, newborn_id, actor_uid = null, actor_role = null,
}) {
  if (!newborn_id) throw AppError.badRequest('newborn_id is required');

  // D7 M-D remediation (signed 2026-07-15): the clinical subject is the
  // newborn's OWN identity (maternity_newborns.newborn_patient_uid) —
  // the pre-D7 mother-fallback CASE is removed. Absent link, failed E-3
  // predicate, or ambiguity rejects the mutation fail-closed; no proxy
  // writes to the mother's record.
  const newbornRows = await prisma.$queryRawUnsafe(
    `SELECT n.id, n.birth_datetime, n.outcome, n.newborn_patient_uid,
            p.patient_uid AS mother_patient_uid
       FROM maternity_newborns n
       JOIN maternity_deliveries d
         ON d.id = n.delivery_id
        AND d.tenant_id = n.tenant_id
       JOIN maternity_pregnancies p
         ON p.id = d.pregnancy_id
        AND p.tenant_id = n.tenant_id
      WHERE n.id = $1::int AND n.tenant_id = $2::uuid`,
    Number(newborn_id), tenantId,
  );
  if (!newbornRows.length) throw AppError.notFound('Newborn not found');
  if (newbornRows[0].outcome !== 'live') {
    throw AppError.badRequest(
      'Cannot schedule immunisations for a non-live outcome',
    );
  }
  if (!newbornRows[0].newborn_patient_uid) throw newbornIdentityRequired();
  const motherPatientUid = String(newbornRows[0].mother_patient_uid);
  // D6-R2: fail closed on an unconfigured facility rather than returning a
  // silently empty {scheduled:0} schedule.
  await assertScheduleConfigured(tenantId);

  return setTenantTx(tenantId, async (tx) => {
    const lockedNewborns = await tx.$queryRawUnsafe(
      `SELECT id, newborn_patient_uid
         FROM maternity_newborns
        WHERE id = $1::int AND tenant_id = $2::uuid
        FOR UPDATE`,
      Number(newborn_id), tenantId,
    );
    if (!lockedNewborns.length) throw AppError.notFound('Newborn not found');
    // E-c1 in-transaction re-check under row locks (newborn row above,
    // users row inside the assert); migration 577's A-1 unique index is
    // the structural backstop for link exclusivity.
    if (!lockedNewborns[0].newborn_patient_uid) throw newbornIdentityRequired();
    const subjectUid = String(lockedNewborns[0].newborn_patient_uid);
    await assertNewbornIdentitySubject({
      db: tx,
      tenantId,
      candidateUid: subjectUid,
      motherPatientUid,
      forUpdate: true,
    });
    await assertExclusiveNewbornLink({
      db: tx, tenantId, candidateUid: subjectUid, newbornId: Number(newborn_id),
    });
    const patientUid = subjectUid;

    const inserted = await tx.$queryRawUnsafe(
      `WITH seeded AS (
         INSERT INTO newborn_immunisations
           (newborn_id, vaccine_catalogue_id, due_date, status, tenant_id)
         SELECT $1::int,
                v.id,
                ($2::date + v.recommended_age_days)::date,
                'scheduled',
                $3::uuid
           FROM vaccine_catalogue v
          WHERE v.tenant_id = $3::uuid
            AND v.active = true
         ON CONFLICT (newborn_id, vaccine_catalogue_id) DO NOTHING
         RETURNING id, newborn_id, vaccine_catalogue_id, due_date,
                   status, created_at
       )
       SELECT seeded.*, v.code, v.dose_number
         FROM seeded
         JOIN vaccine_catalogue v
           ON v.id = seeded.vaccine_catalogue_id
          AND v.tenant_id = $3::uuid
        ORDER BY seeded.id`,
      Number(newborn_id),
      new Date(newbornRows[0].birth_datetime).toISOString().slice(0, 10),
      tenantId,
    );

    for (const dose of inserted) {
      await recordCanonicalClinicalEvent({
        tenantId,
        patientUid,
        eventType: 'immunisation.schedule_seeded',
        eventStatus: 'scheduled',
        sourceTable: 'newborn_immunisations',
        sourceId: dose.id,
        resourceType: 'immunisation_dose',
        resourceId: dose.id,
        actorUid: actor_uid,
        actorRole: actor_role,
        occurredAt: dose.created_at,
        visibleToPatient: false,
        summary: 'Immunisation dose scheduled',
        payload: {
          immunisation_id: dose.id,
          newborn_id: Number(dose.newborn_id),
          vaccine_catalogue_id: Number(dose.vaccine_catalogue_id),
          vaccine_code: dose.code,
          dose_number: dose.dose_number == null ? null : Number(dose.dose_number),
          due_date: dateOnly(dose.due_date),
          status: dose.status,
        },
        afterState: { status: dose.status, due_date: dateOnly(dose.due_date) },
        timelineIdempotencyKey: `newborn_immunisations:${dose.id}:scheduled`,
        auditIdempotencyKey: `newborn_immunisations:${dose.id}:audit:scheduled`,
      }, { db: tx, strict: true });
    }

    return { newborn_id: Number(newborn_id), scheduled: inserted.length };
  });
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
      JOIN maternity_newborns n
        ON n.id = i.newborn_id
       AND n.tenant_id = i.tenant_id
      WHERE i.tenant_id = $1::uuid AND i.newborn_id = $2::int
      ORDER BY i.due_date, v.code, COALESCE(v.dose_number, 0)`,
    tenantId, Number(newborn_id),
  );
}

export async function recordDose({
  tenantId, immunisation_id, status, given_by, given_by_name,
  batch_number, manufacturer, site_of_injection, adverse_event, notes,
  actor_role = null,
}) {
  if (!immunisation_id) throw AppError.badRequest('immunisation_id is required');
  const allowed = ['given', 'missed', 'refused', 'contraindicated'];
  if (!allowed.includes(status)) {
    throw AppError.badRequest(`status must be one of: ${allowed.join(', ')}`);
  }
  if (status === 'given' && !given_by_name) {
    throw AppError.badRequest('given_by_name is required when recording a "given" dose');
  }

  // D7 M-D remediation (signed 2026-07-15): the clinical subject is the
  // newborn's OWN identity — the pre-D7 mother-fallback CASE is removed.
  // Absent link, failed E-3 predicate, or ambiguity rejects the mutation
  // fail-closed BEFORE any write or retry short-circuit; no proxy writes
  // to the mother's record.
  const contexts = await prisma.$queryRawUnsafe(
    `SELECT i.id,
            n.id AS newborn_id,
            n.newborn_patient_uid,
            p.patient_uid AS mother_patient_uid
       FROM newborn_immunisations i
       JOIN maternity_newborns n
         ON n.id = i.newborn_id
        AND n.tenant_id = i.tenant_id
       JOIN maternity_deliveries d
         ON d.id = n.delivery_id
        AND d.tenant_id = n.tenant_id
       JOIN maternity_pregnancies p
         ON p.id = d.pregnancy_id
        AND p.tenant_id = n.tenant_id
      WHERE i.id = $1::int AND i.tenant_id = $2::uuid`,
    Number(immunisation_id), tenantId,
  );
  if (!contexts.length) throw AppError.notFound('Immunisation row not found');
  if (!contexts[0].newborn_patient_uid) throw newbornIdentityRequired();
  const motherPatientUid = String(contexts[0].mother_patient_uid);
  const contextNewbornId = Number(contexts[0].newborn_id);

  return setTenantTx(tenantId, async (tx) => {
    // E-c1 — validate the clinical subject FIRST, under row locks (newborn
    // row + users row FOR UPDATE), before the retry guard or any write:
    // a concurrently invalidated identity (deactivation, soft delete,
    // executed merge) must reject rather than record. Migration 577's A-1
    // unique index is the structural backstop for link exclusivity.
    const lockedNewborns = await tx.$queryRawUnsafe(
      `SELECT id, newborn_patient_uid
         FROM maternity_newborns
        WHERE id = $1::int AND tenant_id = $2::uuid
        FOR UPDATE`,
      contextNewbornId, tenantId,
    );
    if (!lockedNewborns.length) throw AppError.notFound('Newborn not found');
    if (!lockedNewborns[0].newborn_patient_uid) throw newbornIdentityRequired();
    const subjectUid = String(lockedNewborns[0].newborn_patient_uid);
    await assertNewbornIdentitySubject({
      db: tx,
      tenantId,
      candidateUid: subjectUid,
      motherPatientUid,
      forUpdate: true,
    });
    await assertExclusiveNewbornLink({
      db: tx, tenantId, candidateUid: subjectUid, newbornId: contextNewbornId,
    });

    // Effective-state no-op guard (canonical revision-sequence fix). Mirror
    // the CASE/COALESCE semantics of the UPDATE below against the locked
    // current row: an exact retry (same effective persisted state) must
    // return before the UPDATE so the tuple keeps its xmin/updated_at and no
    // canonical revision is allocated. FOR UPDATE makes two concurrent
    // identical mutations collapse — the loser re-reads the winner's
    // committed state and no-ops.
    const guardRows = await tx.$queryRawUnsafe(
      `SELECT n.*,
              (
                    n.status IS NOT DISTINCT FROM $1::varchar
                AND n.given_at IS NOT DISTINCT FROM (CASE
                      WHEN $1::varchar = 'given' THEN COALESCE(n.given_at, NOW())
                      ELSE n.given_at
                    END)
                AND n.given_by IS NOT DISTINCT FROM COALESCE($2::uuid, n.given_by)
                AND n.given_by_name IS NOT DISTINCT FROM COALESCE($3, n.given_by_name)
                AND n.batch_number IS NOT DISTINCT FROM COALESCE($4, n.batch_number)
                AND n.manufacturer IS NOT DISTINCT FROM COALESCE($5, n.manufacturer)
                AND n.site_of_injection IS NOT DISTINCT FROM COALESCE($6, n.site_of_injection)
                AND n.adverse_event IS NOT DISTINCT FROM COALESCE($7, n.adverse_event)
                AND n.notes IS NOT DISTINCT FROM COALESCE($8, n.notes)
              ) AS effective_state_unchanged
         FROM newborn_immunisations n
        WHERE n.id = $9::int AND n.tenant_id = $10::uuid
        FOR UPDATE`,
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
    if (!guardRows.length) throw AppError.notFound('Immunisation row not found');
    if (guardRows[0].effective_state_unchanged === true) {
      const { effective_state_unchanged: _unchanged, ...existingDose } = guardRows[0];
      return existingDose;
    }

    const rows = await tx.$queryRawUnsafe(
      `UPDATE newborn_immunisations
          SET status = $1::varchar,
              given_at = CASE
                WHEN $1::varchar = 'given' THEN COALESCE(given_at, NOW())
                ELSE given_at
              END,
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
    const dose = rows[0];

    const catalogue = await tx.$queryRawUnsafe(
      `SELECT code, dose_number
         FROM vaccine_catalogue
        WHERE id = $1::int AND tenant_id = $2::uuid`,
      Number(dose.vaccine_catalogue_id), tenantId,
    );
    const payload = {
      immunisation_id: dose.id,
      newborn_id: Number(dose.newborn_id),
      vaccine_catalogue_id: Number(dose.vaccine_catalogue_id),
      vaccine_code: catalogue[0]?.code || null,
      dose_number: catalogue[0]?.dose_number == null ? null : Number(catalogue[0].dose_number),
      status: dose.status,
    };
    if (dose.status === 'given') {
      payload.batch_number = dose.batch_number || null;
      payload.manufacturer = dose.manufacturer || null;
      payload.site_of_injection = dose.site_of_injection || null;
    }
    const canonicalFingerprint = canonicalDoseFingerprint(dose);
    // Genuine mutation (the guard above returned for exact retries): bind the
    // revision to this transaction's xid8 so an A -> B -> A return to earlier
    // cold-chain facts still records its own timeline/audit revision.
    const txRevision = await currentCanonicalTransactionRevision(tx);

    await recordCanonicalClinicalEvent({
      tenantId,
      patientUid: subjectUid,
      eventType: 'immunisation.dose_recorded',
      eventStatus: dose.status,
      sourceTable: 'newborn_immunisations',
      sourceId: dose.id,
      resourceType: 'immunisation_dose',
      resourceId: dose.id,
      actorUid: given_by || null,
      actorRole: actor_role,
      occurredAt: dose.given_at || dose.updated_at,
      visibleToPatient: false,
      summary: 'Immunisation dose recorded',
      payload,
      afterState: {
        status: dose.status,
        given_at: dose.given_at || null,
        batch_number: dose.status === 'given' ? dose.batch_number || null : null,
        manufacturer: dose.status === 'given' ? dose.manufacturer || null : null,
        site_of_injection: dose.status === 'given' ? dose.site_of_injection || null : null,
      },
      timelineIdempotencyKey: `newborn_immunisations:${dose.id}:recorded:${canonicalFingerprint}:tx:${txRevision}`,
      auditIdempotencyKey: `newborn_immunisations:${dose.id}:audit:recorded:${canonicalFingerprint}:tx:${txRevision}`,
    }, { db: tx, strict: true });

    return dose;
  });
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
  actor_role = null,
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
  await assertPatientInTenant(tenantId, patient_uid);

  const content = {
    status: 'up_to_date',
    as_of: asOfDate,
    age_group: ageGroup,
    signed_by_name: signed_by_name || null,
    notes: notes || null,
    tenant_id: tenantId,
  };

  return setTenantTx(tenantId, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
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
      actor_role || 'STAFF',
      JSON.stringify(content),
      tenantId,
    );
    const review = rows[0];

    // Fixed lifecycle key (insert-once, audited 2026-07-14): the review note
    // is born signed and is immutable through every clinical_notes surface —
    // clinicalNotesService.updateNote rejects note_type='immunisation_review'
    // before its admin override runs (not an editable type; pinned by
    // src/tests/unit/clinicalNotesUpdate.test.js), signNote 409s
    // already-signed notes, addenda create NEW rows, and repeat reviews
    // insert NEW rows (getImmunisationStatus reads the most recent). If
    // immunisation_review ever becomes editable in place, move this emit to
    // the state-fingerprint + :tx: revision pattern (PR #589; see
    // docs/CANONICAL_CLINICAL_TIMELINE.md "Idempotency-Key Discipline").
    await recordCanonicalClinicalEvent({
      tenantId,
      patientUid: String(patient_uid),
      eventType: 'immunisation.schedule_marked_up_to_date',
      eventStatus: 'up_to_date',
      sourceTable: 'clinical_notes',
      sourceId: review.id,
      resourceType: 'immunisation_review',
      resourceId: review.id,
      actorUid: signed_by,
      actorRole: actor_role,
      occurredAt: review.signed_at,
      visibleToPatient: false,
      summary: 'Immunisation schedule reviewed',
      payload: {
        note_id: review.id,
        status: 'up_to_date',
        as_of: asOfDate,
        age_group: ageGroup,
      },
      afterState: { status: 'up_to_date', as_of: asOfDate, age_group: ageGroup },
      timelineIdempotencyKey: `clinical_notes:${review.id}:immunisation_review`,
      auditIdempotencyKey: `clinical_notes:${review.id}:audit:immunisation_review`,
    }, { db: tx, strict: true });

    return review;
  });
}

/**
 * Patient-facing immunisation status — the patient app's immunisation
 * card calls this to compute "up-to-date as of X" without scanning
 * the full newborn_immunisations table. Returns the most recent
 * immunisation_review note for the patient (if any). Addendum rows are
 * excluded: clinicalNotesService.addAddendum copies note_type from the
 * parent with free-form content, so without the is_addendum filter an
 * addendum would shadow the review and project status 'unknown'.
 */
export async function getImmunisationStatus({ tenantId, patient_uid }) {
  if (!patient_uid) throw AppError.badRequest('patient_uid is required');
  await assertPatientInTenant(tenantId, patient_uid);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, content, signed_at, signed_by, created_at
       FROM clinical_notes
      WHERE tenant_id = $1::uuid
        AND patient_uid = $2::uuid
        AND note_type = 'immunisation_review'
        AND COALESCE(is_addendum, false) = false
      ORDER BY created_at DESC
      LIMIT 1`,
    tenantId,
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
       JOIN maternity_newborns n
         ON n.id = i.newborn_id
        AND n.tenant_id = i.tenant_id
      WHERE i.tenant_id = $1::uuid
        AND i.status = 'scheduled'
        AND i.due_date BETWEEN COALESCE($2::date, $3::date - INTERVAL '7 days')
                           AND COALESCE($4::date, $3::date + INTERVAL '14 days')
      ORDER BY i.due_date, v.code
      LIMIT $5::int`,
    tenantId,
    from_date || null, today, to_date || null,
    boundedInteger(limit, { fallback: 200, min: 1, max: 500 }),
  );
}
