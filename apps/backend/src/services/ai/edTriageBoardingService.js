/**
 * ED Triage and Boarding Predictor.
 *
 * Classifies an emergency-department arrival into an ESI-like triage level
 * (1-5), predicts the most likely specialty and disposition, and forecasts
 * a boarding risk band + minutes from triage acuity, ED occupancy, staff
 * load, and arrival mode.
 *
 * Rules are authoritative: triage level, specialty, disposition, and
 * boarding risk are derived from the supplied signals; the AI layer only
 * supplies a short narrative. Decision-support only — the service never
 * auto-assigns beds, never dispatches a team, and never writes to
 * admission orders. Every output requires ED charge nurse / on-call
 * clinician review.
 *
 * Graceful degradation: if the admission / vitals / occupancy schema is
 * missing, the relevant signal is marked `insufficient_data` and the
 * caller is told to defer to human review rather than assuming defaults.
 */

import crypto from 'crypto';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { publishEvent } from '../events/eventOutboxService.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenantService.js';
import { getClinicalAiModule } from './clinicalAiModuleService.js';
import { generateClinicalText } from './localLlmClient.js';

const MODULE_KEY = 'ed_triage_boarding_predictor';

const DEFAULT_PROMPT = {
  version: 'v1',
  system_prompt:
    'You support ED charge nurse / on-call clinician review of emergency-department arrivals. Rules are authoritative. Return JSON only and never auto-assign beds, dispatch a team, or create/hold admission orders.',
  user_prompt_template:
    'Given the ED arrival context and the rule-based triage + specialty + disposition + boarding forecast, return keys: summary, contributing_signals, recommended_actions, source_citations, safety_flags.',
};

const ARRIVAL_MODES = new Set(['walk_in', 'ambulance', 'transfer', 'police', 'unknown']);
const DISPOSITIONS = new Set([
  'admission', 'observation', 'icu', 'surgery', 'discharge', 'transfer', 'unknown',
]);
const RISK_BANDS = new Set(['low', 'moderate', 'high', 'critical', 'unknown', 'insufficient_data']);
const DECISIONS = new Set(['pending', 'accepted', 'deferred', 'rejected', 'escalated']);
const FINAL_DECISIONS = new Set(['accepted', 'deferred', 'rejected', 'escalated']);

// Default denominator when the admissions occupancy count is all we have.
// Parent/ops can override via admissions per ward; this is a safe cap.
const DEFAULT_ED_BED_CAPACITY = 20;

const PRIVACY_DISCLAIMER =
  'Review-only forecast; confirm with charge nurse before action.';

// ---------- Small helpers -----------------------------------------------

function resolveTenantId(options = {}) {
  return options.tenantId || DEFAULT_TENANT_ID;
}

function isMissingSchemaError(err) {
  return /does not exist|column .* does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizedText(value) {
  return cleanText(value).toLowerCase();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function toNumber(value, fallback = 0) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'bigint') return Number(value);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toNullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'bigint') return Number(value);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function optionalInt(value, fieldName = 'id') {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw AppError.badRequest(`${fieldName} must be a positive integer`);
  }
  return parsed;
}

function sourceHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value || {})).digest('hex');
}

