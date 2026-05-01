/**
 * Tier D — emergency / triage AI assistants. 9 modules wrapping the
 * Phase D4 ED entities (emergency_visits / triage_assessments /
 * ambulance_requests / mlc_records).
 *
 * Modules registered by migration 135:
 *   emergency_triage_form_assistant, triage_priority_suggestion,
 *   ed_red_flag_detection, emergency_visit_summary,
 *   ambulance_handover_summary, stroke_fast_check_assistant,
 *   chest_pain_protocol_assistant, trauma_checklist_assistant,
 *   mlc_documentation_assistant.
 *
 * All decision-support only — every output enqueues a clinical_ai_reviews
 * 'pending' row. Many ED modules carry a critical risk label so the
 * registry settings require two-person enablement for go-live.
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
// 1. Emergency triage form assistant — drafts the triage form from a transcript
// ---------------------------------------------------------------------------
export async function generateEmergencyTriageForm({
  tenantId = null, transcript, ageYears = null, sex = null,
  generatedBy = null, req = null,
} = {}) {
  const text = requireText(transcript, 'transcript', { min: 30 });
  return runExplainerPipeline({
    moduleKey: 'emergency_triage_form_assistant',
    tenantId, patientUid: null, admissionId: null,
    systemPrompt: [
      'You are an ED triage scribe. Draft the triage form (vitals captured / chief complaint / HPI / initial impression) from a first-contact transcript.',
      'Output: explanation_summary, triage_form (object: vitals_captured, chief_complaint, hpi, initial_impression, immediate_actions).',
      'Quote the transcript span when citing a value. Do NOT invent vitals; if a vital is not in the transcript, leave it null.',
    ].join('\n'),
    userPromptPayload: { transcript: text, age_years: ageYears, sex },
    contextForDefenses: { transcript: text },
    citations: [{
      source_type: 'first_contact_transcript', source_id: shortHash(text),
      label: `First-contact transcript (${text.length} chars)`, timestamp: null,
    }],
    metadata: { transcript_chars: text.length },
    generatedBy, req,
  });
}

// ---------------------------------------------------------------------------
// 2. Triage priority suggestion — ESI / Manchester
// ---------------------------------------------------------------------------
export async function generateTriagePrioritySuggestion({
  tenantId = null, scale = 'ESI', vitals = null, chiefComplaint, ageYears = null,
  redFlagsObserved = [],
  generatedBy = null, req = null,
} = {}) {
  const cleanScale = String(scale || 'ESI').toUpperCase();
  if (!['ESI', 'MANCHESTER', 'CTAS'].includes(cleanScale)) {
    throw AppError.badRequest('scale must be ESI | MANCHESTER | CTAS');
  }
  const cc = requireText(chiefComplaint, 'chief_complaint', { min: 3, max: 500 });

  return runExplainerPipeline({
    moduleKey: 'triage_priority_suggestion',
    tenantId, patientUid: null, admissionId: null,
    systemPrompt: [
      `You are an ED triage assistant. Suggest a ${cleanScale} priority for this patient.`,
      'Output: explanation_summary, priority (per-scale value), confidence: low|medium|high, key_drivers (array), red_flags_present (array).',
      `${cleanScale} value spaces:`,
      '  ESI 1=resuscitation, 2=emergent, 3=urgent, 4=less urgent, 5=non-urgent',
      '  MANCHESTER RED|ORANGE|YELLOW|GREEN|BLUE',
      '  CTAS 1=resuscitation, 2=emergent, 3=urgent, 4=less urgent, 5=non-urgent',
      'Cite which vital or red flag drove the priority. NEVER auto-assign — triage nurse signs.',
    ].join('\n'),
    userPromptPayload: {
      scale: cleanScale, chief_complaint: cc, age_years: ageYears,
      vitals: vitals || {}, red_flags_observed: Array.isArray(redFlagsObserved) ? redFlagsObserved : [],
    },
    contextForDefenses: { vitals, chief_complaint: cc },
    citations: [{
      source_type: 'chief_complaint', source_id: shortHash(cc),
      label: cc.slice(0, 80), timestamp: null,
    }],
    metadata: { scale: cleanScale, cc_hash: shortHash(cc) },
    generatedBy, req,
  });
}

// ---------------------------------------------------------------------------
// 3. ED red-flag detection
// ---------------------------------------------------------------------------
export async function generateEdRedFlagDetection({
  tenantId = null, chiefComplaint, vitals = null, ageYears = null,
  generatedBy = null, req = null,
} = {}) {
  const cc = requireText(chiefComplaint, 'chief_complaint', { min: 3, max: 500 });

  return runExplainerPipeline({
    moduleKey: 'ed_red_flag_detection',
    tenantId, patientUid: null, admissionId: null,
    systemPrompt: [
      'You are an ED first-contact red-flag screener. Surface suspected stroke / sepsis / MI / DKA / anaphylaxis / pediatric red flags / pregnancy emergencies / surgical abdomen.',
      'Output: explanation_summary, red_flags (array of { syndrome, supporting_signs, recommended_immediate_action, severity: critical|urgent|attention }).',
      'Cite which finding triggered each flag. Never miss life threats; always default to escalating ambiguous cases.',
    ].join('\n'),
    userPromptPayload: {
      chief_complaint: cc, age_years: ageYears,
      vitals: vitals || {},
    },
    contextForDefenses: { chief_complaint: cc, vitals },
    citations: [{
      source_type: 'chief_complaint', source_id: shortHash(cc),
      label: cc.slice(0, 80), timestamp: null,
    }],
    metadata: { cc_hash: shortHash(cc) },
    generatedBy, req,
  });
}

// ---------------------------------------------------------------------------
// 4. Emergency visit summary — wraps emergency_visits row
// ---------------------------------------------------------------------------
export async function generateEmergencyVisitSummary({
  tenantId = null, emergencyVisitId,
  generatedBy = null, req = null,
} = {}) {
  const visitId = normalizeId(emergencyVisitId, 'emergency_visit_id');
  const visit = (await safeQuery(
    `SELECT id, patient_uid, arrival_at, disposition_at, disposition,
            chief_complaint, presenting_complaint_summary, current_state
     FROM emergency_visits WHERE id = $1 LIMIT 1`,
    [visitId],
  ))[0];
  if (!visit) throw AppError.notFound('Emergency visit not found');

  const triage = await safeQuery(
    `SELECT id, scale, score, priority, recorded_at, notes
     FROM triage_assessments WHERE emergency_visit_id = $1
     ORDER BY recorded_at DESC LIMIT 5`,
    [visitId],
  );

  return runExplainerPipeline({
    moduleKey: 'emergency_visit_summary',
    tenantId, patientUid: visit.patient_uid, admissionId: null,
    systemPrompt: [
      'You are an ED scribe. Produce an end-of-visit summary for handover or patient discharge instructions.',
      'Output: explanation_summary, presentation, key_findings (array), interventions (array), disposition, follow_up_instructions, when_to_return (red flags).',
      'Quote the emergency_visit row + triage assessments. Do not invent diagnoses or interventions.',
    ].join('\n'),
    userPromptPayload: {
      visit: {
        arrival_at: visit.arrival_at, disposition_at: visit.disposition_at,
        disposition: visit.disposition,
        chief_complaint: visit.chief_complaint,
        presenting_complaint_summary: visit.presenting_complaint_summary,
        current_state: visit.current_state,
      },
      triage_assessments: triage,
    },
    contextForDefenses: { visit, triage },
    citations: [
      { source_type: 'emergency_visit', source_id: String(visit.id),
        label: `ED visit #${visit.id}`, timestamp: visit.arrival_at },
      ...triage.slice(0, 2).map((t) => ({
        source_type: 'triage_assessment', source_id: String(t.id),
        label: `${t.scale} ${t.priority || t.score}`, timestamp: t.recorded_at,
      })),
    ],
    metadata: { emergency_visit_id: visitId, triage_count: triage.length },
    generatedBy, req,
  });
}

// ---------------------------------------------------------------------------
// 5. Ambulance handover summary
// ---------------------------------------------------------------------------
export async function generateAmbulanceHandoverSummary({
  tenantId = null, ambulanceRequestId,
  generatedBy = null, req = null,
} = {}) {
  const ambId = normalizeId(ambulanceRequestId, 'ambulance_request_id');
  const amb = (await safeQuery(
    `SELECT id, patient_uid, dispatched_at, scene_arrived_at, hospital_arrived_at,
            status, dispatch_kind, scene_observations, en_route_interventions,
            chief_complaint, vitals_on_pickup
     FROM ambulance_requests WHERE id = $1 LIMIT 1`,
    [ambId],
  ))[0];
  if (!amb) throw AppError.notFound('Ambulance request not found');

  return runExplainerPipeline({
    moduleKey: 'ambulance_handover_summary',
    tenantId, patientUid: amb.patient_uid, admissionId: null,
    systemPrompt: [
      'You are an ED triage scribe. Draft an SBAR-style ambulance → ED handover from the ambulance_request row.',
      'Output: explanation_summary, sbar (object with situation, background, assessment, recommendation), critical_gaps (array — what info is missing).',
      'Quote scene_observations / en_route_interventions verbatim. Do not invent vitals or interventions.',
    ].join('\n'),
    userPromptPayload: {
      dispatched_at: amb.dispatched_at, scene_arrived_at: amb.scene_arrived_at,
      hospital_arrived_at: amb.hospital_arrived_at,
      dispatch_kind: amb.dispatch_kind, status: amb.status,
      chief_complaint: amb.chief_complaint,
      vitals_on_pickup: amb.vitals_on_pickup,
      scene_observations: amb.scene_observations,
      en_route_interventions: amb.en_route_interventions,
    },
    contextForDefenses: { ambulance_request: amb },
    citations: [{
      source_type: 'ambulance_request', source_id: String(amb.id),
      label: `Ambulance request #${amb.id}`, timestamp: amb.dispatched_at,
    }],
    metadata: { ambulance_request_id: ambId },
    generatedBy, req,
  });
}

// ---------------------------------------------------------------------------
// 6. Stroke FAST check assistant
// ---------------------------------------------------------------------------
export async function generateStrokeFastCheckAssistant({
  tenantId = null, observations,
  patientUid = null, emergencyVisitId = null,
  generatedBy = null, req = null,
} = {}) {
  const obs = requireText(observations, 'observations', { min: 5 });
  const visitId = emergencyVisitId ? normalizeId(emergencyVisitId, 'emergency_visit_id') : null;

  return runExplainerPipeline({
    moduleKey: 'stroke_fast_check_assistant',
    tenantId,
    patientUid: patientUid ? maybeUuid(patientUid, 'patient_uid') : null,
    admissionId: null,
    systemPrompt: [
      'You are an ED stroke screener. Convert the supplied observations into a FAST checklist.',
      'Output: explanation_summary, fast (object: face_droop, arm_drift, speech_difficulty, time_of_onset_known, last_known_well, suspected_stroke: yes|no|unclear), recommended_actions (array — CT head, endovascular pathway, time-window check).',
      'Cite which observation triggered each FAST element. Default to escalating; never downgrade an unclear case.',
    ].join('\n'),
    userPromptPayload: { observations: obs, emergency_visit_id: visitId },
    contextForDefenses: { observations: obs },
    citations: [{
      source_type: 'observation_text', source_id: shortHash(obs),
      label: `Observations (${obs.length} chars)`, timestamp: null,
    }],
    metadata: { obs_chars: obs.length, emergency_visit_id: visitId },
    generatedBy, req,
  });
}

// ---------------------------------------------------------------------------
// 7. Chest pain protocol assistant
// ---------------------------------------------------------------------------
export async function generateChestPainProtocol({
  tenantId = null, observations, riskFactors = [],
  ecg = null, troponin = null,
  patientUid = null, emergencyVisitId = null,
  generatedBy = null, req = null,
} = {}) {
  const obs = requireText(observations, 'observations', { min: 5 });
  const visitId = emergencyVisitId ? normalizeId(emergencyVisitId, 'emergency_visit_id') : null;

  return runExplainerPipeline({
    moduleKey: 'chest_pain_protocol_assistant',
    tenantId,
    patientUid: patientUid ? maybeUuid(patientUid, 'patient_uid') : null,
    admissionId: null,
    systemPrompt: [
      'You are an ED chest-pain assistant. Produce a HEART-score-aligned workup recommendation.',
      'Output: explanation_summary, features (typical|atypical|cannot_classify), heart_score_components (history, ecg, age, risk_factors, troponin — each with score 0/1/2 and rationale), heart_total, risk_band: low|moderate|high, recommended_pathway (rule out, observation, urgent cath, etc.).',
      'Cite which input fed which component. If ECG or troponin missing, mark unknown — do not invent.',
    ].join('\n'),
    userPromptPayload: {
      observations: obs,
      risk_factors: Array.isArray(riskFactors) ? riskFactors : [],
      ecg, troponin, emergency_visit_id: visitId,
    },
    contextForDefenses: { observations: obs, risk_factors: riskFactors, ecg, troponin },
    citations: [{
      source_type: 'observation_text', source_id: shortHash(obs),
      label: `Observations (${obs.length} chars)`, timestamp: null,
    }],
    metadata: { obs_chars: obs.length, emergency_visit_id: visitId },
    generatedBy, req,
  });
}

// ---------------------------------------------------------------------------
// 8. Trauma checklist assistant
// ---------------------------------------------------------------------------
export async function generateTraumaChecklist({
  tenantId = null, observations, mechanism = null,
  patientUid = null, emergencyVisitId = null,
  generatedBy = null, req = null,
} = {}) {
  const obs = requireText(observations, 'observations', { min: 5 });
  const visitId = emergencyVisitId ? normalizeId(emergencyVisitId, 'emergency_visit_id') : null;

  return runExplainerPipeline({
    moduleKey: 'trauma_checklist_assistant',
    tenantId,
    patientUid: patientUid ? maybeUuid(patientUid, 'patient_uid') : null,
    admissionId: null,
    systemPrompt: [
      'You are an ED trauma resuscitation assistant. Produce an ATLS-aligned checklist.',
      'Output: explanation_summary, primary_survey (object: airway, breathing, circulation, disability, exposure — each with status: clear|concern|critical and what to do), secondary_survey_gaps (array), immediate_imaging (FAST, CT, X-ray), recommended_team_alerts.',
      'Cite which observation triggered each concern. Never replace the trauma team leader; surface gaps so they decide.',
    ].join('\n'),
    userPromptPayload: { observations: obs, mechanism, emergency_visit_id: visitId },
    contextForDefenses: { observations: obs, mechanism },
    citations: [{
      source_type: 'observation_text', source_id: shortHash(obs),
      label: `Trauma observations (${obs.length} chars)`, timestamp: null,
    }],
    metadata: { obs_chars: obs.length, emergency_visit_id: visitId },
    generatedBy, req,
  });
}

// ---------------------------------------------------------------------------
// 9. MLC documentation assistant
// ---------------------------------------------------------------------------
export async function generateMlcDocumentation({
  tenantId = null, mlcRecordId,
  generatedBy = null, req = null,
} = {}) {
  const mlcId = normalizeId(mlcRecordId, 'mlc_record_id');
  const mlc = (await safeQuery(
    `SELECT id, emergency_visit_id, mlc_kind, status, opened_at, closed_at,
            informant_relationship, alleged_history, examination_summary,
            police_station, fir_number, ipc_sections, mlc_number
     FROM mlc_records WHERE id = $1 LIMIT 1`,
    [mlcId],
  ))[0];
  if (!mlc) throw AppError.notFound('MLC record not found');

  let visit = null;
  if (mlc.emergency_visit_id) {
    visit = (await safeQuery(
      `SELECT id, patient_uid, arrival_at, chief_complaint
       FROM emergency_visits WHERE id = $1 LIMIT 1`,
      [mlc.emergency_visit_id],
    ))[0] || null;
  }

  return runExplainerPipeline({
    moduleKey: 'mlc_documentation_assistant',
    tenantId, patientUid: visit?.patient_uid || null, admissionId: null,
    systemPrompt: [
      'You are a hospital medico-legal documentation assistant.',
      'Draft a complete MLC pack from the supplied row + linked emergency_visit. Cover: alleged history (verbatim, in patient/informant words), examination summary, time/date relationships, police-notification fields, IPC/CrPC sections invoked.',
      'Output: explanation_summary, mlc_pack (object), gaps (array — fields that need clinician completion), regulatory_flags (array — any field that affects police-notification timeline).',
      'Quote alleged_history and examination_summary verbatim. Do not edit those fields.',
      'Never invent IPC sections or police-station names; if missing, surface in gaps.',
    ].join('\n'),
    userPromptPayload: { mlc_record: mlc, emergency_visit: visit },
    contextForDefenses: { mlc, visit },
    citations: [
      { source_type: 'mlc_record', source_id: String(mlc.id),
        label: `MLC #${mlc.mlc_number || mlc.id} (${mlc.mlc_kind})`, timestamp: mlc.opened_at },
      ...(visit ? [{ source_type: 'emergency_visit', source_id: String(visit.id),
                     label: `ED visit #${visit.id}`, timestamp: visit.arrival_at }] : []),
    ],
    metadata: { mlc_record_id: mlcId, mlc_kind: mlc.mlc_kind },
    generatedBy, req,
  });
}

export const __testing__ = { shortHash, isMissingSchemaError };

export default {
  generateEmergencyTriageForm,
  generateTriagePrioritySuggestion,
  generateEdRedFlagDetection,
  generateEmergencyVisitSummary,
  generateAmbulanceHandoverSummary,
  generateStrokeFastCheckAssistant,
  generateChestPainProtocol,
  generateTraumaChecklist,
  generateMlcDocumentation,
};
