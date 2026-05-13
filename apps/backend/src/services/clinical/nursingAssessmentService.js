// src/services/clinical/nursingAssessmentService.js
//
// Sprint 15 — NEWS2 + Braden + Morse + sepsis screen scoring.
// Pure-compute scoring functions + persistence helpers. The scoring
// versions are locked into the row at write time so future guideline
// changes don't silently re-grade old data.

import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';

const SCORING_VERSION = 'v1';

// ── NEWS2 ───────────────────────────────────────────────────────────
// Royal College of Physicians 2017 spec.
// Inputs: rr (resp rate), spo2 (%), spo2_scale (1=normal, 2=copd),
// supplemental_o2 (bool), temp_c, sbp, hr, consciousness ('awake' | 'avpu_v_p_u').
// Long-form aliases (respiratory_rate, temperature, systolic_bp, pulse,
// heart_rate) are accepted because the staff-app vitals payload uses them;
// without aliasing, every long-form field falls through as undefined and the
// score collapses to 0 even for clinically deteriorating patients.
export function scoreNews2(input) {
  const raw = input ?? {};
  const i = {
    rr: raw.rr ?? raw.respiratory_rate,
    spo2: raw.spo2,
    spo2_scale: raw.spo2_scale,
    supplemental_o2: raw.supplemental_o2,
    temp_c: raw.temp_c ?? raw.temperature,
    sbp: raw.sbp ?? raw.systolic_bp,
    hr: raw.hr ?? raw.pulse ?? raw.heart_rate,
    consciousness: raw.consciousness,
  };
  let total = 0;
  let band = 'low'; // low | low_medium | medium | high

  function add(n) {
    total += n;
    if (n >= 3) band = bumpBand(band, 'high');
  }
  function bumpBand(current, candidate) {
    const order = ['low', 'low_medium', 'medium', 'high'];
    return order.indexOf(candidate) > order.indexOf(current) ? candidate : current;
  }

  // Respiratory rate
  if (i.rr != null) {
    if (i.rr <= 8) add(3);
    else if (i.rr <= 11) add(1);
    else if (i.rr <= 20) add(0);
    else if (i.rr <= 24) add(2);
    else add(3);
  }

  // SpO2 — scale 1 (normal) vs scale 2 (chronic hypercapnic respiratory failure / COPD).
  const scale2 = String(i.spo2_scale ?? 1) === '2';
  if (i.spo2 != null) {
    if (!scale2) {
      if (i.spo2 <= 91) add(3);
      else if (i.spo2 <= 93) add(2);
      else if (i.spo2 <= 95) add(1);
      else add(0);
    } else {
      // Scale 2 (target 88-92%): scoring tiers different.
      if (i.spo2 <= 83) add(3);
      else if (i.spo2 <= 85) add(2);
      else if (i.spo2 <= 87) add(1);
      else if (i.spo2 <= 92) add(0);
      else if (i.spo2 <= 94 && i.supplemental_o2) add(1);
      else if (i.spo2 <= 96 && i.supplemental_o2) add(2);
      else if (i.spo2 >= 97 && i.supplemental_o2) add(3);
      else add(0);
    }
  }

  // Air vs supplemental O2 (separate +2 if on O2)
  if (i.supplemental_o2) add(2);

  // Temperature
  if (i.temp_c != null) {
    if (i.temp_c <= 35.0) add(3);
    else if (i.temp_c <= 36.0) add(1);
    else if (i.temp_c <= 38.0) add(0);
    else if (i.temp_c <= 39.0) add(1);
    else add(2);
  }

  // Systolic BP
  if (i.sbp != null) {
    if (i.sbp <= 90) add(3);
    else if (i.sbp <= 100) add(2);
    else if (i.sbp <= 110) add(1);
    else if (i.sbp <= 219) add(0);
    else add(3);
  }

  // Heart rate
  if (i.hr != null) {
    if (i.hr <= 40) add(3);
    else if (i.hr <= 50) add(1);
    else if (i.hr <= 90) add(0);
    else if (i.hr <= 110) add(1);
    else if (i.hr <= 130) add(2);
    else add(3);
  }

  // Consciousness — A (alert) = 0; V/P/U = 3
  if (i.consciousness && i.consciousness !== 'awake' && i.consciousness !== 'A') {
    add(3);
  }

  // Final band per NEWS2 protocol.
  if (band === 'high' || total >= 7) band = 'high';
  else if (total >= 5) band = 'medium';
  else if (total >= 3) band = 'low_medium';
  else band = 'low';

  // Reassessment frequency per protocol.
  const reassessmentMins =
    band === 'high' ? 15 : band === 'medium' ? 60 : band === 'low_medium' ? 240 : 720;

  const recommendedActions =
    band === 'high'
      ? ['Emergency assessment by clinical team with critical care competencies', 'Continuous monitoring', 'Consider transfer to ICU']
      : band === 'medium'
        ? ['Urgent review by clinical decision-maker', 'Consider transfer to higher level of care', 'Increase monitoring frequency to hourly']
        : band === 'low_medium'
          ? ['Review by registered nurse who decides if clinician review needed', 'Increase monitoring frequency to 4-6h']
          : ['Continue routine monitoring (12-hourly)'];

  return { total_score: total, band, recommended_actions: recommendedActions, reassessmentMins };
}

