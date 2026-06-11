// src/services/clinical/deathCertificationService.js — Sprint 21
//
// MCCD (Medical Certificate of Cause of Death — Form 4) + mortality
// review (M&M). Status walk for the death record:
//   pending → certified → submitted_to_registrar → registered
// or → cancelled (only from pending). Body release is a separate
// PATCH that can happen any time after pending.

import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';

const TENANT_FALLBACK = '00000000-0000-4000-8000-000000000001';
function tenantOr(t) { return t || TENANT_FALLBACK; }
function unwrap(rows) { return Array.isArray(rows) ? rows[0] : rows; }

const STATUS_TRANSITIONS = {
  pending:                ['certified', 'cancelled'],
  certified:              ['submitted_to_registrar'],
  submitted_to_registrar: ['registered'],
  registered:             [],
  cancelled:              [],
};

const VALID_PLACES = ['inpatient', 'emergency', 'icu', 'or', 'home_brought_dead', 'transferred_out_dead'];
const VALID_MANNERS = ['natural', 'accident', 'suicide', 'homicide', 'pending', 'undetermined'];

async function assertPatientInTenant(tenantId, patientUid) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT uid FROM users
      WHERE tenant_id = $1::uuid
        AND uid = $2::uuid
        AND role = 'PATIENT'
      LIMIT 1`,
    tenantOr(tenantId),
    String(patientUid),
  );
  if (!rows.length) throw AppError.notFound('Patient not found');
}

async function assertAdmissionInTenant(tenantId, admissionId, patientUid) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, patient_uid
       FROM admissions
      WHERE tenant_id = $1::uuid AND id = $2::int`,
    tenantOr(tenantId),
    parseInt(admissionId, 10),
  );
  const admission = unwrap(rows);
  if (!admission) throw AppError.notFound('Admission not found');
  if (String(admission.patient_uid) !== String(patientUid)) {
    throw AppError.forbidden('Admission belongs to a different patient');
  }
  return admission;
}

async function nextSerial(tenantId, year) {
  const sql = `
    INSERT INTO mccd_serial_counter (tenant_id, next_serial)
    VALUES ($1, 2)
    ON CONFLICT (tenant_id)
    DO UPDATE SET next_serial = mccd_serial_counter.next_serial + 1
    RETURNING next_serial - 1 AS issued`;
  const rows = await prisma.$queryRawUnsafe(sql, tenantOr(tenantId));
  const r = unwrap(rows);
  return `MCCD-${year}-${String(r.issued).padStart(6, '0')}`;
}

// Validate MCCD content before letting status leave 'pending'.
// The State registrar rejects forms that are missing 1a or that
// declare medicolegal without police clearance.
function validateForCertification(rec) {
  const errs = [];
  if (!rec.cause_part_1a || !rec.cause_part_1a.trim()) {
    errs.push('Part Ia (immediate cause) required');
  }
  if (!rec.manner_of_death) errs.push('manner_of_death required');
  if (rec.is_medicolegal) {
    if (!rec.police_station) errs.push('police_station required when medicolegal');
    if (!rec.police_fir_no) errs.push('police_fir_no required when medicolegal');
  }
  if (rec.was_pregnancy_related && !rec.pregnancy_stage) {
    errs.push('pregnancy_stage required when was_pregnancy_related');
  }
  return errs;
}

