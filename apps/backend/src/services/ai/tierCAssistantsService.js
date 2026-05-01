/**
 * Tier C "P0/P1 clinical assistants" — 16 module wrappers from
 * docs/AI_FEATURE_GAP_BACKLOG.md "Tier C". Each reuses
 * runExplainerPipeline (the shared draft pipeline). All decision-support
 * only — outputs are persisted with a clinical_ai_reviews row pending
 * clinician sign-off; nothing auto-publishes.
 *
 * Modules registered by migration 134:
 *   Documentation drafts       medical_certificate_draft, clinic_letter_draft,
 *                              clinical_note_cleanup
 *   Chart-completeness prompts missing_questions_assistant,
 *                              missing_examination_assistant,
 *                              missing_tests_assistant
 *   Protocol scaffolds         order_set_suggestion
 *   Drug-safety standalones    renal_dose_check, liver_dose_check,
 *                              pregnancy_lactation_warning,
 *                              adverse_drug_event_detector
 *   Risk prediction wrappers   fall_risk_prediction,
 *                              pressure_ulcer_risk_prediction,
 *                              aki_risk_alert
 *   Inpatient summaries        intake_output_summary, icu_round_summary
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
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw AppError.badRequest(`${label} must be a positive integer`);
  }
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

function shortHash(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload || {})).digest('hex').slice(0, 16);
}

async function safeQuery(sql, params = [], fallback = []) {
  try {
    const rows = await prisma.$queryRawUnsafe(sql, ...params);
    return Array.isArray(rows) ? rows : fallback;
  } catch (err) {
    if (isMissingSchemaError(err)) return fallback;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 1. Medical certificate draft
// ---------------------------------------------------------------------------
export async function generateMedicalCertificateDraft({
  tenantId = null, admissionId, certType = 'fitness', notes = null,
  generatedBy = null, req = null,
} = {}) {
  const admId = normalizeId(admissionId, 'admission_id');
  const cert = String(certType || 'fitness').toLowerCase();
  if (!['fitness', 'sickness', 'vaccination', 'disability', 'travel', 'leave'].includes(cert)) {
    throw AppError.badRequest('cert_type must be fitness/sickness/vaccination/disability/travel/leave');
  }
  const adm = (await safeQuery(
    `SELECT id, patient_uid, admission_date, discharge_date, primary_diagnosis,
            secondary_diagnoses
     FROM admissions WHERE id = $1 LIMIT 1`,
    [admId],
  ))[0];
  if (!adm) throw AppError.notFound('Admission not found');

  const citations = [{
    source_type: 'admission', source_id: String(adm.id),
    label: `Admission #${adm.id}`, timestamp: adm.admission_date,
  }];

  return runExplainerPipeline({
    moduleKey: 'medical_certificate_draft',
    tenantId, patientUid: adm.patient_uid, admissionId: admId,
    systemPrompt: [
      `You are a clinical scribe. Draft a ${cert} medical certificate from the admission context.`,
      'Output a JSON object with: explanation_summary (one-line purpose), certificate_text (multi-paragraph signable text), recommended_validity_days, restrictions (array).',
      'Do NOT fabricate diagnoses, durations, or doctor signatures. Only include what the admission row + supplied notes support.',
    ].join('\n'),
    userPromptPayload: {
      cert_type: cert,
      admission: { admission_date: adm.admission_date, discharge_date: adm.discharge_date,
                   primary_diagnosis: adm.primary_diagnosis,
                   secondary_diagnoses: adm.secondary_diagnoses },
      additional_notes: notes ? String(notes).slice(0, 2000) : null,
    },
    contextForDefenses: { admission: adm },
    citations,
    metadata: { admission_id: admId, cert_type: cert },
    generatedBy, req,
  });
}

// ---------------------------------------------------------------------------
// 2. Clinic letter draft
// ---------------------------------------------------------------------------
export async function generateClinicLetterDraft({
  tenantId = null, admissionId, recipientType = 'referring_physician',
  letterPurpose = null,
  generatedBy = null, req = null,
} = {}) {
  const admId = normalizeId(admissionId, 'admission_id');
  const adm = (await safeQuery(
    `SELECT id, patient_uid, admission_date, discharge_date, primary_diagnosis,
            secondary_diagnoses, discharge_summary
     FROM admissions WHERE id = $1 LIMIT 1`,
    [admId],
  ))[0];
  if (!adm) throw AppError.notFound('Admission not found');

  const notes = await safeQuery(
    `SELECT id, note_text, note_type, author_role, created_at
     FROM clinical_notes WHERE admission_id = $1
     ORDER BY created_at DESC LIMIT 5`,
    [admId],
  );

  const citations = [
    { source_type: 'admission', source_id: String(adm.id),
      label: `Admission #${adm.id}`, timestamp: adm.admission_date },
    ...notes.slice(0, 3).map((n) => ({
      source_type: 'clinical_note', source_id: String(n.id),
      label: `${n.note_type || 'note'} (${n.author_role || 'unknown'})`,
      timestamp: n.created_at,
    })),
  ];

  return runExplainerPipeline({
    moduleKey: 'clinic_letter_draft',
    tenantId, patientUid: adm.patient_uid, admissionId: admId,
    systemPrompt: [
      `You are a clinical scribe. Draft a clinic letter to a ${recipientType.replace(/_/g, ' ')}.`,
      'Output: explanation_summary (one-line summary of the encounter), letter_body (full letter, 2-4 paragraphs), recommended_followup (array).',
      'Quote diagnoses verbatim from primary_diagnosis / secondary_diagnoses. Only include findings supported by the supplied notes.',
      'Do NOT add new diagnoses, medications, or test orders the source data does not contain.',
    ].join('\n'),
    userPromptPayload: {
      recipient_type: recipientType,
      letter_purpose: letterPurpose,
      admission: { primary_diagnosis: adm.primary_diagnosis,
                   secondary_diagnoses: adm.secondary_diagnoses,
                   discharge_summary: adm.discharge_summary,
                   admission_date: adm.admission_date,
                   discharge_date: adm.discharge_date },
      recent_notes: notes.map((n) => ({ note_type: n.note_type,
                                        text: String(n.note_text || '').slice(0, 1500),
                                        created_at: n.created_at })),
    },
    contextForDefenses: { admission: adm, notes },
    citations,
    metadata: { admission_id: admId, recipient_type: recipientType },
    generatedBy, req,
  });
}

// ---------------------------------------------------------------------------
// 3. Clinical note cleanup
// ---------------------------------------------------------------------------
export async function generateClinicalNoteCleanup({
  tenantId = null, noteText, patientUid = null, admissionId = null,
  generatedBy = null, req = null,
} = {}) {
  const cleanText = requireText(noteText, 'note_text', { min: 30 });
  const uid = patientUid ? maybeUuid(patientUid, 'patient_uid') : null;
  const admId = admissionId ? normalizeId(admissionId, 'admission_id') : null;

  const citations = [{
    source_type: 'free_text_note', source_id: shortHash(cleanText),
    label: `Free-text note (${cleanText.length} chars)`, timestamp: null,
  }];

  return runExplainerPipeline({
    moduleKey: 'clinical_note_cleanup',
    tenantId, patientUid: uid, admissionId: admId,
    systemPrompt: [
      'You are a clinical-documentation assistant. Re-structure a free-text clinical note into a clean SOAP / problem-oriented format.',
      'You MUST NOT change clinical meaning, add new findings, change medication names or doses, or expand abbreviations into the wrong meaning.',
      'When the source is ambiguous, surface the ambiguous phrase verbatim with [AMBIGUOUS] in safety_flags rather than guessing.',
      'Output: explanation_summary, structured_note (object with subjective/objective/assessment/plan), preserved_quotes (array of source spans you copied verbatim).',
    ].join('\n'),
    userPromptPayload: { note_text: cleanText },
    contextForDefenses: { note_text: cleanText },
    citations,
    metadata: { chars: cleanText.length },
    generatedBy, req,
  });
}

// ---------------------------------------------------------------------------
// 4-6. Chart-completeness prompts (missing questions / examination / tests)
// ---------------------------------------------------------------------------
async function missingChartElement({
  moduleKey, prompt, payload, citations, tenantId, patientUid, admissionId,
  generatedBy, req,
}) {
  return runExplainerPipeline({
    moduleKey, tenantId,
    patientUid: patientUid || null, admissionId: admissionId || null,
    systemPrompt: prompt,
    userPromptPayload: payload,
    contextForDefenses: payload,
    citations,
    metadata: payload.metadata || {},
    generatedBy, req,
  });
}

export async function generateMissingQuestionsAssistant({
  tenantId = null, chiefComplaint, ageYears = null, comorbidities = [],
  patientUid = null, admissionId = null, encounterId = null,
  generatedBy = null, req = null,
} = {}) {
  const cc = requireText(chiefComplaint, 'chief_complaint', { min: 3, max: 1000 });
  return missingChartElement({
    moduleKey: 'missing_questions_assistant',
    prompt: [
      'You are a clinical assistant. Suggest follow-up questions a clinician might want to ask given the chief complaint.',
      'Output: explanation_summary, suggested_questions (array of { question, rationale, urgency: low|medium|high }).',
      'Order by clinical urgency. Cite which finding triggered each suggestion.',
      'Do NOT diagnose. Suggest questions only.',
    ].join('\n'),
    payload: { chief_complaint: cc, age_years: ageYears,
               comorbidities: Array.isArray(comorbidities) ? comorbidities : [],
               metadata: { encounter_id: encounterId, chief_complaint_hash: shortHash(cc) } },
    citations: [{
      source_type: 'chief_complaint', source_id: shortHash(cc),
      label: `Chief complaint (${cc.length} chars)`, timestamp: null,
    }],
    tenantId, patientUid: patientUid ? maybeUuid(patientUid, 'patient_uid') : null,
    admissionId: admissionId ? normalizeId(admissionId, 'admission_id') : null,
    generatedBy, req,
  });
}

export async function generateMissingExaminationAssistant({
  tenantId = null, workingDiagnosis, examCompleted = [],
  patientUid = null, admissionId = null,
  generatedBy = null, req = null,
} = {}) {
  const dx = requireText(workingDiagnosis, 'working_diagnosis', { min: 3, max: 500 });
  return missingChartElement({
    moduleKey: 'missing_examination_assistant',
    prompt: [
      'You are a clinical assistant. Suggest examination steps that the clinician has not yet documented for the working diagnosis.',
      'Output: explanation_summary, suggested_examinations (array of { exam, system, rationale }).',
      'Skip examinations already in the supplied exam_completed list.',
      'Do NOT perform or replace clinical judgement.',
    ].join('\n'),
    payload: { working_diagnosis: dx,
               exam_completed: Array.isArray(examCompleted) ? examCompleted : [],
               metadata: { dx_hash: shortHash(dx) } },
    citations: [{
      source_type: 'working_diagnosis', source_id: shortHash(dx),
      label: dx.slice(0, 80), timestamp: null,
    }],
    tenantId, patientUid: patientUid ? maybeUuid(patientUid, 'patient_uid') : null,
    admissionId: admissionId ? normalizeId(admissionId, 'admission_id') : null,
    generatedBy, req,
  });
}

export async function generateMissingTestsAssistant({
  tenantId = null, workingDiagnosis, testsOrdered = [],
  patientUid = null, admissionId = null,
  generatedBy = null, req = null,
} = {}) {
  const dx = requireText(workingDiagnosis, 'working_diagnosis', { min: 3, max: 500 });
  return missingChartElement({
    moduleKey: 'missing_tests_assistant',
    prompt: [
      'You are a clinical assistant. Surface investigations recommended for the working diagnosis but missing from the order list.',
      'Output: explanation_summary, suggested_tests (array of { test, modality: lab|imaging|other, rationale, urgency }).',
      'Skip tests already in tests_ordered. Cite the workup standard you are referencing.',
      'Do NOT auto-order anything.',
    ].join('\n'),
    payload: { working_diagnosis: dx,
               tests_ordered: Array.isArray(testsOrdered) ? testsOrdered : [],
               metadata: { dx_hash: shortHash(dx) } },
    citations: [{
      source_type: 'working_diagnosis', source_id: shortHash(dx),
      label: dx.slice(0, 80), timestamp: null,
    }],
    tenantId, patientUid: patientUid ? maybeUuid(patientUid, 'patient_uid') : null,
    admissionId: admissionId ? normalizeId(admissionId, 'admission_id') : null,
    generatedBy, req,
  });
}

// ---------------------------------------------------------------------------
// 7. Order-set suggestion
// ---------------------------------------------------------------------------
export async function generateOrderSetSuggestion({
  tenantId = null, workingDiagnosis, acuity = 'routine',
  patientUid = null, admissionId = null,
  generatedBy = null, req = null,
} = {}) {
  const dx = requireText(workingDiagnosis, 'working_diagnosis', { min: 3, max: 500 });
  if (!['routine', 'urgent', 'emergent'].includes(String(acuity || '').toLowerCase())) {
    throw AppError.badRequest('acuity must be routine | urgent | emergent');
  }

  return runExplainerPipeline({
    moduleKey: 'order_set_suggestion',
    tenantId,
    patientUid: patientUid ? maybeUuid(patientUid, 'patient_uid') : null,
    admissionId: admissionId ? normalizeId(admissionId, 'admission_id') : null,
    systemPrompt: [
      'You are a clinical assistant. Suggest an order-set bundle for the working diagnosis at the given acuity.',
      'Output: explanation_summary, order_set (object with labs[], imaging[], medications[], nursing[], monitoring[]).',
      'Each line item: { name, frequency_or_dose, rationale, evidence_level: high|moderate|low }.',
      'Cite the protocol you are referencing (sepsis 1-hour bundle, AMI protocol, DKA, etc.).',
      'Do NOT auto-place orders. Clinician picks per line.',
    ].join('\n'),
    userPromptPayload: { working_diagnosis: dx, acuity },
    contextForDefenses: { working_diagnosis: dx },
    citations: [{
      source_type: 'working_diagnosis', source_id: shortHash(dx),
      label: dx.slice(0, 80), timestamp: null,
    }],
    metadata: { dx_hash: shortHash(dx), acuity },
    generatedBy, req,
  });
}

// ---------------------------------------------------------------------------
// 8-10. Drug-safety standalones (renal / liver / pregnancy-lactation)
// ---------------------------------------------------------------------------
async function drugSafetyCheck({
  moduleKey, label, prescriptionId, additionalContext, prompt, generatedBy, req, tenantId,
}) {
  const rxId = normalizeId(prescriptionId, 'prescription_id');
  const rx = (await safeQuery(
    `SELECT id, patient_uid, medication_name, dosage, frequency, duration, status
     FROM prescriptions WHERE id = $1 LIMIT 1`,
    [rxId],
  ))[0];
  if (!rx) throw AppError.notFound('Prescription not found');

  return runExplainerPipeline({
    moduleKey, tenantId,
    patientUid: rx.patient_uid || null, admissionId: null,
    systemPrompt: prompt,
    userPromptPayload: {
      prescription: { medication: rx.medication_name, dosage: rx.dosage,
                      frequency: rx.frequency, duration: rx.duration },
      ...additionalContext,
    },
    contextForDefenses: { prescription: rx, ...additionalContext },
    citations: [{ source_type: 'prescription', source_id: String(rx.id),
                  label: `${rx.medication_name} ${rx.dosage || ''}`.trim(), timestamp: null }],
    metadata: { prescription_id: rxId, label },
    generatedBy, req,
  });
}

export async function generateRenalDoseCheck({
  tenantId = null, prescriptionId, eGfr = null, creatinine = null,
  generatedBy = null, req = null,
} = {}) {
  return drugSafetyCheck({
    moduleKey: 'renal_dose_check', label: 'renal',
    prescriptionId, additionalContext: { eGFR_ml_min_1_73m2: eGfr, creatinine_mg_dl: creatinine },
    prompt: [
      'You are a hospital pharmacist assistant. Review the prescription against the patient renal function.',
      'Output: explanation_summary, dose_adjustment_recommended: yes|no|unclear, suggested_adjustment, rationale, severity: low|moderate|high|critical.',
      'Cite the drug renal-adjustment guidance you referenced. If eGFR is missing, request it via safety_flags rather than assume normal renal function.',
      'NEVER auto-change the prescription.',
    ].join('\n'),
    tenantId, generatedBy, req,
  });
}

export async function generateLiverDoseCheck({
  tenantId = null, prescriptionId, ast = null, alt = null, bilirubin = null,
  childPugh = null,
  generatedBy = null, req = null,
} = {}) {
  return drugSafetyCheck({
    moduleKey: 'liver_dose_check', label: 'liver',
    prescriptionId,
    additionalContext: { AST_U_L: ast, ALT_U_L: alt, bilirubin_mg_dl: bilirubin, child_pugh: childPugh },
    prompt: [
      'You are a hospital pharmacist assistant. Review the prescription against the patient hepatic function.',
      'Output: explanation_summary, dose_adjustment_recommended, suggested_adjustment, rationale, severity, child_pugh_category_used.',
      'Cite the drug hepatic-adjustment guidance. Flag ambiguity rather than guess. NEVER auto-change.',
    ].join('\n'),
    tenantId, generatedBy, req,
  });
}

export async function generatePregnancyLactationWarning({
  tenantId = null, prescriptionId, pregnancyStatus = null, lactationStatus = null,
  trimester = null,
  generatedBy = null, req = null,
} = {}) {
  return drugSafetyCheck({
    moduleKey: 'pregnancy_lactation_warning', label: 'pregnancy_lactation',
    prescriptionId,
    additionalContext: { pregnancy_status: pregnancyStatus, lactation_status: lactationStatus, trimester },
    prompt: [
      'You are a hospital pharmacist assistant. Review the prescription against the patient pregnancy / lactation status.',
      'Output: explanation_summary, risk_category: A|B|C|D|X|unknown, recommendation: continue|substitute|avoid|consult, rationale.',
      'Cite the source (FDA category / Briggs / other). NEVER auto-change. If pregnancy/lactation status missing, ask for it via safety_flags.',
    ].join('\n'),
    tenantId, generatedBy, req,
  });
}

// ---------------------------------------------------------------------------
// 11. Adverse drug event detector
// ---------------------------------------------------------------------------
export async function generateAdverseDrugEventDetection({
  tenantId = null, patientUid, signal,
  generatedBy = null, req = null,
} = {}) {
  const uid = requireUuid(patientUid, 'patient_uid');
  if (!signal || typeof signal !== 'object') {
    throw AppError.badRequest('signal must be an object describing the symptom/lab/vital');
  }
  const meds = await safeQuery(
    `SELECT id, medication_name, dosage, frequency, duration, prescribed_at
     FROM prescriptions
     WHERE patient_uid = $1::uuid AND status IN ('active', 'ongoing')
     ORDER BY prescribed_at DESC LIMIT 25`,
    [uid],
  );

  return runExplainerPipeline({
    moduleKey: 'adverse_drug_event_detector',
    tenantId, patientUid: uid, admissionId: null,
    systemPrompt: [
      'You are a clinical pharmacist. Decide whether the patient signal is a likely adverse drug event for any active medication.',
      'Output: explanation_summary, likely_ade: yes|no|uncertain, candidate_drugs (array of { medication, mechanism, naranjo_band: definite|probable|possible|doubtful, recommended_action }).',
      'Use the Naranjo algorithm framing. Cite the medication source. Defer to clinical judgement.',
    ].join('\n'),
    userPromptPayload: { signal, active_medications: meds },
    contextForDefenses: { signal, meds },
    citations: meds.slice(0, 5).map((m) => ({
      source_type: 'prescription', source_id: String(m.id),
      label: `${m.medication_name} ${m.dosage || ''}`.trim(), timestamp: m.prescribed_at,
    })),
    metadata: { signal_hash: shortHash(signal), active_med_count: meds.length },
    generatedBy, req,
  });
}

// ---------------------------------------------------------------------------
// 12. Fall risk prediction (wraps fall_risk_assessments from F2)
// ---------------------------------------------------------------------------
export async function generateFallRiskPrediction({
  tenantId = null, patientUid, generatedBy = null, req = null,
} = {}) {
  const uid = requireUuid(patientUid, 'patient_uid');
  const recent = await safeQuery(
    `SELECT id, scale, score, risk_level, factors, interventions, recorded_at
     FROM fall_risk_assessments
     WHERE patient_uid = $1::uuid
     ORDER BY recorded_at DESC LIMIT 5`,
    [uid],
  );
  if (!recent.length) {
    throw AppError.notFound('No fall_risk_assessments rows found — record one first via /clinical/assessments/fall-risk');
  }

  return runExplainerPipeline({
    moduleKey: 'fall_risk_prediction',
    tenantId, patientUid: uid, admissionId: null,
    systemPrompt: [
      'You are a clinical risk model. Predict the patient fall risk over the next 24-72 hours.',
      'Output: explanation_summary, predicted_risk_level: low|medium|high|very_high, predicted_probability_24h (0..1), trend_vs_prior (improving|stable|worsening), recommended_interventions (array).',
      'Use the supplied recent_assessments (most recent first). If only one assessment exists, mark trend_vs_prior=baseline.',
    ].join('\n'),
    userPromptPayload: {
      recent_assessments: recent.map((a) => ({
        scale: a.scale, score: a.score, risk_level: a.risk_level,
        factors: a.factors, recorded_at: a.recorded_at,
      })),
    },
    contextForDefenses: { recent_assessments: recent },
    citations: recent.slice(0, 3).map((a) => ({
      source_type: 'fall_risk_assessment', source_id: String(a.id),
      label: `${a.scale} ${a.score} (${a.risk_level})`, timestamp: a.recorded_at,
    })),
    metadata: { sample_size: recent.length },
    generatedBy, req,
  });
}

// ---------------------------------------------------------------------------
// 13. Pressure ulcer risk prediction
// ---------------------------------------------------------------------------
export async function generatePressureUlcerRiskPrediction({
  tenantId = null, patientUid, admissionId,
  bradenScore = null, mobilityNotes = null,
  generatedBy = null, req = null,
} = {}) {
  const uid = requireUuid(patientUid, 'patient_uid');
  const admId = normalizeId(admissionId, 'admission_id');

  return runExplainerPipeline({
    moduleKey: 'pressure_ulcer_risk_prediction',
    tenantId, patientUid: uid, admissionId: admId,
    systemPrompt: [
      'You are a nursing risk model. Predict pressure-ulcer risk over the next admission day.',
      'Output: explanation_summary, predicted_risk_level: low|medium|high|very_high, recommended_interventions (turning frequency, surface, nutrition, moisture management).',
      'Cite the scale you used (Braden / Norton). If braden_score is missing flag it; never invent it.',
    ].join('\n'),
    userPromptPayload: {
      braden_score: bradenScore,
      mobility_notes: mobilityNotes ? String(mobilityNotes).slice(0, 1500) : null,
    },
    contextForDefenses: { braden_score: bradenScore, mobility_notes: mobilityNotes },
    citations: [{
      source_type: 'admission', source_id: String(admId),
      label: `Admission #${admId} pressure-ulcer scoring`, timestamp: null,
    }],
    metadata: { admission_id: admId },
    generatedBy, req,
  });
}

// ---------------------------------------------------------------------------
// 14. AKI risk alert
// ---------------------------------------------------------------------------
export async function generateAkiRiskAlert({
  tenantId = null, patientUid,
  generatedBy = null, req = null,
} = {}) {
  const uid = requireUuid(patientUid, 'patient_uid');
  const creats = await safeQuery(
    `SELECT id, test_name, result_value, result_unit, completed_at
     FROM investigations
     WHERE patient_uid = $1::uuid
       AND LOWER(test_name) IN ('creatinine', 'serum creatinine', 'egfr')
       AND completed_at IS NOT NULL
     ORDER BY completed_at DESC LIMIT 8`,
    [uid],
  );
  const meds = await safeQuery(
    `SELECT id, medication_name, dosage, prescribed_at
     FROM prescriptions
     WHERE patient_uid = $1::uuid AND status IN ('active', 'ongoing')
     ORDER BY prescribed_at DESC LIMIT 30`,
    [uid],
  );

  return runExplainerPipeline({
    moduleKey: 'aki_risk_alert',
    tenantId, patientUid: uid, admissionId: null,
    systemPrompt: [
      'You are a clinical AKI surveillance assistant. Decide whether the patient is at acute kidney injury risk.',
      'Use the KDIGO definition (creatinine rise >=0.3 mg/dL within 48h OR >=1.5x baseline).',
      'Output: explanation_summary, aki_stage: none|stage_1|stage_2|stage_3|undetermined, nephrotoxic_drug_concerns (array), recommended_actions.',
      'If creatinine series is too short or absent, mark undetermined and request more data via safety_flags. NEVER fabricate creatinine values.',
    ].join('\n'),
    userPromptPayload: {
      recent_creatinine: creats.map((c) => ({
        value: c.result_value, unit: c.result_unit, at: c.completed_at,
      })),
      active_medications: meds.map((m) => ({ name: m.medication_name, dose: m.dosage })),
    },
    contextForDefenses: { creats, meds },
    citations: creats.slice(0, 3).map((c) => ({
      source_type: 'investigation', source_id: String(c.id),
      label: `${c.test_name} ${c.result_value}${c.result_unit || ''}`,
      timestamp: c.completed_at,
    })),
    metadata: { creatinine_sample_size: creats.length, active_med_count: meds.length },
    generatedBy, req,
  });
}

// ---------------------------------------------------------------------------
// 15. Intake / output summary
// ---------------------------------------------------------------------------
export async function generateIntakeOutputSummary({
  tenantId = null, admissionId, dateIso = null,
  generatedBy = null, req = null,
} = {}) {
  const admId = normalizeId(admissionId, 'admission_id');
  const adm = (await safeQuery(
    `SELECT id, patient_uid FROM admissions WHERE id = $1 LIMIT 1`, [admId],
  ))[0];
  if (!adm) throw AppError.notFound('Admission not found');

  const day = dateIso ? String(dateIso).slice(0, 10) : null;
  const ioParams = day ? [admId, day] : [admId];
  const io = await safeQuery(
    day
      ? `SELECT id, io_type, amount_ml, recorded_at
         FROM intake_output
         WHERE admission_id = $1 AND recorded_at::date = $2::date
         ORDER BY recorded_at ASC`
      : `SELECT id, io_type, amount_ml, recorded_at
         FROM intake_output
         WHERE admission_id = $1 AND recorded_at >= NOW() - INTERVAL '1 day'
         ORDER BY recorded_at ASC`,
    ioParams,
  );
  if (!io.length) {
    throw AppError.notFound('No intake_output rows found for the specified day');
  }

  const intake = io.filter((r) => /intake|fluid_in|po|iv/i.test(r.io_type || ''))
    .reduce((s, r) => s + Number(r.amount_ml || 0), 0);
  const output = io.filter((r) => /output|urine|drain|emesis|stool/i.test(r.io_type || ''))
    .reduce((s, r) => s + Number(r.amount_ml || 0), 0);

  return runExplainerPipeline({
    moduleKey: 'intake_output_summary',
    tenantId, patientUid: adm.patient_uid, admissionId: admId,
    systemPrompt: [
      'You are a clinical scribe. Summarise the patient intake / output for the day.',
      'Output: explanation_summary, intake_total_ml, output_total_ml, net_balance_ml, by_type (object), notable_trends, recommended_actions.',
      'Cite the I/O entries by id. Compute totals from supplied data only.',
    ].join('\n'),
    userPromptPayload: {
      day,
      intake_total_ml: intake, output_total_ml: output,
      net_balance_ml: intake - output,
      entries: io.map((r) => ({ id: r.id, type: r.io_type, ml: r.amount_ml, at: r.recorded_at })),
    },
    contextForDefenses: { entries: io, intake, output },
    citations: io.slice(0, 5).map((r) => ({
      source_type: 'intake_output', source_id: String(r.id),
      label: `${r.io_type} ${r.amount_ml}ml`, timestamp: r.recorded_at,
    })),
    metadata: { admission_id: admId, day, entry_count: io.length },
    generatedBy, req,
  });
}

// ---------------------------------------------------------------------------
// 16. ICU round summary
// ---------------------------------------------------------------------------
export async function generateIcuRoundSummary({
  tenantId = null, admissionId,
  generatedBy = null, req = null,
} = {}) {
  const admId = normalizeId(admissionId, 'admission_id');
  const adm = (await safeQuery(
    `SELECT id, patient_uid, admission_date, primary_diagnosis,
            secondary_diagnoses, ward, bed_number
     FROM admissions WHERE id = $1 LIMIT 1`,
    [admId],
  ))[0];
  if (!adm) throw AppError.notFound('Admission not found');

  const recentVitals = await safeQuery(
    `SELECT id, recorded_at, heart_rate, systolic_bp, diastolic_bp, spo2, temperature_c, respiratory_rate
     FROM vitals_chart WHERE admission_id = $1
     ORDER BY recorded_at DESC LIMIT 10`,
    [admId],
  );
  const overnightNotes = await safeQuery(
    `SELECT id, note_type, note_text, author_role, created_at
     FROM clinical_notes WHERE admission_id = $1 AND created_at >= NOW() - INTERVAL '24 hours'
     ORDER BY created_at DESC LIMIT 10`,
    [admId],
  );
  const activeOrders = await safeQuery(
    `SELECT id, order_type, details, status, created_at
     FROM clinical_orders WHERE admission_id = $1 AND status IN ('pending','active','in_progress')
     ORDER BY created_at DESC LIMIT 30`,
    [admId],
  );

  return runExplainerPipeline({
    moduleKey: 'icu_round_summary',
    tenantId, patientUid: adm.patient_uid, admissionId: admId,
    systemPrompt: [
      'You are an ICU scribe. Produce the per-patient round summary for the rounding team.',
      'Output: explanation_summary, problem_list (array of { problem, status }), overnight_events (array), today_plan (array), pending_items (array).',
      'Cite the supplied data items. Quote diagnoses verbatim. Do not introduce new diagnoses or orders not present in the source.',
    ].join('\n'),
    userPromptPayload: {
      admission: { ward: adm.ward, bed_number: adm.bed_number,
                   primary_diagnosis: adm.primary_diagnosis,
                   secondary_diagnoses: adm.secondary_diagnoses },
      recent_vitals: recentVitals.slice(0, 5),
      overnight_notes: overnightNotes.map((n) => ({
        type: n.note_type, role: n.author_role,
        text: String(n.note_text || '').slice(0, 800), at: n.created_at,
      })),
      active_orders: activeOrders.map((o) => ({ id: o.id, type: o.order_type,
                                                details: o.details, status: o.status })),
    },
    contextForDefenses: { admission: adm, vitals: recentVitals,
                          notes: overnightNotes, orders: activeOrders },
    citations: [
      { source_type: 'admission', source_id: String(admId),
        label: `Admission #${admId}`, timestamp: adm.admission_date },
      ...overnightNotes.slice(0, 2).map((n) => ({
        source_type: 'clinical_note', source_id: String(n.id),
        label: `${n.note_type || 'note'} (${n.author_role || 'unknown'})`,
        timestamp: n.created_at,
      })),
    ],
    metadata: {
      admission_id: admId, vitals_sample: recentVitals.length,
      overnight_notes: overnightNotes.length, active_orders: activeOrders.length,
    },
    generatedBy, req,
  });
}

export const __testing__ = { shortHash, isMissingSchemaError };

export default {
  generateMedicalCertificateDraft,
  generateClinicLetterDraft,
  generateClinicalNoteCleanup,
  generateMissingQuestionsAssistant,
  generateMissingExaminationAssistant,
  generateMissingTestsAssistant,
  generateOrderSetSuggestion,
  generateRenalDoseCheck,
  generateLiverDoseCheck,
  generatePregnancyLactationWarning,
  generateAdverseDrugEventDetection,
  generateFallRiskPrediction,
  generatePressureUlcerRiskPrediction,
  generateAkiRiskAlert,
  generateIntakeOutputSummary,
  generateIcuRoundSummary,
};
