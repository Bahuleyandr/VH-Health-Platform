/**
 * Surgical / OR AI modules (Tier B PR2).
 *
 * Eight thin generators each backing one of the AI surgical modules
 * registered in clinicalAiModuleService:
 *   1. preop_checklist_review
 *   2. surgical_consent_draft
 *   3. ot_note_draft
 *   4. post_op_instruction_draft
 *   5. surgical_risk_summary
 *   6. anesthesia_precheck_assistant
 *   7. implant_consumable_tracker
 *   8. post_op_complication_alert
 *
 * They share a common pipeline: load case context from ot_schedules +
 * the relevant Tier B PR1 row -> build a focused LLM prompt -> run
 * runOutputDefenses -> persist clinical_ai_generations + enqueue
 * clinical_ai_reviews. Decision is read off the existing review surface;
 * never auto-applies to the source row.
 *
 * Decision-support only: every module's output is decision_support_only.
 * Surgeons / anesthetists move drafts through the review queue
 * (accepted / edited / rejected) before any data is treated as final.
 */

import crypto from 'crypto';

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenantService.js';
import { getClinicalAiModule } from './clinicalAiModuleService.js';
import { runOutputDefenses } from './hallucinationDefenses.js';
import { generateClinicalText } from './localLlmClient.js';

const SURGICAL_AI_MODULES = new Set([
  'preop_checklist_review',
  'surgical_consent_draft',
  'ot_note_draft',
  'post_op_instruction_draft',
  'surgical_risk_summary',
  'anesthesia_precheck_assistant',
  'implant_consumable_tracker',
  'post_op_complication_alert',
]);

function resolveTenantId(options = {}) {
  return options.tenantId || DEFAULT_TENANT_ID;
}

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

function sourceHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value || {})).digest('hex').slice(0, 32);
}

