import crypto from 'crypto';

import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { getClinicalAiModule } from './clinicalAiModuleService.js';
import { runExplainerPipeline } from './patientExplainersService.js';
import { reviewPolypharmacy } from './polypharmacyAiService.js';

export const OPD_AI_MODULES = [
  {
    key: 'op_visit_prep',
    label: 'OP Visit Prep',
    purpose: 'Pre-consult doctor brief from appointment and chart context.',
  },
  {
    key: 'polypharmacy_ai_review',
    label: 'Prescription Safety Assistant',
    purpose: 'Rules plus AI advisory review of a medication list.',
  },
  {
    key: 'soap_from_dictation',
    label: 'Voice Note to SOAP Draft',
    purpose: 'Convert clinician voice-note transcripts into reviewable SOAP drafts.',
  },
  {
    key: 'op_investigation_review',
    label: 'Investigation Review Aid',
    purpose: 'Doctor-facing interpretation aid for OP lab/radiology results.',
  },
  {
    key: 'op_differential_red_flags',
    label: 'Differential / Red Flag Checklist',
    purpose: 'Differentials to consider, red flags, and next checks.',
  },
  {
    key: 'op_follow_up_plan',
    label: 'Follow-Up Plan Draft',
    purpose: 'Monitoring, repeat tests, review timing, and escalation cues.',
  },
  {
    key: 'op_referral_draft',
    label: 'Referral / Second Opinion Draft',
    purpose: 'Structured referral draft for clinician editing.',
  },
];

const TEXT_MAX = 12_000;

function isMissingSchemaError(err) {
  return /does not exist|relation .* does not exist|column .* does not exist/i.test(String(err?.message || ''));
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

function normalizeId(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw AppError.badRequest(`${label} must be a positive integer`);
  }
  return parsed;
}

function maybeUuid(value, label = 'patient_uid') {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i.test(text)) {
    throw AppError.badRequest(`${label} must be a UUID`);
  }
  return text;
}

function requireText(value, label, { min = 3, max = TEXT_MAX } = {}) {
  const text = String(value || '').trim();
  if (text.length < min) throw AppError.badRequest(`${label} must be at least ${min} characters`);
  return text.slice(0, max);
}

function shortHash(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload || {})).digest('hex').slice(0, 16);
}

function compactRows(rows, maxText = 1600) {
  return rows.map((row) => {
    const out = {};
    for (const [key, value] of Object.entries(row || {})) {
      if (value === null || value === undefined) continue;
      out[key] = typeof value === 'string' ? value.slice(0, maxText) : value;
    }
    return out;
  });
}

async function loadPatientContext({ tenantId, patientUid }) {
  if (!patientUid) {
    return {
      latest_prescriptions: [],
      latest_investigations: [],
      latest_notes: [],
      latest_diagnoses: [],
    };
  }

  const [prescriptions, investigations, notes, diagnoses] = await Promise.all([
    safeQuery(
      `SELECT id, prescription_number, diagnosis, medications, follow_up_date,
              follow_up_notes, created_at
         FROM e_prescriptions
        WHERE tenant_id = $1::uuid
          AND patient_uid = $2::uuid
        ORDER BY created_at DESC NULLS LAST, id DESC
        LIMIT 5`,
      [tenantId, patientUid],
    ),
    safeQuery(
      `SELECT id, test_name, test_type, status, result_value, result_unit,
              reference_range, abnormal_flag, interpretation, conclusion,
              notes, completed_at, created_at
         FROM investigations
        WHERE tenant_id = $1::uuid
          AND patient_uid = $2::uuid
        ORDER BY COALESCE(completed_at, created_at) DESC NULLS LAST, id DESC
        LIMIT 8`,
      [tenantId, patientUid],
    ),
    safeQuery(
      `SELECT id, note_type, title, content, author_role, is_signed, created_at
         FROM clinical_notes
        WHERE tenant_id = $1::uuid
          AND patient_uid = $2::uuid
        ORDER BY created_at DESC
        LIMIT 5`,
      [tenantId, patientUid],
    ),
    safeQuery(
      `SELECT id, icd10_code, icd10_description, description,
              diagnosis_type, severity, onset_date, created_at
         FROM diagnoses
        WHERE patient_uid = $1::uuid
        ORDER BY created_at DESC NULLS LAST, id DESC
        LIMIT 5`,
      [patientUid],
    ),
  ]);

  return {
    latest_prescriptions: compactRows(prescriptions),
    latest_investigations: compactRows(investigations),
    latest_notes: compactRows(notes),
    latest_diagnoses: compactRows(diagnoses),
  };
}

