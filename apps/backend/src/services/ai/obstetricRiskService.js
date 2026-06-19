/**
 * Pregnancy / Obstetric Risk Assistant.
 *
 * Decision-support assessment of pregnancy, intrapartum, and postpartum
 * risk from gestational age, obstetric history (gravida/parity),
 * pre-existing conditions, vitals, labs, and symptoms. Emits:
 *   - risk factors (age extremes, grand multipara, prior preeclampsia,
 *     chronic hypertension, pre-existing diabetes, multiple gestation,
 *     prior cesarean, nullipara older mother)
 *   - red-flag signals (severe preeclampsia, preeclampsia suspected,
 *     gestational hypertension, possible eclampsia, possible PPH,
 *     reduced fetal movement, fever in pregnancy, low/high fetal heart
 *     rate, abnormal proteinuria)
 *   - computed risk score + band (low/moderate/high/critical)
 *   - follow-up plan with the next ANC visit and escalation criteria
 *
 * Rules are authoritative. The service never starts/stops labour
 * interventions, orders magnesium sulphate, or changes any obstetric
 * order. Obstetrician / clinician signoff is required before action.
 */

import crypto from 'crypto';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { publishEvent } from '../events/eventOutboxService.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { getClinicalAiModule } from './clinicalAiModuleService.js';
import { runOutputDefenses } from './hallucinationDefenses.js';
import { generateClinicalText } from './localLlmClient.js';

const MODULE_KEY = 'obstetric_risk_assistant';

const DEFAULT_PROMPT = {
  version: 'v1',
  system_prompt:
    'You support obstetric risk review. Rules are authoritative. Use only supplied chart evidence. Return JSON only. Never start, stop, or modify any obstetric order, labour intervention, magnesium sulphate regimen, or delivery plan.',
  user_prompt_template:
    'Given the chart packet and rule-based obstetric risk evaluation, return keys: risk_score, risk_band, risk_factors, red_flag_signals, recommendations, follow_up_plan, summary, source_citations, safety_flags. Do not invent gestational age or obstetric history.',
};

const ASSESSMENT_STAGES = new Set([
  'pre_conception',
  'first_trimester',
  'second_trimester',
  'third_trimester',
  'intrapartum',
  'postpartum',
  'unknown',
]);
const RISK_BANDS = new Set(['low', 'moderate', 'high', 'critical', 'unknown']);
const DECISIONS = new Set(['pending', 'accepted', 'deferred', 'rejected', 'escalated']);
const FINAL_DECISIONS = new Set(['accepted', 'deferred', 'rejected', 'escalated']);

// Standard WHO/FIGO recommended ANC visits (in gestational weeks).
const ANC_SCHEDULE_WEEKS = [12, 20, 26, 30, 34, 36, 38];

// Obstetric keywords used when scanning admissions / chart text for
// pregnancy context (chief_complaint, admitting_diagnosis, notes).
export const OBSTETRIC_KEYWORDS = [
  'pregnancy',
  'pregnant',
  'anc',
  'antenatal',
  'labour',
  'labor',
  'delivery',
  'intrapartum',
  'postpartum',
  'post-partum',
  'pih',
  'preeclampsia',
  'pre-eclampsia',
  'eclampsia',
  'gravida',
  'obstetric',
];

// ---------- small helpers ------------------------------------------------

