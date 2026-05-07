// src/services/clinical/dialysisService.js — Sprint 22
//
// Dialysis unit: patient roster, vascular access, session lifecycle
// (scheduled → in_progress → completed | cancelled | no_show),
// intra-dialysis observations, serology surveillance.

import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';

const TENANT_FALLBACK = '00000000-0000-4000-8000-000000000001';
function tenantOr(t) { return t || TENANT_FALLBACK; }
function unwrap(rows) { return Array.isArray(rows) ? rows[0] : rows; }

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

// ── Patients ──────────────────────────────────────────────────────

export async function enrolPatient({ tenantId, ...body }) {
  if (!body.patient_uid) throw AppError.badRequest('patient_uid required');
  if (body.modality && !VALID_MODALITIES.includes(body.modality)) {
    throw AppError.badRequest(`modality must be one of: ${VALID_MODALITIES.join(', ')}`);
  }

  const sql = `
    INSERT INTO dialysis_patients
      (patient_uid, modality, schedule_pattern, prescribed_minutes,
       prescribed_dialyser, dry_weight_kg, dry_weight_set_at,
       anticoag_default, hbsag_status, hcv_status, hiv_status,
       notes, tenant_id)
    VALUES ($1, COALESCE($2, 'hd'), $3, $4, $5, $6,
            CASE WHEN $6 IS NOT NULL THEN NOW() ELSE NULL END,
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
  const conds = ['tenant_id = $1'];
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
    `SELECT * FROM dialysis_patients WHERE id = $1 AND tenant_id = $2`,
    parseInt(id, 10), tenantOr(tenantId));
  const pat = unwrap(patRows);
  if (!pat) throw AppError.notFound('Dialysis patient not found');

  const accessRows = await prisma.$queryRawUnsafe(
    `SELECT * FROM vascular_access WHERE dialysis_patient_id = $1 ORDER BY active DESC, created_date DESC`,
    pat.id);
  const recentSessions = await prisma.$queryRawUnsafe(
    `SELECT * FROM dialysis_sessions WHERE dialysis_patient_id = $1 ORDER BY session_date DESC LIMIT 10`,
    pat.id);
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
    WHERE id = $2 AND tenant_id = $3
    RETURNING *`;
  const rows = await prisma.$queryRawUnsafe(sql,
    Number(dry_weight_kg), parseInt(id, 10), tenantOr(tenantId));
  const r = unwrap(rows);
  if (!r) throw AppError.notFound('Dialysis patient not found');
  return r;
}

// ── Vascular access ───────────────────────────────────────────────

export async function addAccess({ dialysis_patient_id, ...body }) {
  if (!body.access_type) throw AppError.badRequest('access_type required');
  if (!VALID_ACCESS_TYPES.includes(body.access_type)) {
    throw AppError.badRequest(`access_type invalid; must be one of: ${VALID_ACCESS_TYPES.join(', ')}`);
  }
  if (!body.created_date) throw AppError.badRequest('created_date required');

  // Deactivate previous active access (only one active at a time).
  await prisma.$queryRawUnsafe(
    `UPDATE vascular_access SET active = false, abandoned_date = COALESCE(abandoned_date, CURRENT_DATE)
     WHERE dialysis_patient_id = $1 AND active = true`,
    parseInt(dialysis_patient_id, 10));

  const sql = `
    INSERT INTO vascular_access
      (dialysis_patient_id, access_type, side, created_date, first_used_date,
       active, last_qa_check_date, qa_flow_ml_min, last_doppler_date, notes)
    VALUES ($1, $2, $3, $4::date, $5::date, true, $6::date, $7, $8::date, $9)
    RETURNING *`;
  const rows = await prisma.$queryRawUnsafe(sql,
    parseInt(dialysis_patient_id, 10), body.access_type,
    body.side || null, body.created_date, body.first_used_date || null,
    body.last_qa_check_date || null, body.qa_flow_ml_min || null,
    body.last_doppler_date || null, body.notes || null);
  return unwrap(rows);
}

