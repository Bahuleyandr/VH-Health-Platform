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

import { createHash } from 'node:crypto';

import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import {
  currentCanonicalTransactionRevision,
  recordCanonicalClinicalEvent,
} from '../clinical/canonicalClinicalPlatformService.js';
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

function matchesPersistedDoseRetry(persisted, requested) {
  if (persisted.status !== requested.status) return false;
  if (requested.givenAt != null) {
    const requestedAt = new Date(requested.givenAt);
    if (Number.isNaN(requestedAt.getTime()) || !persisted.given_at) return false;
    if (requestedAt.toISOString() !== new Date(persisted.given_at).toISOString()) return false;
  }
  const fields = [
    ['givenBy', 'given_by'],
    ['givenByName', 'given_by_name'],
    ['batchNumber', 'batch_number'],
    ['manufacturer', 'manufacturer'],
    ['siteOfInjection', 'site_of_injection'],
    ['adverseEvent', 'adverse_event'],
    ['notes', 'notes'],
  ];
  return fields.every(([requestKey, persistedKey]) => {
    const value = requested[requestKey];
    if (value == null) return true;
    const persistedValue = persisted[persistedKey];
    return persistedValue != null && String(value) === String(persistedValue);
  });
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
 * that vaccine. Candidate resolution and every schedule write happen inside
 * one tenant-scoped transaction. The two source tables are SHARE-locked before
 * the single INSERT...SELECT statement so another newborn or newborn dose
 * cannot appear between the exactness check and the back-link write. Any
 * ambiguity leaves the row unlinked and is reported by
 * scripts/immunisation-linkage-report.mjs. Rows that already exist are never
 * re-linked here (no backfill): the ON CONFLICT branch does not touch
 * newborn_immunisation_id.
 */
export async function seedScheduleForPatient({
  patientUid, dob, tenantId, actorUid = null, actorRole = null,
}) {
  if (!patientUid) throw AppError.badRequest('patientUid is required');
  if (!dob) throw AppError.badRequest('dob is required');
  const tid = tenantOr(tenantId);
  const dobDate = new Date(dob);
  if (Number.isNaN(dobDate.getTime())) throw AppError.badRequest('dob must be a valid date');
  await assertPatientInTenant(patientUid, tid);

  const dobIso = dobDate.toISOString().slice(0, 10);
  const counts = await setTenantTx(tid, async (tx) => {
    // SHARE conflicts with INSERT/UPDATE/DELETE's ROW EXCLUSIVE lock. Holding
    // both locks until commit closes the identity/dose phantom window without
    // changing historical rows or adding a schema constraint.
    await tx.$executeRawUnsafe(
      'LOCK TABLE maternity_newborns, newborn_immunisations IN SHARE MODE',
    );
    const rows = await tx.$queryRawUnsafe(
      `WITH exact_newborn AS (
         SELECT MIN(id)::int AS newborn_id
           FROM maternity_newborns
          WHERE tenant_id = $1::uuid
            AND newborn_patient_uid = $2::uuid
         HAVING COUNT(*) = 1
       ),
       exact_doses AS (
         SELECT ni.vaccine_catalogue_id,
                MIN(ni.id)::int AS newborn_immunisation_id
           FROM newborn_immunisations ni
           JOIN exact_newborn en ON en.newborn_id = ni.newborn_id
          WHERE ni.tenant_id = $1::uuid
          GROUP BY ni.vaccine_catalogue_id
         HAVING COUNT(*) = 1
       ),
       active_catalogue AS (
         SELECT vc.id,
                ($3::date + vc.recommended_age_days)::date AS due_date
           FROM vaccine_catalogue vc
          WHERE vc.tenant_id = $1::uuid
            AND vc.active = true
       ),
       upserted AS (
         INSERT INTO patient_immunisations
           (patient_uid, vaccine_catalogue_id, due_date,
            newborn_immunisation_id, tenant_id)
         SELECT $2::uuid, ac.id, ac.due_date,
                ed.newborn_immunisation_id, $1::uuid
           FROM active_catalogue ac
           LEFT JOIN exact_doses ed
             ON ed.vaccine_catalogue_id = ac.id
         ON CONFLICT (patient_uid, vaccine_catalogue_id)
         DO UPDATE SET updated_at = patient_immunisations.updated_at
         WHERE patient_immunisations.tenant_id = EXCLUDED.tenant_id
         RETURNING id, vaccine_catalogue_id, due_date,
                   (xmax = 0) AS was_insert, newborn_immunisation_id
       )
       SELECT (SELECT COUNT(*)::int FROM active_catalogue) AS total,
              COUNT(*)::int AS touched,
              COUNT(*) FILTER (WHERE was_insert)::int AS inserted,
              COUNT(*) FILTER (WHERE NOT was_insert)::int AS updated,
              COUNT(*) FILTER (
                WHERE was_insert AND newborn_immunisation_id IS NOT NULL
              )::int AS linked,
              COALESCE(
                jsonb_agg(jsonb_build_object(
                  'id', id,
                  'vaccine_catalogue_id', vaccine_catalogue_id,
                  'due_date', due_date,
                  'newborn_immunisation_id', newborn_immunisation_id
                ) ORDER BY id) FILTER (WHERE was_insert),
                '[]'::jsonb
              ) AS inserted_rows
         FROM upserted`,
      tid, patientUid, dobIso,
    );
    const result = rows[0];
    if (Number(result?.touched || 0) !== Number(result?.total || 0)) {
      throw AppError.conflict(
        'Patient immunisation row conflicts with another tenant',
        'PAEDIATRIC_IMMUNISATION_TENANT_CONFLICT',
      );
    }

    const insertedRows = Array.isArray(result?.inserted_rows) ? result.inserted_rows : [];
    for (const dose of insertedRows) {
      await recordCanonicalClinicalEvent({
        tenantId: tid,
        patientUid,
        eventType: 'immunisation.schedule_seeded',
        eventStatus: 'scheduled',
        sourceTable: 'patient_immunisations',
        sourceId: dose.id,
        resourceType: 'immunisation_dose',
        resourceId: dose.id,
        actorUid,
        actorRole,
        visibleToPatient: false,
        summary: 'Immunisation dose scheduled',
        payload: {
          immunisation_id: Number(dose.id),
          vaccine_catalogue_id: Number(dose.vaccine_catalogue_id),
          due_date: dateOnly(dose.due_date),
          linked_to_newborn: dose.newborn_immunisation_id != null,
          status: 'scheduled',
        },
        afterState: { status: 'scheduled', due_date: dateOnly(dose.due_date) },
        timelineIdempotencyKey: `patient_immunisations:${dose.id}:scheduled`,
        auditIdempotencyKey: `patient_immunisations:${dose.id}:audit:scheduled`,
      }, { db: tx, strict: true });
    }
    return result;
  });

  const total = Number(counts?.total || 0);
  const inserted = Number(counts?.inserted || 0);
  const updated = Number(counts?.updated || 0);
  const linked = Number(counts?.linked || 0);

  logger.info(`Paediatric immunisation schedule seeded for patient=${patientUid} inserted=${inserted} updated=${updated} linked=${linked}`);
  return { patient_uid: patientUid, inserted, updated, linked, total };
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
  await assertPatientInTenant(patientUid, tenantId);
  const rows = await prisma.$queryRawUnsafe(
     `WITH newborn_identity AS (
       SELECT tenant_id, newborn_patient_uid, COUNT(*)::int AS newborn_count
         FROM maternity_newborns
        WHERE tenant_id = $2::uuid
          AND newborn_patient_uid IS NOT NULL
        GROUP BY tenant_id, newborn_patient_uid
     ),
     linked_candidates AS (
       SELECT ni.id, ni.tenant_id, ni.newborn_id, ni.vaccine_catalogue_id,
              ni.due_date, ni.status, ni.given_at, ni.given_by,
              ni.given_by_name, ni.batch_number, ni.manufacturer,
              ni.site_of_injection, ni.adverse_event, ni.notes,
              n.newborn_patient_uid, ident.newborn_count,
              COUNT(*) OVER (
                PARTITION BY ni.tenant_id, n.newborn_patient_uid,
                             ni.vaccine_catalogue_id
              )::int AS dose_count
         FROM newborn_immunisations ni
         JOIN maternity_newborns n
           ON n.id = ni.newborn_id
          AND n.tenant_id = ni.tenant_id
         JOIN newborn_identity ident
           ON ident.tenant_id = n.tenant_id
          AND ident.newborn_patient_uid = n.newborn_patient_uid
     )
     SELECT pi.id, pi.patient_uid, pi.vaccine_catalogue_id,
            CASE WHEN linked.id IS NOT NULL THEN linked.due_date ELSE pi.due_date END AS due_date,
            CASE WHEN linked.id IS NOT NULL THEN linked.status ELSE pi.status END AS status,
            CASE WHEN linked.id IS NOT NULL THEN linked.given_at ELSE pi.given_at END AS given_at,
            CASE WHEN linked.id IS NOT NULL THEN linked.given_by ELSE pi.given_by END AS given_by,
            CASE WHEN linked.id IS NOT NULL THEN linked.given_by_name ELSE pi.given_by_name END AS given_by_name,
            CASE WHEN linked.id IS NOT NULL THEN linked.batch_number ELSE pi.batch_number END AS batch_number,
            CASE WHEN linked.id IS NOT NULL THEN linked.manufacturer ELSE pi.manufacturer END AS manufacturer,
            CASE WHEN linked.id IS NOT NULL THEN linked.site_of_injection ELSE pi.site_of_injection END AS site_of_injection,
            CASE WHEN linked.id IS NOT NULL THEN linked.adverse_event ELSE pi.adverse_event END AS adverse_event,
            CASE WHEN linked.id IS NOT NULL THEN linked.notes ELSE pi.notes END AS notes,
            pi.newborn_immunisation_id,
            pi.created_at, pi.updated_at,
            vc.code, vc.display_name, vc.dose_number,
            vc.recommended_age_days, vc.window_days
      FROM patient_immunisations pi
       JOIN vaccine_catalogue vc ON vc.id = pi.vaccine_catalogue_id
        AND vc.tenant_id = pi.tenant_id
       LEFT JOIN linked_candidates linked
         ON linked.id = pi.newborn_immunisation_id
        AND linked.tenant_id = pi.tenant_id
        AND linked.newborn_patient_uid = pi.patient_uid
        AND linked.vaccine_catalogue_id = pi.vaccine_catalogue_id
        AND linked.newborn_count = 1
        AND linked.dose_count = 1
      WHERE pi.patient_uid = $1::uuid
        AND pi.tenant_id = $2::uuid
      ORDER BY due_date ASC, vc.code ASC, vc.dose_number ASC NULLS FIRST`,
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
  await assertPatientInTenant(patientUid, tenantId);
  const checkpoint = asOf ? new Date(asOf) : new Date();
  const checkpointIso = checkpoint.toISOString().slice(0, 10);
  const review = await latestSignedUpToDateReview({ patientUid, tenantId });
  const reviewCutoffIso = review && review.as_of <= checkpointIso ? review.as_of : null;
  return prisma.$queryRawUnsafe(
     `WITH newborn_identity AS (
       SELECT tenant_id, newborn_patient_uid, COUNT(*)::int AS newborn_count
         FROM maternity_newborns
        WHERE tenant_id = $4::uuid
          AND newborn_patient_uid IS NOT NULL
        GROUP BY tenant_id, newborn_patient_uid
     ),
     linked_candidates AS (
       SELECT ni.id, ni.tenant_id, ni.vaccine_catalogue_id,
              ni.due_date, ni.status, n.newborn_patient_uid,
              ident.newborn_count,
              COUNT(*) OVER (
                PARTITION BY ni.tenant_id, n.newborn_patient_uid,
                             ni.vaccine_catalogue_id
              )::int AS dose_count
         FROM newborn_immunisations ni
         JOIN maternity_newborns n
           ON n.id = ni.newborn_id
          AND n.tenant_id = ni.tenant_id
         JOIN newborn_identity ident
           ON ident.tenant_id = n.tenant_id
          AND ident.newborn_patient_uid = n.newborn_patient_uid
     ),
     effective AS (
       SELECT pi.id,
              CASE WHEN linked.id IS NOT NULL THEN linked.due_date ELSE pi.due_date END AS due_date,
              CASE WHEN linked.id IS NOT NULL THEN linked.status ELSE pi.status END AS status,
              vc.code, vc.display_name, vc.dose_number, vc.window_days
         FROM patient_immunisations pi
         JOIN vaccine_catalogue vc
           ON vc.id = pi.vaccine_catalogue_id
          AND vc.tenant_id = pi.tenant_id
         LEFT JOIN linked_candidates linked
           ON linked.id = pi.newborn_immunisation_id
          AND linked.tenant_id = pi.tenant_id
          AND linked.newborn_patient_uid = pi.patient_uid
          AND linked.vaccine_catalogue_id = pi.vaccine_catalogue_id
          AND linked.newborn_count = 1
          AND linked.dose_count = 1
        WHERE pi.patient_uid = $1::uuid
          AND pi.tenant_id = $4::uuid
     )
     SELECT id, due_date, status, code, display_name,
            dose_number, window_days,
            (CASE WHEN due_date <= $2::date THEN 'due_or_overdue'
                  ELSE 'upcoming' END) AS bucket
       FROM effective
      WHERE status = 'scheduled'
        AND ($3::date IS NULL OR due_date > $3::date)
      ORDER BY due_date ASC`,
    patientUid, checkpointIso, reviewCutoffIso, tenantOr(tenantId),
  );
}

/**
 * Record a dose given. Flips scheduled -> given (or to missed/refused/
 * contraindicated). Captures batch + manufacturer + site so the
 * cold-chain audit row is complete.
 *
 * An unlinked patient dose remains authoritative and is updated in place.
 * For a linked dose, reads project the newborn row as authoritative, so the
 * mutation must re-prove the exact tenant/identity/catalogue link and update
 * only that newborn row. The source tables are write-locked before exactness
 * is checked so a concurrent newborn or dose cannot make the link ambiguous
 * between validation and mutation. Stale/ambiguous links and already-final
 * newborn history fail closed without changing either table.
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
  actorRole = null,
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

  const updateArgs = [
    status,
    givenAt ?? (status === 'given' ? new Date().toISOString() : null),
    givenBy ?? null,
    givenByName ?? null,
    batchNumber ?? null,
    manufacturer ?? null,
    siteOfInjection ?? null,
    adverseEvent ?? null,
    notes ?? null,
    tid,
  ];

  return setTenantTx(tid, async (tx) => {
    const initial = await tx.$queryRawUnsafe(
      `SELECT id, newborn_immunisation_id
         FROM patient_immunisations
        WHERE id = $1::int
          AND tenant_id = $2::uuid`,
      id, tid,
    );
    if (!initial.length) throw AppError.notFound(`Immunisation row ${id} not found`);

    if (initial[0].newborn_immunisation_id == null) {
      // Effective-state no-op guard (canonical revision-sequence fix).
      // Mirror the CASE/COALESCE semantics of the UPDATE below against the
      // row-locked current state: an exact retry must return before the
      // UPDATE (tuple keeps xmin/updated_at, no canonical revision), and two
      // concurrent identical mutations collapse because the loser re-reads
      // the winner's committed state under FOR UPDATE. The lock is taken
      // only in the unlinked branch — the linked branch below keeps its
      // table-lock-first ordering.
      const guardRows = await tx.$queryRawUnsafe(
        `SELECT p.id, p.patient_uid, p.status, p.given_at, p.given_by,
                p.given_by_name, p.batch_number, p.manufacturer,
                p.site_of_injection, p.adverse_event, p.notes,
                p.vaccine_catalogue_id, p.updated_at,
                (
                      p.status IS NOT DISTINCT FROM $2::varchar
                  AND p.given_at IS NOT DISTINCT FROM (CASE
                        WHEN $2::varchar = 'given' THEN COALESCE(p.given_at, $3::timestamptz)
                        ELSE COALESCE($3::timestamptz, p.given_at)
                      END)
                  AND p.given_by IS NOT DISTINCT FROM COALESCE($4::uuid, p.given_by)
                  AND p.given_by_name IS NOT DISTINCT FROM COALESCE($5, p.given_by_name)
                  AND p.batch_number IS NOT DISTINCT FROM COALESCE($6, p.batch_number)
                  AND p.manufacturer IS NOT DISTINCT FROM COALESCE($7, p.manufacturer)
                  AND p.site_of_injection IS NOT DISTINCT FROM COALESCE($8, p.site_of_injection)
                  AND p.adverse_event IS NOT DISTINCT FROM COALESCE($9, p.adverse_event)
                  AND p.notes IS NOT DISTINCT FROM COALESCE($10, p.notes)
                ) AS effective_state_unchanged
           FROM patient_immunisations p
          WHERE p.id = $1::int
            AND p.tenant_id = $11::uuid
            AND p.newborn_immunisation_id IS NULL
          FOR UPDATE`,
        id, ...updateArgs,
      );
      if (!guardRows.length) {
        throw AppError.conflict(
          'Immunisation linkage changed while the dose was being recorded',
          'PAEDIATRIC_IMMUNISATION_LINK_CHANGED',
        );
      }
      if (guardRows[0].effective_state_unchanged === true) {
        const { effective_state_unchanged: _unchanged, ...existingDose } = guardRows[0];
        return existingDose;
      }

      const patientResult = await tx.$queryRawUnsafe(
        `UPDATE patient_immunisations
            SET status = $2::varchar,
                given_at = CASE
                  WHEN $2::varchar = 'given' THEN COALESCE(given_at, $3::timestamptz)
                  ELSE COALESCE($3::timestamptz, given_at)
                END,
                given_by = COALESCE($4::uuid, given_by),
                given_by_name = COALESCE($5, given_by_name),
                batch_number = COALESCE($6, batch_number),
                manufacturer = COALESCE($7, manufacturer),
                site_of_injection = COALESCE($8, site_of_injection),
                adverse_event = COALESCE($9, adverse_event),
                notes = COALESCE($10, notes),
                updated_at = NOW()
          WHERE id = $1::int
            AND tenant_id = $11::uuid
            AND newborn_immunisation_id IS NULL
          RETURNING id, patient_uid, status, given_at, given_by,
                    given_by_name, batch_number, manufacturer,
                    site_of_injection, adverse_event, notes,
                    vaccine_catalogue_id, updated_at`,
        id, ...updateArgs,
      );
      if (!patientResult.length) {
        throw AppError.conflict(
          'Immunisation linkage changed while the dose was being recorded',
          'PAEDIATRIC_IMMUNISATION_LINK_CHANGED',
        );
      }
      const dose = patientResult[0];
      const payload = {
        immunisation_id: Number(dose.id),
        vaccine_catalogue_id: Number(dose.vaccine_catalogue_id),
        status: dose.status,
      };
      if (dose.status === 'given') {
        payload.batch_number = dose.batch_number || null;
        payload.manufacturer = dose.manufacturer || null;
        payload.site_of_injection = dose.site_of_injection || null;
      }
      const canonicalFingerprint = canonicalDoseFingerprint(dose);
      // Genuine mutation: bind the revision to this transaction's xid8 so an
      // A -> B -> A return to earlier cold-chain facts still records its own
      // timeline/audit revision instead of colliding with revision 1's key.
      const txRevision = await currentCanonicalTransactionRevision(tx);
      await recordCanonicalClinicalEvent({
        tenantId: tid,
        patientUid: String(dose.patient_uid),
        eventType: 'immunisation.dose_recorded',
        eventStatus: dose.status,
        sourceTable: 'patient_immunisations',
        sourceId: dose.id,
        resourceType: 'immunisation_dose',
        resourceId: dose.id,
        actorUid: givenBy || null,
        actorRole,
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
        timelineIdempotencyKey: `patient_immunisations:${dose.id}:recorded:${canonicalFingerprint}:tx:${txRevision}`,
        auditIdempotencyKey: `patient_immunisations:${dose.id}:audit:recorded:${canonicalFingerprint}:tx:${txRevision}`,
      }, { db: tx, strict: true });
      return dose;
    }

    await tx.$executeRawUnsafe('LOCK TABLE maternity_newborns IN SHARE MODE');
    await tx.$executeRawUnsafe(
      'LOCK TABLE newborn_immunisations IN SHARE ROW EXCLUSIVE MODE',
    );

    const patientRows = await tx.$queryRawUnsafe(
      `SELECT id, patient_uid, vaccine_catalogue_id, newborn_immunisation_id
         FROM patient_immunisations
        WHERE id = $1::int
          AND tenant_id = $2::uuid
        FOR UPDATE`,
      id, tid,
    );
    if (!patientRows.length) throw AppError.notFound(`Immunisation row ${id} not found`);
    const patientDose = patientRows[0];
    if (patientDose.newborn_immunisation_id == null) {
      throw AppError.conflict(
        'Immunisation linkage changed while the dose was being recorded',
        'PAEDIATRIC_IMMUNISATION_LINK_CHANGED',
      );
    }

    const exactRows = await tx.$queryRawUnsafe(
      `SELECT ni.id, ni.status, ni.given_at, ni.given_by,
              ni.given_by_name, ni.batch_number, ni.manufacturer,
              ni.site_of_injection, ni.adverse_event, ni.notes
         FROM newborn_immunisations ni
         JOIN maternity_newborns n
           ON n.id = ni.newborn_id
          AND n.tenant_id = ni.tenant_id
         JOIN vaccine_catalogue vc
           ON vc.id = ni.vaccine_catalogue_id
          AND vc.tenant_id = ni.tenant_id
        WHERE ni.id = $4::int
          AND ni.tenant_id = $1::uuid
          AND ni.vaccine_catalogue_id = $3::int
          AND n.newborn_patient_uid = $2::uuid
          AND (
            SELECT COUNT(*)
              FROM maternity_newborns identity_candidate
             WHERE identity_candidate.tenant_id = $1::uuid
               AND identity_candidate.newborn_patient_uid = $2::uuid
          ) = 1
          AND (
            SELECT COUNT(*)
              FROM newborn_immunisations dose_candidate
              JOIN maternity_newborns candidate_newborn
                ON candidate_newborn.id = dose_candidate.newborn_id
               AND candidate_newborn.tenant_id = dose_candidate.tenant_id
             WHERE dose_candidate.tenant_id = $1::uuid
               AND candidate_newborn.newborn_patient_uid = $2::uuid
               AND dose_candidate.vaccine_catalogue_id = $3::int
          ) = 1
        FOR UPDATE OF ni`,
      tid,
      patientDose.patient_uid,
      Number(patientDose.vaccine_catalogue_id),
      Number(patientDose.newborn_immunisation_id),
    );
    if (!exactRows.length) {
      throw AppError.conflict(
        'Linked newborn immunisation is no longer an exact tenant-scoped match',
        'PAEDIATRIC_IMMUNISATION_LINK_NOT_EXACT',
      );
    }
    if (exactRows[0].status !== 'scheduled') {
      const persistedDose = exactRows[0];
      const canonicalFingerprint = canonicalDoseFingerprint(persistedDose);
      // Newborn-dose revisions written after the canonical revision-sequence
      // fix carry a `:tx:<xid8>` suffix on top of the state-fingerprint base;
      // rows written before it are the bare base. A semantically identical
      // retry must recognise both, so match the exact legacy key OR any
      // xid8-suffixed key sharing this persisted-state base.
      const retryKeys = {
        timeline: `newborn_immunisations:${persistedDose.id}:recorded:${canonicalFingerprint}`,
        audit: `newborn_immunisations:${persistedDose.id}:audit:recorded:${canonicalFingerprint}`,
      };
      const semanticallyIdentical = matchesPersistedDoseRetry(persistedDose, {
        status,
        givenAt,
        givenBy,
        givenByName,
        batchNumber,
        manufacturer,
        siteOfInjection,
        adverseEvent,
        notes,
      });
      const canonicalRows = semanticallyIdentical
        ? await tx.$queryRawUnsafe(
          `SELECT EXISTS (
                    SELECT 1
                      FROM clinical_timeline_events
                     WHERE tenant_id = $1::uuid
                       AND patient_uid = $2::uuid
                       AND source_table = 'newborn_immunisations'
                       AND source_id = $3::text
                       AND (idempotency_key = $4::text
                            OR left(idempotency_key, length($6::text)) = $6::text)
                  ) AS timeline_exists,
                  EXISTS (
                    SELECT 1
                      FROM clinical_audit_events
                     WHERE tenant_id = $1::uuid
                       AND patient_uid = $2::uuid
                       AND resource_table = 'newborn_immunisations'
                       AND resource_id = $3::text
                       AND (idempotency_key = $5::text
                            OR left(idempotency_key, length($7::text)) = $7::text)
                  ) AS audit_exists`,
          tid,
          patientDose.patient_uid,
          String(exactRows[0].id),
          retryKeys.timeline,
          retryKeys.audit,
          `${retryKeys.timeline}:tx:`,
          `${retryKeys.audit}:tx:`,
        )
        : [];
      if (canonicalRows[0]?.timeline_exists && canonicalRows[0]?.audit_exists) {
        return {
          id: patientDose.id,
          patient_uid: patientDose.patient_uid,
          status: persistedDose.status,
          given_at: persistedDose.given_at,
          given_by: persistedDose.given_by,
          vaccine_catalogue_id: patientDose.vaccine_catalogue_id,
        };
      }
      throw AppError.conflict(
        'Linked newborn immunisation history is already final',
        'PAEDIATRIC_IMMUNISATION_HISTORY_FINAL',
      );
    }

    const newbornResult = await tx.$queryRawUnsafe(
      `UPDATE newborn_immunisations
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
        WHERE id = $1::int
          AND tenant_id = $11::uuid
          AND status = 'scheduled'
        RETURNING id, status, given_at, given_by, given_by_name,
                  batch_number, manufacturer, site_of_injection,
                  adverse_event, notes, updated_at`,
      Number(patientDose.newborn_immunisation_id), ...updateArgs,
    );
    if (!newbornResult.length) {
      throw AppError.conflict(
        'Linked newborn immunisation history is already final',
        'PAEDIATRIC_IMMUNISATION_HISTORY_FINAL',
      );
    }
    const dose = newbornResult[0];
    const payload = {
      patient_immunisation_id: Number(patientDose.id),
      newborn_immunisation_id: Number(dose.id),
      vaccine_catalogue_id: Number(patientDose.vaccine_catalogue_id),
      status: dose.status,
    };
    if (dose.status === 'given') {
      payload.batch_number = dose.batch_number || null;
      payload.manufacturer = dose.manufacturer || null;
      payload.site_of_injection = dose.site_of_injection || null;
    }
    const canonicalFingerprint = canonicalDoseFingerprint(dose);
    // Same xid8 stamping as the unlinked branch so the shared
    // newborn_immunisations key namespace stays uniform going forward.
    const txRevision = await currentCanonicalTransactionRevision(tx);
    await recordCanonicalClinicalEvent({
      tenantId: tid,
      patientUid: String(patientDose.patient_uid),
      eventType: 'immunisation.dose_recorded',
      eventStatus: dose.status,
      sourceTable: 'newborn_immunisations',
      sourceId: dose.id,
      resourceType: 'immunisation_dose',
      resourceId: dose.id,
      actorUid: givenBy || null,
      actorRole,
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

    return {
      id: patientDose.id,
      patient_uid: patientDose.patient_uid,
      status: dose.status,
      given_at: dose.given_at,
      given_by: dose.given_by,
      vaccine_catalogue_id: patientDose.vaccine_catalogue_id,
    };
  });
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