async function loadCaseContext({ otScheduleId }) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, patient_uid, encounter_id, surgeon, anesthetist,
            procedure_name, procedure_code, ot_room,
            scheduled_date, scheduled_time, estimated_duration,
            actual_duration, status, equipment_needed,
            blood_arranged, consent_obtained
     FROM ot_schedules WHERE id = $1 LIMIT 1`,
    otScheduleId,
  );
  if (!rows[0]) throw AppError.notFound('ot_schedule not found');
  return rows[0];
}

async function safeQueryRow(sql, ...params) {
  try {
    const rows = await prisma.$queryRawUnsafe(sql, ...params);
    return rows[0] || null;
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    throw err;
  }
}

async function safeQueryRows(sql, ...params) {
  try {
    return await prisma.$queryRawUnsafe(sql, ...params);
  } catch (err) {
    if (isMissingSchemaError(err)) return [];
    throw err;
  }
}

async function loadPatientSummary(patientUid) {
  if (!patientUid) return null;
  const rows = await safeQueryRows(
    `SELECT u.uid AS patient_uid, u.role, u.full_name, u.dob, u.gender,
            (SELECT array_agg(a.allergen) FROM patient_allergies a WHERE a.patient_uid = u.uid) AS allergies
     FROM users u WHERE u.uid = $1 LIMIT 1`,
    patientUid,
  );
  return rows[0] || { patient_uid: patientUid };
}

/**
 * Shared pipeline. All eight modules call this with their module_key,
 * a system prompt, the user-prompt payload, citations, and any context
 * the defenses layer needs.
 */
async function runSurgicalPipeline({
  moduleKey,
  tenantId,
  caseContext,
  patientUid,
  systemPrompt,
  userPromptPayload,
  contextForDefenses,
  citations,
  metadata,
  generatedBy,
  req,
}) {
  if (!SURGICAL_AI_MODULES.has(moduleKey)) {
    throw AppError.badRequest(`Unknown surgical AI module_key: ${moduleKey}`);
  }
  const tid = resolveTenantId({ tenantId });
  const module = await getClinicalAiModule(moduleKey);
  if (!module.enabled) {
    throw AppError.forbidden(`Clinical AI module is disabled: ${module.display_name}`);
  }

  const aiResult = await generateClinicalText({
    systemPrompt: [
      systemPrompt,
      'Return JSON only with the schema-required keys.',
      'Cite every clinical claim back to a source in the citations array. Do not invent values.',
      'This is a draft for clinician review before any clinical action. Add a safety_flag instead of guessing when uncertain.',
      'Decision-support only — never auto-finalize, never auto-publish, never auto-order.',
    ].join('\n\n'),
    userPrompt: JSON.stringify(userPromptPayload),
    taskType: moduleKey,
    tenantRegion: req?.tenant?.region || null,
  });

  const draft = safeJsonParse(aiResult.text, null) || {
    fallback_used: true,
    safety_flags: [],
    source_citations: citations,
  };
  if (!Array.isArray(draft.source_citations)) draft.source_citations = citations;
  if (!Array.isArray(draft.safety_flags)) draft.safety_flags = [];

  const defenseFlags = runOutputDefenses({
    draft,
    module,
    context: contextForDefenses || {},
    citations,
  });
  const safetyFlags = [
    ...(Array.isArray(draft.safety_flags) ? draft.safety_flags : []),
    ...defenseFlags,
  ];
  const hasCritical = safetyFlags.some((flag) => flag.severity === 'critical');
  const status = hasCritical ? 'failed' : 'draft';
  const usage = aiResult.usage || {};

  let generationId = null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_generations
         (tenant_id, patient_uid, admission_id, task_type, module_key, provider, model,
          prompt_version, source_hash, status, used_ai, safety_flags, citations, draft,
          generated_by, prompt_tokens, completion_tokens, total_tokens,
          estimated_cost_minor, latency_ms, provider_request_id, finish_reason,
          metadata, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, $4, $5, $6, 'v1', $7, $8, $9,
               $10::jsonb, $11::jsonb, $12::jsonb, $13::uuid, $14, $15, $16,
               $17, $18, $19, $20, $21::jsonb, NOW(), NOW())
       RETURNING id`,
      tid,
      patientUid || caseContext.patient_uid || null,
      null,
      moduleKey,
      aiResult.provider || 'template',
      aiResult.model || null,
      sourceHash({ moduleKey, payload: userPromptPayload }),
      status,
      Boolean(aiResult.usedAi),
      JSON.stringify(safetyFlags),
      JSON.stringify(citations),
      JSON.stringify(draft),
      generatedBy || null,
      usage.prompt_tokens || 0,
      usage.completion_tokens || 0,
      usage.total_tokens || 0,
      aiResult.estimatedCostMinor ?? null,
      usage.latency_ms || null,
      usage.provider_request_id || null,
      usage.finish_reason || null,
      JSON.stringify({
        ...(metadata || {}),
        ot_schedule_id: caseContext.id,
      }),
    );
    generationId = rows[0]?.id || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn(`${moduleKey} generation persist failed`, { error: err.message });
    }
  }

  if (generationId) {
    try {
      await prisma.$queryRawUnsafe(
        `INSERT INTO clinical_ai_reviews
           (tenant_id, generation_id, module_key, patient_uid, admission_id, decision, metadata, created_at, updated_at)
         VALUES ($1::uuid, $2, $3, $4::uuid, NULL, 'pending', $5::jsonb, NOW(), NOW())`,
        tid, generationId, moduleKey,
        patientUid || caseContext.patient_uid || null,
        JSON.stringify({
          review_roles: module.settings?.reviewRoles || ['DOCTOR'],
          source: 'surgical_ai',
          ot_schedule_id: caseContext.id,
        }),
      );
    } catch (err) {
      if (!isMissingSchemaError(err)) {
        logger.warn(`${moduleKey} review enqueue failed`, { error: err.message });
      }
    }
  }

  return {
    module_key: moduleKey,
    generation_id: generationId,
    ot_schedule_id: caseContext.id,
    draft,
    safety_flags: safetyFlags,
    source_citations: citations,
    used_ai: Boolean(aiResult.usedAi),
    provider: aiResult.provider || 'template',
    status,
    review_status: status === 'failed' ? 'failed' : 'pending',
    requires_signoff: Boolean(module.settings?.requiresClinicianSignoff),
    decision_support_only: true,
  };
}

// ---------------------------------------------------------------------------
// 1. Pre-op checklist review
// ---------------------------------------------------------------------------

