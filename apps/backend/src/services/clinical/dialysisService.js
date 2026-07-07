// src/services/clinical/dialysisService.js — Sprint 22 + roadmap D7 depth
//
// Dialysis unit: patient roster, vascular access, session lifecycle
// (scheduled → in_progress → completed | cancelled | no_show),
// intra-dialysis observations, serology surveillance.
//
// D7 depth (2026-06-10): standing dialysis prescriptions (one active per
// patient; sessions inherit params), machine-data provenance on intra-obs
// (source staff|device), structured intra-dialytic complication events
// with canonical timeline emission.

import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { recordCanonicalClinicalEvent } from './canonicalClinicalPlatformService.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { addInvoiceItem, createDraftInvoice } from '../billing/billingV2Service.js';

function tenantOr(t) { return requireTenantId(t); }
function unwrap(rows) { return Array.isArray(rows) ? rows[0] : rows; }

const REUSE_INTEGRITY_RESULTS = ['pending', 'pass', 'fail', 'not_done'];
const REUSE_STATUSES = ['in_use', 'discarded', 'quarantined'];
const MACHINE_QA_STATUSES = ['pending', 'passed', 'failed', 'maintenance_required'];

function intOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : NaN;
}

export function validateReuseRegisterInput(body = {}) {
  const reuseCycleCount = intOrNull(body.reuse_cycle_count ?? body.cycle_count);
  if (!Number.isInteger(reuseCycleCount) || reuseCycleCount < 0 || reuseCycleCount > 100) {
    throw AppError.badRequest('reuse_cycle_count must be an integer from 0 to 100', 'DIALYZER_REUSE_CYCLE_INVALID');
  }
  const integrity = body.integrity_test_result || 'pending';
  if (!REUSE_INTEGRITY_RESULTS.includes(integrity)) {
    throw AppError.badRequest(
      `integrity_test_result must be one of: ${REUSE_INTEGRITY_RESULTS.join(', ')}`,
      'DIALYZER_REUSE_INTEGRITY_INVALID',
    );
  }
  const status = body.status || (integrity === 'fail' ? 'quarantined' : 'in_use');
  if (!REUSE_STATUSES.includes(status)) {
    throw AppError.badRequest(
      `status must be one of: ${REUSE_STATUSES.join(', ')}`,
      'DIALYZER_REUSE_STATUS_INVALID',
    );
  }
  const discardReason = body.discard_reason ? String(body.discard_reason).trim() : null;
  if (status === 'discarded' && !discardReason) {
    throw AppError.badRequest('discard_reason is required when status is discarded', 'DIALYZER_REUSE_DISCARD_REASON_REQUIRED');
  }
  if (integrity === 'fail' && status === 'in_use') {
    throw AppError.badRequest('failed integrity tests must be discarded or quarantined', 'DIALYZER_REUSE_FAILED_IN_USE');
  }
  return { reuseCycleCount, integrity, status, discardReason };
}

export function buildMachineQaWarnings(log, machineNo) {
  if (!machineNo) return ['Machine number missing; QA log cannot be matched'];
  if (!log) return [`No same-day machine QA log for ${machineNo}`];
  const warnings = [];
  if (log.warn_only !== true) warnings.push('Machine QA log is not marked warn-only');
  if (log.disinfection_completed !== true) warnings.push(`Machine ${machineNo} disinfection is not marked complete`);
  if (log.machine_ready !== true) warnings.push(`Machine ${machineNo} is not marked ready`);
  if (['failed', 'maintenance_required'].includes(String(log.status))) {
    warnings.push(`Machine ${machineNo} QA status is ${log.status}`);
  }
  return warnings;
}

// Session status walk
const SESSION_TRANSITIONS = {
  scheduled:  ['in_progress', 'cancelled', 'no_show'],
  in_progress:['completed',   'cancelled'],
  completed:  [],
  cancelled:  [],
  no_show:    [],
};

const VALID_MODALITIES = ['hd', 'hdf', 'pd_capd', 'pd_apd', 'crrt', 'sled'];
const VALID_ACCESS_TYPES = [
  'avf_radiocephalic', 'avf_brachiocephalic', 'avf_brachiobasilic',
  'avg_forearm', 'avg_upper_arm', 'avg_thigh',
  'cvc_temporary_ij', 'cvc_temporary_femoral',
  'cvc_tunneled_ij', 'cvc_tunneled_subclavian',
  'pd_catheter',
];

// URR (urea reduction ratio) computed at session save when both
// pre/post urea are present.
function computeUrr({ urea_pre_mg_dl, urea_post_mg_dl }) {
  if (!urea_pre_mg_dl || urea_pre_mg_dl <= 0) return null;
  if (urea_post_mg_dl == null) return null;
  const r = (1 - (urea_post_mg_dl / urea_pre_mg_dl)) * 100;
  return Math.round(r);
}

// Daugirdas single-pool Kt/V (most-cited formula in HD). Required:
// urea pre/post + duration + UF volume + post-weight. If any missing,
// return null and let the caller record what they have.
function computeKtv({ urea_pre_mg_dl, urea_post_mg_dl, duration_min,
  actual_uf_l, post_weight_kg }) {
  if (!urea_pre_mg_dl || !urea_post_mg_dl) return null;
  if (!duration_min || !post_weight_kg) return null;
  const t = duration_min / 60;                          // hours
  const uf = actual_uf_l || 0;
  const ratio = urea_post_mg_dl / urea_pre_mg_dl;
  const ktv = -Math.log(ratio - 0.008 * t) +
              (4 - 3.5 * ratio) * (uf / post_weight_kg);
  return Math.round(ktv * 100) / 100;                   // 2 decimals
}

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

async function getDialysisPatientInTenant(tenantId, dialysisPatientId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, patient_uid
       FROM dialysis_patients
      WHERE id = $1 AND tenant_id = $2::uuid`,
    parseInt(dialysisPatientId, 10),
    tenantOr(tenantId),
  );
  const patient = unwrap(rows);
  if (!patient) throw AppError.notFound('Dialysis patient not found');
  return patient;
}

async function getDialysisSessionInTenant(tenantId, sessionId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT s.id, s.status, s.dialysis_patient_id, p.patient_uid
       FROM dialysis_sessions s
       JOIN dialysis_patients p
         ON p.id = s.dialysis_patient_id
        AND p.tenant_id = s.tenant_id
      WHERE s.id = $1 AND s.tenant_id = $2::uuid`,
    parseInt(sessionId, 10),
    tenantOr(tenantId),
  );
  const session = unwrap(rows);
  if (!session) throw AppError.notFound('Session not found');
  return session;
}

