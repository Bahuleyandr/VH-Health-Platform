/**
 * Tier E — patient engagement AI assistants. 13 modules from
 * docs/AI_FEATURE_GAP_BACKLOG.md "Tier E". All decision-support only;
 * every output enqueues a clinical_ai_reviews row before any patient
 * surface displays it.
 */

import crypto from 'crypto';

import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { runExplainerPipeline } from './patientExplainersService.js';

const TEXT_INPUT_MAX = 12_000;

function isMissingSchemaError(err) {
  return /does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}
function normalizeId(value, label = 'id') {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw AppError.badRequest(`${label} must be a positive integer`);
  return parsed;
}
function maybeUuid(value, label = 'uid') {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw AppError.badRequest(`${label} must be a UUID`);
  }
  return text;
}
function requireUuid(value, label) {
  const out = maybeUuid(value, label);
  if (!out) throw AppError.badRequest(`${label} is required`);
  return out;
}
function requireText(value, label, { min = 1, max = TEXT_INPUT_MAX } = {}) {
  const text = String(value || '').trim();
  if (text.length < min) throw AppError.badRequest(`${label} must be at least ${min} characters`);
  return text.slice(0, max);
}
function shortHash(p) { return crypto.createHash('sha256').update(JSON.stringify(p || {})).digest('hex').slice(0, 16); }
async function safeQuery(sql, params = [], fallback = []) {
  try {
    const rows = await prisma.$queryRawUnsafe(sql, ...params);
    return Array.isArray(rows) ? rows : fallback;
  } catch (err) {
    if (isMissingSchemaError(err)) return fallback;
    throw err;
  }
}

const CHRONIC_CONDITIONS = ['diabetes', 'hypertension', 'ckd', 'heart_failure', 'copd', 'asthma', 'pregnancy', 'cardiac', 'obstetric'];
const MENTAL_SCREENS = ['PHQ9', 'GAD7', 'EPDS', 'AUDIT', 'CAGE'];

// ---------------------------------------------------------------------------
// 1. Symptom red flag checker
// ---------------------------------------------------------------------------
export async function generateSymptomRedFlagCheck({
  tenantId = null, symptomDescription, ageYears = null, sex = null,
  knownConditions = [], language = 'en',
  patientUid = null, generatedBy = null, req = null,
} = {}) {
  const desc = requireText(symptomDescription, 'symptom_description', { min: 10, max: 2000 });
  return runExplainerPipeline({
    moduleKey: 'symptom_red_flag_checker',
    tenantId, patientUid: patientUid ? maybeUuid(patientUid, 'patient_uid') : null, admissionId: null,
    systemPrompt: [
      'You are a patient-facing triage assistant. Identify red-flag symptom patterns and tell the patient where to go (ER, same-day clinic, scheduled visit, self-monitor).',
      `Target language: ${language}.`,
      'Output: explanation_summary, urgency: emergency|same_day|scheduled|self_monitor, red_flags_present (array), recommended_action.',
      'Default to escalating ambiguous cases. Never give specific dose/medication advice. End with "this is not a substitute for clinical evaluation".',
    ].join('\n'),
    userPromptPayload: { symptom_description: desc, age_years: ageYears, sex, known_conditions: Array.isArray(knownConditions) ? knownConditions : [] },
    contextForDefenses: { symptom_description: desc, known_conditions: knownConditions },
    citations: [{ source_type: 'symptom_text', source_id: shortHash(desc), label: `Patient-reported symptoms (${desc.length} chars)`, timestamp: null }],
    metadata: { language, symptom_hash: shortHash(desc) },
    generatedBy, req,
  });
}

