// src/services/clinical/problemListService.js
//
// Roadmap B7 — longitudinal structured problem list.
//
// `diagnoses` rows answer "what was diagnosed in this encounter"; this
// service owns "what conditions does the patient live with right now":
// active/resolved problems with onset, managing doctor (canonical users.id,
// roadmap A9), ICD-10/SNOMED codes (soft-validated through the B8
// terminology service), chronicity, and provenance back to the per-visit
// diagnosis a problem was promoted from.
//
// Canonical timeline invariant (docs/CANONICAL_CLINICAL_TIMELINE.md): every
// successful write lands the detail row + one clinical_timeline_events row +
// one clinical_audit_events row in the same transaction.

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { recordCanonicalClinicalEvent } from './canonicalClinicalPlatformService.js';
import { resolveDoctorRef } from '../doctor/doctorRefService.js';
import { validateCode } from '../terminology/terminologyService.js';
import {
  attachResourceCodings,
  legacyIcd10Coding,
  listResourceCodings,
  mergeClinicalCodings,
  replaceResourceCodings,
} from '../terminology/clinicalCodeBindingService.js';

export const PROBLEM_STATUSES = Object.freeze(['active', 'resolved', 'inactive', 'entered_in_error']);

// active → resolved/inactive/entered_in_error; resolved/inactive may
// reactivate (recurrence) or be corrected; entered_in_error is terminal.
export const PROBLEM_TRANSITIONS = Object.freeze({
  active: ['resolved', 'inactive', 'entered_in_error'],
  inactive: ['active', 'resolved', 'entered_in_error'],
  resolved: ['active', 'entered_in_error'],
  entered_in_error: [],
});

/** Pure transition guard — exported for unit tests. */
export function assertProblemTransition(from, to) {
  const allowed = PROBLEM_TRANSITIONS[from];
  if (!allowed) {
    throw AppError.badRequest(`Unknown problem status '${from}'`, 'PROBLEM_UNKNOWN_STATUS');
  }
  if (!allowed.includes(to)) {
    throw AppError.invalidTransition(from, to, allowed);
  }
}

const PROBLEM_COLUMNS = `
  id, tenant_id, patient_uid, patient_id, title, icd10_code, snomed_code,
  status, severity, is_chronic, onset_date, resolved_date,
  managing_doctor_id, source_encounter_id, source_diagnosis_id,
  notes, resolution_notes, recorded_by, resolved_by, metadata,
  created_at, updated_at`;

async function emitProblemEvent({
  db, problem, eventType, actorUid, actorRole, previousStatus = null, extraPayload = {},
}) {
  const stamp = problem.updated_at?.toISOString?.() || problem.created_at?.toISOString?.() || Date.now();
  await recordCanonicalClinicalEvent({
    tenantId: problem.tenant_id,
    patientUid: problem.patient_uid,
    encounterId: problem.source_encounter_id || null,
    eventType,
    eventStatus: problem.status,
    sourceTable: 'patient_problems',
    sourceId: String(problem.id),
    resourceType: 'problem',
    resourceId: String(problem.id),
    actorUid,
    actorRole,
    summary: `Problem ${problem.status}: ${problem.title}`,
    payload: {
      problem_id: problem.id,
      title: problem.title,
      icd10_code: problem.icd10_code || null,
      snomed_code: problem.snomed_code || null,
      codings: problem.codings || [],
      severity: problem.severity || null,
      is_chronic: problem.is_chronic === true,
      onset_date: problem.onset_date || null,
      resolved_date: problem.resolved_date || null,
      previous_status: previousStatus,
      status: problem.status,
      source_diagnosis_id: problem.source_diagnosis_id || null,
      ...extraPayload,
    },
    beforeState: previousStatus ? { status: previousStatus } : null,
    afterState: { status: problem.status },
    tags: ['problem-list'],
    timelineIdempotencyKey: `patient_problems:${problem.id}:${eventType}:${problem.status}:${stamp}`,
    auditIdempotencyKey: `patient_problems:${problem.id}:audit:${eventType}:${problem.status}:${stamp}`,
  }, { db });
}