async function getSameDayMachineQaLog(tenantId, machineNo, db = prisma) {
  if (!machineNo) return null;
  const rows = await db.$queryRawUnsafe(
    `SELECT id, machine_no, session_id, qa_date, disinfection_completed,
            machine_ready, status, warn_only, issues, recorded_at
       FROM dialysis_machine_qa_logs
      WHERE tenant_id = $1::uuid
        AND machine_no = $2
        AND qa_date = CURRENT_DATE
      ORDER BY recorded_at DESC, id DESC
      LIMIT 1`,
    tenantOr(tenantId), String(machineNo),
  ).catch((err) => {
    logger.warn('dialysis machine QA lookup failed', { tenantId, machineNo, error: err.message });
    return [];
  });
  return unwrap(rows) || null;
}

async function getSessionBillingConfig(tenantId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT tenant_id, charge_enabled, service_code, unit_price, gst_rate,
            finance_reviewed_at, finance_reviewed_by
       FROM dialysis_billing_settings
      WHERE tenant_id = $1::uuid
      LIMIT 1`,
    tenantOr(tenantId),
  ).catch((err) => {
    logger.warn('dialysis billing settings lookup failed', { tenantId, error: err.message });
    return [];
  });
  return unwrap(rows) || null;
}

async function getPatientBillingSnapshot(tenantId, patientUid) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT uid, name, phone
       FROM users
      WHERE tenant_id = $1::uuid AND uid = $2::uuid
      LIMIT 1`,
    tenantOr(tenantId), String(patientUid),
  );
  return unwrap(rows) || { uid: patientUid, name: null, phone: null };
}