function resolveTenantId(options = {}) {
  return requireTenantId(options.tenantId);
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

function stringListMatches(list, needles) {
  const items = asArray(list).map((item) => normalizedText(item));
  const terms = asArray(needles).map((term) => normalizedText(term));
  return items.some((text) => terms.some((needle) => needle && text.includes(needle)));
}

function symptomMatches(symptoms, needles) {
  return stringListMatches(symptoms, needles);
}

// ---------- pure helpers (exported) --------------------------------------

/**
 * Classify an assessment stage from gestational age (weeks).
 *
 * Buckets by weeks:
 *   null/undefined/0 -> pre_conception
 *   < 14             -> first_trimester
 *   14 to < 28       -> second_trimester
 *   >= 28            -> third_trimester (up to ~42)
 *
 * "intrapartum" and "postpartum" can only be set explicitly by the caller
 * (via stageOverride) — they are not inferred from gestational age alone.
 */
export function classifyAssessmentStage(gestationalAgeWeeks) {
  if (gestationalAgeWeeks === null || gestationalAgeWeeks === undefined) {
    return 'pre_conception';
  }
  const n = toNullableNumber(gestationalAgeWeeks);
  if (n === null) return 'unknown';
  if (n <= 0) return 'pre_conception';
  if (n < 14) return 'first_trimester';
  if (n < 28) return 'second_trimester';
  return 'third_trimester';
}

/**
 * Detect obstetric risk factors from demographics + history.
 *
 * Returns an array of { code, severity, description } objects. All string
 * matching against priorConditions / currentConditions is case-insensitive
 * substring matching.
 */
export function detectRiskFactors({
  ageYears = null,
  gravida: _gravida = null,
  parity = null,
  priorConditions = [],
  currentConditions = [],
  gestationalAgeWeeks = null,
  multipleGestation = false,
} = {}) {
  const factors = [];
  const age = toNullableNumber(ageYears);
  const par = toNullableNumber(parity);
  const priors = asArray(priorConditions);
  const current = asArray(currentConditions);
  const all = [...priors, ...current];

  if (age !== null && (age < 18 || age > 35)) {
    factors.push({
      code: 'AGE_EXTREME',
      severity: 'medium',
      description: age < 18
        ? `Maternal age ${age} is below 18; adolescent pregnancy carries increased obstetric risk.`
        : `Maternal age ${age} is above 35; advanced maternal age carries increased obstetric risk.`,
    });
  }

  if (par !== null && par >= 5) {
    factors.push({
      code: 'GRAND_MULTIPARA',
      severity: 'medium',
      description: `Grand multipara (parity ${par}); increased risk of malpresentation, PPH, and uterine rupture.`,
    });
  }

  if (par !== null && par === 0 && age !== null && age > 30) {
    factors.push({
      code: 'NULLIPARA',
      severity: 'low',
      description: `Nulliparous patient over 30 (age ${age}); slightly increased risk of labour complications.`,
    });
  }

  if (stringListMatches(priors, ['preeclampsia', 'pre-eclampsia', 'eclampsia'])) {
    factors.push({
      code: 'PRIOR_PREECLAMPSIA',
      severity: 'high',
      description: 'History of preeclampsia or eclampsia; markedly increased risk of recurrence.',
    });
  }

  if (stringListMatches(all, ['hypertension', 'htn', 'chronic hypertension'])) {
    factors.push({
      code: 'CHRONIC_HYPERTENSION',
      severity: 'high',
      description: 'Chronic hypertension; increased risk of superimposed preeclampsia and IUGR.',
    });
  }

  if (stringListMatches(all, ['diabetes', 'type 1 diabetes', 'type 2 diabetes', 'dm', 'diabetic'])
      && !stringListMatches(all, ['gestational diabetes only'])) {
    factors.push({
      code: 'PRE_EXISTING_DIABETES',
      severity: 'high',
      description: 'Pre-existing diabetes; increased risk of congenital anomalies, macrosomia, and preeclampsia.',
    });
  }

  if (multipleGestation === true
      || stringListMatches(all, ['multiple gestation', 'twin', 'triplet', 'multiple pregnancy'])) {
    factors.push({
      code: 'MULTIPLE_GESTATION',
      severity: 'high',
      description: 'Multiple gestation; increased risk of preterm labour, preeclampsia, and fetal growth issues.',
    });
  }

  if (stringListMatches(priors, ['cesarean', 'c-section', 'csection', 'lscs', 'caesarean'])) {
    factors.push({
      code: 'PRIOR_CESAREAN',
      severity: 'medium',
      description: 'Prior cesarean delivery; increased risk of uterine rupture and abnormal placentation.',
    });
  }

  if (stringListMatches(all, ['placenta previa', 'placenta accreta', 'placenta increta', 'placenta percreta'])) {
    factors.push({
      code: 'ABNORMAL_PLACENTATION',
      severity: 'high',
      description: 'Abnormal placentation documented; risk of antepartum hemorrhage and surgical complications.',
    });
  }

  // Gestational age currently unused in factor detection directly but kept
  // available in the signature for future refinement (e.g. preterm flag).
  const gaWeeks = toNullableNumber(gestationalAgeWeeks);
  if (gaWeeks !== null && gaWeeks > 0 && gaWeeks < 37
      && stringListMatches(all, ['preterm labour', 'preterm labor', 'threatened preterm'])) {
    factors.push({
      code: 'THREATENED_PRETERM_LABOUR',
      severity: 'high',
      description: `Threatened preterm labour at ${gaWeeks} weeks; risk of prematurity-related complications.`,
    });
  }

  return factors;
}

/**
 * Detect red-flag signals from vitals, labs, and symptoms.
 *
 * Each signal returns { code, severity, description, recommendation }. The
 * recommendation is decision-support text only — clinicians decide action.
 */
export function detectRedFlagSignals({
  vitals = {},
  labs = {},
  symptoms = [],
  gestationalAgeWeeks = null,
} = {}) {
  const signals = [];
  const sbp = toNullableNumber(vitals?.systolic_bp);
  const dbp = toNullableNumber(vitals?.diastolic_bp);
  const temp = toNullableNumber(vitals?.temperature);
  const fetalHr = toNullableNumber(vitals?.fetal_hr);
  const symptomList = asArray(symptoms);
  const gaWeeks = toNullableNumber(gestationalAgeWeeks);

  const hasSbpHigh = sbp !== null && sbp >= 140;
  const hasDbpHigh = dbp !== null && dbp >= 90;
  const hasSbpSevere = sbp !== null && sbp >= 160;
  const hasDbpSevere = dbp !== null && dbp >= 110;
  const hasProteinuria = symptomMatches(symptomList, ['proteinuria'])
    || Boolean(labs?.urine_protein);

  // Severe hypertension first (trumps non-severe signal).
  if (hasSbpSevere || hasDbpSevere) {
    signals.push({
      code: 'SEVERE_PREECLAMPSIA',
      severity: 'critical',
      description: `Severe hypertension (SBP ${sbp ?? 'n/a'} / DBP ${dbp ?? 'n/a'}) meets severe preeclampsia threshold.`,
      recommendation: 'Escalate immediately to obstetrician for severe preeclampsia evaluation; arrange magnesium sulphate decision per local protocol.',
    });
  } else if (hasSbpHigh || hasDbpHigh) {
    if (hasProteinuria && (gaWeeks === null || gaWeeks >= 20)) {
      signals.push({
        code: 'PREECLAMPSIA_SUSPECTED',
        severity: 'high',
        description: `Elevated blood pressure (SBP ${sbp ?? 'n/a'} / DBP ${dbp ?? 'n/a'}) with proteinuria after 20 weeks gestation.`,
        recommendation: 'Escalate to obstetrician for preeclampsia workup (urine protein quantification, labs, fetal assessment).',
      });
    } else {
      signals.push({
        code: 'GESTATIONAL_HYPERTENSION',
        severity: 'high',
        description: `Elevated blood pressure (SBP ${sbp ?? 'n/a'} / DBP ${dbp ?? 'n/a'}) without documented proteinuria.`,
        recommendation: 'Recheck BP, obtain urine protein, and arrange obstetric review to rule out preeclampsia.',
      });
    }
  }

  if (symptomMatches(symptomList, ['seizure', 'seizures', 'convulsion', 'convulsions'])) {
    signals.push({
      code: 'POSSIBLE_ECLAMPSIA',
      severity: 'critical',
      description: 'Seizure / convulsion activity reported during pregnancy or postpartum.',
      recommendation: 'Escalate immediately as possible eclampsia; obstetrician review, airway protection, and magnesium sulphate decision per protocol.',
    });
  }

  if (symptomMatches(symptomList, ['heavy bleeding', 'hemorrhage', 'haemorrhage', 'soaked pad', 'pph', 'post-partum haemorrhage', 'postpartum hemorrhage'])) {
    signals.push({
      code: 'POSSIBLE_PPH',
      severity: 'critical',
      description: 'Heavy vaginal bleeding / possible postpartum hemorrhage reported.',
      recommendation: 'Escalate immediately for PPH assessment; IV access, uterotonic decision, and blood bank notification per local protocol.',
    });
  }

  if (symptomMatches(symptomList, ['reduced fetal movement', 'decreased fetal movement', 'no fetal movement', 'absent fetal movement'])) {
    signals.push({
      code: 'REDUCED_FETAL_MOVEMENT',
      severity: 'high',
      description: 'Patient reports reduced or absent fetal movement.',
      recommendation: 'Arrange urgent obstetric review with fetal heart rate assessment and/or non-stress test.',
    });
  }

  if (temp !== null && temp >= 38) {
    signals.push({
      code: 'FEVER_IN_PREGNANCY',
      severity: 'high',
      description: `Fever in pregnancy (temperature ${temp} C).`,
      recommendation: 'Evaluate infection source (UTI, chorioamnionitis, other); arrange cultures and obstetric review.',
    });
  }

  if (fetalHr !== null && fetalHr > 0 && fetalHr < 110) {
    signals.push({
      code: 'LOW_FETAL_HEART_RATE',
      severity: 'critical',
      description: `Fetal heart rate ${fetalHr} bpm is below 110; possible fetal bradycardia / distress.`,
      recommendation: 'Escalate immediately for fetal assessment; consider left lateral position, oxygen, and CTG monitoring per local protocol.',
    });
  } else if (fetalHr !== null && fetalHr > 160) {
    signals.push({
      code: 'HIGH_FETAL_HEART_RATE',
      severity: 'high',
      description: `Fetal heart rate ${fetalHr} bpm is above 160; possible fetal tachycardia.`,
      recommendation: 'Evaluate maternal fever/dehydration; arrange CTG and obstetric review.',
    });
  }

  if (labs && labs.urine_protein !== undefined && labs.urine_protein !== null
      && cleanText(labs.urine_protein) !== '' && cleanText(labs.urine_protein) !== 'negative') {
    signals.push({
      code: 'ABNORMAL_LAB_PROTEINURIA',
      severity: 'medium',
      description: `Urine protein positive (${labs.urine_protein}) on investigation.`,
      recommendation: 'Correlate with blood pressure and symptoms; quantify proteinuria and arrange obstetric review.',
    });
  }

  return signals;
}

/**
 * Compute a 0-100 obstetric risk score from risk factors + red-flag signals.
 *
 * Weights:
 *   severity 'critical' -> 40
 *   severity 'high'     -> 25
 *   severity 'medium'   -> 12
 *   severity 'low'      -> 5
 *
 * Risk band:
 *   score >= 70 -> critical
 *   score >= 45 -> high
 *   score >= 20 -> moderate
 *   else        -> low
 *
 * If both arrays are empty, returns { risk_score: 0, risk_band: 'low' } —
 * a safe default, not 'unknown'.
 */
export function computeObstetricRiskScore({ riskFactors = [], redFlagSignals = [] } = {}) {
  const weight = (severity) => {
    if (severity === 'critical') return 40;
    if (severity === 'high') return 25;
    if (severity === 'medium') return 12;
    return 5;
  };
  const all = [...asArray(riskFactors), ...asArray(redFlagSignals)];
  if (!all.length) {
    return { risk_score: 0, risk_band: 'low' };
  }
  const raw = all.reduce((sum, item) => sum + weight(item?.severity), 0);
  const score = Math.max(0, Math.min(100, raw));
  let band;
  if (score >= 70) band = 'critical';
  else if (score >= 45) band = 'high';
  else if (score >= 20) band = 'moderate';
  else band = 'low';
  return { risk_score: score, risk_band: band };
}

/**
 * Build the ANC / follow-up plan.
 *
 * Returns { next_anc_weeks, required_investigations, escalation_criteria }.
 * Baseline ANC schedule (WHO/FIGO): 12, 20, 26, 30, 34, 36, 38 weeks. If
 * current gestational stage / risk is high/critical, the plan suggests an
 * earlier review (every 1-2 weeks).
 */
export function buildFollowUpPlan({
  assessmentStage = 'unknown',
  riskBand = 'low',
  redFlagSignals = [],
  gestationalAgeWeeks = null,
  riskFactors = [],
} = {}) {
  const gaWeeks = toNullableNumber(gestationalAgeWeeks);
  const signals = asArray(redFlagSignals);
  const factors = asArray(riskFactors);

  // Required investigations baseline.
  const required = [
    'Hemoglobin / complete blood count',
    'Urine routine and urine protein',
    'Blood pressure monitoring at every visit',
  ];
  if (factors.some((f) => f?.code === 'PRE_EXISTING_DIABETES')
      || factors.some((f) => f?.code === 'CHRONIC_HYPERTENSION')) {
    required.push('OGTT at 24-28 weeks (and earlier if risk factors present)');
  } else {
    required.push('OGTT at 24-28 weeks');
  }
  if (assessmentStage === 'third_trimester' || (gaWeeks !== null && gaWeeks >= 28)) {
    required.push('Fetal growth ultrasound as clinically indicated');
  }

  // Escalation criteria — signs that warrant immediate hospital review.
  const escalation = [
    'Systolic BP >= 160 mmHg or diastolic BP >= 110 mmHg',
    'Seizure, convulsion, or severe persistent headache',
    'Heavy vaginal bleeding or soaked pad(s)',
    'Reduced or absent fetal movement',
    'Persistent severe abdominal or epigastric pain',
    'Fever >= 38 C or signs of sepsis',
  ];

  // Next ANC visit calculation.
  let nextAnc = null;
  if (riskBand === 'critical') {
    nextAnc = 'within_48_hours';
  } else if (riskBand === 'high' || signals.some((s) => s?.severity === 'critical')) {
    // 1-2 week interval for high-risk patients.
    nextAnc = gaWeeks !== null ? Math.min(42, gaWeeks + 1) : 'every_1_to_2_weeks';
  } else if (gaWeeks !== null) {
    const next = ANC_SCHEDULE_WEEKS.find((wk) => wk > gaWeeks);
    nextAnc = next !== undefined ? next : gaWeeks >= 38 ? 40 : 40;
  } else {
    nextAnc = ANC_SCHEDULE_WEEKS[0];
  }

  return {
    next_anc_weeks: nextAnc,
    required_investigations: required,
    escalation_criteria: escalation,
  };
}

// ---------- data loaders (best-effort) -----------------------------------

async function loadPatientBirthday(patientUid) {
  if (!patientUid) return null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT u.uid, u.name, u.birthday,
              CASE WHEN u.birthday IS NULL THEN NULL
                   ELSE EXTRACT(YEAR FROM AGE(CURRENT_DATE, u.birthday))::int
              END AS age_years
       FROM users u
       WHERE u.uid = $1::uuid
       LIMIT 1`,
      patientUid
    );
    const row = rows[0];
    if (!row) return null;
    return {
      uid: row.uid,
      name: row.name || null,
      birthday: row.birthday || null,
      age_years: row.age_years !== null && row.age_years !== undefined ? toNumber(row.age_years, null) : null,
    };
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    logger.warn('Obstetric risk: patient birthday load failed', { error: err.message });
    return null;
  }
}

async function loadLatestVitalsForPatient(patientUid) {
  if (!patientUid) return null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, patient_uid, heart_rate, systolic_bp, diastolic_bp, temperature,
              spo2, respiratory_rate, blood_glucose, recorded_at
       FROM vitals_chart
       WHERE patient_uid = $1::uuid
       ORDER BY recorded_at DESC NULLS LAST
       LIMIT 1`,
      patientUid
    );
    return rows[0] || null;
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    logger.warn('Obstetric risk: latest vitals load failed', { error: err.message });
    return null;
  }
}