// ---------------------------------------------------------------------------
// 2. Chronic disease coach
// ---------------------------------------------------------------------------
export async function generateChronicDiseaseCoaching({
  tenantId = null, patientUid, condition, language = 'en',
  generatedBy = null, req = null,
} = {}) {
  const uid = requireUuid(patientUid, 'patient_uid');
  const cond = String(condition || '').toLowerCase().trim();
  if (!CHRONIC_CONDITIONS.includes(cond)) {
    throw AppError.badRequest(`condition must be one of: ${CHRONIC_CONDITIONS.join(', ')}`);
  }

  // Best-effort context: recent labs + active meds
  const labs = await safeQuery(
    `SELECT id, test_name, result_value, result_unit, completed_at, abnormal_flag
     FROM investigations WHERE patient_uid = $1::uuid AND completed_at IS NOT NULL
     ORDER BY completed_at DESC LIMIT 12`, [uid],
  );
  const meds = await safeQuery(
    `SELECT id, medication_name, dosage, frequency, status, prescribed_at
     FROM prescriptions WHERE patient_uid = $1::uuid AND status IN ('active', 'ongoing')
     ORDER BY prescribed_at DESC LIMIT 20`, [uid],
  );

  return runExplainerPipeline({
    moduleKey: 'chronic_disease_coach',
    tenantId, patientUid: uid, admissionId: null,
    systemPrompt: [
      `You are a patient-coaching assistant for ${cond}. Draft a single-week guidance message.`,
      `Target language: ${language}.`,
      'Output: explanation_summary, weekly_focus (1-2 things to do), red_flag_symptoms (when to call the doctor), self_check_questions (3-5).',
      'Use ONLY the supplied recent labs + medications. Quote dose/frequency verbatim. NEVER suggest dose changes or stopping a medication.',
    ].join('\n'),
    userPromptPayload: { condition: cond, recent_labs: labs.slice(0, 8), active_medications: meds },
    contextForDefenses: { condition: cond, labs, meds },
    citations: [
      ...labs.slice(0, 3).map((l) => ({ source_type: 'investigation', source_id: String(l.id),
        label: `${l.test_name} ${l.result_value}${l.result_unit || ''}`, timestamp: l.completed_at })),
      ...meds.slice(0, 3).map((m) => ({ source_type: 'prescription', source_id: String(m.id),
        label: `${m.medication_name} ${m.dosage || ''}`.trim(), timestamp: m.prescribed_at })),
    ],
    metadata: { condition: cond, language, lab_count: labs.length, med_count: meds.length },
    generatedBy, req,
  });
}

// ---------------------------------------------------------------------------
// 3. Post-discharge check-in bot
// ---------------------------------------------------------------------------
export async function generatePostDischargeCheckIn({
  tenantId = null, admissionId, dayPostDischarge = 1, language = 'en',
  generatedBy = null, req = null,
} = {}) {
  const admId = normalizeId(admissionId, 'admission_id');
  const day = normalizeId(dayPostDischarge, 'day_post_discharge');
  if (![1, 3, 7, 14, 30].includes(day)) {
    throw AppError.badRequest('day_post_discharge must be one of: 1, 3, 7, 14, 30');
  }
  const adm = (await safeQuery(
    `SELECT id, patient_uid, discharge_date, primary_diagnosis FROM admissions WHERE id = $1 LIMIT 1`,
    [admId],
  ))[0];
  if (!adm) throw AppError.notFound('Admission not found');

  return runExplainerPipeline({
    moduleKey: 'post_discharge_checkin_bot',
    tenantId, patientUid: adm.patient_uid, admissionId: admId,
    systemPrompt: [
      `You are a post-discharge nurse assistant. Draft the day-${day} check-in conversation.`,
      `Target language: ${language}.`,
      'Output: explanation_summary, questions (array of 3-6 prompts about pain, medications, mobility, red flags), expected_milestones, red_flag_routes (which symptom triggers call-clinician vs ER).',
      'Quote primary_diagnosis verbatim. Tailor to discharge_date.',
    ].join('\n'),
    userPromptPayload: { day_post_discharge: day, discharge_date: adm.discharge_date, primary_diagnosis: adm.primary_diagnosis },
    contextForDefenses: { admission: adm, day },
    citations: [{ source_type: 'admission', source_id: String(adm.id),
      label: `Admission #${adm.id} discharge ${adm.discharge_date}`, timestamp: adm.discharge_date }],
    metadata: { admission_id: admId, day_post_discharge: day, language },
    generatedBy, req,
  });
}