async function getAccessInTenant(tenantId, accessId, dialysisPatientId = null) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT va.id, va.dialysis_patient_id
       FROM vascular_access va
       JOIN dialysis_patients p
         ON p.id = va.dialysis_patient_id
      WHERE va.id = $1
        AND p.tenant_id = $2::uuid`,
    parseInt(accessId, 10),
    tenantOr(tenantId),
  );
  const access = unwrap(rows);
  if (!access) throw AppError.notFound('Access not found');
  if (dialysisPatientId && Number(access.dialysis_patient_id) !== Number(dialysisPatientId)) {
    throw AppError.forbidden('Access belongs to a different dialysis patient');
  }
  return access;
}

// ── Patients ──────────────────────────────────────────────────────

export async function enrolPatient({ tenantId, ...body }) {
  if (!body.patient_uid) throw AppError.badRequest('patient_uid required');
  await assertPatientInTenant(tenantId, body.patient_uid);
  if (body.modality && !VALID_MODALITIES.includes(body.modality)) {
    throw AppError.badRequest(`modality must be one of: ${VALID_MODALITIES.join(', ')}`);
  }

  const sql = `
    INSERT INTO dialysis_patients
      (patient_uid, modality, schedule_pattern, prescribed_minutes,
       prescribed_dialyser, dry_weight_kg, dry_weight_set_at,
       anticoag_default, hbsag_status, hcv_status, hiv_status,
       notes, tenant_id)
    VALUES ($1, COALESCE($2, 'hd'), $3, $4, $5, $6::numeric,
            CASE WHEN $6::numeric IS NOT NULL THEN NOW() ELSE NULL END,
            COALESCE($7, 'heparin'),
            COALESCE($8,  'negative'), COALESCE($9,  'negative'),
            COALESCE($10, 'negative'),
            $11, $12)
    RETURNING *`;
  const rows = await prisma.$queryRawUnsafe(sql,
    body.patient_uid, body.modality || null,
    body.schedule_pattern || null, body.prescribed_minutes || null,
    body.prescribed_dialyser || null, body.dry_weight_kg || null,
    body.anticoag_default || null,
    body.hbsag_status || null, body.hcv_status || null, body.hiv_status || null,
    body.notes || null, tenantOr(tenantId));
  return unwrap(rows);
}

export async function listPatients({ tenantId, status, limit = 200 }) {
  const conds = ['tenant_id = $1::uuid'];
  const args = [tenantOr(tenantId)];
  if (status) { args.push(status); conds.push(`status = $${args.length}`); }
  const lim = Math.min(parseInt(limit, 10) || 200, 1000);
  const sql = `
    SELECT * FROM dialysis_patients
    WHERE ${conds.join(' AND ')}
    ORDER BY enrolled_at DESC
    LIMIT ${lim}`;
  return prisma.$queryRawUnsafe(sql, ...args);
}

export async function getPatient({ tenantId, id }) {
  const patRows = await prisma.$queryRawUnsafe(
    `SELECT * FROM dialysis_patients WHERE id = $1 AND tenant_id = $2::uuid`,
    parseInt(id, 10), tenantOr(tenantId));
  const pat = unwrap(patRows);
  if (!pat) throw AppError.notFound('Dialysis patient not found');

  const accessRows = await prisma.$queryRawUnsafe(
    `SELECT * FROM vascular_access WHERE dialysis_patient_id = $1 ORDER BY active DESC, created_date DESC`,
    pat.id);
  const recentSessions = await prisma.$queryRawUnsafe(
    `SELECT * FROM dialysis_sessions
      WHERE tenant_id = $1::uuid AND dialysis_patient_id = $2
      ORDER BY session_date DESC LIMIT 10`,
    tenantOr(tenantId), pat.id);
  const serology = await prisma.$queryRawUnsafe(
    `SELECT * FROM dialysis_serology WHERE dialysis_patient_id = $1 ORDER BY test_date DESC LIMIT 10`,
    pat.id);
  const adequacyRows = await prisma.$queryRawUnsafe(
    `SELECT * FROM dialysis_adequacy_30d WHERE dialysis_patient_id = $1`,
    pat.id);

  return { ...pat, access: accessRows, recent_sessions: recentSessions, serology, adequacy_30d: unwrap(adequacyRows) };
}

export async function updateDryWeight({ tenantId, id, dry_weight_kg }) {
  if (!dry_weight_kg || dry_weight_kg <= 0) {
    throw AppError.badRequest('dry_weight_kg must be > 0');
  }
  const sql = `
    UPDATE dialysis_patients
    SET dry_weight_kg = $1, dry_weight_set_at = NOW(), updated_at = NOW()
    WHERE id = $2 AND tenant_id = $3::uuid
    RETURNING *`;
  const rows = await prisma.$queryRawUnsafe(sql,
    Number(dry_weight_kg), parseInt(id, 10), tenantOr(tenantId));
  const r = unwrap(rows);
  if (!r) throw AppError.notFound('Dialysis patient not found');
  return r;
}

// ── Vascular access ───────────────────────────────────────────────

export async function addAccess({ tenantId, dialysis_patient_id, ...body }) {
  if (!body.access_type) throw AppError.badRequest('access_type required');
  if (!VALID_ACCESS_TYPES.includes(body.access_type)) {
    throw AppError.badRequest(`access_type invalid; must be one of: ${VALID_ACCESS_TYPES.join(', ')}`);
  }
  if (!body.created_date) throw AppError.badRequest('created_date required');
  const patient = await getDialysisPatientInTenant(tenantId, dialysis_patient_id);

  // Deactivate previous active access (only one active at a time).
  await prisma.$queryRawUnsafe(
    `UPDATE vascular_access SET active = false, abandoned_date = COALESCE(abandoned_date, CURRENT_DATE)
     WHERE dialysis_patient_id = $1 AND active = true`,
    patient.id);

  const sql = `
    INSERT INTO vascular_access
      (dialysis_patient_id, access_type, side, created_date, first_used_date,
       active, last_qa_check_date, qa_flow_ml_min, last_doppler_date, notes)
    VALUES ($1, $2, $3, $4::date, $5::date, true, $6::date, $7, $8::date, $9)
    RETURNING *`;
  const rows = await prisma.$queryRawUnsafe(sql,
    patient.id, body.access_type,
    body.side || null, body.created_date, body.first_used_date || null,
    body.last_qa_check_date || null, body.qa_flow_ml_min || null,
    body.last_doppler_date || null, body.notes || null);
  return unwrap(rows);
}

export async function abandonAccess({ tenantId, id, reason }) {
  const access = await getAccessInTenant(tenantId, id);
  const sql = `
    UPDATE vascular_access
    SET active = false,
        abandoned_date = CURRENT_DATE,
        abandoned_reason = $1
    WHERE id = $2
    RETURNING *`;
  const rows = await prisma.$queryRawUnsafe(sql, reason || null, access.id);
  const r = unwrap(rows);
  if (!r) throw AppError.notFound('Access not found');
  return r;
}

// ── Prescriptions (D7) ────────────────────────────────────────────

export async function prescribe({ tenantId, dialysis_patient_id, prescribed_by, ...body }) {
  if (!dialysis_patient_id) throw AppError.badRequest('dialysis_patient_id required');
  if (body.modality && !VALID_MODALITIES.includes(body.modality)) {
    throw AppError.badRequest(`modality must be one of: ${VALID_MODALITIES.join(', ')}`);
  }
  const patRows = await prisma.$queryRawUnsafe(
    `SELECT id, patient_uid FROM dialysis_patients WHERE id = $1 AND tenant_id = $2::uuid`,
    parseInt(dialysis_patient_id, 10), tenantOr(tenantId));
  const pat = unwrap(patRows);
  if (!pat) throw AppError.notFound('Dialysis patient not found');

  return setTenantTx(tenantOr(tenantId), async (tx) => {
    await tx.$queryRawUnsafe(
      `UPDATE dialysis_prescriptions
       SET status = 'superseded', superseded_at = NOW(), updated_at = NOW()
       WHERE tenant_id = $1::uuid AND dialysis_patient_id = $2 AND status = 'active'`,
      tenantOr(tenantId), pat.id);

    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO dialysis_prescriptions
         (dialysis_patient_id, modality, sessions_per_week, duration_minutes, dialyser,
          dialysate_k_mmol, dialysate_ca_mmol, dialysate_na_mmol, dialysate_hco3_mmol,
          blood_flow_ml_min, dialysate_flow_ml_min, target_dry_weight_kg,
          max_uf_ml_per_session, anticoag, anticoag_loading, anticoag_maintenance,
          prescribed_by, valid_from, notes, tenant_id)
       VALUES ($1, COALESCE($2, 'hd'), COALESCE($3, 3), COALESCE($4, 240), $5,
               $6, $7, $8, $9, $10, $11, $12, $13,
               COALESCE($14, 'heparin'), $15, $16, $17::uuid,
               COALESCE($18::date, CURRENT_DATE), $19, $20)
       RETURNING *`,
      pat.id, body.modality || null,
      body.sessions_per_week || null, body.duration_minutes || null, body.dialyser || null,
      body.dialysate_k_mmol ?? null, body.dialysate_ca_mmol ?? null,
      body.dialysate_na_mmol ?? null, body.dialysate_hco3_mmol ?? null,
      body.blood_flow_ml_min || null, body.dialysate_flow_ml_min || null,
      body.target_dry_weight_kg || null, body.max_uf_ml_per_session || null,
      body.anticoag || null, body.anticoag_loading || null, body.anticoag_maintenance || null,
      prescribed_by || null, body.valid_from || null, body.notes || null,
      tenantOr(tenantId));
    const prescription = unwrap(rows);

    // Keep the roster snapshot in sync (board + legacy surfaces read it).
    await tx.$queryRawUnsafe(
      `UPDATE dialysis_patients
       SET modality = $2, prescribed_minutes = $3, prescribed_dialyser = COALESCE($4, prescribed_dialyser),
           anticoag_default = $5,
           dry_weight_kg = COALESCE($6::numeric, dry_weight_kg),
           dry_weight_set_at = CASE WHEN $6::numeric IS NOT NULL THEN NOW() ELSE dry_weight_set_at END,
           updated_at = NOW()
       WHERE id = $1 AND tenant_id = $7::uuid`,
      pat.id, prescription.modality, prescription.duration_minutes,
      prescription.dialyser, prescription.anticoag,
      body.target_dry_weight_kg || null, tenantOr(tenantId));

    await recordCanonicalClinicalEvent({
      tenantId: tenantOr(tenantId),
      patientUid: pat.patient_uid,
      eventType: 'dialysis.prescribed',
      sourceTable: 'dialysis_prescriptions',
      sourceId: prescription.id,
      actorUid: prescribed_by || null,
      summary: `Dialysis prescription: ${prescription.modality.toUpperCase()} ${prescription.sessions_per_week}×/week, ${prescription.duration_minutes} min`,
      payload: {
        modality: prescription.modality,
        sessions_per_week: prescription.sessions_per_week,
        duration_minutes: prescription.duration_minutes,
        anticoag: prescription.anticoag,
      },
    }, { db: tx });

    return prescription;
  });
}