async function loadAdmissionMeta(admissionId) {
  if (!admissionId) return null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, patient_uid, ward, status, chief_complaint, admitting_diagnosis,
              admitted_at, discharged_at, created_at
       FROM admissions
       WHERE id = $1
       LIMIT 1`,
      admissionId
    );
    return rows[0] || null;
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    logger.warn('Obstetric risk: admission load failed', { error: err.message });
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
    return rows[0] || DEFAULT_PROMPT;
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
  const hasCritical = asArray(safetyFlags).some((flag) => flag?.severity === 'critical');
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_generations
         (tenant_id, patient_uid, admission_id, task_type, module_key, provider, model,
          prompt_version, source_hash, status, used_ai, safety_flags, citations, draft,
          generated_by, prompt_tokens, completion_tokens, total_tokens,
          estimated_cost_minor, latency_ms, provider_request_id, finish_reason,
          metadata, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, $4, $5, $6, $7, $8, $9, $10,
               $11::jsonb, $12::jsonb, $13::jsonb, $14::uuid, $15, $16, $17,
               $18, $19, $20, $21, $22::jsonb, NOW(), NOW())
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
      aiResult?.estimatedCostMinor ?? usage.estimated_cost_minor ?? 0,
      usage.latency_ms || aiResult?.latencyMs || null,
      usage.provider_request_id || aiResult?.requestId || null,
      usage.finish_reason || aiResult?.finishReason || null,
      JSON.stringify({
        ...(metadata || {}),
        tier: aiResult?.tier || 'quick',
        model_tier: aiResult?.tier || 'quick',
        fallback_reason: aiResult?.usedAi ? null : aiResult?.reason || 'template_or_rule_output',
        generation_mode: aiResult?.generation_mode || (aiResult?.usedAi ? 'ai' : 'template_fallback'),
        readiness_reason: aiResult?.readiness_reason || null,
        provider_status: aiResult?.provider_status || (aiResult?.usedAi ? 'used' : 'template_fallback'),
      })
    );
    return rows[0] || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Obstetric risk: generation persist failed', { error: err.message });
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
        review_roles: module?.settings?.reviewRoles || ['DOCTOR', 'NURSING_STAFF', 'OBSTETRICIAN', 'ADMIN'],
        source: 'obstetric_risk_assistant',
        requires_signoff: Boolean(module?.settings?.requiresClinicianSignoff),
        rules_authoritative: true,
        decision_support_only: true,
      })
    );
    return rows[0] || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Obstetric risk: review placeholder failed', { error: err.message });
    }
    return null;
  }
}

function buildSafetyFlags({ riskBand, redFlagSignals, citations }) {
  const flags = [];
  if (riskBand === 'critical') {
    flags.push({
      severity: 'critical',
      code: 'OBSTETRIC_CRITICAL_RISK',
      message: 'Obstetric risk band is critical — immediate obstetrician review required.',
    });
  }
  if (asArray(redFlagSignals).some((s) => s?.code === 'SEVERE_PREECLAMPSIA')) {
    flags.push({
      severity: 'critical',
      code: 'SEVERE_PREECLAMPSIA_SIGNAL',
      message: 'Severe preeclampsia signal detected (SBP >= 160 or DBP >= 110).',
    });
  }
  if (asArray(redFlagSignals).some((s) => s?.code === 'POSSIBLE_ECLAMPSIA')) {
    flags.push({
      severity: 'critical',
      code: 'ECLAMPSIA_SIGNAL',
      message: 'Possible eclampsia — seizure / convulsion activity reported.',
    });
  }
  if (asArray(redFlagSignals).some((s) => s?.code === 'POSSIBLE_PPH')) {
    flags.push({
      severity: 'critical',
      code: 'PPH_SIGNAL',
      message: 'Possible postpartum hemorrhage — escalate immediately.',
    });
  }
  if (asArray(redFlagSignals).some((s) => s?.code === 'LOW_FETAL_HEART_RATE')) {
    flags.push({
      severity: 'critical',
      code: 'FETAL_BRADYCARDIA_SIGNAL',
      message: 'Fetal bradycardia detected (fetal heart rate < 110).',
    });
  }
  if (!citations || !citations.length) {
    flags.push({
      severity: 'medium',
      code: 'OBSTETRIC_NO_CITATIONS',
      message: 'Obstetric risk evaluation has no source citations.',
    });
  }
  return flags;
}

function buildRecommendations({ riskBand, redFlagSignals, riskFactors }) {
  const recs = [];
  for (const signal of asArray(redFlagSignals)) {
    if (!signal) continue;
    recs.push({
      code: signal.code,
      severity: signal.severity,
      recommendation: signal.recommendation,
    });
  }
  if (riskBand === 'critical') {
    recs.push({
      code: 'IMMEDIATE_OBSTETRIC_REVIEW',
      severity: 'critical',
      recommendation: 'Escalate to obstetrician immediately; do not wait for routine ANC interval.',
    });
  } else if (riskBand === 'high') {
    recs.push({
      code: 'URGENT_OBSTETRIC_REVIEW',
      severity: 'high',
      recommendation: 'Arrange obstetrician review within 24-48 hours; increase ANC frequency.',
    });
  }
  if (asArray(riskFactors).some((f) => f?.code === 'PRIOR_PREECLAMPSIA' || f?.code === 'CHRONIC_HYPERTENSION')) {
    recs.push({
      code: 'PREECLAMPSIA_PREVENTION',
      severity: 'medium',
      recommendation: 'Discuss low-dose aspirin prophylaxis per local protocol (usually from 12-16 weeks until 36 weeks).',
    });
  }
  if (!recs.length) {
    recs.push({
      code: 'ROUTINE_ANC',
      severity: 'low',
      recommendation: 'Continue routine ANC; no immediate obstetric escalation indicated.',
    });
  }
  return recs;
}

function buildNarrativePrompt({ prompt, draft, patient, admission }) {
  return `${prompt.user_prompt_template}\n\n${JSON.stringify({
    rules_authoritative: true,
    decision_support_only: true,
    patient: {
      uid: patient?.uid || null,
      age_years: patient?.age_years ?? null,
    },
    admission: admission ? {
      id: admission.id,
      chief_complaint: admission.chief_complaint,
      admitting_diagnosis: admission.admitting_diagnosis,
      status: admission.status,
    } : null,
    rule_based_evaluation: {
      assessment_stage: draft.assessment_stage,
      gestational_age_weeks: draft.gestational_age_weeks,
      gravida: draft.gravida,
      parity: draft.parity,
      risk_score: draft.risk_score,
      risk_band: draft.risk_band,
      risk_factors: draft.risk_factors,
      red_flag_signals: draft.red_flag_signals,
      recommendations: draft.recommendations,
      follow_up_plan: draft.follow_up_plan,
    },
  })}`;
}

function normalizeAiDraft(parsed, fallbackDraft) {
  if (!parsed || typeof parsed !== 'object') return fallbackDraft;
  // AI output is decorative only for narrative fields. Do NOT let AI override
  // the deterministic risk_score / risk_band / risk_factors / red_flag_signals.
  return {
    ...fallbackDraft,
    summary: cleanText(parsed.summary) || fallbackDraft.summary,
    source_citations: uniqueCitations([
      ...asArray(fallbackDraft.source_citations),
      ...asArray(parsed.source_citations),
    ]),
  };
}

// ---------- main service functions ---------------------------------------

export async function evaluateObstetricRisk({
  req = null,
  patientUid,
  admissionId = null,
  gestationalAgeWeeks = null,
  gravida = null,
  parity = null,
  priorConditions = [],
  currentConditions = [],
  vitals = {},
  labs = {},
  symptoms = [],
  multipleGestation = false,
  ageYears = null,
  stageOverride = null,
} = {}) {
  const tenantId = resolveTenantId({ tenantId: req?.tenantId });
  const module = await getClinicalAiModule(MODULE_KEY, { tenantId });
  if (!module.enabled) {
    throw AppError.forbidden(`Clinical AI module is disabled: ${module.display_name}`);
  }

  if (!patientUid || !cleanText(patientUid)) {
    throw AppError.badRequest('patient_uid is required');
  }
  const safeAdmissionId = admissionId ? optionalInt(admissionId, 'admission_id') : null;

  // Best-effort: load admission + latest vitals + patient birthday/age.
  const admission = await loadAdmissionMeta(safeAdmissionId);
  const dbVitalsRow = vitals && Object.keys(vitals).length ? null : await loadLatestVitalsForPatient(patientUid);
  const effectiveVitals = vitals && Object.keys(vitals).length ? vitals : {
    systolic_bp: toNullableNumber(dbVitalsRow?.systolic_bp),
    diastolic_bp: toNullableNumber(dbVitalsRow?.diastolic_bp),
    heart_rate: toNullableNumber(dbVitalsRow?.heart_rate),
    temperature: toNullableNumber(dbVitalsRow?.temperature),
    spo2: toNullableNumber(dbVitalsRow?.spo2),
    respiratory_rate: toNullableNumber(dbVitalsRow?.respiratory_rate),
  };

  let effectiveAgeYears = toNullableNumber(ageYears);
  let patientMeta = null;
  if (effectiveAgeYears === null) {
    patientMeta = await loadPatientBirthday(patientUid);
    if (patientMeta && patientMeta.age_years !== null && patientMeta.age_years !== undefined) {
      effectiveAgeYears = toNullableNumber(patientMeta.age_years);
    }
  }
  if (!patientMeta) {
    patientMeta = { uid: patientUid, name: null, birthday: null, age_years: effectiveAgeYears };
  }

  // Derive stage (explicit override wins; else bucket by weeks).
  let assessmentStage = 'unknown';
  if (stageOverride && ASSESSMENT_STAGES.has(cleanText(stageOverride).toLowerCase())) {
    assessmentStage = cleanText(stageOverride).toLowerCase();
  } else {
    assessmentStage = classifyAssessmentStage(gestationalAgeWeeks);
  }

  const riskFactors = detectRiskFactors({
    ageYears: effectiveAgeYears,
    gravida: toNullableNumber(gravida),
    parity: toNullableNumber(parity),
    priorConditions,
    currentConditions,
    gestationalAgeWeeks,
    multipleGestation,
  });
  const redFlagSignals = detectRedFlagSignals({
    vitals: effectiveVitals,
    labs,
    symptoms,
    gestationalAgeWeeks,
  });
  const { risk_score, risk_band } = computeObstetricRiskScore({
    riskFactors,
    redFlagSignals,
  });
  const followUpPlan = buildFollowUpPlan({
    assessmentStage,
    riskBand: risk_band,
    redFlagSignals,
    gestationalAgeWeeks,
    riskFactors,
  });
  const recommendations = buildRecommendations({
    riskBand: risk_band,
    redFlagSignals,
    riskFactors,
  });

  // Citations: patient, admission (if any), latest vitals row (if used),
  // and labs (if any).
  const citations = [];
  citations.push({
    source_type: 'patient',
    source_id: String(patientUid),
    label: patientMeta?.name ? `Patient ${patientMeta.name}` : 'Patient record',
    timestamp: null,
  });
  if (safeAdmissionId) {
    citations.push({
      source_type: 'admission',
      source_id: String(safeAdmissionId),
      label: admission?.chief_complaint
        ? `Admission — ${admission.chief_complaint}`
        : 'Admission record',
      timestamp: admission?.admitted_at || admission?.created_at || null,
    });
  }
  if (dbVitalsRow?.id) {
    citations.push({
      source_type: 'vitals',
      source_id: String(dbVitalsRow.id),
      label: 'Latest vitals chart entry',
      timestamp: dbVitalsRow.recorded_at || null,
    });
  }
  if (labs && Object.keys(labs).length) {
    citations.push({
      source_type: 'labs',
      source_id: 'supplied',
      label: 'Caller-supplied laboratory results',
      timestamp: null,
    });
  }
  const uniqueCits = uniqueCitations(citations);

  const fallbackDraft = {
    module_key: MODULE_KEY,
    patient_uid: patientUid,
    admission_id: safeAdmissionId,
    gestational_age_weeks: toNullableNumber(gestationalAgeWeeks),
    gravida: toNullableNumber(gravida),
    parity: toNullableNumber(parity),
    assessment_stage: assessmentStage,
    age_years: effectiveAgeYears,
    vitals_snapshot: effectiveVitals,
    risk_factors: riskFactors,
    red_flag_signals: redFlagSignals,
    risk_score,
    risk_band,
    recommendations,
    follow_up_plan: followUpPlan,
    summary: `Obstetric risk band: ${risk_band} (score ${risk_score}); ${riskFactors.length} risk factor(s), ${redFlagSignals.length} red-flag signal(s).`,
    source_citations: uniqueCits,
    safety_flags: [],
    rules_authoritative: true,
    decision_support_only: true,
  };

  const prompt = await getActivePrompt(tenantId);
  let aiResult = { usedAi: false, provider: 'template', model: null, text: '', usage: {} };
  try {
    aiResult = await generateClinicalText({
      taskType: MODULE_KEY,
      systemPrompt: prompt.system_prompt,
      userPrompt: buildNarrativePrompt({ prompt, draft: fallbackDraft, patient: patientMeta, admission }),
      tenantRegion: req?.tenant?.region || null,
      tenantId,
    });
  } catch (err) {
    logger.warn('Obstetric risk: AI narrative failed (non-fatal)', { error: err.message });
  }
  const parsed = safeJsonParse(aiResult?.text, {});
  const draft = normalizeAiDraft(parsed, fallbackDraft);

  const safetyFlags = [
    ...buildSafetyFlags({
      riskBand: draft.risk_band,
      redFlagSignals: draft.red_flag_signals,
      citations: uniqueCits,
    }),
    ...asArray(draft.safety_flags),
    ...runOutputDefenses({
      draft,
      module,
      context: {
        patient: {
          uid: patientMeta?.uid || null,
          age_years: effectiveAgeYears,
        },
        admission,
        vitals: effectiveVitals,
      },
      citations: uniqueCits,
    }),
  ];
  draft.safety_flags = safetyFlags;

  const generation = await insertGeneration({
    tenantId,
    admissionId: safeAdmissionId,
    patientUid,
    sourceHashValue: sourceHash({
      tenant_id: tenantId,
      patient_uid: patientUid,
      admission_id: safeAdmissionId,
      gestational_age_weeks: toNullableNumber(gestationalAgeWeeks),
      gravida: toNullableNumber(gravida),
      parity: toNullableNumber(parity),
      vitals: effectiveVitals,
      labs,
      symptoms,
    }),
    draft,
    citations: uniqueCits,
    safetyFlags,
    requestedBy: req?.user?.uid || null,
    aiResult,
    prompt,
    metadata: {
      admission_id: safeAdmissionId,
      tenant_region: req?.tenant?.region || null,
      assessment_stage: assessmentStage,
      rules_authoritative: true,
      decision_support_only: true,
    },
  });

  const safeStage = ASSESSMENT_STAGES.has(assessmentStage) ? assessmentStage : 'unknown';
  const safeBand = RISK_BANDS.has(draft.risk_band) ? draft.risk_band : 'unknown';

  let assessmentRow = null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_obstetric_risk_assessments
         (tenant_id, patient_uid, admission_id, generation_id,
          gestational_age_weeks, gravida, parity, assessment_stage,
          vitals_snapshot, risk_factors, red_flag_signals,
          risk_score, risk_band, recommendations, follow_up_plan,
          source_citations, safety_flags, reviewer_decision, metadata,
          created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8,
               $9::jsonb, $10::jsonb, $11::jsonb,
               $12, $13, $14::jsonb, $15::jsonb,
               $16::jsonb, $17::jsonb, 'pending', $18::jsonb, NOW(), NOW())
       RETURNING id, tenant_id, patient_uid, admission_id, generation_id,
                 gestational_age_weeks, gravida, parity, assessment_stage,
                 vitals_snapshot, risk_factors, red_flag_signals,
                 risk_score, risk_band, recommendations, follow_up_plan,
                 source_citations, safety_flags, reviewer_decision,
                 reviewed_by, reviewed_at, reviewer_note, metadata,
                 created_at, updated_at`,
      tenantId,
      patientUid,
      safeAdmissionId,
      generation?.id || null,
      toNullableNumber(gestationalAgeWeeks),
      toNullableNumber(gravida),
      toNullableNumber(parity),
      safeStage,
      JSON.stringify(effectiveVitals || {}),
      JSON.stringify(riskFactors),
      JSON.stringify(redFlagSignals),
      draft.risk_score,
      safeBand,
      JSON.stringify(draft.recommendations),
      JSON.stringify(followUpPlan),
      JSON.stringify(uniqueCits),
      JSON.stringify(safetyFlags),
      JSON.stringify({
        used_ai: Boolean(aiResult?.usedAi),
        provider: aiResult?.provider || 'template',
        model: aiResult?.model || null,
        age_years: effectiveAgeYears,
        rules_authoritative: true,
        decision_support_only: true,
      })
    );
    assessmentRow = rows[0] || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) throw err;
    return {
      assessment_id: null,
      generation_id: generation?.id || null,
      draft,
      source_citations: uniqueCits,
      safety_flags: safetyFlags,
      module_key: MODULE_KEY,
      prompt_version: prompt?.version || 'v1',
      review_status: 'schema_unavailable',
      reason: 'clinical_ai_obstetric_risk_assessments_unavailable',
      requires_signoff: Boolean(module.settings?.requiresClinicianSignoff),
      rules_authoritative: true,
      decision_support_only: true,
    };
  }

  const clinicalReview = await createReviewPlaceholder({
    tenantId,
    generationId: generation?.id || null,
    admissionId: safeAdmissionId,
    patientUid,
    module,
  });

  await publishEvent({
    eventType: 'clinical_ai.obstetric_risk_evaluated',
    aggregateType: 'clinical_ai_obstetric_risk_assessment',
    aggregateId: assessmentRow?.id || generation?.id || safeAdmissionId,
    patientUid,
    payload: {
      tenant_id: tenantId,
      admission_id: safeAdmissionId,
      assessment_id: assessmentRow?.id || null,
      generation_id: generation?.id || null,
      risk_score: draft.risk_score,
      risk_band: safeBand,
      assessment_stage: safeStage,
    },
  });

  // Surface to the CDS dashboard on high/critical obstetric risk (pre-eclampsia /
  // eclampsia / PPH red flags) so it reaches the clinician's cards, not just the
  // obstetric-risk queue. Best-effort; the assessment row stays authoritative.
  if (patientUid && (safeBand === 'critical' || safeBand === 'high')) {
    try {
      const { raiseCdsAlert } = await import('../cds/cdsAlertSurfacing.js');
      const topFlag = Array.isArray(draft.red_flag_signals) ? draft.red_flag_signals[0] : null;
      await raiseCdsAlert({
        patientUid,
        encounterId: safeAdmissionId,
        alertType: 'OBSTETRIC_RISK',
        severity: safeBand === 'critical' ? 'critical' : 'warning',
        title: `Obstetric risk — ${safeBand}`,
        description: topFlag?.title || topFlag?.label || topFlag?.signal
          || 'Obstetric risk assessment flagged high/critical risk — review red-flag signals (pre-eclampsia / eclampsia / PPH).',
        sourceData: {
          risk_band: safeBand,
          risk_score: draft.risk_score,
          assessment_stage: safeStage,
          assessment_id: assessmentRow?.id || null,
          source: 'obstetricRiskService.evaluateObstetricRisk',
        },
      });
    } catch (err) {
      logger.warn(`Obstetric risk CDS surfacing failed: ${err.message}`);
    }
  }

  return {
    assessment_id: assessmentRow?.id || null,
    generation_id: generation?.id || null,
    clinical_review_id: clinicalReview?.id || null,
    draft,
    assessment: assessmentRow,
    source_citations: uniqueCits,
    safety_flags: safetyFlags,
    risk_score: draft.risk_score,
    risk_band: safeBand,
    assessment_stage: safeStage,
    module_key: MODULE_KEY,
    prompt_version: prompt?.version || 'v1',
    review_status: clinicalReview?.decision || assessmentRow?.reviewer_decision || 'pending',
    requires_signoff: Boolean(module.settings?.requiresClinicianSignoff),
    ai_metadata: {
      provider: aiResult?.provider || 'template',
      model: aiResult?.model || null,
      used_ai: Boolean(aiResult?.usedAi),
      usage: aiResult?.usage || {},
    },
    rules_authoritative: true,
    decision_support_only: true,
  };
}

