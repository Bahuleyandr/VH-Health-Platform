// src/services/clinical/icuService.js — Sprint 19
//
// ICU admission, hourly flowsheet, RASS/CAM-ICU/SOFA/CPOT assessments,
// and ABCDEF daily bundles. All raw-SQL via prisma.$queryRawUnsafe with
// SPREAD args (per Phase 0.5 convention).

import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import {
  gcsTotal, netBalance, camPositive, bundleComplete, bundlePct,
} from './icuComputations.js';

const TENANT_FALLBACK = '00000000-0000-4000-8000-000000000001';

function tenantOr(t) { return t || TENANT_FALLBACK; }

function unwrap(rows) { return Array.isArray(rows) ? rows[0] : rows; }

// ════════════════════════════════════════════════════════════════════
// ADMISSIONS
// ════════════════════════════════════════════════════════════════════

export async function createAdmission({ tenantId, ...body }) {
  if (!body.patient_uid) throw AppError.badRequest('patient_uid required');
  if (!body.unit_code) throw AppError.badRequest('unit_code required');

  const sql = `
    INSERT INTO icu_admissions
      (patient_uid, admission_id, unit_code, bed_no,
       admitting_doctor_uid, admitting_doctor_name,
       primary_diagnosis, reason_for_icu,
       apache_ii_score, apache_ii_at, sofa_score,
       predicted_mortality_pct, expected_los_days,
       code_status, code_status_set_at, code_status_set_by, tenant_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
            $11, $12, $13, COALESCE($14, 'full_code'), $15, $16, $17)
    RETURNING *`;
  const rows = await prisma.$queryRawUnsafe(sql,
    body.patient_uid, body.admission_id || null,
    body.unit_code, body.bed_no || null,
    body.admitting_doctor_uid || null, body.admitting_doctor_name || null,
    body.primary_diagnosis || null, body.reason_for_icu || null,
    body.apache_ii_score || null,
    body.apache_ii_score ? new Date() : null,
    body.sofa_score || null,
    body.predicted_mortality_pct || null,
    body.expected_los_days || null,
    body.code_status || null,
    body.code_status ? new Date() : null,
    body.code_status_set_by || null,
    tenantOr(tenantId));
  return unwrap(rows);
}

export async function listAdmissions({ tenantId, status, unit_code, limit = 100 }) {
  const conds = ['tenant_id = $1'];
  const args = [tenantOr(tenantId)];
  if (status) { args.push(status); conds.push(`status = $${args.length}`); }
  if (unit_code) { args.push(unit_code); conds.push(`unit_code = $${args.length}`); }
  const lim = Math.min(parseInt(limit, 10) || 100, 500);

  const sql = `
    SELECT * FROM icu_admissions
    WHERE ${conds.join(' AND ')}
    ORDER BY admitted_at DESC
    LIMIT ${lim}`;
  const rows = await prisma.$queryRawUnsafe(sql, ...args);
  return rows;
}