async function loadAppointmentContext({ tenantId, appointmentId }) {
  const apptId = normalizeId(appointmentId, 'appointment_id');
  const rows = await safeQuery(
    `SELECT a.id, a.uid, a.appointment_date, a.appointment_time, a.status,
            a.reason, a.notes, a.department, a.visit_no, a.token_number,
            a.triage_acuity, a.patient_id, a.doctor_id,
            p.uid AS patient_uid, p.name AS patient_name, p.phone AS patient_phone,
            p.gender AS patient_gender, p.birthday AS patient_birthday,
            p.blood_group, p.allergies, p.medical_history,
            d.uid AS doctor_uid, COALESCE(d.name, a.doctor_name) AS doctor_name
       FROM appointments a
       LEFT JOIN users p ON p.id = a.patient_id
       LEFT JOIN users d ON d.id = a.doctor_id
      WHERE a.id = $1
        AND a.tenant_id = $2::uuid
      LIMIT 1`,
    [apptId, tenantId],
  );
  const appointment = rows[0];
  if (!appointment) throw AppError.notFound('Appointment not found');
  const patientUid = appointment.patient_uid || null;
  return {
    appointment,
    patient_uid: patientUid,
    patient_context: await loadPatientContext({ tenantId, patientUid }),
  };
}

function opMetadata(kind, extra = {}) {
  return {
    ...extra,
    source: 'op_ai_assist',
    care_setting: 'opd',
    patient_facing: false,
    decision_support_only: true,
    op_ai_kind: kind,
  };
}

async function requireOpdModuleEnabled(moduleKey, { tenantId = null } = {}) {
  const module = await getClinicalAiModule(moduleKey, { tenantId });
  if (!module.enabled) {
    throw AppError.forbidden(`Clinical AI module is disabled: ${module.display_name || moduleKey}`);
  }
  return module;
}

export async function listOpdAiModules({ tenantId = null } = {}) {
  const modules = await Promise.all(
    OPD_AI_MODULES.map(async (config) => {
      const module = await getClinicalAiModule(config.key, { tenantId });
      return {
        ...config,
        module_key: config.key,
        enabled: Boolean(module.enabled),
        display_name: module.display_name || config.label,
        description: module.description || config.purpose,
        settings: module.settings || {},
      };
    }),
  );
  return { modules, count: modules.length };
}

export async function generateOpVisitPrep({
  tenantId = null, appointmentId, generatedBy = null, req = null,
} = {}) {
  await requireOpdModuleEnabled('op_visit_prep', { tenantId });
  const context = await loadAppointmentContext({ tenantId, appointmentId });
  const appointment = context.appointment;
  const patientUid = context.patient_uid;

  return runExplainerPipeline({
    moduleKey: 'op_visit_prep',
    tenantId,
    patientUid,
    admissionId: null,
    systemPrompt: [
      'You are a doctor-facing OPD visit-prep assistant.',
      'Produce a concise pre-consult brief: brief, active_problems, allergies_or_safety_notes, recent_results_to_review, medication_points, suggested_opening_questions.',
      'Use only the supplied chart context. Do not diagnose, do not recommend autonomous treatment, and do not write patient-facing text.',
    ].join('\n'),
    userPromptPayload: context,
    contextForDefenses: context,
    citations: [{
      source_type: 'appointment',
      source_id: String(appointment.id),
      label: appointment.visit_no || `Appointment #${appointment.id}`,
      timestamp: appointment.appointment_date,
    }],
    metadata: opMetadata('visit_prep', { appointment_id: appointment.id }),
    generatedBy,
    req,
  });
}