function safeJsonParse(text, fallback) {
  if (!text) return fallback;
  const cleaned = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function uniqueCitations(citations) {
  const seen = new Set();
  return asArray(citations).filter((citation) => {
    if (!citation) return false;
    const key = `${citation.source_type}:${citation.source_id}:${citation.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeArrivalMode(value) {
  const mode = normalizedText(value).replace(/[\s-]+/g, '_');
  if (ARRIVAL_MODES.has(mode)) return mode;
  if (mode === 'ems' || mode === 'ambulatory_ems') return 'ambulance';
  if (mode === 'walkin') return 'walk_in';
  return 'unknown';
}

function normalizeVitals(raw) {
  const v = raw && typeof raw === 'object' ? raw : {};
  return {
    heart_rate: toNullableNumber(v.heart_rate ?? v.hr ?? v.pulse),
    systolic_bp: toNullableNumber(v.systolic_bp ?? v.sbp ?? v.systolic),
    diastolic_bp: toNullableNumber(v.diastolic_bp ?? v.dbp ?? v.diastolic),
    spo2: toNullableNumber(v.spo2 ?? v.oxygen_saturation ?? v.o2_sat),
    temperature: toNullableNumber(v.temperature ?? v.temp),
    resp_rate: toNullableNumber(v.resp_rate ?? v.respiratory_rate ?? v.rr),
  };
}

// ---------- Pure helpers (exported) -------------------------------------

/**
 * Classify an ED arrival into an ESI-like triage level (1-5).
 *
 * 1 = resuscitation (airway, severe shock, arrest-adjacent)
 * 2 = emergent (high-risk, one-resource-probably, decompensating)
 * 3 = urgent (moderate, needs workup)
 * 4 = less urgent (stable, mild-moderate pain)
 * 5 = non-urgent (stable + minor complaint)
 */
export function classifyTriageLevel({
  vitals = {},
  painScore = null,
  chiefComplaint = null,
  ageYears = null,
  arrivalMode = 'unknown',
} = {}) {
  const v = normalizeVitals(vitals);
  const pain = toNullableNumber(painScore);
  const complaint = normalizedText(chiefComplaint);
  const age = toNullableNumber(ageYears);
  const mode = normalizeArrivalMode(arrivalMode);

  // --- Level 1: resuscitation ------------------------------------------
  const unresponsiveKeywords = /(unresponsive|cardiac\s*arrest|respiratory\s*arrest|not\s*breathing|no\s*pulse)/i;
  if (unresponsiveKeywords.test(complaint)) return 1;
  if (v.spo2 !== null && v.spo2 < 85) return 1;
  if (v.systolic_bp !== null && v.systolic_bp < 80) return 1;
  if (v.heart_rate !== null && (v.heart_rate > 150 || v.heart_rate < 40)) return 1;
  if (v.resp_rate !== null && (v.resp_rate > 35 || v.resp_rate < 8)) return 1;

  // --- Level 2: emergent -----------------------------------------------
  const strokeKeywords = /(stroke|cva|facial\s*droop|slurred\s*speech|hemiparesis|hemiplegia)/i;
  const severeRespKeywords = /(severe\s*respiratory\s*distress|gasping|stridor|choking|can(?:not|'t)\s*breath)/i;
  const redFlagKeywords = /(chest\s*pain|severe\s*bleeding|hemorrhage|shock|anaphylaxis|seizure|overdose|suicidal)/i;

  if (strokeKeywords.test(complaint)) return 2;
  if (severeRespKeywords.test(complaint)) return 2;
  if (v.spo2 !== null && v.spo2 < 92) return 2;
  if (v.systolic_bp !== null && v.systolic_bp < 90) return 2;
  if (v.heart_rate !== null && v.heart_rate > 130) return 2;
  if (/chest\s*pain/i.test(complaint) && age !== null && age >= 40) return 2;
  if (pain !== null && pain >= 8 && redFlagKeywords.test(complaint)) return 2;
  if (mode === 'ambulance' && (pain !== null && pain >= 7)) return 2;

  // Insufficient data fallback: if we have no complaint and no vitals, be safe.
  const hasAnyVital = Object.values(v).some((n) => n !== null);
  if (!complaint && !hasAnyVital && pain === null) return 3;

  // --- Level 5: non-urgent ---------------------------------------------
  const minorKeywords = /(cough|sore\s*throat|rash|minor\s*injury|medication\s*refill|suture\s*removal)/i;
  const stableVitals = (
    (v.heart_rate === null || (v.heart_rate >= 60 && v.heart_rate <= 100))
    && (v.systolic_bp === null || (v.systolic_bp >= 100 && v.systolic_bp <= 140))
    && (v.spo2 === null || v.spo2 >= 95)
    && (v.resp_rate === null || (v.resp_rate >= 12 && v.resp_rate <= 20))
  );
  if (stableVitals && minorKeywords.test(complaint) && (pain === null || pain <= 3)) return 5;

  // --- Level 4: less urgent --------------------------------------------
  if (stableVitals && (pain === null || pain <= 5)) return 4;

  // --- Level 3 default -------------------------------------------------
  // Elderly with an acute complaint or moderately deranged vitals: urgent.
  return 3;
}

/**
 * Predict the most likely specialty from the chief complaint + demographics.
 * Simple keyword routing; fallback is 'internal' (general internal medicine).
 */
export function predictSpecialty({
  chiefComplaint = null,
  ageYears = null,
  vitals = {},
  painScore = null,
} = {}) {
  const complaint = normalizedText(chiefComplaint);
  const age = toNullableNumber(ageYears);
  void vitals;
  void painScore;

  if (!complaint && age !== null && age < 18) return 'pediatrics';
  if (!complaint) return 'internal';

  // Obstetrics — check before pediatrics because pregnancy can happen in adolescents.
  if (/(labou?r|contraction|bleeding\s*per\s*vagina|pv\s*bleed|pregnan|postpartum|miscarriage)/i.test(complaint)) {
    return 'obstetrics';
  }

  // Pediatrics — anything under 18 that isn't obviously something else.
  if (age !== null && age < 18) return 'pediatrics';

  // Cardiology — chest pain (esp. elderly), palpitations, dyspnea in older patients.
  if (/chest\s*pain/i.test(complaint) && age !== null && age >= 40) return 'cardiology';
  if (/(myocardial|heart\s*attack|mi|angina|palpitation)/i.test(complaint)) return 'cardiology';

  // Neurology — stroke, seizure, severe headache, altered mental status.
  if (/(stroke|cva|seizure|facial\s*droop|slurred|hemiparesis|hemiplegia|severe\s*headache|altered\s*mental)/i.test(complaint)) {
    return 'neurology';
  }

  // Orthopedics — trauma, fracture, dislocation.
  if (/(fracture|broken|dislocat|trauma|sprain)/i.test(complaint)) return 'orthopedics';

  // Psychiatry — self-harm, suicidal ideation, psychotic.
  if (/(suicid|self[-\s]*harm|psychot|mania|overdose\s*intentional)/i.test(complaint)) {
    return 'psychiatry';
  }

  // Surgery — abdominal pain with fever/peritonitis features, appendicitis-ish.
  if (/(appendicit|peritonit|abdominal\s*pain).*fever/i.test(complaint)
    || /(abdominal\s*pain|rebound|rigid\s*abdomen)/i.test(complaint)) {
    return 'surgery';
  }

  // Internal medicine fallback.
  return 'internal';
}

/**
 * Predict disposition (discharge / observation / admission / icu / surgery / transfer / unknown).
 */
export function predictDisposition({
  triageLevel = 3,
  vitals = {},
  ageYears = null,
  predictedSpecialty = null,
} = {}) {
  const level = clampInt(triageLevel, 1, 5, 3);
  const v = normalizeVitals(vitals);
  const age = toNullableNumber(ageYears);
  const specialty = normalizedText(predictedSpecialty);

  if (level === 1) return 'icu';

  if (level === 2) {
    // Respiratory / cardiac decompensation routes to ICU.
    const respiratoryFailure = v.spo2 !== null && v.spo2 < 90;
    const hypotension = v.systolic_bp !== null && v.systolic_bp < 90;
    const tachycardia = v.heart_rate !== null && v.heart_rate > 130;
    if (specialty === 'cardiology' && (tachycardia || hypotension)) return 'icu';
    if (respiratoryFailure || hypotension) return 'icu';
    if (specialty === 'surgery') return 'surgery';
    return 'admission';
  }

  if (level === 3) {
    if (specialty === 'surgery') return 'admission';
    // Elderly or abnormal vitals lean toward admission over observation.
    const abnormalVitals = (
      (v.heart_rate !== null && (v.heart_rate > 110 || v.heart_rate < 55))
      || (v.systolic_bp !== null && (v.systolic_bp > 170 || v.systolic_bp < 100))
      || (v.spo2 !== null && v.spo2 < 94)
    );
    if (age !== null && age >= 70) return 'admission';
    if (abnormalVitals) return 'admission';
    return 'observation';
  }

  if (level === 4) {
    if (age !== null && age >= 80) return 'observation';
    return 'discharge';
  }

  if (level === 5) return 'discharge';

  return 'unknown';
}

/**
 * Compute boarding risk from triage acuity, ED occupancy, staff load,
 * predicted disposition, and arrival mode.
 *
 * Returns { boarding_risk_score (0-100), boarding_risk_band,
 * predicted_boarding_minutes, signals, recommended_actions }.
 */
export function computeBoardingRisk({
  triageLevel = 3,
  occupancy = null,
  staffLoad = 'normal',
  predictedDisposition = 'unknown',
  arrivalMode = 'unknown',
} = {}) {
  const level = clampInt(triageLevel, 1, 5, 3);
  const disposition = DISPOSITIONS.has(normalizedText(predictedDisposition))
    ? normalizedText(predictedDisposition)
    : 'unknown';
  const mode = normalizeArrivalMode(arrivalMode);
  const load = normalizedText(staffLoad);
  const occ = toNullableNumber(occupancy);

  const signals = [];
  let score = 0;

  // --- Baseline by triage level ----------------------------------------
  // Lower level = higher acuity = needs bed faster but also has more
  // downstream overhead; higher level discharges quickly.
  const baselineMinutes = {
    1: 30,   // resuscitation — fast to bed but long LOS; boarding-as-waiting is low
    2: 120,  // emergent — admission pending bed
    3: 90,   // urgent — longer workup
    4: 45,   // less urgent — likely discharge after brief workup
    5: 20,   // non-urgent — rapid discharge
  };
  let minutes = baselineMinutes[level] || 60;

  if (level <= 2) {
    score += 25;
    signals.push({
      code: 'HIGH_ACUITY',
      severity: level === 1 ? 'critical' : 'high',
      description: `Triage level ${level} arrivals compete for the scarcest downstream resources (ICU / monitored beds).`,
    });
  } else if (level === 3) {
    score += 10;
  }

  // --- Disposition overhead --------------------------------------------
  if (disposition === 'icu') {
    score += 25;
    minutes += 90;
    signals.push({
      code: 'ICU_DISPOSITION',
      severity: 'high',
      description: 'Predicted ICU disposition; expect substantial boarding while an ICU bed is readied.',
    });
  } else if (disposition === 'admission') {
    score += 15;
    minutes += 45;
    signals.push({
      code: 'INPATIENT_DISPOSITION',
      severity: 'medium',
      description: 'Predicted inpatient admission; boarding time depends on inpatient bed turnover.',
    });
  } else if (disposition === 'surgery') {
    score += 10;
    minutes += 30;
    signals.push({
      code: 'SURGICAL_DISPOSITION',
      severity: 'medium',
      description: 'Predicted surgical admission; boarding depends on OR + surgical ward availability.',
    });
  }

  // --- Occupancy -------------------------------------------------------
  if (occ === null || !Number.isFinite(occ)) {
    signals.push({
      code: 'OCCUPANCY_UNKNOWN',
      severity: 'low',
      description: 'ED occupancy is unknown; boarding estimate has wider uncertainty.',
    });
  } else if (occ >= 0.95) {
    score += 30;
    minutes += 60;
    signals.push({
      code: 'ED_CRITICAL_OCCUPANCY',
      severity: 'high',
      description: `ED occupancy is ${Math.round(occ * 100)}% — at or above critical threshold.`,
    });
  } else if (occ >= 0.85) {
    score += 20;
    minutes += 30;
    signals.push({
      code: 'ED_HIGH_OCCUPANCY',
      severity: 'medium',
      description: `ED occupancy is ${Math.round(occ * 100)}% — above the high-occupancy threshold.`,
    });
  } else if (occ >= 0.7) {
    score += 10;
    signals.push({
      code: 'ED_MODERATE_OCCUPANCY',
      severity: 'low',
      description: `ED occupancy is ${Math.round(occ * 100)}%.`,
    });
  }

  // --- Staff load ------------------------------------------------------
  if (load === 'high') {
    score += 15;
    minutes += 20;
    signals.push({
      code: 'STAFF_LOAD_HIGH',
      severity: 'medium',
      description: 'Reported ED staff load is high; expect slower turnaround.',
    });
  } else if (load === 'low') {
    score -= 5;
  }

  // --- Arrival mode ----------------------------------------------------
  if (mode === 'ambulance') {
    score += 5;
    signals.push({
      code: 'AMBULANCE_ARRIVAL',
      severity: 'low',
      description: 'Ambulance arrival — prioritize early triage and handoff.',
    });
  } else if (mode === 'transfer') {
    score += 5;
    signals.push({
      code: 'TRANSFER_ARRIVAL',
      severity: 'low',
      description: 'Inter-facility transfer — confirm accepting service before arrival.',
    });
  }

  // Clamp.
  score = Math.max(0, Math.min(100, Math.round(score)));

  let band = 'low';
  if (score >= 70) band = 'critical';
  else if (score >= 45) band = 'high';
  else if (score >= 20) band = 'moderate';

  const recommended_actions = [];
  if (band === 'critical') {
    recommended_actions.push('Notify ED charge nurse and bed manager now; consider surge protocols and early boarding placement.');
  } else if (band === 'high') {
    recommended_actions.push('Flag to ED charge nurse; pre-notify inpatient unit of likely admission and boarding window.');
  } else if (band === 'moderate') {
    recommended_actions.push('Standard monitoring; reassess boarding risk if occupancy or acuity rises.');
  } else {
    recommended_actions.push('Routine disposition workflow; no additional boarding escalation required.');
  }
  if (disposition === 'icu') {
    recommended_actions.push('Notify ICU team of possible admission and confirm bed availability.');
  }
  if (disposition === 'surgery') {
    recommended_actions.push('Notify surgical on-call and confirm OR availability.');
  }
  if (mode === 'ambulance' && level <= 2) {
    recommended_actions.push('Clear a monitored bay for ambulance offload; minimize ramping.');
  }
  // Always include the privacy / operations disclaimer last.
  recommended_actions.push(PRIVACY_DISCLAIMER);

  return {
    boarding_risk_score: score,
    boarding_risk_band: band,
    predicted_boarding_minutes: Math.max(0, Math.round(minutes)),
    signals,
    recommended_actions,
  };
}

// ---------- DB loaders --------------------------------------------------

async function loadAdmission(admissionId) {
  if (!admissionId) return null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, patient_uid, chief_complaint, admission_type, status,
              ward, bed_id, admitted_at, priority
       FROM admissions
       WHERE id = $1
       LIMIT 1`,
      admissionId
    );
    return rows && rows[0] ? rows[0] : null;
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    logger.warn('ED triage: admission load failed', { error: err.message });
    return null;
  }
}

async function loadLatestVitals(patientUid) {
  if (!patientUid) return null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT heart_rate, systolic_bp, diastolic_bp, spo2, temperature,
              respiratory_rate, pain_score, recorded_at
       FROM vitals_chart
       WHERE patient_uid = $1::uuid
       ORDER BY recorded_at DESC
       LIMIT 1`,
      patientUid
    );
    return rows && rows[0] ? rows[0] : null;
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    logger.debug('ED triage: vitals load failed', { error: err.message });
    return null;
  }
}

async function loadPatientAge(patientUid) {
  if (!patientUid) return null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT CASE WHEN birthday IS NULL THEN NULL
                   ELSE EXTRACT(YEAR FROM AGE(NOW(), birthday::timestamp))::int
              END AS age_years
       FROM users
       WHERE uid = $1::uuid
       LIMIT 1`,
      patientUid
    );
    const row = rows && rows[0];
    return row && row.age_years !== null && row.age_years !== undefined
      ? toNumber(row.age_years, null)
      : null;
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    return null;
  }
}