export async function reviewPreopChecklist({
  tenantId = null, otScheduleId, generatedBy = null, req = null,
} = {}) {
  const scheduleId = normalizeId(otScheduleId, 'ot_schedule_id');
  const caseContext = await loadCaseContext({ otScheduleId: scheduleId });
  const checklist = await safeQueryRow(
    `SELECT * FROM preop_checklists
     WHERE tenant_id = $1::uuid AND ot_schedule_id = $2 LIMIT 1`,
    resolveTenantId({ tenantId }), scheduleId,
  );

  const citations = [
    {
      source_type: 'ot_schedule',
      source_id: String(caseContext.id),
      label: `${caseContext.procedure_name || 'OT case'} on ${caseContext.scheduled_date}`,
    },
  ];
  if (checklist) {
    citations.push({
      source_type: 'preop_checklist',
      source_id: String(checklist.id),
      label: `Preop checklist (status: ${checklist.status})`,
    });
  }

  return runSurgicalPipeline({
    moduleKey: 'preop_checklist_review',
    tenantId, caseContext, patientUid: caseContext.patient_uid,
    systemPrompt: [
      'You are an OR safety reviewer. Audit a preop_checklist row against case context.',
      'Output JSON: { readiness_status: "ready" | "missing_items" | "blocked", missing_items: Array<{ item, why_required }>, recommendations: Array<string>, source_citations, safety_flags }.',
      'A "blocked" verdict means a critical safety item is missing (no consent, no NPO, no antibiotic for a clean-contaminated case). "missing_items" is non-blocking but should be done before incision.',
      'Never recommend bypassing the checklist. If the case is genuinely emergent, surface that as a safety_flag, not as auto-clearance.',
    ].join('\n'),
    userPromptPayload: { case: caseContext, checklist: checklist || null },
    contextForDefenses: { case: caseContext, checklist: checklist || null },
    citations,
    metadata: { ot_schedule_id: scheduleId },
    generatedBy, req,
  });
}

// ---------------------------------------------------------------------------
// 2. Surgical consent draft
// ---------------------------------------------------------------------------

export async function draftSurgicalConsent({
  tenantId = null, otScheduleId, language = 'en',
  patientComorbidities = null, generatedBy = null, req = null,
} = {}) {
  const scheduleId = normalizeId(otScheduleId, 'ot_schedule_id');
  const caseContext = await loadCaseContext({ otScheduleId: scheduleId });
  const patient = await loadPatientSummary(caseContext.patient_uid);

  const citations = [
    {
      source_type: 'ot_schedule',
      source_id: String(caseContext.id),
      label: `${caseContext.procedure_name || 'OT case'} (${caseContext.procedure_code || 'no code'})`,
    },
  ];

  return runSurgicalPipeline({
    moduleKey: 'surgical_consent_draft',
    tenantId, caseContext, patientUid: caseContext.patient_uid,
    systemPrompt: [
      'You are a hospital clinician drafting an informed-consent document for surgery.',
      `Target language: ${language}.`,
      'Output JSON: { indication, alternatives, risks: Array<{ risk, why_relevant }>, benefits: Array<string>, plain_language_summary, anesthesia_implications, post_op_course, source_citations, safety_flags }.',
      'Tailor risks to the supplied patient comorbidities. Always include the absolute minimum disclosure: bleeding, infection, anesthesia complications, conversion to open if laparoscopic, mortality.',
      'Never minimise risks to push the procedure through. Surgeon edits and signs.',
    ].join('\n'),
    userPromptPayload: {
      procedure_name: caseContext.procedure_name,
      procedure_code: caseContext.procedure_code,
      patient_summary: patient,
      comorbidities: patientComorbidities,
      language,
    },
    contextForDefenses: { case: caseContext, patient },
    citations,
    metadata: { ot_schedule_id: scheduleId, language },
    generatedBy, req,
  });
}

// ---------------------------------------------------------------------------
// 3. Operative note draft
// ---------------------------------------------------------------------------