export async function generateOpInvestigationReview({
  tenantId = null, investigationId = null, patientUid = null, resultText = null,
  clinicalQuestion = null, generatedBy = null, req = null,
} = {}) {
  await requireOpdModuleEnabled('op_investigation_review', { tenantId });
  let uid = maybeUuid(patientUid, 'patient_uid');
  let investigation = null;
  let sourceText = resultText ? requireText(resultText, 'result_text', { min: 10 }) : null;
  const citations = [];

  if (investigationId) {
    const id = normalizeId(investigationId, 'investigation_id');
    const rows = await safeQuery(
      `SELECT id, patient_uid, test_name, test_type, status, result_value,
              result_unit, reference_range, abnormal_flag, structured_results,
              results, previous_results, interpretation, conclusion, notes,
              completed_at, created_at
         FROM investigations
        WHERE id = $1
          AND tenant_id = $2::uuid
        LIMIT 1`,
      [id, tenantId],
    );
    investigation = rows[0];
    if (!investigation) throw AppError.notFound('Investigation not found');
    uid = investigation.patient_uid || uid;
    citations.push({
      source_type: 'investigation',
      source_id: String(investigation.id),
      label: investigation.test_name || `Investigation #${investigation.id}`,
      timestamp: investigation.completed_at || investigation.created_at,
    });
  }

  if (!investigation && !sourceText) {
    throw AppError.badRequest('investigation_id or result_text is required');
  }

  const context = {
    investigation,
    result_text: sourceText,
    clinical_question: clinicalQuestion ? String(clinicalQuestion).slice(0, 1000) : null,
    patient_context: await loadPatientContext({ tenantId, patientUid: uid }),
  };

  if (!citations.length) {
    citations.push({
      source_type: 'free_text_investigation_result',
      source_id: shortHash(sourceText),
      label: `Free-text result (${sourceText.length} chars)`,
      timestamp: null,
    });
  }

  return runExplainerPipeline({
    moduleKey: 'op_investigation_review',
    tenantId,
    patientUid: uid,
    admissionId: null,
    systemPrompt: [
      'You are a doctor-facing OPD investigation review aid.',
      'Return summary, abnormalities, trend_or_prior_comparison, urgency_cues, suggested_clinical_correlation, and gaps_to_check.',
      'Do not diagnose. Do not provide patient-facing explanations. Do not recommend treatment changes without clinician review.',
    ].join('\n'),
    userPromptPayload: context,
    contextForDefenses: context,
    citations,
    metadata: opMetadata('investigation_review', {
      investigation_id: investigation?.id || null,
      result_hash: sourceText ? shortHash(sourceText) : null,
    }),
    generatedBy,
    req,
  });
}

export async function generateOpDifferentialRedFlags({
  tenantId = null, patientUid = null, chiefComplaint, ageYears = null,
  sex = null, vitals = null, examNotes = null, knownDiagnoses = [],
  generatedBy = null, req = null,
} = {}) {
  await requireOpdModuleEnabled('op_differential_red_flags', { tenantId });
  const uid = maybeUuid(patientUid, 'patient_uid');
  const complaint = requireText(chiefComplaint, 'chief_complaint', { min: 3, max: 2000 });
  const context = {
    chief_complaint: complaint,
    age_years: ageYears,
    sex,
    vitals: vitals || {},
    exam_notes: examNotes ? String(examNotes).slice(0, 3000) : null,
    known_diagnoses: Array.isArray(knownDiagnoses) ? knownDiagnoses : [],
    patient_context: await loadPatientContext({ tenantId, patientUid: uid }),
  };

  return runExplainerPipeline({
    moduleKey: 'op_differential_red_flags',
    tenantId,
    patientUid: uid,
    admissionId: null,
    systemPrompt: [
      'You are a doctor-facing OPD diagnostic support assistant.',
      'Return do_not_miss_red_flags, differentials_to_consider, suggested_history_questions, suggested_exam_checks, suggested_investigations, and uncertainty_notes.',
      'This is not a diagnosis. Do not tell the doctor what the diagnosis is. Do not auto-order anything.',
    ].join('\n'),
    userPromptPayload: context,
    contextForDefenses: context,
    citations: [{
      source_type: 'chief_complaint',
      source_id: shortHash(complaint),
      label: complaint.slice(0, 80),
      timestamp: null,
    }],
    metadata: opMetadata('differential_red_flags', { chief_complaint_hash: shortHash(complaint) }),
    generatedBy,
    req,
  });
}