export async function abandonAccess({ id, reason }) {
  const sql = `
    UPDATE vascular_access
    SET active = false,
        abandoned_date = CURRENT_DATE,
        abandoned_reason = $1
    WHERE id = $2
    RETURNING *`;
  const rows = await prisma.$queryRawUnsafe(sql, reason || null, parseInt(id, 10));
  const r = unwrap(rows);
  if (!r) throw AppError.notFound('Access not found');
  return r;
}

// ── Sessions ──────────────────────────────────────────────────────

export async function scheduleSession({ tenantId, ...body }) {
  if (!body.dialysis_patient_id) throw AppError.badRequest('dialysis_patient_id required');
  if (!body.session_date) throw AppError.badRequest('session_date required');

  // Resolve the active access if not provided.
  let accessId = body.vascular_access_id || null;
  if (!accessId) {
    const accRows = await prisma.$queryRawUnsafe(
      `SELECT id FROM vascular_access WHERE dialysis_patient_id = $1 AND active = true LIMIT 1`,
      parseInt(body.dialysis_patient_id, 10));
    accessId = unwrap(accRows)?.id || null;
  }

  const sql = `
    INSERT INTO dialysis_sessions
      (dialysis_patient_id, vascular_access_id, session_date,
       machine_no, station_no, modality, dialyser, reuse_count,
       scheduled_start_at, prescribed_uf_l, anticoag,
       anticoag_initial_dose, anticoag_maintenance,
       status, conducted_by, supervised_by, tenant_id)
    VALUES ($1, $2, $3::date,
            $4, $5, $6, $7, $8,
            $9::timestamptz, $10, $11, $12, $13,
            'scheduled', $14, $15, $16)
    RETURNING *`;
  const rows = await prisma.$queryRawUnsafe(sql,
    parseInt(body.dialysis_patient_id, 10), accessId,
    body.session_date, body.machine_no || null, body.station_no || null,
    body.modality || 'hd', body.dialyser || null, body.reuse_count || null,
    body.scheduled_start_at || null, body.prescribed_uf_l || null,
    body.anticoag || null, body.anticoag_initial_dose || null,
    body.anticoag_maintenance || null,
    body.conducted_by || null, body.supervised_by || null,
    tenantOr(tenantId));
  return unwrap(rows);
}