export async function createDeathRecord({ tenantId, ...body }) {
  if (!body.patient_uid) throw AppError.badRequest('patient_uid required');
  if (!body.date_of_death) throw AppError.badRequest('date_of_death required');
  if (!body.time_of_death) throw AppError.badRequest('time_of_death required');
  if (!body.cause_part_1a) throw AppError.badRequest('cause_part_1a required (immediate cause)');
  await assertPatientInTenant(tenantId, body.patient_uid);
  if (body.admission_id) {
    await assertAdmissionInTenant(tenantId, body.admission_id, body.patient_uid);
  }

  const place = body.place_of_death || 'inpatient';
  if (!VALID_PLACES.includes(place)) {
    throw AppError.badRequest(`place_of_death must be one of: ${VALID_PLACES.join(', ')}`);
  }
  const manner = body.manner_of_death || 'natural';
  if (!VALID_MANNERS.includes(manner)) {
    throw AppError.badRequest(`manner_of_death must be one of: ${VALID_MANNERS.join(', ')}`);
  }

  // Auto-flag medicolegal for accident/suicide/homicide/undetermined.
  const autoMedicolegal = ['accident', 'suicide', 'homicide', 'undetermined'].includes(manner);
  const isMedicolegal = body.is_medicolegal != null
    ? Boolean(body.is_medicolegal)
    : autoMedicolegal;

  const sql = `
    INSERT INTO death_records
      (patient_uid, admission_id, date_of_death, time_of_death,
       place_of_death, ward_or_unit,
       cause_part_1a, icd10_part_1a, cause_part_1b, icd10_part_1b,
       cause_part_1c, icd10_part_1c, cause_part_2, icd10_part_2,
       manner_of_death,
       was_pregnancy_related, pregnancy_stage,
       was_postsurgery, surgery_within_30d,
       is_medicolegal, police_station, police_fir_no,
       postmortem_required,
       status, notes, tenant_id)
    VALUES ($1, $2, $3::date, $4::time,
            COALESCE($5, 'inpatient'), $6,
            $7, $8, $9, $10, $11, $12, $13, $14,
            COALESCE($15, 'natural'),
            COALESCE($16, false), $17,
            COALESCE($18, false), COALESCE($19, false),
            $20, $21, $22, COALESCE($23, false),
            'pending', $24, $25)
    RETURNING *`;
  const rows = await prisma.$queryRawUnsafe(sql,
    body.patient_uid, body.admission_id || null,
    body.date_of_death, body.time_of_death,
    place, body.ward_or_unit || null,
    body.cause_part_1a, body.icd10_part_1a || null,
    body.cause_part_1b || null, body.icd10_part_1b || null,
    body.cause_part_1c || null, body.icd10_part_1c || null,
    body.cause_part_2 || null, body.icd10_part_2 || null,
    manner,
    Boolean(body.was_pregnancy_related), body.pregnancy_stage || null,
    Boolean(body.was_postsurgery), Boolean(body.surgery_within_30d),
    isMedicolegal, body.police_station || null, body.police_fir_no || null,
    Boolean(body.postmortem_required),
    body.notes || null, tenantOr(tenantId));
  return unwrap(rows);
}

export async function listDeathRecords({ tenantId, status, from, to, is_medicolegal, limit = 100 }) {
  const conds = ['tenant_id = $1::uuid'];
  const args = [tenantOr(tenantId)];
  if (status) { args.push(status); conds.push(`status = $${args.length}`); }
  if (from) { args.push(from); conds.push(`date_of_death >= $${args.length}::date`); }
  if (to) { args.push(to); conds.push(`date_of_death <= $${args.length}::date`); }
  if (is_medicolegal != null) {
    args.push(is_medicolegal === 'true' || is_medicolegal === true);
    conds.push(`is_medicolegal = $${args.length}`);
  }
  const lim = Math.min(parseInt(limit, 10) || 100, 500);
  const sql = `
    SELECT * FROM death_records
    WHERE ${conds.join(' AND ')}
    ORDER BY date_of_death DESC, time_of_death DESC
    LIMIT ${lim}`;
  return prisma.$queryRawUnsafe(sql, ...args);
}

export async function getDeathRecord({ tenantId, id }) {
  const recRows = await prisma.$queryRawUnsafe(
    `SELECT * FROM death_records WHERE id = $1 AND tenant_id = $2::uuid`,
    parseInt(id, 10), tenantOr(tenantId));
  const rec = unwrap(recRows);
  if (!rec) throw AppError.notFound('Death record not found');

  const reviewRows = await prisma.$queryRawUnsafe(
    `SELECT * FROM mortality_reviews
      WHERE death_record_id = $1 AND tenant_id = $2::uuid
      ORDER BY review_date DESC`,
    rec.id, tenantOr(tenantId));
  return { ...rec, reviews: reviewRows };
}