export async function generateOpFollowUpPlan({
  tenantId = null, patientUid = null, diagnosis, treatmentPlan,
  monitoringContext = null, generatedBy = null, req = null,
} = {}) {
  await requireOpdModuleEnabled('op_follow_up_plan', { tenantId });
  const uid = maybeUuid(patientUid, 'patient_uid');
  const dx = requireText(diagnosis, 'diagnosis', { min: 3, max: 2000 });
  const plan = requireText(treatmentPlan, 'treatment_plan', { min: 3, max: 4000 });
  const context = {
    diagnosis: dx,
    treatment_plan: plan,
    monitoring_context: monitoringContext ? String(monitoringContext).slice(0, 4000) : null,
    patient_context: await loadPatientContext({ tenantId, patientUid: uid }),
  };

  return runExplainerPipeline({
    moduleKey: 'op_follow_up_plan',
    tenantId,
    patientUid: uid,
    admissionId: null,
    systemPrompt: [
      'You are a doctor-facing OPD follow-up planning assistant.',
      'Return follow_up_timing, monitoring_plan, repeat_tests, medication_monitoring, return_precautions_for_doctor_to_review, and documentation_gaps.',
      'Do not schedule appointments or send patient instructions. The doctor edits and signs.',
    ].join('\n'),
    userPromptPayload: context,
    contextForDefenses: context,
    citations: [{
      source_type: 'op_treatment_plan',
      source_id: shortHash({ dx, plan }),
      label: dx.slice(0, 80),
      timestamp: null,
    }],
    metadata: opMetadata('follow_up_plan', { diagnosis_hash: shortHash(dx) }),
    generatedBy,
    req,
  });
}

export async function generateOpReferralDraft({
  tenantId = null, patientUid = null, referralReason, clinicalSummary,
  targetSpecialty = null, currentTreatment = null, generatedBy = null, req = null,
} = {}) {
  await requireOpdModuleEnabled('op_referral_draft', { tenantId });
  const uid = maybeUuid(patientUid, 'patient_uid');
  const reason = requireText(referralReason, 'referral_reason', { min: 3, max: 2000 });
  const summary = requireText(clinicalSummary, 'clinical_summary', { min: 10, max: 6000 });
  const context = {
    referral_reason: reason,
    target_specialty: targetSpecialty ? String(targetSpecialty).slice(0, 200) : null,
    clinical_summary: summary,
    current_treatment: currentTreatment ? String(currentTreatment).slice(0, 4000) : null,
    patient_context: await loadPatientContext({ tenantId, patientUid: uid }),
  };

  return runExplainerPipeline({
    moduleKey: 'op_referral_draft',
    tenantId,
    patientUid: uid,
    admissionId: null,
    systemPrompt: [
      'You are a doctor-facing OPD referral drafting assistant.',
      'Return reason_for_referral, clinical_summary, current_treatment, investigations_attached, questions_for_specialist, urgency, and information_gaps.',
      'Do not invent findings. Do not send the referral. The doctor edits and signs.',
    ].join('\n'),
    userPromptPayload: context,
    contextForDefenses: context,
    citations: [{
      source_type: 'op_referral_context',
      source_id: shortHash({ reason, summary }),
      label: reason.slice(0, 80),
      timestamp: null,
    }],
    metadata: opMetadata('referral_draft', { reason_hash: shortHash(reason) }),
    generatedBy,
    req,
  });
}

export async function generateOpPrescriptionSafetyReview({
  patientId = null, patientUid = null, medications, admissionId = null, req = null,
} = {}) {
  return reviewPolypharmacy({
    patientId: patientId ? normalizeId(patientId, 'patient_id') : null,
    patientUid: maybeUuid(patientUid, 'patient_uid'),
    medications,
    admissionId,
    req,
  });
}

export default {
  OPD_AI_MODULES,
  listOpdAiModules,
  generateOpVisitPrep,
  generateOpInvestigationReview,
  generateOpDifferentialRedFlags,
  generateOpFollowUpPlan,
  generateOpReferralDraft,
  generateOpPrescriptionSafetyReview,
};