// ---------------------------------------------------------------------------
// 4. Post-surgery monitoring bot
// ---------------------------------------------------------------------------
export async function generatePostSurgeryMonitoring({
  tenantId = null, admissionId, postOpDay = 1, procedureName = null,
  language = 'en', generatedBy = null, req = null,
} = {}) {
  const admId = normalizeId(admissionId, 'admission_id');
  const day = normalizeId(postOpDay, 'post_op_day');
  const adm = (await safeQuery(
    `SELECT id, patient_uid, primary_diagnosis, ward FROM admissions WHERE id = $1 LIMIT 1`, [admId],
  ))[0];
  if (!adm) throw AppError.notFound('Admission not found');

  return runExplainerPipeline({
    moduleKey: 'post_surgery_monitoring_bot',
    tenantId, patientUid: adm.patient_uid, admissionId: admId,
    systemPrompt: [
      `You are a post-surgical monitoring assistant. Draft the post-op day-${day} check-in conversation.`,
      `Target language: ${language}.`,
      'Output: explanation_summary, wound_care_prompts, mobility_prompts, complication_red_flags (array), follow_up_milestones.',
      'Tailor to procedure_name when supplied; otherwise generic post-op.',
    ].join('\n'),
    userPromptPayload: { post_op_day: day, procedure_name: procedureName, primary_diagnosis: adm.primary_diagnosis },
    contextForDefenses: { admission: adm, post_op_day: day },
    citations: [{ source_type: 'admission', source_id: String(adm.id),
      label: `Surgical admission #${adm.id}`, timestamp: null }],
    metadata: { admission_id: admId, post_op_day: day, language },
    generatedBy, req,
  });
}

// ---------------------------------------------------------------------------
// 5. Home vitals insights
// ---------------------------------------------------------------------------
export async function generateHomeVitalsInsights({
  tenantId = null, patientUid, vitalsSeries, language = 'en',
  generatedBy = null, req = null,
} = {}) {
  const uid = requireUuid(patientUid, 'patient_uid');
  if (!Array.isArray(vitalsSeries) || vitalsSeries.length === 0) {
    throw AppError.badRequest('vitals_series must be a non-empty array');
  }
  if (vitalsSeries.length > 200) {
    throw AppError.badRequest('vitals_series capped at 200 entries');
  }

  return runExplainerPipeline({
    moduleKey: 'home_vitals_insights',
    tenantId, patientUid: uid, admissionId: null,
    systemPrompt: [
      'You are a patient-coaching assistant. Summarise self-reported home vitals.',
      `Target language: ${language}.`,
      'Output: explanation_summary, per_vital (object: { trend: improving|stable|worsening, observation }), red_flag_thresholds_breached (array), when_to_call_doctor (array).',
      'Compute trends from the supplied series only. Cite specific datapoints.',
    ].join('\n'),
    userPromptPayload: { vitals_series: vitalsSeries.slice(0, 200) },
    contextForDefenses: { vitals_series: vitalsSeries },
    citations: [{ source_type: 'home_vitals_series', source_id: shortHash(vitalsSeries),
      label: `Home vitals (${vitalsSeries.length} entries)`, timestamp: null }],
    metadata: { language, sample_size: vitalsSeries.length },
    generatedBy, req,
  });
}

// ---------------------------------------------------------------------------
// 6 + 7. Diet / Exercise advice drafts
// ---------------------------------------------------------------------------
async function lifestyleDraft({ moduleKey, audience, prompt, condition, restrictions, language, patientUid, tenantId, generatedBy, req }) {
  const cond = requireText(condition, 'condition', { min: 2, max: 200 });
  return runExplainerPipeline({
    moduleKey, tenantId,
    patientUid: patientUid ? maybeUuid(patientUid, 'patient_uid') : null, admissionId: null,
    systemPrompt: [prompt, `Target language: ${language}.`].join('\n'),
    userPromptPayload: { condition: cond, restrictions: Array.isArray(restrictions) ? restrictions : [], audience },
    contextForDefenses: { condition: cond, restrictions },
    citations: [{ source_type: 'condition_label', source_id: shortHash(cond), label: cond, timestamp: null }],
    metadata: { condition: cond, language, audience },
    generatedBy, req,
  });
}