async function loadEdOccupancy() {
  // Count currently-admitted emergency patients, normalized against a
  // reasonable bed capacity. If the schema is missing, return null so the
  // caller can flag `insufficient_data`.
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS active_count
       FROM admissions
       WHERE status = 'admitted'`
    );
    const active = toNumber(rows && rows[0] ? rows[0].active_count : 0, 0);
    const capacity = DEFAULT_ED_BED_CAPACITY;
    const fraction = active / capacity;
    return { active, capacity, fraction: Math.max(0, Math.min(2, fraction)) };
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    logger.debug('ED triage: occupancy load failed', { error: err.message });
    return null;
  }
}

async function getActivePrompt(tenantId) {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT version, system_prompt, user_prompt_template
       FROM clinical_ai_prompts
       WHERE tenant_id = $1::uuid
         AND module_key = $2
       ORDER BY active DESC, activated_at DESC NULLS LAST, created_at DESC
       LIMIT 1`,
      tenantId,
      MODULE_KEY
    );
    return (rows && rows[0]) || DEFAULT_PROMPT;
  } catch (err) {
    if (isMissingSchemaError(err)) return DEFAULT_PROMPT;
    throw err;
  }
}

async function insertGeneration({
  tenantId,
  admissionId = null,
  patientUid = null,
  sourceHashValue,
  draft,
  citations,
  safetyFlags,
  requestedBy,
  aiResult,
  prompt,
  metadata,
}) {
  const usage = aiResult?.usage || {};
  const hasCritical = safetyFlags.some((flag) => flag.severity === 'critical');
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_generations
         (tenant_id, patient_uid, admission_id, task_type, module_key, provider, model,
          prompt_version, source_hash, status, used_ai, safety_flags, citations, draft,
          generated_by, prompt_tokens, completion_tokens, total_tokens,
          estimated_cost_minor, metadata, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, $4, $5, $6,
               $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13::jsonb,
               $14::uuid, $15, $16, $17, $18, $19::jsonb, NOW(), NOW())
       RETURNING id, status, created_at`,
      tenantId,
      patientUid,
      admissionId,
      MODULE_KEY,
      aiResult?.provider || 'template',
      aiResult?.model || null,
      prompt?.version || 'v1',
      sourceHashValue,
      hasCritical ? 'failed' : 'draft',
      Boolean(aiResult?.usedAi),
      JSON.stringify(safetyFlags),
      JSON.stringify(citations),
      JSON.stringify(draft),
      requestedBy,
      usage.prompt_tokens || 0,
      usage.completion_tokens || 0,
      usage.total_tokens || 0,
      aiResult?.estimatedCostMinor ?? 0,
      JSON.stringify(metadata || {})
    );
    return (rows && rows[0]) || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('ED triage generation persist failed', { error: err.message });
    }
    return null;
  }
}

async function createReviewPlaceholder({ tenantId, generationId, admissionId, patientUid, module }) {
  if (!generationId) return null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_reviews
         (tenant_id, generation_id, module_key, patient_uid, admission_id, decision, metadata, created_at, updated_at)
       VALUES ($1::uuid, $2, $3, $4::uuid, $5, 'pending', $6::jsonb, NOW(), NOW())
       RETURNING id, decision`,
      tenantId,
      generationId,
      MODULE_KEY,
      patientUid,
      admissionId,
      JSON.stringify({
        review_roles: module?.settings?.reviewRoles || ['DOCTOR', 'NURSING_STAFF', 'ED_CHARGE_NURSE', 'ADMIN'],
        source: 'ed_triage_boarding_predictor',
        requires_signoff: Boolean(module?.settings?.requiresClinicianSignoff),
        rules_authoritative: true,
        decision_support_only: true,
      })
    );
    return (rows && rows[0]) || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('ED triage review placeholder failed', { error: err.message });
    }
    return null;
  }
}