export async function draftOperativeNote({
  tenantId = null, otScheduleId, surgeonNotes = null,
  generatedBy = null, req = null,
} = {}) {
  const scheduleId = normalizeId(otScheduleId, 'ot_schedule_id');
  const caseContext = await loadCaseContext({ otScheduleId: scheduleId });

  const citations = [{
    source_type: 'ot_schedule',
    source_id: String(caseContext.id),
    label: `${caseContext.procedure_name} OT case`,
  }];

  return runSurgicalPipeline({
    moduleKey: 'ot_note_draft',
    tenantId, caseContext, patientUid: caseContext.patient_uid,
    systemPrompt: [
      'You are a hospital clinician drafting a structured operative note.',
      'Output JSON: { procedure_performed, indication, anesthesia_summary, position, prep, incision, findings, technique, specimens: Array<string>, estimated_blood_loss_ml, drains: Array<string>, closure, complications, counts_summary, post_op_plan, source_citations, safety_flags }.',
      'Draw factual content from the case context + supplied surgeon_notes. Do NOT invent technique steps the surgeon did not describe.',
      'If estimated_blood_loss_ml or specimens are missing in input, leave them empty rather than guessing.',
    ].join('\n'),
    userPromptPayload: { case: caseContext, surgeon_notes: surgeonNotes },
    contextForDefenses: { case: caseContext, surgeon_notes: surgeonNotes },
    citations,
    metadata: { ot_schedule_id: scheduleId },
    generatedBy, req,
  });
}

// ---------------------------------------------------------------------------
// 4. Post-op instruction draft (patient-facing)
// ---------------------------------------------------------------------------

export async function draftPostOpInstructions({
  tenantId = null, otScheduleId, language = 'en',
  generatedBy = null, req = null,
} = {}) {
  const scheduleId = normalizeId(otScheduleId, 'ot_schedule_id');
  const caseContext = await loadCaseContext({ otScheduleId: scheduleId });
  const patient = await loadPatientSummary(caseContext.patient_uid);

  const citations = [{
    source_type: 'ot_schedule',
    source_id: String(caseContext.id),
    label: `Post-op for ${caseContext.procedure_name}`,
  }];

  return runSurgicalPipeline({
    moduleKey: 'post_op_instruction_draft',
    tenantId, caseContext, patientUid: caseContext.patient_uid,
    systemPrompt: [
      'You are a hospital patient-education writer. Draft post-op instructions in plain language.',
      `Target language: ${language}.`,
      'Output JSON: { wound_care, medications: Array<{ name, when, why }>, activity, diet, warning_signs: Array<string>, follow_up: Array<{ when, where, why }>, plain_language_summary, source_citations, safety_flags }.',
      'Tailor wound-care + activity to the procedure performed. Never give specific dose changes; defer to the discharge prescription.',
    ].join('\n'),
    userPromptPayload: {
      procedure_name: caseContext.procedure_name,
      patient_summary: patient,
      language,
    },
    contextForDefenses: { case: caseContext, patient },
    citations,
    metadata: { ot_schedule_id: scheduleId, language },
    generatedBy, req,
  });
}

// ---------------------------------------------------------------------------
// 5. Surgical risk summary
// ---------------------------------------------------------------------------

export async function summarizeSurgicalRisk({
  tenantId = null, otScheduleId, generatedBy = null, req = null,
} = {}) {
  const scheduleId = normalizeId(otScheduleId, 'ot_schedule_id');
  const caseContext = await loadCaseContext({ otScheduleId: scheduleId });
  const patient = await loadPatientSummary(caseContext.patient_uid);
  const anesthesia = await safeQueryRow(
    `SELECT asa_grade, airway_assessment, technique
     FROM anesthesia_records
     WHERE tenant_id = $1::uuid AND ot_schedule_id = $2 LIMIT 1`,
    resolveTenantId({ tenantId }), scheduleId,
  );

  const citations = [
    {
      source_type: 'ot_schedule',
      source_id: String(caseContext.id),
      label: `Risk profile for ${caseContext.procedure_name}`,
    },
  ];
  if (anesthesia) {
    citations.push({
      source_type: 'anesthesia_record',
      source_id: String(scheduleId),
      label: `Anesthesia ASA ${anesthesia.asa_grade || 'unrated'}`,
    });
  }

  return runSurgicalPipeline({
    moduleKey: 'surgical_risk_summary',
    tenantId, caseContext, patientUid: caseContext.patient_uid,
    systemPrompt: [
      'You are a peri-operative physician summarizing surgical risk.',
      'Output JSON: { risk_band: "low" | "moderate" | "high" | "very_high", risk_factors: Array<{ factor, contribution, source }>, recommendations: Array<{ action, why, urgency }>, optimisation_required: Array<string>, source_citations, safety_flags }.',
      'Risk band must reflect ASA grade + comorbidities + procedure complexity together. Never label "very_high" risk as "low".',
      'If essential preop labs / cardiac clearance is missing, surface that as a safety_flag with severity=high.',
    ].join('\n'),
    userPromptPayload: {
      procedure_name: caseContext.procedure_name,
      patient_summary: patient,
      anesthesia: anesthesia || null,
    },
    contextForDefenses: { case: caseContext, patient, anesthesia },
    citations,
    metadata: { ot_schedule_id: scheduleId },
    generatedBy, req,
  });
}