/**
 * Soft terminology check (B8): never blocks the write — an unknown code is
 * recorded with a verdict annotation in metadata so curators can clean up,
 * because refusing to chart "Diabetes" over a typo'd code is worse than the
 * typo. Verdicts come back to the caller too.
 */
async function codeVerdicts({ icd10Code, snomedCode }) {
  const verdicts = {};
  if (icd10Code) {
    try {
      const v = await validateCode('ICD10', icd10Code);
      verdicts.icd10 = { valid: v.valid, mode: v.mode, reason: v.reason || null };
    } catch (err) {
      logger.warn('Problem list ICD-10 verdict failed (soft)', { error: err?.message });
    }
  }
  if (snomedCode) {
    try {
      const v = await validateCode('SNOMED_CT', snomedCode);
      verdicts.snomed = { valid: v.valid, mode: v.mode, reason: v.reason || null };
    } catch (err) {
      logger.warn('Problem list SNOMED verdict failed (soft)', { error: err?.message });
    }
  }
  return verdicts;
}

function tenantIdFromContext(context = {}) {
  return context.tenantId || context.tenant_id || null;
}

async function getPatientByUid(patientUid, tenantId = null) {
  const params = [patientUid];
  const filters = ['uid = $1::uuid', "role = 'PATIENT'"];
  if (tenantId) {
    params.push(tenantId);
    filters.push(`tenant_id = $${params.length}::uuid`);
  }
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, uid, tenant_id FROM users WHERE ${filters.join(' AND ')} LIMIT 1`,
    ...params,
  );
  return rows[0] || null;
}

export async function getProblem(problemId, { tenantId = null } = {}) {
  const params = [problemId];
  const filters = ['id = $1::uuid'];
  if (tenantId) {
    params.push(tenantId);
    filters.push(`tenant_id = $${params.length}::uuid`);
  }
  const rows = await prisma.$queryRawUnsafe(
    `SELECT ${PROBLEM_COLUMNS} FROM patient_problems WHERE ${filters.join(' AND ')} LIMIT 1`,
    ...params,
  );
  if (!rows[0]) return null;
  const [withCodings] = await attachResourceCodings(rows, { resourceType: 'patient_problem' });
  return withCodings || null;
}

export async function listProblems(patientUid, { status = null, tenantId = null } = {}) {
  const params = [patientUid];
  let where = 'p.patient_uid = $1::uuid';
  if (tenantId) {
    params.push(tenantId);
    where += ` AND p.tenant_id = $${params.length}::uuid`;
  }
  if (status) {
    if (!PROBLEM_STATUSES.includes(status)) {
      throw AppError.badRequest(
        `status must be one of ${PROBLEM_STATUSES.join(', ')}`,
        'PROBLEM_UNKNOWN_STATUS',
      );
    }
    params.push(status);
    where += ` AND p.status = $${params.length}`;
  }
  const rows = await prisma.$queryRawUnsafe(
    `SELECT p.id, p.title, p.icd10_code, p.snomed_code, p.status, p.severity,
            p.is_chronic, p.onset_date, p.resolved_date, p.notes, p.resolution_notes,
            p.managing_doctor_id, u.name AS managing_doctor_name,
            p.source_encounter_id, p.source_diagnosis_id, p.metadata,
            p.created_at, p.updated_at
       FROM patient_problems p
       LEFT JOIN users u ON u.id = p.managing_doctor_id
      WHERE ${where}
      ORDER BY (p.status = 'active') DESC, p.onset_date DESC NULLS LAST, p.created_at DESC`,
    ...params,
  );
  return attachResourceCodings(rows, { resourceType: 'patient_problem' });
}

/**
 * Active problems in CDS-context shape — consumed by encounter-start cards
 * and (B2) drug-disease checks. Lightweight on purpose.
 */
export async function getActiveProblemSummary(patientUid, { db = prisma, tenantId = null } = {}) {
  const params = [patientUid];
  let tenantFilter = '';
  if (tenantId) {
    params.push(tenantId);
    tenantFilter = ` AND tenant_id = $${params.length}::uuid`;
  }
  return db.$queryRawUnsafe(
    `SELECT id, title, icd10_code, snomed_code, severity, is_chronic, onset_date
       FROM patient_problems
      WHERE patient_uid = $1::uuid${tenantFilter} AND status = 'active'
      ORDER BY is_chronic DESC, onset_date ASC NULLS LAST`,
    ...params,
  );
}

export async function createProblem(input = {}, context = {}) {
  const {
    patientUid, title, icd10Code = null, snomedCode = null, severity = null,
    isChronic = false, onsetDate = null, managingDoctor = null,
    sourceEncounterId = null, sourceDiagnosisId = null, notes = null,
    codings = [],
  } = input;

  // Phase 0 — pre-flight on plain prisma (never 500 on bad input).
  const cleanTitle = (title || '').trim();
  const tenantId = tenantIdFromContext(context);
  if (!patientUid) throw AppError.badRequest('patient_uid is required', 'PROBLEM_PATIENT_REQUIRED');
  if (!cleanTitle) throw AppError.badRequest('title is required', 'PROBLEM_TITLE_REQUIRED');
  if (severity && !['mild', 'moderate', 'severe'].includes(severity)) {
    throw AppError.badRequest('severity must be mild|moderate|severe', 'PROBLEM_BAD_SEVERITY');
  }
  const patient = await getPatientByUid(patientUid, tenantId);
  if (!patient) throw AppError.notFound('Patient not found', 'PROBLEM_PATIENT_NOT_FOUND');

  let managingDoctorId = null;
  if (managingDoctor != null && managingDoctor !== '') {
    const resolved = await resolveDoctorRef(prisma, managingDoctor);
    managingDoctorId = resolved ? Number(resolved.id) : null;
  }

  if (icd10Code) {
    const dup = await prisma.$queryRawUnsafe(
      `SELECT id, title FROM patient_problems
        WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid AND icd10_code = $3 AND status = 'active'
        LIMIT 1`,
      patient.tenant_id,
      patientUid,
      icd10Code,
    );
    if (dup.length > 0) {
      throw AppError.conflict(
        `An active problem with ICD-10 ${icd10Code} already exists for this patient`,
        'PROBLEM_DUPLICATE_ACTIVE',
        { existing_problem_id: dup[0].id, existing_title: dup[0].title },
      );
    }
  }

  const verdicts = await codeVerdicts({ icd10Code, snomedCode });

  // Phase 1 — atomic: detail row + timeline + audit in one transaction.
  const problem = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO patient_problems
         (patient_uid, patient_id, tenant_id, title, icd10_code, snomed_code, severity,
          is_chronic, onset_date, managing_doctor_id, source_encounter_id,
          source_diagnosis_id, notes, recorded_by, metadata)
       VALUES ($1::uuid, $2, COALESCE($3::uuid, '00000000-0000-4000-8000-000000000001'::uuid),
               $4, $5, $6, $7, $8, $9::date, $10, $11::uuid, $12, $13, $14::uuid, $15::jsonb)
       RETURNING ${PROBLEM_COLUMNS}`,
      patientUid,
      patient.id,
      patient.tenant_id || null,
      cleanTitle,
      icd10Code,
      snomedCode,
      severity,
      isChronic === true,
      onsetDate,
      managingDoctorId,
      sourceEncounterId,
      sourceDiagnosisId,
      notes,
      context.actorUid || null,
      JSON.stringify(Object.keys(verdicts).length ? { terminology_verdicts: verdicts } : {}),
    );
    const created = rows[0];
    const savedCodings = await replaceResourceCodings({
      db: tx,
      resourceType: 'patient_problem',
      resourceId: created.id,
      tenantId: created.tenant_id,
      patientUid: created.patient_uid,
      codings: mergeClinicalCodings(
        legacyIcd10Coding({ code: icd10Code, display: cleanTitle }),
        snomedCode ? {
          system: 'SNOMED_CT',
          code: snomedCode,
          display: cleanTitle,
          coding_role: 'diagnosis',
          source: 'manual',
        } : null,
        codings,
      ),
      createdBy: context.actorUid || null,
    });
    created.codings = savedCodings;
    await emitProblemEvent({
      db: tx,
      problem: created,
      eventType: 'problem.recorded',
      actorUid: context.actorUid || null,
      actorRole: context.actorRole || null,
    });
    return created;
  });

  return { problem, terminology_verdicts: verdicts };
}