export async function transition({ tenantId, id, to_status, certified_by, certifier_name, registration_no, ack_no }) {
  const recRows = await prisma.$queryRawUnsafe(
    `SELECT * FROM death_records WHERE id = $1 AND tenant_id = $2::uuid FOR UPDATE`,
    parseInt(id, 10), tenantOr(tenantId));
  const rec = unwrap(recRows);
  if (!rec) throw AppError.notFound('Death record not found');

  const allowed = STATUS_TRANSITIONS[rec.status] || [];
  if (!allowed.includes(to_status)) {
    throw AppError.invalidTransition(rec.status, to_status, allowed);
  }

  if (to_status === 'certified') {
    const errs = validateForCertification(rec);
    if (errs.length > 0) {
      throw AppError.badRequest(`Cannot certify: ${errs.join('; ')}`);
    }
    if (!certified_by || !certifier_name || !registration_no) {
      throw AppError.badRequest('certified_by + certifier_name + registration_no required');
    }
    // Auto-issue MCCD serial when certifying for the first time.
    const year = new Date(rec.date_of_death).getFullYear();
    const serial = rec.mccd_serial || await nextSerial(tenantOr(tenantId), year);

    const sql = `
      UPDATE death_records
      SET status = 'certified',
          mccd_serial = $1,
          certified_by = $2,
          certified_by_name = $3,
          certifier_registration_no = $4,
          certified_at = NOW(),
          updated_at = NOW()
      WHERE id = $5 AND tenant_id = $6::uuid
      RETURNING *`;
    const rows = await prisma.$queryRawUnsafe(sql,
      serial, certified_by, certifier_name, registration_no,
      rec.id, tenantOr(tenantId));
    return unwrap(rows);
  }

  if (to_status === 'registered') {
    if (!ack_no) throw AppError.badRequest('Registrar acknowledgement no. required');
    const sql = `
      UPDATE death_records
      SET status = 'registered',
          registrar_acknowledgement_no = $1,
          registered_at = NOW(),
          updated_at = NOW()
      WHERE id = $2 AND tenant_id = $3::uuid
      RETURNING *`;
    const rows = await prisma.$queryRawUnsafe(sql, ack_no, rec.id, tenantOr(tenantId));
    return unwrap(rows);
  }

  // generic
  const sql = `
    UPDATE death_records
    SET status = $1, updated_at = NOW()
    WHERE id = $2 AND tenant_id = $3::uuid
    RETURNING *`;
  const rows = await prisma.$queryRawUnsafe(sql, to_status, rec.id, tenantOr(tenantId));
  return unwrap(rows);
}

export async function recordBodyRelease({ tenantId, id, ...body }) {
  if (!body.body_released_to_name) throw AppError.badRequest('body_released_to_name required');
  if (!body.body_released_to_relation) throw AppError.badRequest('body_released_to_relation required');

  // Block release if medicolegal AND no police clearance recorded.
  const recRows = await prisma.$queryRawUnsafe(
    `SELECT id, is_medicolegal, police_clearance_at FROM death_records
     WHERE id = $1 AND tenant_id = $2::uuid`,
    parseInt(id, 10), tenantOr(tenantId));
  const rec = unwrap(recRows);
  if (!rec) throw AppError.notFound('Death record not found');
  if (rec.is_medicolegal && !rec.police_clearance_at) {
    throw AppError.badRequest('Cannot release body: medicolegal case requires police clearance first');
  }

  const sql = `
    UPDATE death_records
    SET body_released_at = NOW(),
        body_released_to_name = $1,
        body_released_to_relation = $2,
        body_released_to_id_proof = $3,
        body_release_witnessed_by = $4,
        body_release_method = COALESCE($5, 'family'),
        updated_at = NOW()
    WHERE id = $6 AND tenant_id = $7::uuid
    RETURNING *`;
  const rows = await prisma.$queryRawUnsafe(sql,
    body.body_released_to_name, body.body_released_to_relation,
    body.body_released_to_id_proof || null,
    body.body_release_witnessed_by || null,
    body.body_release_method || null,
    rec.id, tenantOr(tenantId));
  return unwrap(rows);
}

export async function recordPoliceClearance({ tenantId, id, fir_no, station }) {
  const sql = `
    UPDATE death_records
    SET police_clearance_at = NOW(),
        police_fir_no = COALESCE($1, police_fir_no),
        police_station = COALESCE($2, police_station),
        updated_at = NOW()
    WHERE id = $3 AND tenant_id = $4::uuid
    RETURNING *`;
  const rows = await prisma.$queryRawUnsafe(sql,
    fir_no || null, station || null,
    parseInt(id, 10), tenantOr(tenantId));
  const r = unwrap(rows);
  if (!r) throw AppError.notFound('Death record not found');
  return r;
}

// ── MORTALITY REVIEW ────────────────────────────────────────────────