export async function getAdmission({ tenantId, id }) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM icu_admissions WHERE id = $1 AND tenant_id = $2`,
    parseInt(id, 10), tenantOr(tenantId));
  const row = unwrap(rows);
  if (!row) throw AppError.notFound('ICU admission not found');
  return row;
}

export async function updateAdmissionCodeStatus({ tenantId, id, code_status, set_by }) {
  if (!['full_code', 'dni', 'dnr', 'dnr_dni', 'comfort_only'].includes(code_status)) {
    throw AppError.badRequest('invalid code_status');
  }
  const sql = `
    UPDATE icu_admissions
    SET code_status = $1, code_status_set_at = NOW(), code_status_set_by = $2,
        updated_at = NOW()
    WHERE id = $3 AND tenant_id = $4
    RETURNING *`;
  const rows = await prisma.$queryRawUnsafe(sql,
    code_status, set_by || null, parseInt(id, 10), tenantOr(tenantId));
  const row = unwrap(rows);
  if (!row) throw AppError.notFound('ICU admission not found');
  return row;
}

export async function dischargeAdmission({ tenantId, id, disposition, outcome_notes }) {
  const sql = `
    UPDATE icu_admissions
    SET status = CASE WHEN $1 = 'expired' THEN 'expired'
                       WHEN $1 = 'transferred_out' THEN 'transferred'
                       ELSE 'discharged' END,
        discharged_at = NOW(),
        discharge_disposition = $1,
        outcome_notes = $2,
        updated_at = NOW()
    WHERE id = $3 AND tenant_id = $4
    RETURNING *`;
  const rows = await prisma.$queryRawUnsafe(sql,
    disposition, outcome_notes || null, parseInt(id, 10), tenantOr(tenantId));
  const row = unwrap(rows);
  if (!row) throw AppError.notFound('ICU admission not found');
  return row;
}

// ════════════════════════════════════════════════════════════════════
// FLOWSHEET (hourly)
// ════════════════════════════════════════════════════════════════════

export async function logFlowsheet({ tenantId, icu_admission_id, ...body }) {
  if (!icu_admission_id) throw AppError.badRequest('icu_admission_id required');

  const computed = {
    gcs_total: gcsTotal(body.gcs_eye, body.gcs_verbal, body.gcs_motor),
    net_balance_ml: netBalance(body),
  };

  const sql = `
    INSERT INTO icu_flowsheet_entries
      (icu_admission_id, recorded_at,
       hr, sbp, dbp, map, cvp, spo2, rr, temp_c, cap_refill_sec,
       gcs_eye, gcs_verbal, gcs_motor, gcs_total,
       pupils_left_size_mm, pupils_right_size_mm, pupils_reactive,
       vent_mode, fio2_pct, peep_cmh2o, tidal_volume_ml,
       resp_rate_set, airway_pressure_peak, airway_pressure_plateau, pf_ratio,
       noradrenaline_mcg_kg_min, adrenaline_mcg_kg_min, vasopressin_units_hr,
       dobutamine_mcg_kg_min, propofol_mcg_kg_min, midazolam_mg_hr,
       fentanyl_mcg_hr, insulin_units_hr, other_drips,
       iv_fluids_ml, oral_intake_ml, blood_products_ml,
       urine_output_ml, drain_output_ml, ng_aspirate_ml, stool_count,
       net_balance_ml, event_note,
       recorded_by, recorded_by_name, tenant_id)
    VALUES ($1, COALESCE($2::timestamptz, NOW()),
            $3, $4, $5, $6, $7, $8, $9, $10, $11,
            $12, $13, $14, $15,
            $16, $17, $18,
            $19, $20, $21, $22,
            $23, $24, $25, $26,
            $27, $28, $29,
            $30, $31, $32,
            $33, $34, COALESCE($35::jsonb, '[]'::jsonb),
            $36, $37, $38,
            $39, $40, $41, $42,
            $43, $44,
            $45, $46, $47)
    RETURNING *`;
  const rows = await prisma.$queryRawUnsafe(sql,
    parseInt(icu_admission_id, 10), body.recorded_at || null,
    body.hr || null, body.sbp || null, body.dbp || null, body.map || null,
    body.cvp || null, body.spo2 || null, body.rr || null,
    body.temp_c || null, body.cap_refill_sec || null,
    body.gcs_eye || null, body.gcs_verbal || null, body.gcs_motor || null,
    computed.gcs_total,
    body.pupils_left_size_mm || null, body.pupils_right_size_mm || null,
    body.pupils_reactive || null,
    body.vent_mode || null, body.fio2_pct || null, body.peep_cmh2o || null,
    body.tidal_volume_ml || null, body.resp_rate_set || null,
    body.airway_pressure_peak || null, body.airway_pressure_plateau || null,
    body.pf_ratio || null,
    body.noradrenaline_mcg_kg_min || null, body.adrenaline_mcg_kg_min || null,
    body.vasopressin_units_hr || null, body.dobutamine_mcg_kg_min || null,
    body.propofol_mcg_kg_min || null, body.midazolam_mg_hr || null,
    body.fentanyl_mcg_hr || null, body.insulin_units_hr || null,
    body.other_drips ? JSON.stringify(body.other_drips) : null,
    body.iv_fluids_ml || null, body.oral_intake_ml || null,
    body.blood_products_ml || null, body.urine_output_ml || null,
    body.drain_output_ml || null, body.ng_aspirate_ml || null,
    body.stool_count || null,
    computed.net_balance_ml, body.event_note || null,
    body.recorded_by || null, body.recorded_by_name || null, tenantOr(tenantId));
  return unwrap(rows);
}

export async function listFlowsheet({ icu_admission_id, hours = 24 }) {
  const h = Math.min(parseInt(hours, 10) || 24, 168);
  const sql = `
    SELECT * FROM icu_flowsheet_entries
    WHERE icu_admission_id = $1
      AND recorded_at > NOW() - $2::interval
    ORDER BY recorded_at ASC`;
  return prisma.$queryRawUnsafe(sql,
    parseInt(icu_admission_id, 10), `${h} hours`);
}

export async function ioSummary({ icu_admission_id }) {
  const sql = `
    SELECT * FROM icu_24h_io_summary
    WHERE icu_admission_id = $1
    ORDER BY day DESC LIMIT 7`;
  return prisma.$queryRawUnsafe(sql, parseInt(icu_admission_id, 10));
}

// ════════════════════════════════════════════════════════════════════
// ASSESSMENTS — RASS / CAM-ICU / SOFA / CPOT
// ════════════════════════════════════════════════════════════════════

export async function recordAssessment({ tenantId, icu_admission_id, assessment_kind, ...body }) {
  if (!icu_admission_id) throw AppError.badRequest('icu_admission_id required');
  if (!['rass', 'cam_icu', 'sofa', 'cpot'].includes(assessment_kind)) {
    throw AppError.badRequest('invalid assessment_kind');
  }

  // RASS validation
  if (assessment_kind === 'rass') {
    if (body.rass_score == null) throw AppError.badRequest('rass_score required');
    if (body.rass_score < -5 || body.rass_score > 4) {
      throw AppError.badRequest('rass_score must be in [-5, 4]');
    }
  }

  // CAM-ICU computed
  let camPos = null;
  if (assessment_kind === 'cam_icu') {
    if (body.cam_feature_1 == null || body.cam_feature_2 == null) {
      throw AppError.badRequest('cam_feature_1 and cam_feature_2 required');
    }
    camPos = camPositive(body.cam_feature_1, body.cam_feature_2,
      body.cam_feature_3, body.cam_feature_4);
  }

  // SOFA total
  let sofaTotal = null;
  if (assessment_kind === 'sofa') {
    sofaTotal = (body.sofa_resp || 0) + (body.sofa_coag || 0) +
      (body.sofa_liver || 0) + (body.sofa_cardio || 0) +
      (body.sofa_cns || 0) + (body.sofa_renal || 0);
  }

  // CPOT total
  let cpotTotal = null;
  if (assessment_kind === 'cpot') {
    cpotTotal = (body.cpot_facial || 0) + (body.cpot_movement || 0) +
      (body.cpot_muscle_tension || 0) + (body.cpot_vent_compliance || 0);
  }

  const sql = `
    INSERT INTO icu_assessments
      (icu_admission_id, recorded_at, assessment_kind,
       rass_score, rass_target,
       cam_feature_1, cam_feature_2, cam_feature_3, cam_feature_4, cam_positive,
       sofa_resp, sofa_coag, sofa_liver, sofa_cardio, sofa_cns, sofa_renal, sofa_total,
       cpot_facial, cpot_movement, cpot_muscle_tension, cpot_vent_compliance, cpot_total,
       notes, recorded_by, tenant_id)
    VALUES ($1, COALESCE($2::timestamptz, NOW()), $3,
            $4, $5,
            $6, $7, $8, $9, $10,
            $11, $12, $13, $14, $15, $16, $17,
            $18, $19, $20, $21, $22,
            $23, $24, $25)
    RETURNING *`;
  const rows = await prisma.$queryRawUnsafe(sql,
    parseInt(icu_admission_id, 10), body.recorded_at || null, assessment_kind,
    body.rass_score ?? null, body.rass_target ?? null,
    body.cam_feature_1 ?? null, body.cam_feature_2 ?? null,
    body.cam_feature_3 ?? null, body.cam_feature_4 ?? null, camPos,
    body.sofa_resp ?? null, body.sofa_coag ?? null, body.sofa_liver ?? null,
    body.sofa_cardio ?? null, body.sofa_cns ?? null, body.sofa_renal ?? null,
    sofaTotal,
    body.cpot_facial ?? null, body.cpot_movement ?? null,
    body.cpot_muscle_tension ?? null, body.cpot_vent_compliance ?? null,
    cpotTotal,
    body.notes || null, body.recorded_by || null, tenantOr(tenantId));
  return unwrap(rows);
}

export async function listAssessments({ icu_admission_id, kind, limit = 50 }) {
  const lim = Math.min(parseInt(limit, 10) || 50, 200);
  const args = [parseInt(icu_admission_id, 10)];
  let where = 'icu_admission_id = $1';
  if (kind) { args.push(kind); where += ' AND assessment_kind = $2'; }
  const sql = `
    SELECT * FROM icu_assessments
    WHERE ${where}
    ORDER BY recorded_at DESC
    LIMIT ${lim}`;
  return prisma.$queryRawUnsafe(sql, ...args);
}

// ════════════════════════════════════════════════════════════════════
// ABCDEF DAILY BUNDLE
// ════════════════════════════════════════════════════════════════════

export async function upsertBundle({ tenantId, icu_admission_id, bundle_date, ...body }) {
  if (!icu_admission_id) throw AppError.badRequest('icu_admission_id required');
  const day = bundle_date || new Date().toISOString().slice(0, 10);

  const merged = {
    a_awakening_done: Boolean(body.a_awakening_done),
    a_awakening_reason_skipped: body.a_awakening_reason_skipped || null,
    b_breathing_done: Boolean(body.b_breathing_done),
    b_breathing_reason_skipped: body.b_breathing_reason_skipped || null,
    b_breathing_outcome: body.b_breathing_outcome || null,
    c_choice_done: Boolean(body.c_choice_done),
    c_protocol_followed: body.c_protocol_followed ?? null,
    d_delirium_assessed: Boolean(body.d_delirium_assessed),
    d_delirium_positive: body.d_delirium_positive ?? null,
    d_delirium_managed: body.d_delirium_managed ?? null,
    e_mobility_done: Boolean(body.e_mobility_done),
    e_mobility_level: body.e_mobility_level || null,
    e_mobility_reason_skipped: body.e_mobility_reason_skipped || null,
    f_family_done: Boolean(body.f_family_done),
    f_family_method: body.f_family_method || null,
  };

  const complete = bundleComplete(merged);
  const pct = bundlePct(merged);

  const sql = `
    INSERT INTO icu_daily_bundles
      (icu_admission_id, bundle_date,
       a_awakening_done, a_awakening_reason_skipped,
       b_breathing_done, b_breathing_reason_skipped, b_breathing_outcome,
       c_choice_done, c_protocol_followed,
       d_delirium_assessed, d_delirium_positive, d_delirium_managed,
       e_mobility_done, e_mobility_level, e_mobility_reason_skipped,
       f_family_done, f_family_method,
       bundle_complete, bundle_pct,
       recorded_by, notes, tenant_id)
    VALUES ($1, $2::date,
            $3, $4, $5, $6, $7, $8, $9,
            $10, $11, $12, $13, $14, $15, $16, $17,
            $18, $19, $20, $21, $22)
    ON CONFLICT (icu_admission_id, bundle_date)
    DO UPDATE SET
      a_awakening_done            = EXCLUDED.a_awakening_done,
      a_awakening_reason_skipped  = EXCLUDED.a_awakening_reason_skipped,
      b_breathing_done            = EXCLUDED.b_breathing_done,
      b_breathing_reason_skipped  = EXCLUDED.b_breathing_reason_skipped,
      b_breathing_outcome         = EXCLUDED.b_breathing_outcome,
      c_choice_done               = EXCLUDED.c_choice_done,
      c_protocol_followed         = EXCLUDED.c_protocol_followed,
      d_delirium_assessed         = EXCLUDED.d_delirium_assessed,
      d_delirium_positive         = EXCLUDED.d_delirium_positive,
      d_delirium_managed          = EXCLUDED.d_delirium_managed,
      e_mobility_done             = EXCLUDED.e_mobility_done,
      e_mobility_level            = EXCLUDED.e_mobility_level,
      e_mobility_reason_skipped   = EXCLUDED.e_mobility_reason_skipped,
      f_family_done               = EXCLUDED.f_family_done,
      f_family_method             = EXCLUDED.f_family_method,
      bundle_complete             = EXCLUDED.bundle_complete,
      bundle_pct                  = EXCLUDED.bundle_pct,
      recorded_by                 = EXCLUDED.recorded_by,
      notes                       = EXCLUDED.notes,
      updated_at                  = NOW()
    RETURNING *`;
  const rows = await prisma.$queryRawUnsafe(sql,
    parseInt(icu_admission_id, 10), day,
    merged.a_awakening_done, merged.a_awakening_reason_skipped,
    merged.b_breathing_done, merged.b_breathing_reason_skipped, merged.b_breathing_outcome,
    merged.c_choice_done, merged.c_protocol_followed,
    merged.d_delirium_assessed, merged.d_delirium_positive, merged.d_delirium_managed,
    merged.e_mobility_done, merged.e_mobility_level, merged.e_mobility_reason_skipped,
    merged.f_family_done, merged.f_family_method,
    complete, pct,
    body.recorded_by || null, body.notes || null, tenantOr(tenantId));
  return unwrap(rows);
}

export async function getBundle({ icu_admission_id, bundle_date }) {
  const sql = `
    SELECT * FROM icu_daily_bundles
    WHERE icu_admission_id = $1 AND bundle_date = $2::date`;
  const rows = await prisma.$queryRawUnsafe(sql,
    parseInt(icu_admission_id, 10),
    bundle_date || new Date().toISOString().slice(0, 10));
  return unwrap(rows) || null;
}

export async function bundle30dCompliance({ tenantId }) {
  const sql = `
    SELECT * FROM icu_bundle_30d
    WHERE tenant_id = $1
    ORDER BY bundle_date DESC`;
  return prisma.$queryRawUnsafe(sql, tenantOr(tenantId));
}

// Re-export pure-compute helpers (lives in icuComputations.js so unit
// tests can import them without pulling prisma).
export {
  gcsTotal, netBalance, camPositive, bundleComplete, bundlePct,
} from './icuComputations.js';