function normalizePredictionRow(row) {
  if (!row) return row;
  return {
    ...row,
    age_years: row.age_years !== null && row.age_years !== undefined ? toNumber(row.age_years, null) : null,
    pain_score: row.pain_score !== null && row.pain_score !== undefined ? toNumber(row.pain_score, null) : null,
    triage_level: toNumber(row.triage_level, 3),
    boarding_risk_score: toNumber(row.boarding_risk_score, 0),
    predicted_boarding_minutes: row.predicted_boarding_minutes !== null && row.predicted_boarding_minutes !== undefined
      ? toNumber(row.predicted_boarding_minutes, null)
      : null,
  };
}

async function insertEdTriagePrediction({
  tenantId,
  admissionId,
  patientUid,
  chiefComplaint,
  arrivalMode,
  ageYears,
  vitals,
  painScore,
  triageLevel,
  boardingScore,
  boardingBand,
  predictedSpecialty,
  predictedDisposition,
  predictedBoardingMinutes,
  contributingSignals,
  recommendedActions,
  generationId,
  citations,
  safetyFlags,
  metadata,
}) {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_ed_triage_predictions
         (tenant_id, admission_id, patient_uid, chief_complaint, arrival_mode,
          age_years, vitals, pain_score, triage_level, boarding_risk_score,
          boarding_risk_band, predicted_specialty, predicted_disposition,
          predicted_boarding_minutes, contributing_signals, recommended_actions,
          generation_id, source_citations, safety_flags, reviewer_decision,
          metadata, created_at, updated_at)
       VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7::jsonb, $8, $9, $10,
               $11, $12, $13, $14, $15::jsonb, $16::jsonb, $17,
               $18::jsonb, $19::jsonb, 'pending', $20::jsonb, NOW(), NOW())
       RETURNING id, tenant_id, admission_id, patient_uid, chief_complaint,
                 arrival_mode, age_years, vitals, pain_score, triage_level,
                 boarding_risk_score, boarding_risk_band, predicted_specialty,
                 predicted_disposition, predicted_boarding_minutes,
                 contributing_signals, recommended_actions, generation_id,
                 source_citations, safety_flags, reviewer_decision, reviewed_by,
                 reviewed_at, reviewer_note, metadata, created_at, updated_at`,
      tenantId,
      admissionId,
      patientUid,
      chiefComplaint,
      arrivalMode,
      ageYears,
      JSON.stringify(vitals || {}),
      painScore,
      triageLevel,
      boardingScore,
      RISK_BANDS.has(boardingBand) ? boardingBand : 'unknown',
      predictedSpecialty,
      DISPOSITIONS.has(predictedDisposition) ? predictedDisposition : 'unknown',
      predictedBoardingMinutes,
      JSON.stringify(contributingSignals || []),
      JSON.stringify(recommendedActions || []),
      generationId,
      JSON.stringify(citations || []),
      JSON.stringify(safetyFlags || []),
      JSON.stringify(metadata || {})
    );
    return normalizePredictionRow((rows && rows[0]) || null);
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    throw err;
  }
}

// ---------- Public API -------------------------------------------------

export async function evaluateEdTriage({
  req = null,
  admissionId = null,
  patientUid = null,
  chiefComplaint = null,
  arrivalMode = 'unknown',
  ageYears = null,
  vitals = {},
  painScore = null,
  occupancyOverride = null,
  staffLoadOverride = null,
} = {}) {
  const tenantId = resolveTenantId({ tenantId: req?.tenantId });
  const module = await getClinicalAiModule(MODULE_KEY, { tenantId });
  if (!module.enabled) {
    throw AppError.forbidden(`Clinical AI module is disabled: ${module.display_name}`);
  }

  const safeAdmissionId = admissionId ? optionalInt(admissionId, 'admission_id') : null;
  const safePatientUid = patientUid ? cleanText(patientUid) : null;

  // 1) Load admission context (if any).
  const admission = await loadAdmission(safeAdmissionId);
  const resolvedPatientUid = safePatientUid || admission?.patient_uid || null;

  // 2) Auto-fill vitals + age if missing.
  const latestVitals = resolvedPatientUid ? await loadLatestVitals(resolvedPatientUid) : null;
  const mergedVitals = {
    heart_rate: toNullableNumber(vitals.heart_rate ?? latestVitals?.heart_rate),
    systolic_bp: toNullableNumber(vitals.systolic_bp ?? latestVitals?.systolic_bp),
    diastolic_bp: toNullableNumber(vitals.diastolic_bp ?? latestVitals?.diastolic_bp),
    spo2: toNullableNumber(vitals.spo2 ?? latestVitals?.spo2),
    temperature: toNullableNumber(vitals.temperature ?? latestVitals?.temperature),
    resp_rate: toNullableNumber(vitals.resp_rate ?? latestVitals?.respiratory_rate),
  };
  const mergedPainScore = painScore !== null && painScore !== undefined
    ? clampInt(painScore, 0, 10, null)
    : (latestVitals && latestVitals.pain_score !== null && latestVitals.pain_score !== undefined
      ? clampInt(latestVitals.pain_score, 0, 10, null)
      : null);

  const mergedChiefComplaint = cleanText(chiefComplaint) || cleanText(admission?.chief_complaint) || null;
  const mergedArrivalMode = normalizeArrivalMode(arrivalMode);
  const mergedAge = ageYears !== null && ageYears !== undefined
    ? toNullableNumber(ageYears)
    : (resolvedPatientUid ? await loadPatientAge(resolvedPatientUid) : null);

  const hasAnyVital = Object.values(mergedVitals).some((n) => n !== null);
  const insufficientInput = !mergedChiefComplaint && !hasAnyVital && mergedPainScore === null;

  // 3) Rules-authoritative compute ----------------------------------------
  const triageLevel = classifyTriageLevel({
    vitals: mergedVitals,
    painScore: mergedPainScore,
    chiefComplaint: mergedChiefComplaint,
    ageYears: mergedAge,
    arrivalMode: mergedArrivalMode,
  });
  const predictedSpecialty = predictSpecialty({
    chiefComplaint: mergedChiefComplaint,
    ageYears: mergedAge,
    vitals: mergedVitals,
    painScore: mergedPainScore,
  });
  const predictedDisposition = predictDisposition({
    triageLevel,
    vitals: mergedVitals,
    ageYears: mergedAge,
    predictedSpecialty,
  });

  // 4) Occupancy -----------------------------------------------------------
  let occupancyInfo = null;
  let occupancyFraction = null;
  if (occupancyOverride !== null && occupancyOverride !== undefined) {
    occupancyFraction = toNullableNumber(occupancyOverride);
  } else {
    occupancyInfo = await loadEdOccupancy();
    occupancyFraction = occupancyInfo ? occupancyInfo.fraction : null;
  }

  // 5) Staff load ----------------------------------------------------------
  const staffLoad = staffLoadOverride && ['high', 'normal', 'low'].includes(normalizedText(staffLoadOverride))
    ? normalizedText(staffLoadOverride)
    : 'normal';

  // 6) Boarding risk -------------------------------------------------------
  let boarding = computeBoardingRisk({
    triageLevel,
    occupancy: occupancyFraction,
    staffLoad,
    predictedDisposition,
    arrivalMode: mergedArrivalMode,
  });

  // If we truly have nothing to work with, mark insufficient_data.
  if (insufficientInput) {
    boarding = {
      ...boarding,
      boarding_risk_band: 'insufficient_data',
      boarding_risk_score: 0,
      signals: [
        ...boarding.signals,
        {
          code: 'INSUFFICIENT_INPUT',
          severity: 'medium',
          description: 'No chief complaint, vitals, or pain score supplied; cannot produce a confident triage forecast.',
        },
      ],
      recommended_actions: [
        'Capture chief complaint, initial vitals, and pain score before repeating the ED triage forecast.',
        PRIVACY_DISCLAIMER,
      ],
    };
  }

  // 7) Citations + safety flags -------------------------------------------
  const citations = [];
  if (safeAdmissionId && admission) {
    citations.push({
      source_type: 'admission',
      source_id: String(safeAdmissionId),
      label: `Admission #${safeAdmissionId}${admission.admission_type ? ` (${admission.admission_type})` : ''}`,
      timestamp: admission.admitted_at || null,
    });
  }
  if (resolvedPatientUid) {
    citations.push({
      source_type: 'patient',
      source_id: String(resolvedPatientUid),
      label: 'Patient record',
      timestamp: null,
    });
  }
  if (latestVitals) {
    citations.push({
      source_type: 'vitals_chart',
      source_id: String(resolvedPatientUid || ''),
      label: 'Latest vitals (vitals_chart)',
      timestamp: latestVitals.recorded_at || null,
    });
  }
  if (occupancyInfo) {
    citations.push({
      source_type: 'ed_occupancy',
      source_id: 'admissions_active_count',
      label: `ED occupancy (${occupancyInfo.active} active / ${occupancyInfo.capacity} baseline capacity)`,
      timestamp: null,
    });
  }
  const uniqueCits = uniqueCitations(citations);

  const safetyFlags = [];
  if (triageLevel === 1) {
    safetyFlags.push({
      severity: 'critical',
      code: 'ED_TRIAGE_LEVEL_1',
      message: 'Resuscitation-level triage (ESI 1); immediate clinician + monitored bed required.',
    });
  } else if (triageLevel === 2) {
    safetyFlags.push({
      severity: 'high',
      code: 'ED_TRIAGE_LEVEL_2',
      message: 'Emergent triage (ESI 2); early clinician assessment required.',
    });
  }
  if (boarding.boarding_risk_band === 'critical') {
    safetyFlags.push({
      severity: 'high',
      code: 'ED_BOARDING_CRITICAL',
      message: 'Critical boarding risk; notify ED charge nurse / bed manager and consider surge protocols.',
    });
  }
  if (boarding.boarding_risk_band === 'insufficient_data') {
    safetyFlags.push({
      severity: 'medium',
      code: 'ED_TRIAGE_INSUFFICIENT_DATA',
      message: 'Insufficient input to produce a confident boarding forecast; capture chief complaint + vitals and retry.',
    });
  }
  safetyFlags.push({
    severity: 'low',
    code: 'ED_TRIAGE_DECISION_SUPPORT_ONLY',
    message: 'Decision-support only — never used to assign beds, dispatch teams, or create admission orders without charge-nurse review.',
  });

  // 8) Compose draft + run optional AI narrative --------------------------
  const fallbackDraft = {
    module_key: MODULE_KEY,
    admission_id: safeAdmissionId,
    patient_uid: resolvedPatientUid,
    chief_complaint: mergedChiefComplaint,
    arrival_mode: mergedArrivalMode,
    age_years: mergedAge,
    vitals: mergedVitals,
    pain_score: mergedPainScore,
    triage_level: triageLevel,
    predicted_specialty: predictedSpecialty,
    predicted_disposition: predictedDisposition,
    predicted_boarding_minutes: boarding.predicted_boarding_minutes,
    boarding_risk_score: boarding.boarding_risk_score,
    boarding_risk_band: boarding.boarding_risk_band,
    contributing_signals: boarding.signals,
    recommended_actions: boarding.recommended_actions,
    source_citations: uniqueCits,
    safety_flags: safetyFlags,
    summary: insufficientInput
      ? 'Insufficient input — capture chief complaint and vitals to produce a confident ED triage forecast.'
      : `ESI ${triageLevel} arrival — predicted ${predictedDisposition} to ${predictedSpecialty}; boarding ${boarding.boarding_risk_band}.`,
    rules_authoritative: true,
    decision_support_only: true,
  };

  let draft = fallbackDraft;
  let aiResult = null;
  const prompt = await getActivePrompt(tenantId);
  try {
    aiResult = await generateClinicalText({
      taskType: MODULE_KEY,
      systemPrompt: prompt.system_prompt,
      userPrompt: `${prompt.user_prompt_template}\n\n${JSON.stringify({
        ed_arrival: {
          admission_id: safeAdmissionId,
          chief_complaint: mergedChiefComplaint,
          arrival_mode: mergedArrivalMode,
          age_years: mergedAge,
          vitals: mergedVitals,
          pain_score: mergedPainScore,
        },
        rule_based_evaluation: {
          triage_level: triageLevel,
          predicted_specialty: predictedSpecialty,
          predicted_disposition: predictedDisposition,
          boarding_risk_score: boarding.boarding_risk_score,
          boarding_risk_band: boarding.boarding_risk_band,
          predicted_boarding_minutes: boarding.predicted_boarding_minutes,
          signals: boarding.signals,
        },
        operations: {
          occupancy_fraction: occupancyFraction,
          staff_load: staffLoad,
        },
      })}`,
      tenantRegion: req?.tenant?.region || null,
      tenantId,
    });
    const parsed = safeJsonParse(aiResult?.text, {});
    if (parsed && typeof parsed === 'object') {
      draft = {
        ...fallbackDraft,
        summary: cleanText(parsed.summary) || fallbackDraft.summary,
        source_citations: uniqueCitations([
          ...asArray(fallbackDraft.source_citations),
          ...asArray(parsed.source_citations),
        ]),
        // Never let the AI override the rule-based numeric / categorical fields.
      };
    }
  } catch (err) {
    logger.debug('ED triage AI narrative unavailable; using template fallback', {
      error: err?.message,
    });
  }

  draft.source_citations = uniqueCitations(asArray(draft.source_citations));
  draft.safety_flags = safetyFlags;

  // 9) Persist ------------------------------------------------------------
  const generation = await insertGeneration({
    tenantId,
    admissionId: safeAdmissionId,
    patientUid: resolvedPatientUid,
    sourceHashValue: sourceHash({
      tenant_id: tenantId,
      admission_id: safeAdmissionId,
      patient_uid: resolvedPatientUid,
      chief_complaint: mergedChiefComplaint,
      arrival_mode: mergedArrivalMode,
      vitals: mergedVitals,
      pain_score: mergedPainScore,
      triage_level: triageLevel,
    }),
    draft,
    citations: draft.source_citations,
    safetyFlags,
    requestedBy: req?.user?.uid || null,
    aiResult,
    prompt,
    metadata: {
      admission_id: safeAdmissionId,
      triage_level: triageLevel,
      boarding_band: boarding.boarding_risk_band,
      predicted_specialty: predictedSpecialty,
      predicted_disposition: predictedDisposition,
      rules_authoritative: true,
      decision_support_only: true,
    },
  });

  const predictionRow = await insertEdTriagePrediction({
    tenantId,
    admissionId: safeAdmissionId,
    patientUid: resolvedPatientUid,
    chiefComplaint: mergedChiefComplaint,
    arrivalMode: mergedArrivalMode,
    ageYears: mergedAge,
    vitals: mergedVitals,
    painScore: mergedPainScore,
    triageLevel,
    boardingScore: boarding.boarding_risk_score,
    boardingBand: boarding.boarding_risk_band,
    predictedSpecialty,
    predictedDisposition,
    predictedBoardingMinutes: boarding.predicted_boarding_minutes,
    contributingSignals: boarding.signals,
    recommendedActions: boarding.recommended_actions,
    generationId: generation?.id || null,
    citations: draft.source_citations,
    safetyFlags,
    metadata: {
      used_ai: Boolean(aiResult?.usedAi),
      provider: aiResult?.provider || 'template',
      occupancy_fraction: occupancyFraction,
      staff_load: staffLoad,
      rules_authoritative: true,
      decision_support_only: true,
    },
  });

  if (!predictionRow) {
    return {
      prediction_id: null,
      generation_id: generation?.id || null,
      draft,
      source_citations: draft.source_citations,
      safety_flags: safetyFlags,
      module_key: MODULE_KEY,
      prompt_version: prompt.version || 'v1',
      review_status: 'schema_unavailable',
      reason: 'clinical_ai_ed_triage_predictions_unavailable',
      requires_signoff: Boolean(module.settings?.requiresClinicianSignoff),
      rules_authoritative: true,
      decision_support_only: true,
    };
  }

  const clinicalReview = await createReviewPlaceholder({
    tenantId,
    generationId: generation?.id || null,
    admissionId: safeAdmissionId,
    patientUid: resolvedPatientUid,
    module,
  });

  try {
    await publishEvent({
      eventType: 'clinical_ai.ed_triage_predicted',
      aggregateType: 'clinical_ai_ed_triage_prediction',
      aggregateId: predictionRow.id,
      patientUid: resolvedPatientUid,
      payload: {
        tenant_id: tenantId,
        admission_id: safeAdmissionId,
        prediction_id: predictionRow.id,
        generation_id: generation?.id || null,
        triage_level: triageLevel,
        predicted_specialty: predictedSpecialty,
        predicted_disposition: predictedDisposition,
        boarding_risk_band: boarding.boarding_risk_band,
        boarding_risk_score: boarding.boarding_risk_score,
      },
    });
  } catch (err) {
    logger.warn('ED triage event publish failed', { error: err?.message });
  }

  return {
    prediction_id: predictionRow.id,
    generation_id: generation?.id || null,
    clinical_review_id: clinicalReview?.id || null,
    draft,
    prediction: predictionRow,
    source_citations: draft.source_citations,
    safety_flags: safetyFlags,
    triage_level: triageLevel,
    predicted_specialty: predictedSpecialty,
    predicted_disposition: predictedDisposition,
    boarding_risk_band: boarding.boarding_risk_band,
    boarding_risk_score: boarding.boarding_risk_score,
    predicted_boarding_minutes: boarding.predicted_boarding_minutes,
    module_key: MODULE_KEY,
    prompt_version: prompt.version || 'v1',
    review_status: clinicalReview?.decision || predictionRow.reviewer_decision || 'pending',
    requires_signoff: Boolean(module.settings?.requiresClinicianSignoff),
    ai_metadata: {
      provider: aiResult?.provider || 'template',
      model: aiResult?.model || null,
      used_ai: Boolean(aiResult?.usedAi),
    },
    rules_authoritative: true,
    decision_support_only: true,
  };
}