export async function upsertReview({ tenantId, death_record_id, ...body }) {
  if (!death_record_id) throw AppError.badRequest('death_record_id required');

  // Confirm parent belongs to tenant.
  const drRows = await prisma.$queryRawUnsafe(
    `SELECT id FROM death_records WHERE id = $1 AND tenant_id = $2::uuid`,
    parseInt(death_record_id, 10), tenantOr(tenantId));
  if (!unwrap(drRows)) throw AppError.notFound('Parent death record not found');

  // Update existing or insert.
  const existingRows = await prisma.$queryRawUnsafe(
    `SELECT id FROM mortality_reviews
      WHERE death_record_id = $1 AND tenant_id = $2::uuid`,
    parseInt(death_record_id, 10), tenantOr(tenantId));
  const existing = unwrap(existingRows);

  if (existing) {
    const sql = `
      UPDATE mortality_reviews
      SET review_date         = COALESCE($1::date, review_date),
          scheduled_for       = $2,
          preventability      = $3,
          cause_classification = $4,
          factor_disease      = COALESCE($5,  factor_disease),
          factor_communication = COALESCE($6, factor_communication),
          factor_documentation = COALESCE($7, factor_documentation),
          factor_diagnostic_delay = COALESCE($8, factor_diagnostic_delay),
          factor_treatment_delay  = COALESCE($9, factor_treatment_delay),
          factor_medication   = COALESCE($10, factor_medication),
          factor_procedural   = COALESCE($11, factor_procedural),
          factor_supervision  = COALESCE($12, factor_supervision),
          factor_resource     = COALESCE($13, factor_resource),
          factor_handover     = COALESCE($14, factor_handover),
          discussion_summary  = $15,
          learning_points     = $16,
          action_items        = $17,
          presented_by        = $18,
          presented_by_name   = $19,
          status              = COALESCE($20, status),
          updated_at = NOW()
      WHERE id = $21 AND tenant_id = $22::uuid
      RETURNING *`;
    const rows = await prisma.$queryRawUnsafe(sql,
      body.review_date || null, body.scheduled_for || null,
      body.preventability || null, body.cause_classification || null,
      body.factor_disease ?? null, body.factor_communication ?? null,
      body.factor_documentation ?? null, body.factor_diagnostic_delay ?? null,
      body.factor_treatment_delay ?? null, body.factor_medication ?? null,
      body.factor_procedural ?? null, body.factor_supervision ?? null,
      body.factor_resource ?? null, body.factor_handover ?? null,
      body.discussion_summary || null, body.learning_points || null,
      body.action_items || null,
      body.presented_by || null, body.presented_by_name || null,
      body.status || null,
      existing.id, tenantOr(tenantId));
    return unwrap(rows);
  }

  // Insert
  const sql = `
    INSERT INTO mortality_reviews
      (death_record_id, review_date, scheduled_for,
       preventability, cause_classification,
       factor_disease, factor_communication, factor_documentation,
       factor_diagnostic_delay, factor_treatment_delay,
       factor_medication, factor_procedural, factor_supervision,
       factor_resource, factor_handover,
       discussion_summary, learning_points, action_items,
       presented_by, presented_by_name, status, tenant_id)
    VALUES ($1, COALESCE($2::date, CURRENT_DATE), $3,
            $4, $5,
            COALESCE($6,  false), COALESCE($7,  false), COALESCE($8,  false),
            COALESCE($9,  false), COALESCE($10, false),
            COALESCE($11, false), COALESCE($12, false), COALESCE($13, false),
            COALESCE($14, false), COALESCE($15, false),
            $16, $17, $18,
            $19, $20, COALESCE($21, 'draft'), $22)
    RETURNING *`;
  const rows = await prisma.$queryRawUnsafe(sql,
    parseInt(death_record_id, 10), body.review_date || null, body.scheduled_for || null,
    body.preventability || null, body.cause_classification || null,
    body.factor_disease ?? null, body.factor_communication ?? null, body.factor_documentation ?? null,
    body.factor_diagnostic_delay ?? null, body.factor_treatment_delay ?? null,
    body.factor_medication ?? null, body.factor_procedural ?? null, body.factor_supervision ?? null,
    body.factor_resource ?? null, body.factor_handover ?? null,
    body.discussion_summary || null, body.learning_points || null, body.action_items || null,
    body.presented_by || null, body.presented_by_name || null, body.status || null,
    tenantOr(tenantId));
  return unwrap(rows);
}

export async function finaliseReview({ tenantId, id, finalised_by }) {
  const sql = `
    UPDATE mortality_reviews
    SET status = 'finalised',
        finalised_by = $1,
        finalised_at = NOW(),
        updated_at = NOW()
    WHERE id = $2 AND tenant_id = $3::uuid
    RETURNING *`;
  const rows = await prisma.$queryRawUnsafe(sql,
    finalised_by || null, parseInt(id, 10), tenantOr(tenantId));
  const r = unwrap(rows);
  if (!r) throw AppError.notFound('Review not found');
  return r;
}

export async function summary30d({ tenantId }) {
  const sql = `SELECT * FROM mortality_30d_summary WHERE tenant_id = $1::uuid`;
  const rows = await prisma.$queryRawUnsafe(sql, tenantOr(tenantId));
  return unwrap(rows) || {
    total_deaths: 0, registered_count: 0, medicolegal_count: 0,
    maternal_deaths: 0, surgical_30d_deaths: 0,
    reviews_done: 0, reviews_preventable: 0,
  };
}

// Pure helpers for unit tests
export const _internal = {
  STATUS_TRANSITIONS, validateForCertification,
  VALID_PLACES, VALID_MANNERS,
};