// ---------------------------------------------------------------------------
// 6. Anesthesia pre-check assistant
// ---------------------------------------------------------------------------

export async function runAnesthesiaPrecheck({
  tenantId = null, otScheduleId, generatedBy = null, req = null,
} = {}) {
  const scheduleId = normalizeId(otScheduleId, 'ot_schedule_id');
  const caseContext = await loadCaseContext({ otScheduleId: scheduleId });
  const patient = await loadPatientSummary(caseContext.patient_uid);
  const anesthesia = await safeQueryRow(
    `SELECT * FROM anesthesia_records
     WHERE tenant_id = $1::uuid AND ot_schedule_id = $2 LIMIT 1`,
    resolveTenantId({ tenantId }), scheduleId,
  );

  const citations = [{
    source_type: 'ot_schedule',
    source_id: String(caseContext.id),
    label: `Anesthesia precheck for ${caseContext.procedure_name}`,
  }];

  return runSurgicalPipeline({
    moduleKey: 'anesthesia_precheck_assistant',
    tenantId, caseContext, patientUid: caseContext.patient_uid,
    systemPrompt: [
      'You are an anesthetist drafting a pre-anesthesia evaluation.',
      'Output JSON: { asa_assessment: { proposed_grade, rationale }, airway_plan: { mallampati, difficulty_score, plan_a, plan_b }, medication_plan: { hold_anticoagulants, hold_others, restart_when }, fasting_status: { last_solid, last_clear_fluid, cleared }, ponv_risk_score, ponv_prophylaxis, risks: Array<string>, source_citations, safety_flags }.',
      'If preop assessment is incomplete, surface that as a safety_flag; never auto-clear the patient.',
    ].join('\n'),
    userPromptPayload: {
      procedure_name: caseContext.procedure_name,
      patient_summary: patient,
      existing_anesthesia_record: anesthesia,
    },
    contextForDefenses: { case: caseContext, patient, anesthesia },
    citations,
    metadata: { ot_schedule_id: scheduleId },
    generatedBy, req,
  });
}

// ---------------------------------------------------------------------------
// 7. Implant + consumable tracker
// ---------------------------------------------------------------------------

export async function trackImplantsAndConsumables({
  tenantId = null, otScheduleId, generatedBy = null, req = null,
} = {}) {
  const scheduleId = normalizeId(otScheduleId, 'ot_schedule_id');
  const caseContext = await loadCaseContext({ otScheduleId: scheduleId });
  const tid = resolveTenantId({ tenantId });
  const implants = await safeQueryRows(
    `SELECT id, implant_type, manufacturer, brand_name, lot_number, udi,
            expiry_date, side, status, recall_reference
     FROM surgical_implants
     WHERE tenant_id = $1::uuid AND ot_schedule_id = $2`,
    tid, scheduleId,
  );

  const citations = [{
    source_type: 'ot_schedule',
    source_id: String(caseContext.id),
    label: `Implant reconciliation for ${caseContext.procedure_name}`,
  }, ...implants.map((imp) => ({
    source_type: 'surgical_implant',
    source_id: String(imp.id),
    label: `${imp.manufacturer || 'unknown'} ${imp.implant_type} lot=${imp.lot_number || 'n/a'}`,
  }))];

  return runSurgicalPipeline({
    moduleKey: 'implant_consumable_tracker',
    tenantId, caseContext, patientUid: caseContext.patient_uid,
    systemPrompt: [
      'You are a materials-management auditor. Reconcile intra-op implants documented for this case against inventory + recall feeds.',
      'Output JSON: { reconciliation: Array<{ implant_id, status, notes }>, flags: Array<{ implant_id, flag_type: "missing_udi" | "expired" | "recalled" | "no_lot" | "side_unspecified", severity, action }>, completeness_score, source_citations, safety_flags }.',
      'Flag any implant with status=in_situ but no UDI as missing_udi (severity=medium).',
      'Flag any implant whose expiry_date is past the case date as expired (severity=high). Flag recall_reference set as recalled (severity=critical).',
    ].join('\n'),
    userPromptPayload: { case: caseContext, implants },
    contextForDefenses: { implants },
    citations,
    metadata: { ot_schedule_id: scheduleId, implant_count: implants.length },
    generatedBy, req,
  });
}