export async function generateDietAdviceDraft({
  tenantId = null, patientUid = null, condition, restrictions = [], language = 'en',
  generatedBy = null, req = null,
} = {}) {
  return lifestyleDraft({
    moduleKey: 'diet_advice_draft', audience: 'patient',
    prompt: [
      'You are a hospital dietitian assistant. Draft patient-facing diet guidance.',
      'Output: explanation_summary, foods_to_emphasise (array), foods_to_limit (array), portion_guidance, hydration, hydration_red_flags, when_to_consult_dietitian.',
      'Refuse to give specific calorie / macro prescriptions — that is the dietitian\'s call.',
      'Tailor to the supplied condition + restrictions (allergies, religious / cultural preferences).',
    ].join('\n'),
    condition, restrictions, language, patientUid, tenantId, generatedBy, req,
  });
}

export async function generateExerciseAdviceDraft({
  tenantId = null, patientUid = null, condition, restrictions = [], language = 'en',
  generatedBy = null, req = null,
} = {}) {
  return lifestyleDraft({
    moduleKey: 'exercise_advice_draft', audience: 'patient',
    prompt: [
      'You are a hospital physiotherapist assistant. Draft patient-facing exercise / activity guidance.',
      'Output: explanation_summary, recommended_activities (array of { activity, frequency, duration, intensity }), avoid_list, progression_guidance, red_flags_to_stop.',
      'Refuse to prescribe specific weight / load progressions — physiotherapist signs.',
      'Tailor to condition + restrictions (post-op, cardiac rehab phase, pregnancy week, etc.).',
    ].join('\n'),
    condition, restrictions, language, patientUid, tenantId, generatedBy, req,
  });
}

// ---------------------------------------------------------------------------
// 8. Mental health screening bot
// ---------------------------------------------------------------------------
export async function generateMentalHealthScreening({
  tenantId = null, patientUid, screen = 'PHQ9', responses = null, language = 'en',
  generatedBy = null, req = null,
} = {}) {
  const uid = requireUuid(patientUid, 'patient_uid');
  const cleanScreen = String(screen || 'PHQ9').toUpperCase();
  if (!MENTAL_SCREENS.includes(cleanScreen)) {
    throw AppError.badRequest(`screen must be one of: ${MENTAL_SCREENS.join(', ')}`);
  }

  return runExplainerPipeline({
    moduleKey: 'mental_health_screening_bot',
    tenantId, patientUid: uid, admissionId: null,
    systemPrompt: [
      `You are a mental-health screening assistant. Draft the ${cleanScreen} exchange.`,
      `Target language: ${language}.`,
      'When responses are supplied, score the screen + interpret per published cutoffs (cite the cutoffs).',
      'Output: explanation_summary, screen_id (e.g., PHQ9), questions (if no responses) OR score+interpretation, severity_band, recommended_action, suicidality_present (always check + flag).',
      'If suicidality / self-harm mentioned anywhere, set suicidality_present=true and recommended_action=immediate_clinician.',
    ].join('\n'),
    userPromptPayload: { screen: cleanScreen, responses },
    contextForDefenses: { screen: cleanScreen, responses },
    citations: [{ source_type: 'screening_instrument', source_id: cleanScreen, label: cleanScreen, timestamp: null }],
    metadata: { screen: cleanScreen, language, responses_supplied: Boolean(responses) },
    generatedBy, req,
  });
}