export async function updateProblem(problemId, patch = {}, context = {}) {
  // Phase 0
  const tenantId = tenantIdFromContext(context);
  const existing = await getProblem(problemId, { tenantId });
  if (!existing) throw AppError.notFound('Problem not found', 'PROBLEM_NOT_FOUND');

  const nextStatus = patch.status || existing.status;
  if (patch.status && patch.status !== existing.status) {
    assertProblemTransition(existing.status, patch.status);
  }
  if (patch.severity && !['mild', 'moderate', 'severe'].includes(patch.severity)) {
    throw AppError.badRequest('severity must be mild|moderate|severe', 'PROBLEM_BAD_SEVERITY');
  }

  let managingDoctorId;
  if (patch.managingDoctor !== undefined) {
    managingDoctorId = null;
    if (patch.managingDoctor != null && patch.managingDoctor !== '') {
      const resolved = await resolveDoctorRef(prisma, patch.managingDoctor);
      managingDoctorId = resolved ? Number(resolved.id) : null;
    }
  }

  // Reactivation must not violate the one-active-coded-problem guard.
  if (patch.status === 'active' && existing.status !== 'active' && existing.icd10_code) {
    const dup = await prisma.$queryRawUnsafe(
      `SELECT id FROM patient_problems
        WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid AND icd10_code = $3 AND status = 'active' AND id <> $4::uuid
        LIMIT 1`,
      existing.tenant_id,
      existing.patient_uid,
      existing.icd10_code,
      problemId,
    );
    if (dup.length > 0) {
      throw AppError.conflict(
        `Another active problem already carries ICD-10 ${existing.icd10_code}`,
        'PROBLEM_DUPLICATE_ACTIVE',
        { existing_problem_id: dup[0].id },
      );
    }
  }

  const resolving = nextStatus === 'resolved' && existing.status !== 'resolved';
  const reactivating = nextStatus === 'active' && existing.status !== 'active';

  // Phase 1 — atomic update + events.
  const updated = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `UPDATE patient_problems SET
         status = $2,
         title = COALESCE($3, title),
         severity = COALESCE($4, severity),
         is_chronic = COALESCE($5::boolean, is_chronic),
         onset_date = COALESCE($6::date, onset_date),
         notes = COALESCE($7, notes),
         snomed_code = COALESCE($8, snomed_code),
         managing_doctor_id = CASE WHEN $9::boolean THEN $10::int ELSE managing_doctor_id END,
         resolved_date = CASE
           WHEN $11::boolean THEN COALESCE($12::date, CURRENT_DATE)
           WHEN $13::boolean THEN NULL
           ELSE resolved_date END,
         resolved_by = CASE WHEN $11::boolean THEN $14::uuid WHEN $13::boolean THEN NULL ELSE resolved_by END,
         resolution_notes = CASE WHEN $11::boolean THEN COALESCE($15, resolution_notes) ELSE resolution_notes END,
         updated_at = NOW()
       WHERE id = $1::uuid AND tenant_id = $16::uuid
       RETURNING ${PROBLEM_COLUMNS}`,
      problemId,
      nextStatus,
      patch.title != null ? String(patch.title).trim() : null,
      patch.severity ?? null,
      typeof patch.isChronic === 'boolean' ? patch.isChronic : null,
      patch.onsetDate ?? null,
      patch.notes ?? null,
      patch.snomedCode ?? null,
      managingDoctorId !== undefined,
      managingDoctorId !== undefined ? managingDoctorId : null,
      resolving,
      patch.resolvedDate ?? null,
      reactivating,
      resolving ? (context.actorUid || null) : null,
      patch.resolutionNotes ?? null,
      existing.tenant_id,
    );
    const row = rows[0];
    row.codings = await listResourceCodings({ db: tx, resourceType: 'patient_problem', resourceId: row.id });
    const eventType = resolving ? 'problem.resolved'
      : nextStatus === 'entered_in_error' ? 'problem.entered_in_error'
        : reactivating ? 'problem.reactivated'
          : 'problem.updated';
    await emitProblemEvent({
      db: tx,
      problem: row,
      eventType,
      actorUid: context.actorUid || null,
      actorRole: context.actorRole || null,
      previousStatus: existing.status,
    });
    return row;
  });

  return updated;
}