export async function getPrescriptions({ tenantId, dialysis_patient_id }) {
  const patient = await getDialysisPatientInTenant(tenantId, dialysis_patient_id);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM dialysis_prescriptions
     WHERE dialysis_patient_id = $1 AND tenant_id = $2::uuid
     ORDER BY status = 'active' DESC, created_at DESC`,
    patient.id, tenantOr(tenantId));
  return { active: rows.find((r) => r.status === 'active') || null, history: rows };
}

// ── Sessions ──────────────────────────────────────────────────────

export async function scheduleSession({ tenantId, ...body }) {
  if (!body.dialysis_patient_id) throw AppError.badRequest('dialysis_patient_id required');
  if (!body.session_date) throw AppError.badRequest('session_date required');
  const patient = await getDialysisPatientInTenant(tenantId, body.dialysis_patient_id);

  // Resolve the active access if not provided.
  let accessId = body.vascular_access_id || null;
  if (!accessId) {
    const accRows = await prisma.$queryRawUnsafe(
      `SELECT id FROM vascular_access WHERE dialysis_patient_id = $1 AND active = true LIMIT 1`,
      patient.id);
    accessId = unwrap(accRows)?.id || null;
  } else {
    const access = await getAccessInTenant(tenantId, accessId, patient.id);
    accessId = access.id;
  }

  // Inherit from the active prescription (D7) for anything not supplied.
  const rxRows = await prisma.$queryRawUnsafe(
    `SELECT id, modality, dialyser, anticoag, anticoag_loading, anticoag_maintenance, max_uf_ml_per_session
     FROM dialysis_prescriptions
     WHERE tenant_id = $1::uuid AND dialysis_patient_id = $2 AND status = 'active' LIMIT 1`,
    tenantOr(tenantId), patient.id);
  const rx = unwrap(rxRows) || null;

  const sql = `
    INSERT INTO dialysis_sessions
      (dialysis_patient_id, vascular_access_id, session_date,
       machine_no, station_no, modality, dialyser, reuse_count,
       scheduled_start_at, prescribed_uf_l, anticoag,
       anticoag_initial_dose, anticoag_maintenance,
       status, conducted_by, supervised_by, prescription_id, tenant_id)
    VALUES ($1, $2, $3::date,
            $4, $5, $6, $7, $8,
            $9::timestamptz, $10, $11, $12, $13,
            'scheduled', $14, $15, $16, $17)
    RETURNING *`;
  const rows = await prisma.$queryRawUnsafe(sql,
    patient.id, accessId,
    body.session_date, body.machine_no || null, body.station_no || null,
    body.modality || rx?.modality || 'hd',
    body.dialyser || rx?.dialyser || null, body.reuse_count || null,
    body.scheduled_start_at || null,
    body.prescribed_uf_l ?? (rx?.max_uf_ml_per_session ? rx.max_uf_ml_per_session / 1000 : null),
    body.anticoag || rx?.anticoag || null,
    body.anticoag_initial_dose || rx?.anticoag_loading || null,
    body.anticoag_maintenance || rx?.anticoag_maintenance || null,
    body.conducted_by || null, body.supervised_by || null,
    rx?.id || null,
    tenantOr(tenantId));
  return unwrap(rows);
}

export async function startSession({ tenantId, id, ...body }) {
  const sessRows = await prisma.$queryRawUnsafe(
    `SELECT status FROM dialysis_sessions WHERE id = $1 AND tenant_id = $2::uuid FOR UPDATE`,
    parseInt(id, 10), tenantOr(tenantId));
  const sess = unwrap(sessRows);
  if (!sess) throw AppError.notFound('Session not found');
  if (!SESSION_TRANSITIONS[sess.status]?.includes('in_progress')) {
    throw AppError.invalidTransition(sess.status, 'in_progress', SESSION_TRANSITIONS[sess.status] || []);
  }

  const sql = `
    UPDATE dialysis_sessions
    SET status = 'in_progress',
        actual_start_at = NOW(),
        pre_weight_kg = $1,
        pre_bp_systolic = $2,
        pre_bp_diastolic = $3,
        pre_pulse = $4,
        pre_temp_c = $5,
        updated_at = NOW()
    WHERE id = $6 AND tenant_id = $7::uuid
    RETURNING *`;
  const rows = await prisma.$queryRawUnsafe(sql,
    body.pre_weight_kg || null, body.pre_bp_systolic || null,
    body.pre_bp_diastolic || null, body.pre_pulse || null,
    body.pre_temp_c || null,
    parseInt(id, 10), tenantOr(tenantId));
  return unwrap(rows);
}

export async function completeSession({ tenantId, id, completed_by, actorRole, ...body }) {
  const completed = await setTenantTx(tenantOr(tenantId), async (tx) => {
    const sessRows = await tx.$queryRawUnsafe(
      `SELECT s.*, p.patient_uid
         FROM dialysis_sessions s
         JOIN dialysis_patients p ON p.id = s.dialysis_patient_id
          AND p.tenant_id = s.tenant_id
        WHERE s.id = $1 AND s.tenant_id = $2::uuid
        FOR UPDATE`,
      parseInt(id, 10), tenantOr(tenantId));
    const sess = unwrap(sessRows);
    if (!sess) throw AppError.notFound('Session not found');
    if (!SESSION_TRANSITIONS[sess.status]?.includes('completed')) {
      throw AppError.invalidTransition(sess.status, 'completed', SESSION_TRANSITIONS[sess.status] || []);
    }

    const startTs = sess.actual_start_at ? new Date(sess.actual_start_at) : null;
    const durationMin = startTs ? Math.round((Date.now() - startTs.getTime()) / 60000) : null;

    const ureaPre = body.urea_pre_mg_dl ?? sess.urea_pre_mg_dl;
    const ureaPost = body.urea_post_mg_dl ?? sess.urea_post_mg_dl;
    const postWeight = body.post_weight_kg ?? sess.post_weight_kg;
    const actualUf = body.actual_uf_l ?? sess.actual_uf_l;

    const urr = computeUrr({ urea_pre_mg_dl: ureaPre, urea_post_mg_dl: ureaPost });
    const ktv = computeKtv({
      urea_pre_mg_dl: ureaPre, urea_post_mg_dl: ureaPost,
      duration_min: durationMin, actual_uf_l: actualUf, post_weight_kg: postWeight,
    });

    const sql = `
      UPDATE dialysis_sessions
      SET status = 'completed',
          actual_end_at = NOW(),
          duration_min = $1,
          post_weight_kg = $2, post_bp_systolic = $3, post_bp_diastolic = $4,
          post_pulse = $5, post_temp_c = $6,
          actual_uf_l = $7,
          urea_pre_mg_dl = $8, urea_post_mg_dl = $9,
          urr_pct = $10, ktv_calculated = $11,
          intra_dialytic_hypotension = COALESCE($12, intra_dialytic_hypotension),
          cramps = COALESCE($13, cramps),
          bleeding = COALESCE($14, bleeding),
          clotting = COALESCE($15, clotting),
          early_termination = COALESCE($16, early_termination),
          early_termination_reason = $17,
          notes = $18,
          updated_at = NOW()
      WHERE id = $19 AND tenant_id = $20::uuid
      RETURNING *`;
    const rows = await tx.$queryRawUnsafe(sql,
      durationMin,
      postWeight, body.post_bp_systolic || null, body.post_bp_diastolic || null,
      body.post_pulse || null, body.post_temp_c || null,
      actualUf,
      ureaPre, ureaPost, urr, ktv,
      body.intra_dialytic_hypotension ?? null, body.cramps ?? null,
      body.bleeding ?? null, body.clotting ?? null,
      body.early_termination ?? null, body.early_termination_reason || null,
      body.notes || null,
      parseInt(id, 10), tenantOr(tenantId));
    const row = unwrap(rows);

    await recordCanonicalClinicalEvent({
      tenantId: tenantOr(tenantId),
      patientUid: sess.patient_uid,
      eventType: 'dialysis.completed',
      sourceTable: 'dialysis_sessions',
      sourceId: row.id,
      actorUid: completed_by || null,
      actorRole: actorRole || null,
      summary: `Dialysis session completed${row.ktv_calculated ? `; Kt/V ${row.ktv_calculated}` : ''}`,
      payload: {
        session_id: row.id,
        dialysis_patient_id: row.dialysis_patient_id,
        modality: row.modality,
        machine_no: row.machine_no,
        duration_min: row.duration_min,
        urr_pct: row.urr_pct,
        ktv_calculated: row.ktv_calculated,
      },
    }, { db: tx });

    return { ...row, patient_uid: sess.patient_uid };
  });

  const qaLog = await getSameDayMachineQaLog(tenantId, completed.machine_no);
  const machineQaWarnings = buildMachineQaWarnings(qaLog, completed.machine_no);
  const billingHook = await maybeEmitDialysisBillingLine({
    tenantId,
    session: completed,
    actorUid: completed_by || null,
  });

  return {
    ...completed,
    machine_qa_warnings: machineQaWarnings,
    billing_hook: billingHook,
  };
}

export async function cancelSession({ tenantId, id, reason, mark_no_show }) {
  const target = mark_no_show ? 'no_show' : 'cancelled';
  const sessRows = await prisma.$queryRawUnsafe(
    `SELECT status FROM dialysis_sessions WHERE id = $1 AND tenant_id = $2::uuid`,
    parseInt(id, 10), tenantOr(tenantId));
  const sess = unwrap(sessRows);
  if (!sess) throw AppError.notFound('Session not found');
  if (!SESSION_TRANSITIONS[sess.status]?.includes(target)) {
    throw AppError.invalidTransition(sess.status, target, SESSION_TRANSITIONS[sess.status] || []);
  }
  const sql = `
    UPDATE dialysis_sessions
    SET status = $1, notes = COALESCE(notes, '') || COALESCE($2, ''),
        updated_at = NOW()
    WHERE id = $3 AND tenant_id = $4::uuid
    RETURNING *`;
  const note = reason ? `\n[${target}] ${reason}` : null;
  const rows = await prisma.$queryRawUnsafe(sql, target, note,
    parseInt(id, 10), tenantOr(tenantId));
  return unwrap(rows);
}

export async function listSessions({ tenantId, date, status, dialysis_patient_id, limit = 200 }) {
  const conds = ['tenant_id = $1::uuid'];
  const args = [tenantOr(tenantId)];
  if (date) { args.push(date); conds.push(`session_date = $${args.length}::date`); }
  if (status) { args.push(status); conds.push(`status = $${args.length}`); }
  if (dialysis_patient_id) {
    const patient = await getDialysisPatientInTenant(tenantId, dialysis_patient_id);
    args.push(patient.id);
    conds.push(`dialysis_patient_id = $${args.length}`);
  }
  const lim = Math.min(parseInt(limit, 10) || 200, 1000);
  const sql = `
    SELECT * FROM dialysis_sessions
    WHERE ${conds.join(' AND ')}
    ORDER BY session_date DESC, scheduled_start_at ASC
    LIMIT ${lim}`;
  return prisma.$queryRawUnsafe(sql, ...args);
}

export async function todayBoard({ tenantId }) {
  const sql = `SELECT * FROM dialysis_today WHERE tenant_id = $1::uuid ORDER BY scheduled_start_at`;
  return prisma.$queryRawUnsafe(sql, tenantOr(tenantId));
}

// ── Intra-dialysis observations ───────────────────────────────────

export async function logObservation({ tenantId, session_id, recorded_by, source, source_device, ...body }) {
  if (!session_id) throw AppError.badRequest('session_id required');
  const session = await getDialysisSessionInTenant(tenantId, session_id);
  // UF rate alert: > 13 mL/kg/hr is the KDOQI cutoff for harmful UF.
  // Surface it via the event_note auto-fill (don't block).
  let eventNote = body.event_note || null;
  if (body.uf_rate_ml_hr && body.uf_rate_ml_hr > 1300) {
    eventNote = `${eventNote ? eventNote + ' · ' : ''}HIGH UF RATE >13mL/kg/hr (review)`;
  }

  const sql = `
    INSERT INTO dialysis_intra_obs
      (session_id, recorded_at, bp_systolic, bp_diastolic, pulse, spo2, temp_c,
       blood_flow_ml_min, uf_rate_ml_hr, tmp_mmhg,
       arterial_pressure, venous_pressure, conductivity_ms_cm,
       uf_total_ml, event_note, intervention, intervention_dose, recorded_by,
       source, source_device)
    VALUES ($1, COALESCE($2::timestamptz, NOW()),
            $3, $4, $5, $6, $7,
            $8, $9, $10, $11, $12, $13,
            $14, $15, $16, $17, $18,
            COALESCE($19, 'staff'), $20)
    RETURNING *`;
  const rows = await prisma.$queryRawUnsafe(sql,
    session.id, body.recorded_at || null,
    body.bp_systolic || null, body.bp_diastolic || null,
    body.pulse || null, body.spo2 || null, body.temp_c || null,
    body.blood_flow_ml_min || null, body.uf_rate_ml_hr || null,
    body.tmp_mmhg || null, body.arterial_pressure || null,
    body.venous_pressure || null, body.conductivity_ms_cm || null,
    body.uf_total_ml || null, eventNote,
    body.intervention || null, body.intervention_dose || null,
    recorded_by || null,
    source || null, source_device || null);
  return unwrap(rows);
}

// ── Structured complications (D7) ────────────────────────────────

const SESSION_FLAG_BY_EVENT = {
  hypotension: 'intra_dialytic_hypotension',
  cramps: 'cramps',
  bleeding: 'bleeding',
  clotting: 'clotting',
};

const VALID_EVENT_TYPES = [
  'hypotension', 'cramps', 'clotting', 'bleeding', 'access_issue',
  'fever_rigors', 'hypoglycemia', 'arrhythmia', 'air_embolism_alarm', 'other',
];
const VALID_SEVERITIES = ['mild', 'moderate', 'severe'];

export async function recordSessionEvent({ tenantId, session_id, recorded_by, actorRole, ...body }) {
  if (!session_id) throw AppError.badRequest('session_id required');
  if (!body.event_type || !VALID_EVENT_TYPES.includes(body.event_type)) {
    throw AppError.badRequest(
      `event_type must be one of: ${VALID_EVENT_TYPES.join(', ')}`,
      'DIALYSIS_EVENT_TYPE_INVALID',
    );
  }
  if (body.severity && !VALID_SEVERITIES.includes(body.severity)) {
    throw AppError.badRequest('severity must be mild, moderate, or severe', 'DIALYSIS_SEVERITY_INVALID');
  }

  const sessRows = await prisma.$queryRawUnsafe(
    `SELECT s.id, s.status, p.patient_uid
     FROM dialysis_sessions s
     JOIN dialysis_patients p ON p.id = s.dialysis_patient_id
      AND p.tenant_id = s.tenant_id
     WHERE s.id = $1 AND s.tenant_id = $2::uuid`,
    parseInt(session_id, 10), tenantOr(tenantId));
  const sess = unwrap(sessRows);
  if (!sess) throw AppError.notFound('Session not found');
  if (!['in_progress', 'completed'].includes(sess.status)) {
    throw AppError.invalidTransition(sess.status, 'recording a complication', ['in_progress', 'completed']);
  }

  return setTenantTx(tenantOr(tenantId), async (tx) => {
    let event;
    try {
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO dialysis_session_events
           (session_id, event_type, severity, occurred_at, bp_systolic, bp_diastolic,
            intervention, intervention_dose, resolved, recorded_by, notes, tenant_id)
         VALUES ($1, $2, COALESCE($3, 'mild'), COALESCE($4::timestamptz, NOW()), $5, $6,
                 $7, $8, COALESCE($9, false), $10::uuid, $11, $12)
         RETURNING *`,
        sess.id, body.event_type, body.severity || null, body.occurred_at || null,
        body.bp_systolic || null, body.bp_diastolic || null,
        body.intervention || null, body.intervention_dose || null,
        body.resolved ?? null, recorded_by || null, body.notes || null,
        tenantOr(tenantId));
      event = unwrap(rows);
    } catch (err) {
      if (String(err.message).includes('chk_dialysis_session_events_type')) {
        throw AppError.badRequest('Unknown event_type', 'DIALYSIS_EVENT_TYPE_INVALID');
      }
      if (String(err.message).includes('chk_dialysis_session_events_severity')) {
        throw AppError.badRequest('severity must be mild, moderate, or severe', 'DIALYSIS_SEVERITY_INVALID');
      }
      throw err;
    }

    // Keep the session boolean flags in sync (adequacy reporting reads them).
    const flag = SESSION_FLAG_BY_EVENT[body.event_type];
    if (flag) {
      await tx.$queryRawUnsafe(
        `UPDATE dialysis_sessions
            SET ${flag} = true, updated_at = NOW()
          WHERE id = $1 AND tenant_id = $2::uuid`,
        sess.id, tenantOr(tenantId));
    }

    await recordCanonicalClinicalEvent({
      tenantId: tenantOr(tenantId),
      patientUid: sess.patient_uid,
      eventType: 'dialysis.complication',
      sourceTable: 'dialysis_session_events',
      sourceId: event.id,
      actorUid: recorded_by || null,
      actorRole: actorRole || null,
      summary: `Intra-dialytic ${body.event_type} (${event.severity})${body.intervention ? ` — ${body.intervention}` : ''}`,
      payload: {
        session_id: sess.id,
        event_type: body.event_type,
        severity: event.severity,
        intervention: body.intervention || null,
      },
    }, { db: tx });

    return event;
  });
}