// ---------------------------------------------------------------------------
// 9. Medication reminder generator
// ---------------------------------------------------------------------------
export async function generateMedicationReminders({
  tenantId = null, patientUid, language = 'en',
  generatedBy = null, req = null,
} = {}) {
  const uid = requireUuid(patientUid, 'patient_uid');
  const meds = await safeQuery(
    `SELECT id, medication_name, dosage, frequency, duration, instructions, status, prescribed_at
     FROM prescriptions WHERE patient_uid = $1::uuid AND status IN ('active', 'ongoing')
     ORDER BY prescribed_at DESC`, [uid],
  );
  if (!meds.length) throw AppError.notFound('No active prescriptions found');

  return runExplainerPipeline({
    moduleKey: 'medication_reminder_generator',
    tenantId, patientUid: uid, admissionId: null,
    systemPrompt: [
      'You are a patient-coaching assistant. Generate a per-medication daily reminder schedule.',
      `Target language: ${language}.`,
      'Output: explanation_summary, schedule (array of { time, medication, dose, with_or_without_food, side_effects_to_call_doctor }), end_dates (per-medication), notes.',
      'Quote dose and frequency verbatim. Do NOT change them.',
    ].join('\n'),
    userPromptPayload: { medications: meds.map((m) => ({
      name: m.medication_name, dose: m.dosage, frequency: m.frequency, duration: m.duration, instructions: m.instructions,
    })) },
    contextForDefenses: { medications: meds },
    citations: meds.slice(0, 5).map((m) => ({ source_type: 'prescription', source_id: String(m.id),
      label: `${m.medication_name} ${m.dosage || ''}`.trim(), timestamp: m.prescribed_at })),
    metadata: { med_count: meds.length, language },
    generatedBy, req,
  });
}

// ---------------------------------------------------------------------------
// 10. Follow-up reminder generator
// ---------------------------------------------------------------------------
export async function generateFollowUpReminders({
  tenantId = null, admissionId, language = 'en',
  generatedBy = null, req = null,
} = {}) {
  const admId = normalizeId(admissionId, 'admission_id');
  const adm = (await safeQuery(
    `SELECT id, patient_uid, admission_date, discharge_date, primary_diagnosis,
            discharge_summary
     FROM admissions WHERE id = $1 LIMIT 1`, [admId],
  ))[0];
  if (!adm) throw AppError.notFound('Admission not found');

  return runExplainerPipeline({
    moduleKey: 'follow_up_reminder_generator',
    tenantId, patientUid: adm.patient_uid, admissionId: admId,
    systemPrompt: [
      'You are a care-coordinator assistant. Generate a follow-up reminder schedule from the discharge plan.',
      `Target language: ${language}.`,
      'Output: explanation_summary, follow_ups (array of { type: clinic|lab|imaging, when (relative to discharge_date), what, why }), no_show_red_flag.',
      'Use the discharge_summary text as the source. Cite which discharge_summary span fed each follow-up.',
    ].join('\n'),
    userPromptPayload: { discharge_date: adm.discharge_date, primary_diagnosis: adm.primary_diagnosis,
      discharge_summary: adm.discharge_summary },
    contextForDefenses: { admission: adm },
    citations: [{ source_type: 'admission', source_id: String(adm.id),
      label: `Admission #${adm.id} discharge plan`, timestamp: adm.discharge_date }],
    metadata: { admission_id: admId, language },
    generatedBy, req,
  });
}

// ---------------------------------------------------------------------------
// 11. Pre-visit form assistant
// ---------------------------------------------------------------------------
export async function generatePreVisitForm({
  tenantId = null, patientUid = null, appointmentReason, departmentSpecialty = null, language = 'en',
  generatedBy = null, req = null,
} = {}) {
  const reason = requireText(appointmentReason, 'appointment_reason', { min: 3, max: 500 });

  return runExplainerPipeline({
    moduleKey: 'pre_visit_form_assistant',
    tenantId, patientUid: patientUid ? maybeUuid(patientUid, 'patient_uid') : null, admissionId: null,
    systemPrompt: [
      'You are a patient-coaching assistant. Help the patient prepare for an upcoming appointment.',
      `Target language: ${language}.`,
      'Output: explanation_summary, history_prompts (questions for the patient to answer in advance), document_checklist (insurance card, prior reports, current medications), questions_to_ask_doctor (3-5).',
      'Tailor to appointment_reason + department_specialty.',
    ].join('\n'),
    userPromptPayload: { appointment_reason: reason, department_specialty: departmentSpecialty },
    contextForDefenses: { appointment_reason: reason, department_specialty: departmentSpecialty },
    citations: [{ source_type: 'appointment_reason', source_id: shortHash(reason), label: reason.slice(0, 80), timestamp: null }],
    metadata: { language, reason_hash: shortHash(reason) },
    generatedBy, req,
  });
}