// ── Braden ──────────────────────────────────────────────────────────
// Inputs: sensory (1-4), moisture (1-4), activity (1-4), mobility (1-4),
// nutrition (1-4), friction (1-3). Total 6-23. Lower = higher risk.
export function scoreBraden(input) {
  const i = input ?? {};
  for (const k of ['sensory', 'moisture', 'activity', 'mobility', 'nutrition']) {
    if (i[k] != null && (i[k] < 1 || i[k] > 4)) {
      throw AppError.badRequest(`Braden ${k} must be 1-4`);
    }
  }
  if (i.friction != null && (i.friction < 1 || i.friction > 3)) {
    throw AppError.badRequest('Braden friction must be 1-3');
  }
  const total = ['sensory', 'moisture', 'activity', 'mobility', 'nutrition', 'friction']
    .reduce((acc, k) => acc + (Number(i[k]) || 0), 0);
  let band = 'no_risk';
  if (total <= 9) band = 'severe_risk';
  else if (total <= 12) band = 'high_risk';
  else if (total <= 14) band = 'moderate_risk';
  else if (total <= 18) band = 'mild_risk';
  return {
    total_score: total,
    band,
    recommended_actions: total <= 14
      ? ['Pressure-relieving mattress', 'Reposition q2h', 'Skin inspection per shift', 'Nutrition assessment']
      : ['Routine skin care', 'Reposition q4h'],
  };
}

// ── Morse Falls Scale ───────────────────────────────────────────────
// 6 items. Inputs:
//   history_falls (true → 25)
//   secondary_dx (true → 15)
//   ambulatory_aid: 'none' (0) / 'crutches_cane_walker' (15) / 'furniture' (30)
//   iv_therapy (true → 20)
//   gait: 'normal_or_bedrest' (0) / 'weak' (10) / 'impaired' (20)
//   mental_status: 'oriented' (0) / 'forgets_limits' (15)
export function scoreMorse(input) {
  const i = input ?? {};
  let total = 0;
  if (i.history_falls) total += 25;
  if (i.secondary_dx) total += 15;
  if (i.ambulatory_aid === 'crutches_cane_walker') total += 15;
  else if (i.ambulatory_aid === 'furniture') total += 30;
  if (i.iv_therapy) total += 20;
  if (i.gait === 'weak') total += 10;
  else if (i.gait === 'impaired') total += 20;
  if (i.mental_status === 'forgets_limits') total += 15;
  let band;
  if (total >= 45) band = 'high_risk';
  else if (total >= 25) band = 'moderate_risk';
  else band = 'low_risk';
  return {
    total_score: total,
    band,
    recommended_actions: total >= 45
      ? ['High fall-risk wristband', 'Bed in lowest position with rails up', 'Assist with all transfers', 'Frequent rounds (q1h)']
      : total >= 25
        ? ['Standard fall precautions', 'Call bell within reach', 'Q2h rounding']
        : ['Routine precautions'],
  };
}

// ── Sepsis screen ───────────────────────────────────────────────────
// SIRS + qSOFA + suspected source. ≥2 SIRS criteria + suspected source = sepsis screen positive.
export function scoreSepsisScreen(input) {
  const i = input ?? {};
  const sirs = [
    i.rr_over_22,
    i.hr_over_90,
    i.temp_abnormal, // < 36 or > 38
    i.wbc_abnormal,  // < 4 or > 12 or > 10% bands
  ].filter(Boolean).length;
  const qsofa = [i.rr_over_22, i.altered_mentation, i.sbp_under_100].filter(Boolean).length;
  const lactateHigh = !!i.lactate_over_2;
  const sourceSuspected = !!i.source_suspected;

  let band = 'no_concern';
  if (qsofa >= 2 && sourceSuspected) band = 'septic_shock_risk';
  else if (sirs >= 2 && sourceSuspected) band = 'sepsis_likely';
  else if (qsofa >= 2 || lactateHigh) band = 'monitor_closely';

  return {
    total_score: sirs * 10 + qsofa, // composite for sortability; SIRS dominates
    band,
    recommended_actions: band === 'septic_shock_risk'
      ? [
          'Activate sepsis bundle (blood cultures × 2)',
          'Lactate STAT',
          'IV broad-spectrum antibiotics within 1 hour',
          'IV fluid 30 ml/kg crystalloid',
          'Vasopressor if MAP < 65 after fluids',
          'ICU consult',
        ]
      : band === 'sepsis_likely'
        ? [
            'Activate sepsis bundle (blood cultures × 2)',
            'Lactate, CBC, procalcitonin',
            'IV broad-spectrum antibiotics within 1 hour',
            'IV fluid 30 ml/kg if hypotensive or lactate > 2',
            'Reassess q1h',
          ]
        : band === 'monitor_closely'
          ? ['Repeat vitals q1h', 'Consider lactate', 'Notify physician']
          : ['Continue routine monitoring'],
  };
}