export async function listSessionEvents({ tenantId, session_id }) {
  const session = await getDialysisSessionInTenant(tenantId, session_id);
  return prisma.$queryRawUnsafe(
    `SELECT * FROM dialysis_session_events
      WHERE tenant_id = $1::uuid AND session_id = $2
      ORDER BY occurred_at`,
    tenantOr(tenantId), session.id);
}

export async function listObservations({ tenantId, session_id }) {
  const session = await getDialysisSessionInTenant(tenantId, session_id);
  return prisma.$queryRawUnsafe(
    `SELECT * FROM dialysis_intra_obs WHERE session_id = $1 ORDER BY recorded_at`,
    session.id);
}

async function maybeEmitDialysisBillingLine({ tenantId, session, actorUid = null }) {
  const config = await getSessionBillingConfig(tenantId);
  if (!config?.charge_enabled) {
    return { status: 'disabled', emitted: false };
  }
  if (!config.finance_reviewed_at || config.unit_price == null) {
    return { status: 'finance_review_required', emitted: false };
  }

  try {
    const existing = await prisma.$queryRawUnsafe(
      `SELECT id, invoice_id
         FROM billing_invoice_items
        WHERE source_ref_type = 'dialysis_session'
          AND source_ref_id = $1::int
        LIMIT 1`,
      Number(session.id),
    );
    if (existing.length) {
      return {
        status: 'already_emitted',
        emitted: false,
        invoice_id: existing[0].invoice_id,
        invoice_item_id: existing[0].id,
      };
    }

    const patient = await getPatientBillingSnapshot(tenantId, session.patient_uid);
    let invoice = unwrap(await prisma.$queryRawUnsafe(
      `SELECT id
         FROM billing_invoices
        WHERE tenant_id = $1::uuid
          AND patient_uid = $2::uuid
          AND department = 'Dialysis'
          AND invoice_type = 'OP'
          AND status = 'DRAFT'
        ORDER BY created_at DESC
        LIMIT 1`,
      tenantOr(tenantId), String(session.patient_uid),
    ));
    if (!invoice) {
      invoice = await createDraftInvoice({
        tenantId: tenantOr(tenantId),
        patient_uid: session.patient_uid,
        patient_name: patient.name || null,
        patient_phone: patient.phone || null,
        department: 'Dialysis',
        invoice_type: 'OP',
        notes: 'Auto-created by dialysis completion hook; draft only until finance issues invoice.',
        created_by: actorUid,
      });
    }

    const unitPrice = Number(config.unit_price);
    const item = await addInvoiceItem(invoice.id, {
      tenantId: tenantOr(tenantId),
      service_code: config.service_code || 'DIALYSIS-HD-SESSION',
      description: `Dialysis session #${session.id}`,
      category: 'procedure',
      quantity: 1,
      unit_price: unitPrice,
      gst_rate: Number(config.gst_rate || 0),
      notes: 'Finance-reviewed dialysis tariff emitted from session completion.',
      source_ref_type: 'dialysis_session',
      source_ref_id: session.id,
    });
    return {
      status: 'emitted',
      emitted: true,
      invoice_id: invoice.id,
      invoice_item_id: item.id,
      unit_price: unitPrice,
    };
  } catch (err) {
    const duplicate = await prisma.$queryRawUnsafe(
      `SELECT id, invoice_id
         FROM billing_invoice_items
        WHERE source_ref_type = 'dialysis_session'
          AND source_ref_id = $1::int
        LIMIT 1`,
      Number(session.id),
    ).catch(() => []);
    if (duplicate.length) {
      return {
        status: 'already_emitted',
        emitted: false,
        invoice_id: duplicate[0].invoice_id,
        invoice_item_id: duplicate[0].id,
      };
    }
    logger.error('dialysis billing hook failed', {
      tenantId,
      sessionId: session.id,
      error: err.message,
    });
    return { status: 'error', emitted: false, message: 'Billing hook failed; review required' };
  }
}