export async function listObstetricRiskAssessments({
  tenantId = null,
  patientUid = null,
  admissionId = null,
  riskBand = null,
  stage = null,
  reviewerDecision = null,
  limit = 50,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const aid = admissionId ? optionalInt(admissionId, 'admission_id') : null;
  const normalizedBand = riskBand && RISK_BANDS.has(cleanText(riskBand).toLowerCase())
    ? cleanText(riskBand).toLowerCase()
    : null;
  const normalizedStage = stage && ASSESSMENT_STAGES.has(cleanText(stage).toLowerCase())
    ? cleanText(stage).toLowerCase()
    : null;
  const normalizedDecision = reviewerDecision && DECISIONS.has(cleanText(reviewerDecision).toLowerCase())
    ? cleanText(reviewerDecision).toLowerCase()
    : null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT a.id, a.tenant_id, a.patient_uid, u.name AS patient_name,
              a.admission_id, a.generation_id,
              a.gestational_age_weeks, a.gravida, a.parity, a.assessment_stage,
              a.vitals_snapshot, a.risk_factors, a.red_flag_signals,
              a.risk_score, a.risk_band, a.recommendations, a.follow_up_plan,
              a.source_citations, a.safety_flags, a.reviewer_decision,
              a.reviewed_by, a.reviewed_at, a.reviewer_note, a.metadata,
              a.created_at, a.updated_at
       FROM clinical_ai_obstetric_risk_assessments a
       LEFT JOIN users u ON u.uid = a.patient_uid
       WHERE a.tenant_id = $1::uuid
         AND ($2::uuid IS NULL OR a.patient_uid = $2::uuid)
         AND ($3::int IS NULL OR a.admission_id = $3)
         AND ($4::text IS NULL OR a.risk_band = $4)
         AND ($5::text IS NULL OR a.assessment_stage = $5)
         AND ($6::text IS NULL OR a.reviewer_decision = $6)
       ORDER BY
         CASE a.risk_band
           WHEN 'critical' THEN 0
           WHEN 'high' THEN 1
           WHEN 'moderate' THEN 2
           WHEN 'low' THEN 3
           ELSE 4
         END,
         a.created_at DESC
       LIMIT $7`,
      tid,
      patientUid || null,
      aid,
      normalizedBand,
      normalizedStage,
      normalizedDecision,
      safeLimit
    );
    const normalized = rows.map((row) => ({
      ...row,
      gestational_age_weeks: row.gestational_age_weeks !== null && row.gestational_age_weeks !== undefined
        ? toNumber(row.gestational_age_weeks, null)
        : null,
      gravida: row.gravida !== null && row.gravida !== undefined ? toNumber(row.gravida, null) : null,
      parity: row.parity !== null && row.parity !== undefined ? toNumber(row.parity, null) : null,
      risk_score: toNumber(row.risk_score, 0),
    }));
    return { assessments: normalized, count: normalized.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { assessments: [], count: 0 };
    throw err;
  }
}

export async function decideObstetricRiskAssessment({
  tenantId = null,
  assessmentId,
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
    `UPDATE clinical_ai_obstetric_risk_assessments
     SET reviewer_decision = $2,
         reviewed_by = $3::uuid,
         reviewed_at = NOW(),
         reviewer_note = $4,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $5::uuid
     RETURNING id, patient_uid, admission_id, generation_id,
               gestational_age_weeks, gravida, parity, assessment_stage,
               risk_score, risk_band, reviewer_decision, reviewed_by,
               reviewed_at, reviewer_note`,
    optionalInt(assessmentId, 'assessment_id'),
    normalized,
    reviewerUid,
    note,
    tid
  );
  if (!rows[0]) throw AppError.notFound('Obstetric risk assessment not found');
  const row = rows[0];
  return {
    ...row,
    gestational_age_weeks: row.gestational_age_weeks !== null && row.gestational_age_weeks !== undefined
      ? toNumber(row.gestational_age_weeks, null)
      : null,
    gravida: row.gravida !== null && row.gravida !== undefined ? toNumber(row.gravida, null) : null,
    parity: row.parity !== null && row.parity !== undefined ? toNumber(row.parity, null) : null,
    risk_score: toNumber(row.risk_score, 0),
  };
}

export default {
  ANC_SCHEDULE_WEEKS,
  OBSTETRIC_KEYWORDS,
  buildFollowUpPlan,
  classifyAssessmentStage,
  computeObstetricRiskScore,
  decideObstetricRiskAssessment,
  detectRedFlagSignals,
  detectRiskFactors,
  evaluateObstetricRisk,
  listObstetricRiskAssessments,
};
