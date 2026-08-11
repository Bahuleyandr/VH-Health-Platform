// src/services/clinical/nursingAssessmentService.js
//
// Sprint 15 — NEWS2 + Braden + Morse + sepsis screen scoring.
// Pure-compute scoring functions + persistence helpers. The scoring
// versions are locked into the row at write time so future guideline
// changes don't silently re-grade old data.

import prisma, { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { boundedInteger } from '../../utils/pagination.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { recordCanonicalClinicalEvent } from './canonicalClinicalPlatformService.js';
import {
  calculateNEWS2,
  escalateNews2,
  normalizeSpo2Scale,
  resolveSpo2ScaleForPatient,
} from './news2Service.js';

const SCORING_VERSION = 'v1';

// ── NEWS2 ───────────────────────────────────────────────────────────
// Royal College of Physicians 2017 spec.
// Inputs: rr (resp rate), spo2 (%), spo2_scale (1=normal, 2=copd),
// supplemental_o2 (bool), temp_c, sbp, hr, consciousness ('awake' | 'avpu_v_p_u').
// Long-form aliases (respiratory_rate, temperature, systolic_bp, pulse,
// heart_rate) are accepted because the staff-app vitals payload uses them;
// without aliasing, every long-form field falls through as undefined and the
// score collapses to 0 even for clinically deteriorating patients.
//
// Thin adapter over the single NEWS2 scorer (news2Service.calculateNEWS2 —
// C-M7 unification; this file previously carried a divergent copy). It keeps
// this surface's aliases, the 'awake' consciousness vocabulary, and the
// band names + thresholds the listOverdueOrHighRisk dashboard SQL filters on
// (low | low_medium | medium | high — do not rename them without updating
// that query).
export function scoreNews2(input, options = {}) {
  const raw = input ?? {};
  const consciousness = raw.consciousness === 'awake' ? 'A' : raw.consciousness;
  const computed = calculateNEWS2({
    respiration_rate: raw.rr ?? raw.respiratory_rate,
    spo2: raw.spo2,
    supplemental_o2: !!raw.supplemental_o2,
    temperature: raw.temp_c ?? raw.temperature,
    systolic_bp: raw.sbp ?? raw.systolic_bp,
    heart_rate: raw.hr ?? raw.pulse ?? raw.heart_rate,
    consciousness,
  }, { spo2Scale: options.spo2Scale ?? raw.spo2_scale });

  const total = computed.totalScore;
  // Final band per NEWS2 protocol — a single red (=3) parameter forces high.
  let band;
  if (computed.anyParamThree || total >= 7) band = 'high';
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

  // `computed` is the full scorer output (scorable/partial/missingParams/
  // scores/clinicalRisk/escalationAction) — recordAssessment needs it to
  // honor the scorable flag, persist the partial marker, and drive the same
  // escalateNews2 the vitals path uses (audit 2026-08-10 parity fix).
  return { total_score: total, band, recommended_actions: recommendedActions, reassessmentMins, computed };
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
export function score(kind, inputs, options = {}) {
  switch (kind) {
    case 'news2': return scoreNews2(inputs, options);
    case 'braden': return scoreBraden(inputs);
    case 'morse': return scoreMorse(inputs);
    case 'sepsis_screen': return scoreSepsisScreen(inputs);
    default: throw AppError.badRequest(`Unknown assessment kind: ${kind}`);
  }
}

// Sepsis-screen bands that constitute a POSITIVE screen (scoreSepsisScreen).
const SEPSIS_POSITIVE_BANDS = new Set(['sepsis_likely', 'septic_shock_risk']);

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

  // NEWS2 with no caller-supplied scale: the patient-level flag decides
  // (migration 646). The applied scale is locked into the stored inputs so
  // the persisted row stays reproducible even if the flag later changes
  // (scoring_version discipline — rows must not silently re-grade).
  let effectiveInputs = inputs ?? {};
  if (assessment_kind === 'news2') {
    const suppliedScale = effectiveInputs.spo2_scale;
    if (suppliedScale === undefined || suppliedScale === null || suppliedScale === '') {
      const resolvedScale = await resolveSpo2ScaleForPatient(String(patient_uid));
      effectiveInputs = { ...effectiveInputs, spo2_scale: resolvedScale };
    } else {
      const normalizedScale = normalizeSpo2Scale(suppliedScale);
      if (normalizedScale === null) {
        throw AppError.badRequest('spo2_scale must be 1 or 2');
      }
      effectiveInputs = { ...effectiveInputs, spo2_scale: normalizedScale };
    }
  }

  const result = score(assessment_kind, effectiveInputs);
  // Honor the scorer's scorable flag (audit 2026-08-10): a NEWS2 assessment
  // with ZERO core parameters previously persisted as "total 0 / low /
  // 12-hourly" — a fabricated reassuring score. Reject it instead.
  if (assessment_kind === 'news2' && result.computed && !result.computed.scorable) {
    throw AppError.badRequest(
      'NEWS2 assessment requires at least one core parameter (respiration rate, SpO2, temperature, systolic BP, heart rate, or consciousness)',
    );
  }
  const news2Partial = assessment_kind === 'news2' && result.computed?.partial === true;
  const news2MissingParams = news2Partial ? result.computed.missingParams : null;
  const reassessMins = result.reassessmentMins ?? null;
  const nextDueAt = reassessMins
    ? new Date(Date.now() + reassessMins * 60_000).toISOString()
    : null;

  // Snapshot the recording nurse's display name at write time. The route
  // never asks the client for assessed_by_name (it's derived from the
  // signed-in user), so without this lookup `assessed_by_name` lands as
  // null and the printed handover sheet shows a blank "recorded by"
  // field — a JCI/NABH governance gap. Finding:
  // 2026-05-09-inpatient-admission-nurse-assessed-by-name-null.
  let resolvedAssessedByName = assessed_by_name || null;
  if (!resolvedAssessedByName && assessed_by) {
    try {
      const user = await prisma.users.findUnique({
        where: { uid: String(assessed_by) },
        select: { name: true },
      });
      resolvedAssessedByName = user?.name || null;
    } catch {
      // Best-effort snapshot — falling through leaves the column null,
      // which matches the pre-fix behaviour rather than blocking the write.
    }
  }

  // Detail row + canonical timeline/audit pair in ONE tenant-scoped tx
  // (docs/CANONICAL_CLINICAL_TIMELINE.md): a failed canonical emit rolls back
  // the assessment row. Previously this was a single INSERT on plain prisma —
  // even a positive sepsis screen left zero timeline/audit footprint.
  const resolvedTenantId = requireTenantId(tenantId);
  const sepsisPositive = assessment_kind === 'sepsis_screen' && SEPSIS_POSITIVE_BANDS.has(result.band);
  const saved = await setTenantTx(resolvedTenantId, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO nursing_assessments
         (patient_uid, admission_id, assessment_kind, inputs, total_score,
          band, scoring_version, recommended_actions, notes,
          assessed_by, assessed_by_name, next_assessment_due_at, tenant_id,
          partial_score, missing_params)
       VALUES ($1::uuid, $2::int, $3, $4::jsonb, $5::int, $6, $7,
               $8::text[], $9, $10::uuid, $11, $12::timestamptz, $13::uuid,
               $14, $15::text[])
       RETURNING *,
                 (EXTRACT(EPOCH FROM assessed_at) * 1000)::double precision AS assessed_at_epoch_ms`,
      String(patient_uid),
      admission_id ? Number(admission_id) : null,
      assessment_kind,
      JSON.stringify(effectiveInputs),
      Number(result.total_score),
      result.band,
      SCORING_VERSION,
      result.recommended_actions ?? null,
      notes || null,
      assessed_by ? String(assessed_by) : null,
      resolvedAssessedByName,
      nextDueAt,
      resolvedTenantId,
      news2Partial,
      news2MissingParams,
    );
    const row = rows[0];
    if (Number.isFinite(Number(row?.assessed_at_epoch_ms))) {
      row.assessed_at = new Date(Number(row.assessed_at_epoch_ms));
    }
    delete row?.assessed_at_epoch_ms;
    await recordCanonicalClinicalEvent({
      tenantId: resolvedTenantId,
      patientUid: String(patient_uid),
      eventType: 'nursing_assessment.recorded',
      eventSubtype: assessment_kind,
      eventStatus: 'recorded',
      sourceTable: 'nursing_assessments',
      sourceId: row.id,
      resourceType: 'nursing_assessment',
      resourceId: row.id,
      actorUid: assessed_by ? String(assessed_by) : null,
      summary: sepsisPositive
        ? `Sepsis screen POSITIVE (${result.band}, score ${result.total_score})`
        : news2Partial
          ? `NEWS2 partial score ${result.total_score} recorded — risk band unavailable`
        : `${assessment_kind} assessment: ${result.band} (score ${result.total_score})`,
      payload: {
        assessment_kind,
        total_score: result.total_score,
        band: result.band,
        recommended_actions: result.recommended_actions ?? null,
        scoring_version: SCORING_VERSION,
        ...(assessment_kind === 'news2'
          ? { partial: news2Partial, missing_params: news2MissingParams }
          : {}),
        ...(assessment_kind === 'sepsis_screen' ? { sepsis_screen_positive: sepsisPositive } : {}),
      },
      afterState: row,
      tags: sepsisPositive
        ? ['nursing-assessment', assessment_kind, 'sepsis-screen-positive']
        : ['nursing-assessment', assessment_kind],
    }, { db: tx });
    return row;
  });

  // Escalation parity with the vitals path (audit 2026-08-10): a NEWS2 of 8
  // charted through a nursing assessment previously rendered "emergency" text
  // but raised no tracked task, while the SAME score via recordVitals did.
  // POST-COMMIT like the vitals path (it touches other tables / the CDS
  // module); escalateNews2 itself decides whether the score warrants a task
  // (aggregate >= 5 or a single red parameter) and is LOUD on failure.
  // resourceType 'nursing_assessment' keeps the task dedup slot off the
  // news2_scores id space.
  if (assessment_kind === 'news2' && result.computed) {
    await escalateNews2(String(patient_uid), saved, result.computed, {
      tenantId: resolvedTenantId,
      resourceType: 'nursing_assessment',
    });
  }
  return saved;
}

export async function listForPatient({ tenantId, patient_uid, kind, limit = 50 }) {
  const params = [tenantId, String(patient_uid)];
  let where = `tenant_id = $1::uuid AND patient_uid = $2::uuid`;
  if (kind) {
    params.push(kind);
    where += ` AND assessment_kind = $${params.length}`;
  }
  params.push(boundedInteger(limit, { fallback: 50, min: 1, max: 200 }));
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, assessment_kind, assessed_at, assessed_by_name,
            total_score, band, scoring_version, recommended_actions,
            inputs, notes, next_assessment_due_at, partial_score, missing_params
       FROM nursing_assessments
      WHERE ${where}
      ORDER BY assessed_at DESC
      LIMIT $${params.length}::int`,
    ...params,
  );
  return rows.map((row) => row.assessment_kind === 'news2' && row.partial_score === true
    ? {
      ...row,
      band: null,
      recommended_actions: null,
      risk_band_available: false,
      display: `NEWS2 ${row.total_score} (partial; risk band unavailable)`,
    }
    : { ...row, risk_band_available: row.assessment_kind === 'news2' ? true : undefined });
}

export async function listOverdueOrHighRisk({ tenantId, limit = 100 }) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, patient_uid, admission_id, assessment_kind, total_score,
            band, assessed_at, next_assessment_due_at, partial_score, missing_params,
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
    tenantId, boundedInteger(limit, { fallback: 100, min: 1, max: 200 }),
  );
  return rows.map((row) => row.assessment_kind === 'news2' && row.partial_score === true
    ? {
      ...row,
      band: null,
      risk_band_available: false,
      display: `NEWS2 ${row.total_score} (partial; risk band unavailable; clinical review required)`,
    }
    : row);
}