export async function recordReuseRegister({ tenantId, session_id, processed_by, ...body }) {
  if (!session_id) throw AppError.badRequest('session_id required');
  if (!body.dialyzer_serial) throw AppError.badRequest('dialyzer_serial required');
  const normalized = validateReuseRegisterInput(body);

  return setTenantTx(tenantOr(tenantId), async (tx) => {
    const sessRows = await tx.$queryRawUnsafe(
      `SELECT s.id, s.reuse_count, s.dialysis_patient_id, p.patient_uid
         FROM dialysis_sessions s
         JOIN dialysis_patients p ON p.id = s.dialysis_patient_id
          AND p.tenant_id = s.tenant_id
        WHERE s.id = $1::int AND s.tenant_id = $2::uuid
        FOR UPDATE`,
      Number(session_id), tenantOr(tenantId),
    );
    const sess = unwrap(sessRows);
    if (!sess) throw AppError.notFound('Session not found');
    if (sess.reuse_count != null && Number(sess.reuse_count) !== normalized.reuseCycleCount) {
      throw AppError.badRequest(
        'reuse_cycle_count must match the session reuse_count',
        'DIALYZER_REUSE_SESSION_MISMATCH',
        { session_reuse_count: Number(sess.reuse_count), reuse_cycle_count: normalized.reuseCycleCount },
      );
    }
    if (sess.reuse_count == null) {
      await tx.$executeRawUnsafe(
        `UPDATE dialysis_sessions
            SET reuse_count = $1::int, updated_at = NOW()
          WHERE id = $2::int AND tenant_id = $3::uuid`,
        normalized.reuseCycleCount, sess.id, tenantOr(tenantId),
      );
    }

    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO dialyzer_reuse_register
         (tenant_id, session_id, dialysis_patient_id, patient_uid, dialyzer_serial,
          reuse_cycle_count, session_reuse_count, integrity_test_result,
          integrity_test_method, disinfectant, processed_by, status, discard_reason, notes)
       VALUES ($1::uuid, $2::int, $3::int, $4::uuid, $5, $6::int, $7::int, $8,
               $9, $10, $11::uuid, $12, $13, $14)
       ON CONFLICT (tenant_id, session_id) DO UPDATE SET
          dialyzer_serial = EXCLUDED.dialyzer_serial,
          reuse_cycle_count = EXCLUDED.reuse_cycle_count,
          session_reuse_count = EXCLUDED.session_reuse_count,
          integrity_test_result = EXCLUDED.integrity_test_result,
          integrity_test_method = EXCLUDED.integrity_test_method,
          disinfectant = EXCLUDED.disinfectant,
          processed_by = EXCLUDED.processed_by,
          processed_at = NOW(),
          status = EXCLUDED.status,
          discard_reason = EXCLUDED.discard_reason,
          notes = EXCLUDED.notes,
          updated_at = NOW()
       RETURNING *`,
      tenantOr(tenantId),
      sess.id,
      sess.dialysis_patient_id,
      sess.patient_uid,
      String(body.dialyzer_serial).trim(),
      normalized.reuseCycleCount,
      normalized.reuseCycleCount,
      normalized.integrity,
      body.integrity_test_method || null,
      body.disinfectant || null,
      processed_by || null,
      normalized.status,
      normalized.discardReason,
      body.notes || null,
    );
    return unwrap(rows);
  });
}

export async function listReuseRegister({ tenantId, session_id, dialysis_patient_id, limit = 100 }) {
  const conds = ['tenant_id = $1::uuid'];
  const args = [tenantOr(tenantId)];
  if (session_id) {
    args.push(Number(session_id));
    conds.push(`session_id = $${args.length}::int`);
  }
  if (dialysis_patient_id) {
    const patient = await getDialysisPatientInTenant(tenantId, dialysis_patient_id);
    args.push(patient.id);
    conds.push(`dialysis_patient_id = $${args.length}::int`);
  }
  const lim = Math.min(parseInt(limit, 10) || 100, 500);
  return prisma.$queryRawUnsafe(
    `SELECT * FROM dialyzer_reuse_register
      WHERE ${conds.join(' AND ')}
      ORDER BY processed_at DESC, id DESC
      LIMIT ${lim}`,
    ...args,
  );
}

export async function recordMachineQaLog({ tenantId, recorded_by, ...body }) {
  if (!body.machine_no && !body.session_id) {
    throw AppError.badRequest('machine_no or session_id required');
  }
  let machineNo = body.machine_no ? String(body.machine_no).trim() : null;
  const sessionId = body.session_id ? Number(body.session_id) : null;
  if (sessionId) {
    const session = await getDialysisSessionInTenant(tenantId, sessionId);
    const sessionRows = await prisma.$queryRawUnsafe(
      `SELECT machine_no FROM dialysis_sessions WHERE id = $1::int AND tenant_id = $2::uuid`,
      session.id, tenantOr(tenantId),
    );
    const sessionMachine = unwrap(sessionRows)?.machine_no || null;
    if (!machineNo) machineNo = sessionMachine;
    if (machineNo && sessionMachine && machineNo !== sessionMachine) {
      throw AppError.badRequest('machine_no does not match the session machine_no', 'DIALYSIS_QA_MACHINE_MISMATCH');
    }
  }
  if (!machineNo) throw AppError.badRequest('machine_no required');
  const issues = Array.isArray(body.issues) ? body.issues : [];
  const status = body.status || (body.machine_ready && body.disinfection_completed ? 'passed' : 'pending');
  if (!MACHINE_QA_STATUSES.includes(status)) {
    throw AppError.badRequest(
      `status must be one of: ${MACHINE_QA_STATUSES.join(', ')}`,
      'DIALYSIS_QA_STATUS_INVALID',
    );
  }
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO dialysis_machine_qa_logs
       (tenant_id, machine_no, session_id, qa_date, disinfection_completed,
        disinfection_method, disinfectant_lot, turnaround_started_at,
        turnaround_completed_at, machine_ready, status, issues, notes, recorded_by)
     VALUES ($1::uuid, $2, $3::int, COALESCE($4::date, CURRENT_DATE), COALESCE($5, false),
             $6, $7, $8::timestamptz, $9::timestamptz, COALESCE($10, false),
             $11, $12::jsonb, $13, $14::uuid)
     RETURNING *`,
    tenantOr(tenantId),
    machineNo,
    sessionId,
    body.qa_date || null,
    body.disinfection_completed ?? null,
    body.disinfection_method || null,
    body.disinfectant_lot || null,
    body.turnaround_started_at || null,
    body.turnaround_completed_at || null,
    body.machine_ready ?? null,
    status,
    JSON.stringify(issues),
    body.notes || null,
    recorded_by || null,
  );
  return unwrap(rows);
}

export async function listMachineQaLogs({ tenantId, machine_no, session_id, limit = 100 }) {
  const conds = ['tenant_id = $1::uuid'];
  const args = [tenantOr(tenantId)];
  if (machine_no) {
    args.push(String(machine_no));
    conds.push(`machine_no = $${args.length}`);
  }
  if (session_id) {
    args.push(Number(session_id));
    conds.push(`session_id = $${args.length}::int`);
  }
  const lim = Math.min(parseInt(limit, 10) || 100, 500);
  return prisma.$queryRawUnsafe(
    `SELECT * FROM dialysis_machine_qa_logs
      WHERE ${conds.join(' AND ')}
      ORDER BY qa_date DESC, recorded_at DESC, id DESC
      LIMIT ${lim}`,
    ...args,
  );
}

// ── Serology ──────────────────────────────────────────────────────

export async function recordSerology({ tenantId, dialysis_patient_id, ...body }) {
  if (!dialysis_patient_id) throw AppError.badRequest('dialysis_patient_id required');
  const patient = await getDialysisPatientInTenant(tenantId, dialysis_patient_id);

  // Look up most recent prior — if any positive marker turned positive
  // since then, flag as seroconversion (drives isolation + cluster
  // investigation).
  const priorRows = await prisma.$queryRawUnsafe(
    `SELECT hbsag, anti_hcv, hiv FROM dialysis_serology
     WHERE dialysis_patient_id = $1 ORDER BY test_date DESC LIMIT 1`,
    patient.id);
  const prior = unwrap(priorRows);

  const isSeroconv = (() => {
    if (!prior) return false;
    if (prior.hbsag === 'negative' && body.hbsag === 'positive') return true;
    if (prior.anti_hcv === 'negative' && body.anti_hcv === 'positive') return true;
    if (prior.hiv === 'negative' && body.hiv === 'positive') return true;
    return false;
  })();

  const sql = `
    INSERT INTO dialysis_serology
      (dialysis_patient_id, test_date, hbsag, hbs_titre, anti_hcv,
       hcv_pcr, hiv, is_seroconversion, reported_by, notes)
    VALUES ($1, COALESCE($2::date, CURRENT_DATE),
            $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING *`;
  const rows = await prisma.$queryRawUnsafe(sql,
    patient.id, body.test_date || null,
    body.hbsag || null, body.hbs_titre || null, body.anti_hcv || null,
    body.hcv_pcr || null, body.hiv || null, isSeroconv,
    body.reported_by || null, body.notes || null);

  // Promote patient-level statuses on a positive — drives isolation flag.
  if (body.hbsag === 'positive' || body.anti_hcv === 'positive' || body.hiv === 'positive') {
    await prisma.$queryRawUnsafe(
      `UPDATE dialysis_patients
       SET hbsag_status = COALESCE(NULLIF($1, 'pending'), hbsag_status),
           hcv_status   = COALESCE(NULLIF($2, 'pending'), hcv_status),
           hiv_status   = COALESCE(NULLIF($3, 'pending'), hiv_status),
           updated_at = NOW()
       WHERE id = $4 AND tenant_id = $5::uuid`,
      body.hbsag === 'positive' ? 'positive' : null,
      body.anti_hcv === 'positive' ? 'positive' : null,
      body.hiv === 'positive' ? 'positive' : null,
      patient.id, tenantOr(tenantId));
  }
  return unwrap(rows);
}

export const _internal = {
  SESSION_TRANSITIONS, computeUrr, computeKtv,
  VALID_MODALITIES, VALID_ACCESS_TYPES,
  validateReuseRegisterInput, buildMachineQaWarnings,
};