/**
 * Promote a per-visit `diagnoses` row onto the longitudinal problem list.
 * Idempotent against duplicates: if an active problem already carries the
 * diagnosis ICD-10 (or was already promoted from this row), it is returned
 * with already_active=true instead of erroring.
 */
export async function promoteDiagnosis(diagnosisId, input = {}, context = {}) {
  const id = Number.parseInt(diagnosisId, 10);
  if (!Number.isInteger(id) || id <= 0) {
    throw AppError.badRequest('diagnosisId must be a positive integer', 'PROBLEM_BAD_DIAGNOSIS_ID');
  }
  const tenantId = tenantIdFromContext(context);
  const params = [id];
  let tenantFilter = '';
  if (tenantId) {
    params.push(tenantId);
    tenantFilter = ` AND tenant_id = $${params.length}::uuid`;
  }
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, tenant_id, patient_uid, encounter_id, icd10_code, icd10_description, description,
            status, onset_date, severity, diagnosed_by
       FROM diagnoses WHERE id = $1${tenantFilter} LIMIT 1`,
    ...params,
  );
  const diagnosis = rows[0];
  if (!diagnosis) throw AppError.notFound('Diagnosis not found', 'PROBLEM_DIAGNOSIS_NOT_FOUND');
  const effectiveTenantId = tenantId || diagnosis.tenant_id || null;

  const existing = await prisma.$queryRawUnsafe(
    `SELECT ${PROBLEM_COLUMNS} FROM patient_problems
      WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid AND status = 'active'
        AND (source_diagnosis_id = $3 OR (icd10_code IS NOT NULL AND icd10_code = $4))
      LIMIT 1`,
    effectiveTenantId,
    diagnosis.patient_uid,
    id,
    diagnosis.icd10_code,
  );
  if (existing.length > 0) {
    return { problem: existing[0], already_active: true, terminology_verdicts: {} };
  }

  const created = await createProblem({
    patientUid: diagnosis.patient_uid,
    title: diagnosis.icd10_description || diagnosis.description,
    icd10Code: diagnosis.icd10_code || null,
    severity: ['mild', 'moderate', 'severe'].includes(diagnosis.severity) ? diagnosis.severity : null,
    isChronic: input.isChronic === true,
    onsetDate: diagnosis.onset_date || null,
    managingDoctor: input.managingDoctor ?? null,
    sourceEncounterId: diagnosis.encounter_id || null,
    sourceDiagnosisId: id,
    notes: input.notes ?? null,
    codings: await listResourceCodings({ resourceType: 'diagnosis', resourceId: id }),
  }, { ...context, tenantId: effectiveTenantId });
  return { ...created, already_active: false };
}

export default {
  PROBLEM_STATUSES,
  PROBLEM_TRANSITIONS,
  assertProblemTransition,
  getProblem,
  listProblems,
  getActiveProblemSummary,
  createProblem,
  updateProblem,
  promoteDiagnosis,
};