// ---------------------------------------------------------------------------
// 8. Post-op complication alert
// ---------------------------------------------------------------------------

export async function detectPostOpComplications({
  tenantId = null, otScheduleId, generatedBy = null, req = null,
} = {}) {
  const scheduleId = normalizeId(otScheduleId, 'ot_schedule_id');
  const caseContext = await loadCaseContext({ otScheduleId: scheduleId });
  const tid = resolveTenantId({ tenantId });
  const postopNotes = await safeQueryRows(
    `SELECT id, pod_number, recovery_phase, vitals, pain_score, drain_status,
            wound_status, complications_noted, urine_output_ml, created_at
     FROM postop_notes
     WHERE tenant_id = $1::uuid AND ot_schedule_id = $2
     ORDER BY created_at DESC LIMIT 10`,
    tid, scheduleId,
  );
  const existingAlerts = await safeQueryRows(
    `SELECT id, complication_type, severity, status, detected_at
     FROM postop_complication_alerts
     WHERE tenant_id = $1::uuid AND ot_schedule_id = $2 AND status IN ('open', 'acknowledged')`,
    tid, scheduleId,
  );

  const citations = [
    {
      source_type: 'ot_schedule',
      source_id: String(caseContext.id),
      label: `Post-op surveillance for ${caseContext.procedure_name}`,
    },
    ...postopNotes.slice(0, 5).map((n) => ({
      source_type: 'postop_note',
      source_id: String(n.id),
      label: `Post-op note POD${n.pod_number ?? '?'} (${n.recovery_phase || 'phase?'})`,
    })),
  ];

  return runSurgicalPipeline({
    moduleKey: 'post_op_complication_alert',
    tenantId, caseContext, patientUid: caseContext.patient_uid,
    systemPrompt: [
      'You are a surgical safety reviewer. Detect surgery-specific post-op complications from postop_notes + vitals trends.',
      'Output JSON: { complication_signals: Array<{ type: "anastomotic_leak" | "deep_ssi" | "superficial_ssi" | "wound_dehiscence" | "return_to_theatre" | "reintubation" | "dvt" | "pe" | "mi" | "cva" | "aki" | "sepsis" | "hemorrhage" | "ileus" | "organ_injury" | "other", evidence: Array<string>, confidence }>, severity: "low" | "medium" | "high" | "critical", recommended_action: Array<string>, source_citations, safety_flags }.',
      'Distinct from generic deterioration — focus on operative-recovery patterns. Anastomotic leak in a colorectal case = abdominal pain + tachycardia + leukocytosis on POD3-5.',
      'Do NOT signal a complication that is already in existing_alerts (provided in payload). If symptoms match an open alert, mention it and surface as "duplicate_signal".',
    ].join('\n'),
    userPromptPayload: {
      case: caseContext,
      postop_notes: postopNotes,
      existing_alerts: existingAlerts,
    },
    contextForDefenses: { postop_notes: postopNotes },
    citations,
    metadata: { ot_schedule_id: scheduleId, note_count: postopNotes.length },
    generatedBy, req,
  });
}

export const __testing__ = {
  SURGICAL_AI_MODULES,
};

export default {
  reviewPreopChecklist,
  draftSurgicalConsent,
  draftOperativeNote,
  draftPostOpInstructions,
  summarizeSurgicalRisk,
  runAnesthesiaPrecheck,
  trackImplantsAndConsumables,
  detectPostOpComplications,
};