export async function listEdTriagePredictions({
  tenantId = null,
  admissionId = null,
  patientUid = null,
  triageLevel = null,
  boardingBand = null,
  reviewerDecision = null,
  limit = 50,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const aid = admissionId ? optionalInt(admissionId, 'admission_id') : null;
  const normalizedUid = patientUid ? cleanText(patientUid) : null;
  const normalizedLevel = triageLevel !== null && triageLevel !== undefined
    ? clampInt(triageLevel, 1, 5, null)
    : null;
  const normalizedBand = boardingBand && RISK_BANDS.has(cleanText(boardingBand).toLowerCase())
    ? cleanText(boardingBand).toLowerCase()
    : null;
  const normalizedDecision = reviewerDecision && DECISIONS.has(cleanText(reviewerDecision).toLowerCase())
    ? cleanText(reviewerDecision).toLowerCase()
    : null;

  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT p.id, p.tenant_id, p.admission_id, p.patient_uid, p.chief_complaint,
              p.arrival_mode, p.age_years, p.vitals, p.pain_score, p.triage_level,
              p.boarding_risk_score, p.boarding_risk_band, p.predicted_specialty,
              p.predicted_disposition, p.predicted_boarding_minutes,
              p.contributing_signals, p.recommended_actions, p.generation_id,
              p.source_citations, p.safety_flags, p.reviewer_decision,
              p.reviewed_by, p.reviewed_at, p.reviewer_note, p.metadata,
              p.created_at, p.updated_at,
              u.name AS patient_name
       FROM clinical_ai_ed_triage_predictions p
       LEFT JOIN users u ON u.uid = p.patient_uid
       WHERE p.tenant_id = $1::uuid
         AND ($2::int IS NULL OR p.admission_id = $2)
         AND ($3::uuid IS NULL OR p.patient_uid = $3::uuid)
         AND ($4::int IS NULL OR p.triage_level = $4)
         AND ($5::text IS NULL OR p.boarding_risk_band = $5)
         AND ($6::text IS NULL OR p.reviewer_decision = $6)
       ORDER BY
         p.triage_level ASC,
         CASE p.boarding_risk_band
           WHEN 'critical' THEN 0
           WHEN 'high' THEN 1
           WHEN 'moderate' THEN 2
           WHEN 'low' THEN 3
           WHEN 'insufficient_data' THEN 4
           ELSE 5
         END,
         p.created_at DESC
       LIMIT $7`,
      tid,
      aid,
      normalizedUid,
      normalizedLevel,
      normalizedBand,
      normalizedDecision,
      safeLimit
    );
    const normalized = asArray(rows).map(normalizePredictionRow);
    return { predictions: normalized, count: normalized.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { predictions: [], count: 0 };
    throw err;
  }
}

export async function decideEdTriagePrediction({
  tenantId = null,
  predictionId,
  decision,
  reviewerUid = null,
  note = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const normalized = cleanText(decision).toLowerCase();
  if (!FINAL_DECISIONS.has(normalized)) {
    throw AppError.badRequest('decision must be accepted, deferred, rejected, or escalated');
  }
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE clinical_ai_ed_triage_predictions
     SET reviewer_decision = $2,
         reviewed_by = $3::uuid,
         reviewed_at = NOW(),
         reviewer_note = $4,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $5::uuid
     RETURNING id, tenant_id, admission_id, patient_uid, chief_complaint,
               arrival_mode, age_years, vitals, pain_score, triage_level,
               boarding_risk_score, boarding_risk_band, predicted_specialty,
               predicted_disposition, predicted_boarding_minutes,
               contributing_signals, recommended_actions, generation_id,
               source_citations, safety_flags, reviewer_decision,
               reviewed_by, reviewed_at, reviewer_note, metadata,
               created_at, updated_at`,
    optionalInt(predictionId, 'prediction_id'),
    normalized,
    reviewerUid,
    note,
    tid
  );
  if (!rows || !rows[0]) throw AppError.notFound('ED triage prediction not found');
  return normalizePredictionRow(rows[0]);
}

export default {
  classifyTriageLevel,
  computeBoardingRisk,
  decideEdTriagePrediction,
  evaluateEdTriage,
  listEdTriagePredictions,
  predictDisposition,
  predictSpecialty,
};