// ---------------------------------------------------------------------------
// 12. Preventive health recommender
// ---------------------------------------------------------------------------
export async function generatePreventiveHealthRecommendations({
  tenantId = null, patientUid = null, ageYears, sex,
  comorbidities = [], familyHistory = [], language = 'en',
  generatedBy = null, req = null,
} = {}) {
  const age = normalizeId(ageYears, 'age_years');
  const sx = String(sex || '').toUpperCase();
  if (!['MALE', 'FEMALE', 'OTHER'].includes(sx)) {
    throw AppError.badRequest('sex must be MALE | FEMALE | OTHER');
  }

  return runExplainerPipeline({
    moduleKey: 'preventive_health_recommender',
    tenantId, patientUid: patientUid ? maybeUuid(patientUid, 'patient_uid') : null, admissionId: null,
    systemPrompt: [
      'You are a preventive-health coach. Recommend age- and sex-appropriate screenings.',
      `Target language: ${language}.`,
      'Output: explanation_summary, recommended_screenings (array of { test, frequency, rationale, evidence_strength }), vaccinations (array), lifestyle_advice.',
      'Cite the guideline body (USPSTF, IAP, MoHFW) when possible. Tailor to age + sex + comorbidities + family_history.',
    ].join('\n'),
    userPromptPayload: { age_years: age, sex: sx, comorbidities, family_history: familyHistory },
    contextForDefenses: { age_years: age, sex: sx, comorbidities, family_history: familyHistory },
    citations: [{ source_type: 'demographic_profile', source_id: shortHash({ age, sx }),
      label: `${age}y ${sx}`, timestamp: null }],
    metadata: { language, age, sex: sx, comorbidity_count: comorbidities.length },
    generatedBy, req,
  });
}

// ---------------------------------------------------------------------------
// 13. Family health risk summary
// ---------------------------------------------------------------------------
export async function generateFamilyHealthRiskSummary({
  tenantId = null, patientUid = null, familyHistoryEntries, language = 'en',
  generatedBy = null, req = null,
} = {}) {
  if (!Array.isArray(familyHistoryEntries) || !familyHistoryEntries.length) {
    throw AppError.badRequest('family_history_entries must be a non-empty array');
  }

  return runExplainerPipeline({
    moduleKey: 'family_health_risk_summary',
    tenantId, patientUid: patientUid ? maybeUuid(patientUid, 'patient_uid') : null, admissionId: null,
    systemPrompt: [
      'You are a preventive-health coach. Summarise family medical history into a risk profile.',
      `Target language: ${language}.`,
      'Output: explanation_summary, per_condition_risk (array of { condition, relative_pattern, lifetime_risk_band: low|moderate|elevated|high, recommended_screening_cadence, rationale }), genetic_counseling_referral_indicated (boolean).',
      'Use the supplied family_history_entries verbatim. Do not infer conditions not stated. Cite the relative who carries the condition.',
    ].join('\n'),
    userPromptPayload: { family_history_entries: familyHistoryEntries },
    contextForDefenses: { family_history_entries: familyHistoryEntries },
    citations: [{ source_type: 'family_history', source_id: shortHash(familyHistoryEntries),
      label: `${familyHistoryEntries.length} family-history entries`, timestamp: null }],
    metadata: { language, entry_count: familyHistoryEntries.length },
    generatedBy, req,
  });
}

export const __testing__ = { CHRONIC_CONDITIONS, MENTAL_SCREENS, shortHash };

export default {
  generateSymptomRedFlagCheck,
  generateChronicDiseaseCoaching,
  generatePostDischargeCheckIn,
  generatePostSurgeryMonitoring,
  generateHomeVitalsInsights,
  generateDietAdviceDraft,
  generateExerciseAdviceDraft,
  generateMentalHealthScreening,
  generateMedicationReminders,
  generateFollowUpReminders,
  generatePreVisitForm,
  generatePreventiveHealthRecommendations,
  generateFamilyHealthRiskSummary,
};