export async function startSession({ tenantId, id, ...body }) {
  const sessRows = await prisma.$queryRawUnsafe(
    `SELECT status FROM dialysis_sessions WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
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
    WHERE id = $6 AND tenant_id = $7
    RETURNING *`;
  const rows = await prisma.$queryRawUnsafe(sql,
    body.pre_weight_kg || null, body.pre_bp_systolic || null,
    body.pre_bp_diastolic || null, body.pre_pulse || null,
    body.pre_temp_c || null,
    parseInt(id, 10), tenantOr(tenantId));
  return unwrap(rows);
}

export async function completeSession({ tenantId, id, ...body }) {
  const sessRows = await prisma.$queryRawUnsafe(
    `SELECT * FROM dialysis_sessions WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    parseInt(id, 10), tenantOr(tenantId));
  const sess = unwrap(sessRows);
  if (!sess) throw AppError.notFound('Session not found');
  if (!SESSION_TRANSITIONS[sess.status]?.includes('completed')) {
    throw AppError.invalidTransition(sess.status, 'completed', SESSION_TRANSITIONS[sess.status] || []);
  }

  const startTs = sess.actual_start_at ? new Date(sess.actual_start_at) : null;
  const durationMin = startTs ? Math.round((Date.now() - startTs.getTime()) / 60000) : null;

  // Compute Kt/V + URR if labs supplied.
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
    WHERE id = $19 AND tenant_id = $20
    RETURNING *`;
  const rows = await prisma.$queryRawUnsafe(sql,
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
  return unwrap(rows);
}

export async function cancelSession({ tenantId, id, reason, mark_no_show }) {
  const target = mark_no_show ? 'no_show' : 'cancelled';
  const sessRows = await prisma.$queryRawUnsafe(
    `SELECT status FROM dialysis_sessions WHERE id = $1 AND tenant_id = $2`,
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
    WHERE id = $3 AND tenant_id = $4
    RETURNING *`;
  const note = reason ? `\n[${target}] ${reason}` : null;
  const rows = await prisma.$queryRawUnsafe(sql, target, note,
    parseInt(id, 10), tenantOr(tenantId));
  return unwrap(rows);
}

export async function listSessions({ tenantId, date, status, dialysis_patient_id, limit = 200 }) {
  const conds = ['tenant_id = $1'];
  const args = [tenantOr(tenantId)];
  if (date) { args.push(date); conds.push(`session_date = $${args.length}::date`); }
  if (status) { args.push(status); conds.push(`status = $${args.length}`); }
  if (dialysis_patient_id) {
    args.push(parseInt(dialysis_patient_id, 10));
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
  const sql = `SELECT * FROM dialysis_today WHERE tenant_id = $1 ORDER BY scheduled_start_at`;
  return prisma.$queryRawUnsafe(sql, tenantOr(tenantId));
}

// ── Intra-dialysis observations ───────────────────────────────────

export async function logObservation({ session_id, recorded_by, ...body }) {
  if (!session_id) throw AppError.badRequest('session_id required');
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
       uf_total_ml, event_note, intervention, intervention_dose, recorded_by)
    VALUES ($1, COALESCE($2::timestamptz, NOW()),
            $3, $4, $5, $6, $7,
            $8, $9, $10, $11, $12, $13,
            $14, $15, $16, $17, $18)
    RETURNING *`;
  const rows = await prisma.$queryRawUnsafe(sql,
    parseInt(session_id, 10), body.recorded_at || null,
    body.bp_systolic || null, body.bp_diastolic || null,
    body.pulse || null, body.spo2 || null, body.temp_c || null,
    body.blood_flow_ml_min || null, body.uf_rate_ml_hr || null,
    body.tmp_mmhg || null, body.arterial_pressure || null,
    body.venous_pressure || null, body.conductivity_ms_cm || null,
    body.uf_total_ml || null, eventNote,
    body.intervention || null, body.intervention_dose || null,
    recorded_by || null);
  return unwrap(rows);
}

export async function listObservations({ session_id }) {
  return prisma.$queryRawUnsafe(
    `SELECT * FROM dialysis_intra_obs WHERE session_id = $1 ORDER BY recorded_at`,
    parseInt(session_id, 10));
}

// ── Serology ──────────────────────────────────────────────────────

export async function recordSerology({ dialysis_patient_id, ...body }) {
  if (!dialysis_patient_id) throw AppError.badRequest('dialysis_patient_id required');

  // Look up most recent prior — if any positive marker turned positive
  // since then, flag as seroconversion (drives isolation + cluster
  // investigation).
  const priorRows = await prisma.$queryRawUnsafe(
    `SELECT hbsag, anti_hcv, hiv FROM dialysis_serology
     WHERE dialysis_patient_id = $1 ORDER BY test_date DESC LIMIT 1`,
    parseInt(dialysis_patient_id, 10));
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
    parseInt(dialysis_patient_id, 10), body.test_date || null,
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
       WHERE id = $4`,
      body.hbsag === 'positive' ? 'positive' : null,
      body.anti_hcv === 'positive' ? 'positive' : null,
      body.hiv === 'positive' ? 'positive' : null,
      parseInt(dialysis_patient_id, 10));
  }
  return unwrap(rows);
}

export const _internal = {
  SESSION_TRANSITIONS, computeUrr, computeKtv,
  VALID_MODALITIES, VALID_ACCESS_TYPES,
};