// Public scoring entry — picks the right function based on kind.
export function score(kind, inputs) {
  switch (kind) {
    case 'news2': return scoreNews2(inputs);
    case 'braden': return scoreBraden(inputs);
    case 'morse': return scoreMorse(inputs);
    case 'sepsis_screen': return scoreSepsisScreen(inputs);
    default: throw AppError.badRequest(`Unknown assessment kind: ${kind}`);
  }
}

// ── Persistence ─────────────────────────────────────────────────────

export async function recordAssessment({
  tenantId, patient_uid, admission_id, assessment_kind, inputs,
  assessed_by, assessed_by_name, notes,
}) {
  if (!patient_uid) throw AppError.badRequest('patient_uid is required');
  if (!assessment_kind) throw AppError.badRequest('assessment_kind is required');
  const allowed = ['news2', 'braden', 'morse', 'sepsis_screen'];
  if (!allowed.includes(assessment_kind)) {
    throw AppError.badRequest(`assessment_kind must be one of: ${allowed.join(', ')}`);
  }

  const result = score(assessment_kind, inputs);
  const reassessMins = result.reassessmentMins ?? null;
  const nextDueAt = reassessMins
    ? new Date(Date.now() + reassessMins * 60_000).toISOString()
    : null;

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO nursing_assessments
       (patient_uid, admission_id, assessment_kind, inputs, total_score,
        band, scoring_version, recommended_actions, notes,
        assessed_by, assessed_by_name, next_assessment_due_at, tenant_id)
     VALUES ($1::uuid, $2::int, $3, $4::jsonb, $5::int, $6, $7,
             $8::text[], $9, $10::uuid, $11, $12::timestamptz, $13::uuid)
     RETURNING *`,
    String(patient_uid),
    admission_id ? Number(admission_id) : null,
    assessment_kind,
    JSON.stringify(inputs ?? {}),
    Number(result.total_score),
    result.band,
    SCORING_VERSION,
    result.recommended_actions ?? null,
    notes || null,
    assessed_by ? String(assessed_by) : null,
    assessed_by_name || null,
    nextDueAt,
    tenantId,
  );
  return rows[0];
}

export async function listForPatient({ tenantId, patient_uid, kind, limit = 50 }) {
  const params = [tenantId, String(patient_uid)];
  let where = `tenant_id = $1::uuid AND patient_uid = $2::uuid`;
  if (kind) {
    params.push(kind);
    where += ` AND assessment_kind = $${params.length}`;
  }
  params.push(Number(limit));
  return prisma.$queryRawUnsafe(
    `SELECT id, assessment_kind, assessed_at, assessed_by_name,
            total_score, band, scoring_version, recommended_actions,
            inputs, notes, next_assessment_due_at
       FROM nursing_assessments
      WHERE ${where}
      ORDER BY assessed_at DESC
      LIMIT $${params.length}::int`,
    ...params,
  );
}

export async function listOverdueOrHighRisk({ tenantId, limit = 100 }) {
  return prisma.$queryRawUnsafe(
    `SELECT id, patient_uid, admission_id, assessment_kind, total_score,
            band, assessed_at, next_assessment_due_at,
            CASE
              WHEN next_assessment_due_at IS NULL THEN 0
              ELSE EXTRACT(EPOCH FROM (NOW() - next_assessment_due_at)) / 60
            END AS minutes_overdue
       FROM nursing_assessments na
      WHERE tenant_id = $1::uuid
        AND (
          band IN ('high', 'medium', 'high_risk', 'severe_risk', 'sepsis_likely', 'septic_shock_risk')
          OR (next_assessment_due_at IS NOT NULL AND next_assessment_due_at < NOW())
        )
        -- Only show the latest assessment per (patient, kind) so the
        -- dashboard isn't dominated by historical readings.
        AND id IN (
          SELECT MAX(id)
            FROM nursing_assessments
           WHERE tenant_id = $1::uuid
           GROUP BY patient_uid, assessment_kind
        )
      ORDER BY
        CASE band
          WHEN 'septic_shock_risk' THEN 0
          WHEN 'high' THEN 1
          WHEN 'sepsis_likely' THEN 2
          WHEN 'severe_risk' THEN 3
          WHEN 'medium' THEN 4
          WHEN 'high_risk' THEN 5
          ELSE 9
        END,
        next_assessment_due_at NULLS LAST
      LIMIT $2::int`,
    tenantId, Number(limit),
  );
}
