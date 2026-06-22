import crypto from 'crypto';
import prisma, { setTenant } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { collectAdmissionClinicalContext } from '../emr/clinicalTimelineService.js';
import { publishEvent } from '../events/eventOutboxService.js';
import { generateClinicalText } from './localLlmClient.js';
import { getClinicalAiModule } from './clinicalAiModuleService.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { runOutputDefenses } from './hallucinationDefenses.js';
import { retrieveRelevant } from './ragService.js';
import { groundWithKnowledgeBases } from './knowledgeGroundingService.js';
import {
  extractContextSignature,
  recordDecision as recordDecisionMemory,
  retrieveRelevantDecisions,
} from './decisionMemoryService.js';
import { runDifferentialDebate } from './clinicalDebateService.js';
// NOTE: annotateCodingDraft (codingValidationService) is imported LAZILY inside the
// build_safety_flags node so codingValidationService -> terminologyService
// (-> prismaReadOnly) is NOT pulled into this module's eager import graph — a static
// import breaks every test that mocks ../../lib/prisma.js without prismaReadOnly.
import { WorkflowGraph, runWorkflow } from './workflowGraphRunner.js';
import { getDefaultCheckpointStore } from './workflowCheckpointStore.js';

// Multi-tenant helper. Every query that writes to or reads from a tenant-scoped
// clinical_ai_* table must pass tenantId. Null means "all tenants" and is only
// allowed for SUPER_ADMIN callers (enforced at the route boundary, not here).
function resolveTenantId(options = {}) {
  if (options.tenantId === null) return null;
  return requireTenantId(options.tenantId);
}

const MODULE_PROMPT_FALLBACK = {
  version: 'v1',
  system_prompt: 'You are a hospital clinical AI drafting assistant. Use only supplied chart context. Return JSON only. Include source citations. All output is draft-only and requires human review.',
  user_prompt_template: 'Draft the requested module output from this chart context. Do not invent facts.',
  output_schema: {},
};

const ADMISSION_MODULES = new Set([
  'patient_record_summary',
  'patient_aftercare_instructions',
  'medication_reconciliation',
  'discharge_readiness',
  'abnormal_result_triage',
  'referral_letter',
  'clinical_coding_assist',
  'quality_case_review',
]);

const REVIEW_STATUS_BY_DECISION = {
  accepted: 'accepted',
  signed: 'accepted',
  approved: 'accepted',
  rejected: 'rejected',
  needs_revision: 'needs_revision',
  edited: 'edited',
};

const REVIEW_NOTE_REQUIRED_DECISIONS = new Set(['accepted', 'signed', 'approved', 'edited']);
const REVIEW_NOTE_MIN_CHARS = 12;
const REVIEW_NOTE_MIN_WORDS = 3;

function isMissingSchemaError(err) {
  return /does not exist|column .* does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

function clinicalAiSchemaUnavailable(err, surface) {
  if (!isMissingSchemaError(err)) return err;
  logger.warn('Clinical AI workflow schema unavailable', {
    surface,
    error: err.message,
  });
  return AppError.internal(
    'Clinical AI workflow schema is unavailable; refusing unsafe fallback',
    'CLINICAL_AI_SCHEMA_UNAVAILABLE'
  );
}

function cleanText(value, fallback = '') {
  return String(value ?? fallback).trim();
}

function normalizeReviewerNote(data = {}) {
  return cleanText(data.reviewer_note ?? data.reviewerNote ?? data.note ?? '');
}

function hasSubstantiveReviewerNote(note) {
  const words = cleanText(note).split(/\s+/).filter(Boolean);
  return note.length >= REVIEW_NOTE_MIN_CHARS && words.length >= REVIEW_NOTE_MIN_WORDS;
}

function clampInt(value, { min = 1, max = 500, fallback = 50 } = {}) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeRoleValue(value) {
  return String(value || '').trim().toUpperCase();
}

function roleAllowedForReview({ review, reviewerRole, allowOverride = false }) {
  const role = normalizeRoleValue(reviewerRole);
  const moduleRoles = asArray(review?.module_review_roles || review?.metadata?.review_roles)
    .map(normalizeRoleValue)
    .filter(Boolean);
  if (!role) return false;
  if (moduleRoles.includes(role)) return true;
  return allowOverride && ['ADMIN', 'SUPER_ADMIN'].includes(role);
}

function sourceHash(payload) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(payload || {}))
    .digest('hex');
}

function safeJsonParse(text, fallback) {
  if (!text) return fallback;
  const cleaned = String(text)
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
  try {
    const parsed = JSON.parse(cleaned);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function eventSummary(event) {
  if (!event) return null;
  return {
    type: event.event_type,
    sub_type: event.sub_type,
    id: event.id,
    summary: event.summary,
    timestamp: event.timestamp,
    payload: event.payload,
  };
}

function latest(events, count = 5) {
  return asArray(events).slice(-count).map(eventSummary).filter(Boolean);
}

function citationFor(sourceType, sourceId, label, timestamp = null) {
  return {
    source_type: sourceType,
    source_id: sourceId === null || sourceId === undefined ? null : String(sourceId),
    label,
    timestamp,
  };
}

function uniqueCitations(citations) {
  const seen = new Set();
  return asArray(citations).filter((citation) => {
    const key = `${citation.source_type}:${citation.source_id}:${citation.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function medicationNameFromEvent(event) {
  const payload = event?.payload || {};
  const details = payload.details || {};
  return cleanText(
    payload.medication_name || details.medication_name || details.name || event?.summary,
    'Medication'
  );
}

function buildChartPacket(context) {
  const admission = context.admission || {};
  const patient = context.patient || {};
  return {
    patient: {
      uid: patient.uid,
      name: patient.name,
      gender: patient.gender,
      birthday: patient.birthday,
    },
    admission: {
      id: admission.id,
      encounter_id: admission.encounter_id,
      status: admission.status,
      ward: admission.ward,
      bed_number: admission.bed_number,
      chief_complaint: admission.chief_complaint,
      admitting_diagnosis: admission.admitting_diagnosis,
      code_status: admission.code_status,
      admitted_at: admission.admitted_at,
      discharged_at: admission.discharged_at,
      discharge_summary: admission.discharge_summary,
    },
    allergies: asArray(context.allergies),
    active_diagnoses: latest(context.diagnoses, 12),
    recent_notes: latest(context.notes, 12),
    recent_vitals: latest(context.vitals, 12),
    medications: latest([...asArray(context.medications), ...asArray(context.orders).filter((item) => item.sub_type === 'medication')], 20),
    investigations: latest(context.investigations, 20),
    orders: latest(context.orders, 20),
    handovers: latest(context.handovers, 8),
    citations: uniqueCitations(context.citations),
  };
}

function pendingInvestigations(context) {
  return asArray(context.investigations).filter((event) => {
    const status = cleanText(event.payload?.status || event.sub_type).toLowerCase();
    return status && !['completed', 'reported', 'cancelled', 'resulted', 'done'].includes(status);
  });
}

function unsignedNotes(context) {
  return asArray(context.notes).filter((event) => event.payload && event.payload.is_signed === false);
}

function activeOrders(context) {
  return asArray(context.orders).filter((event) => {
    const status = cleanText(event.payload?.status || event.sub_type).toLowerCase();
    return ['ordered', 'active', 'pending', 'in_progress'].includes(status);
  });
}

function medicationSafetyFlags(context) {
  const allergies = asArray(context.allergies)
    .map((row) => cleanText(row.allergen || row.name || row.allergy_name).toLowerCase())
    .filter(Boolean);
  if (!allergies.length) return [];

  const medicationEvents = [
    ...asArray(context.medications),
    ...asArray(context.orders).filter((item) => item.sub_type === 'medication'),
  ];
  return medicationEvents
    .filter((event) => {
      const medName = medicationNameFromEvent(event).toLowerCase();
      return allergies.some((allergy) => allergy && medName.includes(allergy));
    })
    .map((event) => ({
      severity: 'critical',
      code: 'ALLERGY_MEDICATION_MATCH',
      message: `Possible allergy match in medication source: ${medicationNameFromEvent(event)}`,
    }));
}

function buildCommonSafetyFlags(context, module, citations) {
  const flags = [];
  if (module?.settings?.requiresCitations && !citations.length) {
    // AI-5 (WS5 B5.1): for modules that REQUIRE citations, zero citations is
    // a blocking failure, not a reviewer hint. A 'critical' flag routes the
    // draft through the existing dead-letter path in persist_generation
    // (status='failed', never enqueued for review) instead of letting an
    // uncited draft reach a reviewer as an acceptable item. Modules that do
    // not require citations are unaffected.
    flags.push({
      severity: 'critical',
      code: 'MISSING_CITATIONS',
      message: 'AI draft has no chart citations but the module requires them; draft fails closed and must not be accepted.',
    });
  }

  if (pendingInvestigations(context).length > 0) {
    flags.push({
      severity: 'medium',
      code: 'PENDING_INVESTIGATIONS',
      message: 'Pending investigations exist in the chart packet.',
    });
  }

  if (unsignedNotes(context).length > 0) {
    flags.push({
      severity: 'medium',
      code: 'UNSIGNED_NOTES',
      message: 'Unsigned clinical notes are present and should be reviewed before final acceptance.',
    });
  }

  return [...flags, ...medicationSafetyFlags(context)];
}

function patientRecordSummary(context) {
  const packet = buildChartPacket(context);
  return {
    summary: `${packet.patient.name || 'Patient'} is admitted for ${packet.admission.chief_complaint || packet.admission.admitting_diagnosis || 'an inpatient encounter'}.`,
    current_location: {
      ward: packet.admission.ward,
      bed_number: packet.admission.bed_number,
      status: packet.admission.status,
    },
    active_problems: packet.active_diagnoses.map((item) => item.summary),
    medications: packet.medications.map((item) => item.summary),
    recent_vitals: packet.recent_vitals.map((item) => item.summary),
    investigations: packet.investigations.map((item) => item.summary),
    allergies: packet.allergies,
    pending_tasks: [
      ...pendingInvestigations(context).map((item) => item.summary),
      ...activeOrders(context).map((item) => item.summary),
    ],
  };
}

function aftercareInstructions(context) {
  const packet = buildChartPacket(context);
  return {
    plain_language_summary: `You were treated for ${packet.admission.admitting_diagnosis || packet.admission.chief_complaint || 'your hospital condition'}. Follow the instructions confirmed by your clinical team.`,
    medicines: packet.medications.map((item) => ({
      medicine: medicationNameFromEvent(item),
      instruction: 'Take only as prescribed on the final signed discharge medication list.',
      source: item.summary,
    })),
    follow_up: ['Attend the follow-up appointment advised by your doctor.'],
    warning_signs: [
      'Worsening breathlessness, chest pain, fainting, persistent high fever, confusion, or any symptom your doctor highlighted.',
    ],
    diet_activity: {
      diet: 'Follow the diet advised in the signed discharge summary.',
      activity: 'Resume activity gradually unless your doctor restricted activity.',
    },
    language_ready_sections: ['summary', 'medicines', 'follow_up', 'warning_signs', 'diet_activity'],
  };
}

function medicationReconciliation(context) {
  const medicationEvents = [
    ...asArray(context.medications),
    ...asArray(context.orders).filter((event) => event.sub_type === 'medication'),
  ];
  const byMedication = new Map();
  for (const event of medicationEvents) {
    const name = medicationNameFromEvent(event);
    if (!byMedication.has(name)) byMedication.set(name, []);
    byMedication.get(name).push(event.summary);
  }

  const duplicates = [...byMedication.entries()]
    .filter(([, sources]) => sources.length > 1)
    .map(([medication, sources]) => ({ medication, sources }));

  return {
    continue: [...byMedication.keys()].map((medication) => ({
      medication,
      rationale: 'Present in inpatient medication sources; clinician must confirm final discharge status.',
    })),
    stop: [],
    change: [],
    duplicates,
    allergies: asArray(context.allergies),
    safety_flags: medicationSafetyFlags(context),
  };
}

function dischargeReadiness(context) {
  const pending = pendingInvestigations(context);
  const active = activeOrders(context);
  const unsigned = unsignedNotes(context);
  const blockers = [
    ...pending.map((item) => ({ type: 'pending_investigation', label: item.summary })),
    ...active.map((item) => ({ type: 'active_order', label: item.summary })),
    ...unsigned.map((item) => ({ type: 'unsigned_note', label: item.summary })),
  ];

  return {
    ready: blockers.length === 0,
    blockers,
    checklist: {
      pending_investigations_clear: pending.length === 0,
      active_orders_resolved: active.length === 0,
      notes_signed: unsigned.length === 0,
      discharge_summary_signed: Boolean(context.admission?.discharge_summary?.is_signed),
      follow_up_documented: Boolean(context.admission?.discharge_summary?.follow_up_instructions),
    },
    forecast: blockers.length === 0
      ? 'No obvious chart blockers found by rule review.'
      : 'Discharge requires human review of listed blockers.',
  };
}

function abnormalResultTriage(context) {
  const urgentItems = [];
  const watchItems = [];
  for (const event of asArray(context.vitals)) {
    const vitals = event.payload || {};
    const problems = [];
    if (Number(vitals.spo2) && Number(vitals.spo2) < 92) problems.push(`SpO2 ${vitals.spo2}%`);
    if (Number(vitals.temperature) && Number(vitals.temperature) >= 38.5) problems.push(`temperature ${vitals.temperature}`);
    if (Number(vitals.heart_rate) && Number(vitals.heart_rate) >= 120) problems.push(`heart rate ${vitals.heart_rate}`);
    if (problems.length) urgentItems.push({ source: event.summary, abnormalities: problems });
  }
  for (const event of asArray(context.investigations)) {
    const status = cleanText(event.payload?.status || event.sub_type).toLowerCase();
    const priority = cleanText(event.payload?.priority).toLowerCase();
    if (priority === 'urgent' || status === 'critical') urgentItems.push({ source: event.summary, abnormalities: ['urgent result source'] });
    if (status === 'pending') watchItems.push({ source: event.summary, note: 'pending result' });
  }

  return {
    urgent_items: urgentItems,
    watch_items: watchItems,
    explanation: 'Rule/CDS output remains authoritative. This triage only summarizes visible chart signals.',
  };
}

function referralLetter(context) {
  const packet = buildChartPacket(context);
  return {
    reason_for_referral: packet.admission.chief_complaint || packet.admission.admitting_diagnosis || 'Specialist review requested',
    clinical_summary: patientRecordSummary(context).summary,
    active_diagnoses: packet.active_diagnoses.map((item) => item.summary),
    current_treatment: packet.medications.map((item) => item.summary),
    investigations: packet.investigations.map((item) => item.summary),
    pending_items: pendingInvestigations(context).map((item) => item.summary),
  };
}

function codingAssist(context) {
  const signedNotes = asArray(context.notes).filter((event) => event.payload?.is_signed === true);
  const diagnoses = asArray(context.diagnoses).map((event) => event.payload || {});
  return {
    signed_documentation_only: true,
    suggested_codes: signedNotes.length
      ? diagnoses.map((diagnosis) => ({
        system: 'ICD10',
        code: diagnosis.icd10_code || diagnosis.icd10_description || 'UNSPECIFIED',
        description: diagnosis.description || diagnosis.icd10_description || 'Diagnosis requires coder review',
        confidence: diagnosis.icd10_code ? 'medium' : 'low',
      }))
      : [],
    evidence: signedNotes.map((event) => event.summary),
    coder_notes: signedNotes.length
      ? 'Coder/admin approval required before billing use.'
      : 'No signed clinical documentation was found in the chart packet.',
  };
}

function qualityCaseReview(context) {
  const packet = buildChartPacket(context);
  return {
    case_summary: patientRecordSummary(context).summary,
    timeline: packet.recent_notes.concat(packet.investigations).map((item) => ({
      timestamp: item.timestamp,
      event: item.summary,
    })),
    safety_signals: [
      ...pendingInvestigations(context).map((item) => item.summary),
      ...unsignedNotes(context).map((item) => item.summary),
    ],
    open_questions: ['Confirm whether this case belongs to incident, readmission, mortality, infection-control, grievance, or RCA workflow.'],
  };
}

function buildAdmissionFallback(moduleKey, context) {
  const builders = {
    patient_record_summary: patientRecordSummary,
    patient_aftercare_instructions: aftercareInstructions,
    medication_reconciliation: medicationReconciliation,
    discharge_readiness: dischargeReadiness,
    abnormal_result_triage: abnormalResultTriage,
    referral_letter: referralLetter,
    clinical_coding_assist: codingAssist,
    quality_case_review: qualityCaseReview,
  };
  return builders[moduleKey]?.(context) || patientRecordSummary(context);
}

async function getActivePrompt(moduleKey, options = {}) {
  const tenantId = resolveTenantId(options);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, module_key, version, title, system_prompt, user_prompt_template,
              output_schema, status, active, created_at, activated_at
       FROM clinical_ai_prompts
       WHERE module_key = $1
         AND tenant_id = $2::uuid
       ORDER BY active DESC, activated_at DESC NULLS LAST, created_at DESC
       LIMIT 1`,
      moduleKey,
      tenantId
    );
    return rows[0] || { ...MODULE_PROMPT_FALLBACK, module_key: moduleKey };
  } catch (err) {
    if (isMissingSchemaError(err)) return { ...MODULE_PROMPT_FALLBACK, module_key: moduleKey };
    throw err;
  }
}

async function saveContextSnapshot({ tenantId = null, patientUid = null, admissionId = null, contextType, payload, createdBy = null }) {
  try {
    const hash = sourceHash(payload);
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_context_snapshots
         (tenant_id, patient_uid, admission_id, context_type, source_hash, payload, created_by, created_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::jsonb, $7::uuid, NOW())
       RETURNING id, source_hash, created_at`,
      resolveTenantId({ tenantId }),
      patientUid,
      admissionId,
      contextType,
      hash,
      JSON.stringify(payload || {}),
      createdBy
    );
    return rows[0] || { source_hash: hash };
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Clinical AI context snapshot failed', { contextType, error: err.message });
    }
    return { source_hash: sourceHash(payload) };
  }
}

function citationCoverage(citations) {
  return citations.length ? 100 : 0;
}

async function saveGeneration({
  tenantId = null,
  patientUid = null,
  admissionId = null,
  moduleKey,
  promptVersion,
  sourceHash,
  draft,
  citations,
  safetyFlags,
  generatedBy = null,
  aiResult,
  status = 'draft',
  failureReason = null,
  metadata = {},
}) {
  const usage = aiResult?.usage || {};
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO clinical_ai_generations
       (tenant_id, patient_uid, admission_id, task_type, module_key, provider, model, prompt_version,
        source_hash, status, used_ai, safety_flags, citations, draft, generated_by,
        prompt_tokens, completion_tokens, total_tokens, estimated_cost_minor, latency_ms,
        provider_request_id, finish_reason, metadata, created_at, updated_at)
     VALUES
       ($1::uuid, $2::uuid, $3, $4, $4, $5, $6, $7, $8, $9, $10, $11::jsonb,
        $12::jsonb, $13::jsonb, $14::uuid, $15, $16, $17, $18, $19, $20, $21,
        $22::jsonb, NOW(), NOW())
     RETURNING id, status, created_at`,
    resolveTenantId({ tenantId }),
    patientUid,
    admissionId,
    moduleKey,
    aiResult?.provider || 'template',
    aiResult?.model || null,
    promptVersion || 'v1',
    sourceHash,
    status,
    Boolean(aiResult?.usedAi),
    JSON.stringify(safetyFlags || []),
    JSON.stringify(citations || []),
    JSON.stringify(draft || {}),
    generatedBy,
    usage.prompt_tokens || 0,
    usage.completion_tokens || 0,
    usage.total_tokens || 0,
    aiResult?.estimatedCostMinor ?? null,
    usage.latency_ms || null,
    usage.provider_request_id || null,
    usage.finish_reason || null,
    JSON.stringify({
      ...metadata,
      tier: aiResult?.tier || 'quick',
      model_tier: aiResult?.tier || 'quick',
      failure_reason: failureReason,
      fallback_reason: aiResult?.usedAi ? null : aiResult?.reason || 'template_or_rule_output',
      generation_mode: aiResult?.generation_mode || (aiResult?.usedAi ? 'ai' : 'template_fallback'),
      readiness_reason: aiResult?.readiness_reason || null,
      provider_status: aiResult?.provider_status || (aiResult?.usedAi ? 'used' : 'template_fallback'),
    })
  );
  return rows[0];
}

async function runSafetyReview({ tenantId = null, generationId, moduleKey, citations, safetyFlags }) {
  const findings = [
    ...(citationCoverage(citations) < 100
      ? [{
        severity: 'high',
        code: 'CITATION_COVERAGE_LOW',
        message: 'Draft cannot be accepted until cited evidence is reviewed.',
      }]
      : []),
    ...asArray(safetyFlags),
  ];
  const status = findings.some((item) => item.severity === 'critical')
    ? 'blocked'
    : findings.length
      ? 'needs_review'
      : 'passed';

  try {
    await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_safety_reviews
         (tenant_id, generation_id, module_key, status, findings, citation_coverage_pct, created_at)
       VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6, NOW())`,
      resolveTenantId({ tenantId }),
      generationId,
      moduleKey,
      status,
      JSON.stringify(findings),
      citationCoverage(citations)
    );
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Clinical AI safety review insert failed', { generationId, error: err.message });
    }
  }

  return { status, findings, citation_coverage_pct: citationCoverage(citations) };
}

async function createReviewPlaceholder({ tenantId = null, generationId, module, patientUid = null, admissionId = null }) {
  if (!module?.settings?.requiresClinicianSignoff && !module?.settings?.reviewRoles?.length) {
    return null;
  }

  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_reviews
         (tenant_id, generation_id, module_key, patient_uid, admission_id, decision, metadata, created_at, updated_at)
       VALUES ($1::uuid, $2, $3, $4::uuid, $5, 'pending', $6::jsonb, NOW(), NOW())
       RETURNING id, decision`,
      resolveTenantId({ tenantId }),
      generationId,
      module.module_key,
      patientUid,
      admissionId,
      JSON.stringify({
        review_roles: module.settings?.reviewRoles || [],
        requires_signoff: Boolean(module.settings?.requiresClinicianSignoff),
      })
    );
    return rows[0] || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Clinical AI review placeholder failed', { generationId, error: err.message });
    }
    return null;
  }
}

async function requireEnabledModule(moduleKey, { tenantId = null } = {}) {
  const module = await getClinicalAiModule(moduleKey, { tenantId });
  if (!module.enabled) {
    throw AppError.forbidden(`Clinical AI module is disabled: ${module.display_name}`);
  }
  return module;
}

function standardDraftResponse({ module, prompt, draft, citations, safetyFlags, aiResult, generation, review, safetyReview }) {
  return {
    draft,
    module_key: module.module_key,
    prompt_version: prompt.version || 'v1',
    source_citations: citations,
    safety_flags: safetyFlags,
    ai_metadata: {
      provider: aiResult?.provider || 'template',
      model: aiResult?.model || null,
      tier: aiResult?.tier || 'quick',
      model_tier: aiResult?.tier || 'quick',
      used_ai: Boolean(aiResult?.usedAi),
      fallback_reason: aiResult?.usedAi ? null : aiResult?.reason || 'template_or_rule_output',
      generation_mode: aiResult?.generation_mode || (aiResult?.usedAi ? 'ai' : 'template_fallback'),
      readiness_reason: aiResult?.readiness_reason || null,
      provider_status: aiResult?.provider_status || (aiResult?.usedAi ? 'used' : 'template_fallback'),
      usage: aiResult?.usage || {},
      safety_review: safetyReview,
    },
    review_status: review?.decision || 'pending',
    review_id: review?.id || null,
    generation_id: generation?.id || null,
    draft_generation_id: generation?.id || null,
    requires_signoff: Boolean(module.settings?.requiresClinicianSignoff),
  };
}

// ---------- generateAdmissionAiDraft graph -----------------------------
//
// The admission-AI-draft pipeline is expressed as an explicit DAG so it
// can be checkpointed, resumed after a crash, and (in future) paused for
// human-in-the-loop nodes (governance approval before persistence,
// payer-side prior-auth, doctor sign-off). Each node is a small, named
// step that returns a state delta. The graph definition lives outside
// the function so module-level test stubs of the helper functions take
// effect at run time, not import time.
//
// State shape (each node sees these keys; the trailing nodes assemble
// the response):
//   admissionId, moduleKey, requestedBy, requestContext, module, tenantId
//   context, packet, prompt
//   retrieved, retrievedCitations
//   decisionMemory, contextSignature
//   snapshot, fallbackDraft, aiResult, draft, citations, safetyFlags
//   debateOutcome
//   generation, safetyReview, review
//   result   (final response, returned to the caller)
//
// The graph is intentionally one-shot: every edge is the next-key in
// definition order. The runner picks that up automatically.

const ADMISSION_AI_DRAFT_GRAPH_NODES = {
  gather_chart_context: async (state) => {
    const context = await collectAdmissionClinicalContext(state.admissionId, state.tenantId || null);
    return { context, packet: buildChartPacket(context) };
  },

  fetch_active_prompt: async (state) => {
    const prompt = await getActivePrompt(state.moduleKey, { tenantId: state.tenantId });
    return { prompt };
  },

  rag_retrieve: async (state) => {
    // RAG: pull up to 5 prior signed discharge summaries from THIS tenant
    // that look semantically similar to the current admission. Graceful
    // degradation — empty result is fine, the chart packet alone still
    // grounds the draft.
    const retrievalQuery = [
      state.packet.admission.chief_complaint,
      state.packet.admission.admitting_diagnosis,
      (state.packet.active_diagnoses || []).map((d) => d.summary).slice(0, 3).join(' '),
    ].filter(Boolean).join('. ');
    const retrieved = await retrieveRelevant({
      tenantId: state.tenantId,
      queryText: retrievalQuery,
      filters: { sourceType: 'discharge_summary' },
      topK: 5,
      minScore: 0.65,
    });
    const packet = {
      ...state.packet,
      retrieved_cases: (retrieved.results || []).map((row) => ({
        source_type: row.source_type,
        source_id: row.source_id,
        similarity: Number(row.similarity).toFixed(3),
        signed_at: row.signed_at,
        snippet: String(row.content).slice(0, 400),
      })),
    };
    const retrievedCitations = (retrieved.results || []).map((row) =>
      citationFor(row.source_type, row.source_id, `Similar prior case (sim ${Number(row.similarity).toFixed(2)})`, row.signed_at)
    );
    return { retrieved, packet, retrievedCitations };
  },

  kb_grounding: async (state) => {
    // WS5 B5.5 — curated knowledge-base grounding. ADDITIVE + GATED: only
    // modules whose registry settings.knowledgeBases declares kb_types
    // (e.g. medication_reconciliation → formulary/clinical_guideline) pull
    // curation-approved chunks here; every other module no-ops. Graceful:
    // if the embedder/KB is unavailable or returns nothing, the packet +
    // citations are unchanged and generation proceeds on the chart packet
    // alone. NOT a hard precondition for the requiresCitations gate.
    const groundingQuery = [
      state.packet.admission?.chief_complaint,
      state.packet.admission?.admitting_diagnosis,
      (state.packet.active_diagnoses || []).map((d) => d.summary).slice(0, 3).join(' '),
      (state.packet.medications || []).map((m) => m.summary).slice(0, 5).join(' '),
    ].filter(Boolean).join('. ');
    const kbGrounding = await groundWithKnowledgeBases({
      module: state.module,
      tenantId: state.tenantId,
      queryText: groundingQuery,
      role: state.requestContext?.requested_by_role || null,
      retrievedBy: state.requestedBy,
      moduleKey: state.moduleKey,
    });
    const packet = kbGrounding.used
      ? { ...state.packet, curated_knowledge: kbGrounding.groundingChunks }
      : state.packet;
    return { kbGrounding, kbCitations: kbGrounding.citations, packet };
  },

  memory_retrieve: async (state) => {
    // Decision memory: prior reviewer decisions on this patient + cross-
    // patient lessons that match the current context shape. Empty result
    // is fine — RAG + chart packet remain the primary grounding.
    const contextSignature = extractContextSignature(state.context, state.moduleKey);
    const decisionMemory = await retrieveRelevantDecisions({
      tenantId: state.tenantId,
      moduleKey: state.moduleKey,
      patientUid: state.context.admission?.patient_uid || null,
      contextSignature,
      limit: 5,
    });
    const packet = {
      ...state.packet,
      prior_decisions: decisionMemory.entries,
      context_signature: contextSignature,
    };
    return { decisionMemory, contextSignature, packet };
  },

  save_context_snapshot: async (state) => {
    const snapshot = await saveContextSnapshot({
      tenantId: state.tenantId,
      patientUid: state.context.admission.patient_uid,
      admissionId: state.admissionId,
      contextType: state.moduleKey,
      payload: state.packet,
      createdBy: state.requestedBy,
    });
    return { snapshot, fallbackDraft: buildAdmissionFallback(state.moduleKey, state.context) };
  },

  generate_ai_text: async (state) => {
    const aiResult = await generateClinicalText({
      taskType: state.moduleKey,
      systemPrompt: state.prompt.system_prompt,
      userPrompt: `${state.prompt.user_prompt_template}\n\n${JSON.stringify({ module_key: state.moduleKey, chart_packet: state.packet })}`,
      tenantRegion: state.requestContext.tenant_region,
      tenantId: state.tenantId,
    });
    return { aiResult, draft: safeJsonParse(aiResult.text, state.fallbackDraft) };
  },

  build_safety_flags: async (state) => {
    // baseCitations = chart-packet + RAG citations ONLY (NO curated KB). The
    // requiresCitations fail-close in buildCommonSafetyFlags is evaluated on
    // these alone, so a curated-KB citation (WS5 B5.5) can NEVER satisfy a
    // gate that must require chart/RAG grounding.
    const baseCitations = uniqueCitations([
      ...state.packet.citations,
      ...state.retrievedCitations,
    ]);
    // Full citation set (base + KB) that is persisted, returned, and shown.
    // Curated-KB citations stay visible for traceability; uniqueCitations
    // de-dupes; an empty kbCitations leaves the set equal to baseCitations.
    const citations = uniqueCitations([
      ...baseCitations,
      ...(state.kbCitations || []),
    ]);
    const safetyFlags = buildCommonSafetyFlags(state.context, state.module, baseCitations);
    if (!state.retrieved?.results?.length && state.retrieved?.source === 'corpus_unavailable') {
      safetyFlags.push({
        severity: 'low',
        code: 'RAG_UNAVAILABLE',
        message: 'Institutional-memory corpus not available. Draft grounded only in current admission chart.',
      });
    }
    // Layer hallucination defenses.
    const outputDefenseFlags = runOutputDefenses({
      draft: state.draft,
      module: state.module,
      context: state.context,
      citations,
    });
    safetyFlags.push(...outputDefenseFlags);
    if (
      state.moduleKey === 'clinical_coding_assist'
      && !asArray(state.context.notes).some((event) => event.payload?.is_signed === true)
    ) {
      safetyFlags.push({
        severity: 'high',
        code: 'NO_SIGNED_DOCUMENTATION',
        message: 'Coding assistant is restricted to signed documentation and no signed note was found.',
      });
    }
    // Validate ICD-10 codes in the draft and merge any UNVALIDATED_CODE flags.
    if (state.moduleKey === 'clinical_coding_assist' && state.draft && Array.isArray(state.draft.suggested_codes)) {
      const { annotateCodingDraft } = await import('./codingValidationService.js');
      const { suggested_codes, safety_flags: codeFlags } = await annotateCodingDraft(state.draft, { tenantId: state.tenantId });
      state.draft.suggested_codes = suggested_codes;   // replace with validated/annotated codes
      safetyFlags.push(...codeFlags);                  // merge UNVALIDATED_CODE flag(s)
    }
    return { citations, safetyFlags, outputDefenseFlags };
  },

  run_debate: async (state) => {
    // TradingAgents-style pursue/challenge differential. Module-gated.
    const debateOutcome = runDifferentialDebate({
      chartPacket: state.packet,
      draft: state.draft,
      module: state.module,
      citations: state.citations,
      maxRounds: state.module?.settings?.maxDebateRounds || 1,
    });
    const draft = debateOutcome.evidence_balance
      ? { ...state.draft, evidence_balance: debateOutcome.evidence_balance }
      : state.draft;
    const safetyFlags = [...state.safetyFlags, ...debateOutcome.safety_flags];
    return { debateOutcome, draft, safetyFlags };
  },

  persist_generation: async (state) => {
    // Critical defense failures (PHI leaks, unsafe allergies) mark the
    // draft as failed so it never enters the review queue — it lands in
    // the dead-letter dashboard for platform admins to investigate.
    const hasCriticalFlag = state.safetyFlags.some((flag) => flag.severity === 'critical');
    const generation = await saveGeneration({
      tenantId: state.tenantId,
      patientUid: state.context.admission.patient_uid,
      admissionId: state.admissionId,
      moduleKey: state.moduleKey,
      promptVersion: state.prompt.version || 'v1',
      sourceHash: state.snapshot.source_hash,
      draft: state.draft,
      citations: state.citations,
      safetyFlags: state.safetyFlags,
      generatedBy: state.requestedBy,
      aiResult: state.aiResult,
      status: hasCriticalFlag ? 'failed' : 'draft',
      failureReason: hasCriticalFlag
        ? state.safetyFlags.find((flag) => flag.severity === 'critical')?.code || 'critical_defense_failure'
        : null,
      metadata: {
        request_id: state.requestContext.request_id,
        context_snapshot_id: state.snapshot.id || null,
        tenant_region: state.requestContext.tenant_region,
        output_defenses_ran: true,
        // AI-4c: heuristic defenses are NOT a safety proof. This flag means
        // "no heuristic defense flag fired", not "verified safe" — a human
        // reviewer remains authoritative. Renamed from the old
        // `defenses_passed`, which read as a clean bill of health.
        no_heuristic_flags: !asArray(state.outputDefenseFlags).length,
        output_defense_flag_codes: asArray(state.outputDefenseFlags).map((flag) => flag.code),
        defense_flag_codes: state.safetyFlags.map((flag) => flag.code),
        context_signature: state.contextSignature,
        prior_decisions_count: state.decisionMemory.entries.length,
        prior_decisions_source: state.decisionMemory.source,
        debate_enabled: state.debateOutcome.debate_enabled,
        debate_balance: state.debateOutcome.evidence_balance?.balance || null,
      },
    });
    return { generation, hasCriticalFlag };
  },

  persist_safety_review: async (state) => {
    const safetyReview = await runSafetyReview({
      tenantId: state.tenantId,
      generationId: state.generation.id,
      moduleKey: state.moduleKey,
      citations: state.citations,
      safetyFlags: state.safetyFlags,
    });
    return { safetyReview };
  },

  create_review_placeholder: async (state) => {
    const review = await createReviewPlaceholder({
      tenantId: state.tenantId,
      generationId: state.generation.id,
      module: state.module,
      patientUid: state.context.admission.patient_uid,
      admissionId: state.admissionId,
    });
    return { review };
  },

  publish_draft_event: async (state) => {
    await publishEvent({
      eventType: 'clinical_ai.draft_generated',
      aggregateType: 'clinical_ai_generation',
      aggregateId: state.generation.id,
      patientUid: state.context.admission.patient_uid,
      payload: {
        tenant_id: state.tenantId,
        module_key: state.moduleKey,
        admission_id: state.admissionId,
        review_id: state.review?.id || null,
      },
    });
    return {};
  },

  build_response: async (state) => {
    return {
      result: standardDraftResponse({
        module: state.module,
        prompt: state.prompt,
        draft: state.draft,
        citations: state.citations,
        safetyFlags: state.safetyFlags,
        aiResult: state.aiResult,
        generation: state.generation,
        review: state.review,
        safetyReview: state.safetyReview,
      }),
    };
  },
};

let _admissionAiDraftGraph = null;
export function getAdmissionAiDraftGraph() {
  if (!_admissionAiDraftGraph) {
    _admissionAiDraftGraph = new WorkflowGraph({
      key: 'admission_ai_draft',
      nodes: ADMISSION_AI_DRAFT_GRAPH_NODES,
      start: 'gather_chart_context',
    });
  }
  return _admissionAiDraftGraph;
}

// Re-exported for parent workflows (e.g. discharge_summary_compose) that
// need to validate moduleKey before spawning the admission_ai_draft graph
// as a subgraph.
export { ADMISSION_MODULES };

// Re-exported helpers for parent workflows that need to fabricate the
// initial state shape that the admission_ai_draft graph expects.
export { requireEnabledModule, resolveTenantId };

// Exported as a pure function so the AI-5 invariant (zero citations on a
// citations-required module is a CRITICAL/blocking flag) is unit-testable
// without standing up the full admission workflow + DB.
export { buildCommonSafetyFlags };

export async function generateAdmissionAiDraft(admissionId, moduleKey, requestedBy, req = null) {
  const key = cleanText(moduleKey).toLowerCase();
  if (!ADMISSION_MODULES.has(key)) throw AppError.badRequest('Unsupported admission AI module');

  const tenantId = resolveTenantId({ tenantId: req?.tenantId });
  const module = await requireEnabledModule(key, { tenantId });

  // Lift only the fields nodes need from the Express request — the full
  // req object is not safely JSON-serialisable (circular refs, methods)
  // and the runner persists state to JSONB on every node transition.
  const requestContext = {
    request_id: req?.id || null,
    tenant_region: req?.tenant?.region || null,
    // Used by the kb_grounding node for the KB access-policy gate. Optional
    // — the grounding helper falls back to a clinician-equivalent role.
    requested_by_role: req?.user?.role || null,
  };

  const outcome = await runWorkflow({
    graph: getAdmissionAiDraftGraph(),
    initialState: { admissionId, moduleKey: key, requestedBy, requestContext, module, tenantId },
    store: getDefaultCheckpointStore(),
    tenantId,
    startedBy: requestedBy,
    workflowMetadata: {
      module_key: key,
      admission_id: admissionId,
      request_id: requestContext.request_id,
    },
  });

  if (outcome.status === 'failed') {
    const node = outcome.error?.node || 'unknown';
    const message = outcome.error?.message || 'Workflow failed';
    logger.error('Admission AI draft workflow failed', { admissionId, moduleKey: key, node, message });
    // Surface the original failure as a 500-class error. Callers see the
    // same error semantics as before the refactor — node-level detail is
    // logged for debugging but not leaked to clients.
    throw AppError.internal('Failed to generate admission AI draft', 'ADMISSION_AI_DRAFT_FAILED');
  }

  return outcome.result;
}

function wardBriefDraft(ward, contexts) {
  return {
    ward: ward || 'all',
    generated_at: new Date().toISOString(),
    patients: contexts.map((context) => {
      const packet = buildChartPacket(context);
      return {
        admission_id: packet.admission.id,
        patient_uid: packet.patient.uid,
        patient_name: packet.patient.name,
        location: `${packet.admission.ward || '-'} / ${packet.admission.bed_number || '-'}`,
        overnight_events: packet.recent_notes.slice(-3).map((item) => item.summary),
        abnormal_results: abnormalResultTriage(context).urgent_items,
        medication_changes: packet.medications.slice(-5).map((item) => item.summary),
        pending_investigations: pendingInvestigations(context).map((item) => item.summary),
        discharge_blockers: dischargeReadiness(context).blockers,
      };
    }),
  };
}

export async function generateWardRoundBrief({ ward = null, limit = 20, requestedBy = null, req = null } = {}) {
  const tenantId = resolveTenantId({ tenantId: req?.tenantId });
  const module = await requireEnabledModule('daily_ward_round_brief', { tenantId });
  const safeLimit = clampInt(limit, { min: 1, max: 50, fallback: 20 });
  const admissions = await prisma.$queryRawUnsafe(
    `SELECT id
     FROM admissions
     WHERE status = 'admitted'
       AND tenant_id = $1::uuid
       AND ($2::text IS NULL OR ward = $2)
     ORDER BY admitted_at DESC NULLS LAST, created_at DESC
     LIMIT $3`,
    tenantId,
    ward || null,
    safeLimit
  );
  const contexts = [];
  for (const admission of admissions) {
    contexts.push(await collectAdmissionClinicalContext(admission.id, tenantId));
  }

  const prompt = await getActivePrompt('daily_ward_round_brief', { tenantId });
  const fallbackDraft = wardBriefDraft(ward, contexts);
  const packet = {
    ward,
    admissions: contexts.map(buildChartPacket),
  };
  const snapshot = await saveContextSnapshot({
    tenantId,
    contextType: 'daily_ward_round_brief',
    payload: packet,
    createdBy: requestedBy,
  });
  const aiResult = await generateClinicalText({
    taskType: 'daily_ward_round_brief',
    systemPrompt: prompt.system_prompt,
    userPrompt: `${prompt.user_prompt_template}\n\n${JSON.stringify(packet)}`,
    tenantRegion: req?.tenant?.region,
    tenantId,
  });
  const draft = safeJsonParse(aiResult.text, fallbackDraft);
  const citations = uniqueCitations(contexts.flatMap((context) => context.citations));
  const safetyFlags = citations.length
    ? []
    : [{ severity: 'medium', code: 'NO_ACTIVE_ADMISSIONS', message: 'No admitted patients were available for this ward brief.' }];
  safetyFlags.push(...runOutputDefenses({ draft, module, context: { admissions: contexts }, citations }));
  const generation = await saveGeneration({
    tenantId,
    moduleKey: 'daily_ward_round_brief',
    promptVersion: prompt.version || 'v1',
    sourceHash: snapshot.source_hash,
    draft,
    citations,
    safetyFlags,
    generatedBy: requestedBy,
    aiResult,
    metadata: {
      request_id: req?.id || null,
      ward,
      context_snapshot_id: snapshot.id || null,
      tenant_region: req?.tenant?.region || null,
    },
  });
  const safetyReview = await runSafetyReview({
    tenantId,
    generationId: generation.id,
    moduleKey: 'daily_ward_round_brief',
    citations,
    safetyFlags,
  });
  const review = await createReviewPlaceholder({ tenantId, generationId: generation.id, module });
  await publishEvent({
    eventType: 'clinical_ai.ward_brief_generated',
    aggregateType: 'clinical_ai_generation',
    aggregateId: generation.id,
    payload: { tenant_id: tenantId, module_key: 'daily_ward_round_brief', ward, review_id: review?.id || null },
  });
  return standardDraftResponse({ module, prompt, draft, citations, safetyFlags, aiResult, generation, review, safetyReview });
}

function denialRiskGaps(claim) {
  if (!claim) return ['Claim not found'];
  const gaps = [];
  if (!claim.invoice_id) gaps.push('No linked invoice');
  const documents = Array.isArray(claim.documents)
    ? claim.documents
    : (claim.documents && Array.isArray(claim.documents.items) ? claim.documents.items : null);
  if (!documents || documents.length === 0) gaps.push('No supporting documents attached');
  if (!claim.policy_number) gaps.push('Missing policy number');
  if (!claim.insurance_provider) gaps.push('Missing payer');
  if (Number(claim.claim_amount) <= 0) gaps.push('Claim amount is zero or missing');
  return gaps;
}

function denialRiskDraft(claim) {
  if (!claim) {
    return {
      risk_level: 'unknown',
      gaps: ['Claim not found'],
      recommended_actions: ['Verify claim id and retry.'],
    };
  }
  const gaps = denialRiskGaps(claim);
  return {
    claim_number: claim.claim_number,
    patient_uid: claim.patient_uid,
    payer: claim.insurance_provider,
    risk_level: gaps.length >= 2 ? 'high' : gaps.length ? 'medium' : 'low',
    gaps,
    recommended_actions: gaps.length
      ? ['Attach signed documentation, invoice evidence, diagnosis/procedure support, and payer-specific forms.']
      : ['Proceed with standard billing review.'],
  };
}

export async function generateDenialRiskAssist(claimId, requestedBy, req = null) {
  const tenantId = resolveTenantId({ tenantId: req?.tenantId });
  const module = await requireEnabledModule('denial_risk_assist', { tenantId });
  const id = Number.parseInt(claimId, 10);
  if (!Number.isFinite(id)) throw AppError.badRequest('Invalid claim ID');

  // Tenant-scope the lookup (audit 2026-06-22 H6): insurance_claims carries
  // tenant_id (migration 239) but this query previously matched on id only — a
  // cross-tenant claim id would load another tenant's claim (+ patient PHI) into
  // the denial-risk assist. SERIAL ids are not globally unique, so the tenant
  // predicate is load-bearing defense-in-depth even before the RLS enforce flip.
  // The sibling appealLetterGeneratorService.loadClaim was already fixed this way.
  const rows = await prisma.$queryRawUnsafe(
    `SELECT c.id, c.claim_number, c.patient_uid, c.invoice_id, c.insurance_provider,
            c.policy_number, c.claim_amount, c.approved_amount, c.status, c.documents,
            c.submitted_at, c.reviewed_at, c.rejection_reason,
            i.invoice_number, i.items, i.total_amount, i.payment_status,
            u.name AS patient_name
     FROM insurance_claims c
     LEFT JOIN invoices i ON i.id = c.invoice_id
     LEFT JOIN users u ON u.uid = c.patient_uid
     WHERE c.id = $1
       AND c.tenant_id = $2::uuid
     LIMIT 1`,
    id,
    tenantId,
  );
  const claim = rows[0] || null;
  if (!claim) throw AppError.notFound('Insurance claim not found');

  const prompt = await getActivePrompt('denial_risk_assist', { tenantId });
  const fallbackDraft = denialRiskDraft(claim);
  const snapshot = await saveContextSnapshot({
    tenantId,
    patientUid: claim.patient_uid,
    contextType: 'denial_risk_assist',
    payload: claim,
    createdBy: requestedBy,
  });
  const aiResult = await generateClinicalText({
    taskType: 'denial_risk_assist',
    systemPrompt: prompt.system_prompt,
    userPrompt: `${prompt.user_prompt_template}\n\n${JSON.stringify({ claim })}`,
    tenantRegion: req?.tenant?.region,
    tenantId,
  });
  const draft = safeJsonParse(aiResult.text, fallbackDraft);
  const citations = [
    citationFor('insurance_claim', claim.id, claim.claim_number, claim.submitted_at),
    ...(claim.invoice_id ? [citationFor('invoice', claim.invoice_id, claim.invoice_number, null)] : []),
  ];
  // Compute safety flags from the raw claim row, not the AI draft — a
  // hallucinating model could omit gaps that are objectively true from the
  // DB record. Rules stay authoritative.
  const independentGaps = denialRiskGaps(claim);
  const safetyFlags = independentGaps.map((gap) => ({
    severity: gap === 'No supporting documents attached' ? 'high' : 'medium',
    code: 'DENIAL_RISK_GAP',
    message: gap,
  }));
  safetyFlags.push(...runOutputDefenses({ draft, module, context: { claim }, citations }));
  const generation = await saveGeneration({
    tenantId,
    patientUid: claim.patient_uid,
    moduleKey: 'denial_risk_assist',
    promptVersion: prompt.version || 'v1',
    sourceHash: snapshot.source_hash,
    draft,
    citations,
    safetyFlags,
    generatedBy: requestedBy,
    aiResult,
    metadata: {
      request_id: req?.id || null,
      claim_id: id,
      context_snapshot_id: snapshot.id || null,
      tenant_region: req?.tenant?.region || null,
    },
  });
  const safetyReview = await runSafetyReview({
    tenantId,
    generationId: generation.id,
    moduleKey: 'denial_risk_assist',
    citations,
    safetyFlags,
  });
  const review = await createReviewPlaceholder({
    tenantId,
    generationId: generation.id,
    module,
    patientUid: claim.patient_uid,
  });
  return standardDraftResponse({ module, prompt, draft, citations, safetyFlags, aiResult, generation, review, safetyReview });
}

export async function getBedForecast({ ward = null, windowHours = 24, tenantId = null } = {}) {
  const tid = resolveTenantId({ tenantId });
  await requireEnabledModule('bed_discharge_forecast', { tenantId: tid });
  const safeHours = clampInt(windowHours, { min: 1, max: 168, fallback: 24 });
  const rows = await prisma.$queryRawUnsafe(
    `SELECT a.id, a.patient_uid, a.ward, a.bed_number, a.admitted_at, a.expected_los_days, a.status
     FROM admissions a
     JOIN users u ON u.uid = a.patient_uid AND u.tenant_id = $1::uuid
     WHERE a.status = 'admitted'
       AND ($2::text IS NULL OR a.ward = $2)
     ORDER BY a.admitted_at ASC NULLS LAST`,
    tid,
    ward || null
  );

  const now = Date.now();
  const patients = rows.map((row) => {
    const admittedAt = row.admitted_at ? new Date(row.admitted_at).getTime() : now;
    const elapsedHours = Math.max(0, Math.round((now - admittedAt) / 36_000) / 100);
    const expectedHours = row.expected_los_days ? Number(row.expected_los_days) * 24 : 72;
    const remainingHours = Math.max(expectedHours - elapsedHours, 0);
    return {
      admission_id: row.id,
      patient_uid: row.patient_uid,
      ward: row.ward,
      bed_number: row.bed_number,
      likely_discharge_24h: remainingHours <= 24,
      likely_discharge_48h: remainingHours <= 48,
      remaining_hours_estimate: Math.round(remainingHours),
    };
  });
  const forecast = {
    ward: ward || 'all',
    forecast_window_hours: safeHours,
    admitted_count: rows.length,
    likely_discharges_24h: patients.filter((item) => item.likely_discharge_24h).length,
    likely_discharges_48h: patients.filter((item) => item.likely_discharge_48h).length,
    patients,
    generated_at: new Date().toISOString(),
  };
  // RLS POC — persists forecast under the tenant's RLS scope. The WITH CHECK
  // clause on the tenant_isolation policy enforces that tenant_id in the row
  // matches the GUC uuid set by setTenant.
  await setTenant(tid, (tx) =>
    tx.$executeRawUnsafe(
      `INSERT INTO clinical_ai_bed_forecasts
         (tenant_id, ward, forecast_window_hours, forecast, created_at)
       VALUES ($1::uuid, $2, $3, $4::jsonb, NOW())`,
      tid, ward || null, safeHours, JSON.stringify(forecast),
    ),
  );
  return forecast;
}

export async function getPharmacyStockoutForecast({ days = 7, tenantId = null } = {}) {
  const tid = resolveTenantId({ tenantId });
  await requireEnabledModule('pharmacy_stockout_predictor', { tenantId: tid });
  const safeDays = clampInt(days, { min: 1, max: 90, fallback: 7 });
  const rows = await prisma.$queryRawUnsafe(
    `SELECT COALESCE(co.details->>'medication_name', co.details->>'name', 'Unknown medication') AS medication_name,
            COUNT(*)::int AS order_count
     FROM clinical_orders co
     JOIN users u ON u.uid = co.patient_uid AND u.tenant_id = $2::uuid
     WHERE co.order_type = 'medication'
       AND co.created_at >= NOW() - ($1::int * INTERVAL '1 day')
     GROUP BY COALESCE(co.details->>'medication_name', co.details->>'name', 'Unknown medication')
     ORDER BY order_count DESC, medication_name
     LIMIT 50`,
    safeDays,
    tid
  );
  const highUsageMeds = rows.map((row) => ({
    medication_name: row.medication_name,
    order_count: row.order_count,
    risk_level: row.order_count >= 20 ? 'high' : row.order_count >= 5 ? 'medium' : 'low',
    recommended_action: row.order_count >= 5 ? 'Review reorder level and supplier lead time.' : 'Monitor routine usage.',
  }));
  const forecast = {
    window_days: safeDays,
    high_usage_meds: highUsageMeds,
    stockout_risks: highUsageMeds.filter((item) => item.risk_level !== 'low'),
    generated_at: new Date().toISOString(),
  };
  for (const item of highUsageMeds.slice(0, 20)) {
    // RLS POC — each write runs under the tenant GUC; RLS WITH CHECK enforces
    // tenant_id matches the GUC uuid, so a misconfigured caller cannot smuggle
    // rows into another tenant.
    await setTenant(tid, (tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO clinical_ai_pharmacy_forecasts
           (tenant_id, medication_name, risk_level, forecast, created_at)
         VALUES ($1::uuid, $2, $3, $4::jsonb, NOW())`,
        tid, item.medication_name, item.risk_level, JSON.stringify(item),
      ),
    );
  }
  return forecast;
}

export async function listPrompts({ moduleKey = null, status = null, limit = 100, tenantId = null } = {}) {
  const tid = resolveTenantId({ tenantId });
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, module_key, version, title, system_prompt, user_prompt_template,
            output_schema, status, active, created_by, activated_by, activated_at,
            created_at, updated_at
     FROM clinical_ai_prompts
     WHERE tenant_id = $1::uuid
       AND ($2::text IS NULL OR module_key = $2)
       AND ($3::text IS NULL OR status = $3)
     ORDER BY module_key, active DESC, created_at DESC
     LIMIT $4`,
    tid,
    moduleKey || null,
    status || null,
    clampInt(limit, { min: 1, max: 500, fallback: 100 })
  );
  return { prompts: rows, count: rows.length };
}

export async function createPrompt(data = {}, createdBy = null, options = {}) {
  const tid = resolveTenantId(options);
  const moduleKey = cleanText(data.module_key).toLowerCase();
  if (!moduleKey) throw AppError.badRequest('module_key is required');
  await getClinicalAiModule(moduleKey);
  const version = cleanText(data.version, `v${Date.now()}`);
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO clinical_ai_prompts
       (tenant_id, module_key, version, title, system_prompt, user_prompt_template,
        output_schema, status, active, created_by, created_at, updated_at)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb, 'draft', false, $8::uuid, NOW(), NOW())
     RETURNING id, module_key, version, title, status, active, created_at`,
    tid,
    moduleKey,
    version,
    cleanText(data.title, `${moduleKey} ${version}`),
    cleanText(data.system_prompt, MODULE_PROMPT_FALLBACK.system_prompt),
    cleanText(data.user_prompt_template, MODULE_PROMPT_FALLBACK.user_prompt_template),
    JSON.stringify(data.output_schema || {}),
    createdBy
  );
  return rows[0];
}

export async function getApprovalById(approvalId, options = {}) {
  if (!approvalId) return null;
  const tid = resolveTenantId(options);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, approval_type, module_key, status, requested_by, approved_by,
            rejected_by, reason, payload, expires_at, decided_at, created_at
     FROM clinical_ai_approvals
     WHERE id = $1
       AND tenant_id = $2::uuid
     LIMIT 1`,
    Number.parseInt(approvalId, 10),
    tid
  );
  return rows[0] || null;
}

export async function createApproval(data = {}, requestedBy = null, options = {}) {
  const tid = resolveTenantId(options);
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO clinical_ai_approvals
       (tenant_id, approval_type, module_key, status, requested_by, reason, payload, expires_at, created_at, updated_at)
     VALUES ($1::uuid, $2, $3, 'pending', $4::uuid, $5, $6::jsonb, $7::timestamptz, NOW(), NOW())
     RETURNING id, approval_type, module_key, status, requested_by, reason, payload, expires_at, created_at`,
    tid,
    cleanText(data.approval_type, 'governance_change'),
    data.module_key ? cleanText(data.module_key).toLowerCase() : null,
    requestedBy,
    cleanText(data.reason, 'Clinical AI governance approval requested'),
    JSON.stringify(data.payload || {}),
    data.expires_at || null
  );
  return rows[0];
}

export async function decideApproval(approvalId, decision, actorUid, reason = null, options = {}) {
  const tid = resolveTenantId(options);
  const normalized = cleanText(decision).toLowerCase();
  if (!['approved', 'rejected'].includes(normalized)) {
    throw AppError.badRequest('decision must be approved or rejected');
  }
  const approval = await getApprovalById(approvalId, { tenantId: tid });
  if (!approval) throw AppError.notFound('Clinical AI approval not found');
  if (approval.status !== 'pending') throw AppError.conflict('Clinical AI approval was already decided');
  if (approval.requested_by && approval.requested_by === actorUid) {
    throw AppError.forbidden('Two-person approval requires a different approver');
  }

  const rows = await prisma.$queryRawUnsafe(
    `UPDATE clinical_ai_approvals
     SET status = $2::text,
         approved_by = CASE WHEN $2::text = 'approved' THEN $3::uuid ELSE approved_by END,
         rejected_by = CASE WHEN $2::text = 'rejected' THEN $3::uuid ELSE rejected_by END,
         reason = COALESCE($4::text, reason),
         decided_at = NOW(),
         updated_at = NOW()
     WHERE id = $1::int
       AND tenant_id = $5::uuid
     RETURNING id, approval_type, module_key, status, requested_by, approved_by,
               rejected_by, reason, payload, expires_at, decided_at, created_at`,
    Number.parseInt(approvalId, 10),
    normalized,
    actorUid,
    reason || null,
    tid
  );
  return rows[0];
}

export async function activatePrompt(promptId, activatedBy, approvalId = null, options = {}) {
  const tid = resolveTenantId(options);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, module_key, version, title, status
     FROM clinical_ai_prompts
     WHERE id = $1
       AND tenant_id = $2::uuid
     LIMIT 1`,
    Number.parseInt(promptId, 10),
    tid
  );
  const prompt = rows[0];
  if (!prompt) throw AppError.notFound('Clinical AI prompt not found');

  const approval = await getApprovalById(approvalId, { tenantId: tid });
  if (!approval || approval.status !== 'approved') {
    const pending = await createApproval({
      approval_type: 'prompt_activation',
      module_key: prompt.module_key,
      reason: `Activate prompt ${prompt.version} for ${prompt.module_key}`,
      payload: { prompt_id: prompt.id, version: prompt.version },
    }, activatedBy, { tenantId: tid });
    return { approval_required: true, approval: pending, prompt };
  }

  await prisma.$queryRawUnsafe(
    `UPDATE clinical_ai_prompts
     SET active = false, status = CASE WHEN status = 'active' THEN 'superseded' ELSE status END, updated_at = NOW()
     WHERE module_key = $1 AND tenant_id = $2::uuid AND active = true`,
    prompt.module_key,
    tid
  );
  const updated = await prisma.$queryRawUnsafe(
    `UPDATE clinical_ai_prompts
     SET active = true, status = 'active', activated_by = $2::uuid,
         activated_at = NOW(), updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $3::uuid
     RETURNING id, module_key, version, title, status, active, activated_by, activated_at`,
    prompt.id,
    activatedBy,
    tid
  );
  return { approval_required: false, prompt: updated[0] };
}

export async function listReviews({ decision = null, moduleKey = null, reviewerRole = null, limit = 100, tenantId = null } = {}) {
  const tid = resolveTenantId({ tenantId });
  // reviewerRole filters to modules whose settings.reviewRoles[] contains the
  // role — lets a DOCTOR see only the queue they're eligible to sign off on.
  // The module's reviewRoles comes from settings JSONB; use ? to check array
  // membership with a case-insensitive upper-case comparison.
  const normalizedRole = reviewerRole ? String(reviewerRole).toUpperCase() : null;
  let rows;
  try {
    rows = await prisma.$queryRawUnsafe(
      `SELECT r.id, r.generation_id, r.module_key, r.patient_uid, u.name AS patient_name,
              r.admission_id, r.reviewer_uid, r.reviewer_role, r.decision,
              r.edited_draft, r.rejection_reason, r.reviewer_note,
              r.metadata, r.created_at, r.updated_at,
              g.provider, g.model, g.total_tokens, g.used_ai,
              g.draft, g.citations,
              g.status AS generation_status,
              COALESCE(g.metadata->>'tier', g.metadata->>'model_tier',
                CASE WHEN g.used_ai THEN 'quick' ELSE 'template' END) AS tier,
              COALESCE(g.metadata->>'model_tier', g.metadata->>'tier',
                CASE WHEN g.used_ai THEN 'quick' ELSE 'template' END) AS model_tier,
              COALESCE(g.metadata->>'generation_mode',
                CASE WHEN g.used_ai THEN 'ai' ELSE 'template_fallback' END) AS generation_mode,
              g.metadata->>'fallback_reason' AS fallback_reason,
              g.metadata->>'readiness_reason' AS readiness_reason,
              COALESCE(g.metadata->>'provider_status',
                CASE WHEN g.used_ai THEN 'used' ELSE 'template_fallback' END) AS provider_status,
              g.safety_flags,
              m.settings->'reviewRoles' AS module_review_roles
       FROM clinical_ai_reviews r
       LEFT JOIN users u ON u.uid = r.patient_uid
       LEFT JOIN clinical_ai_generations g ON g.id = r.generation_id
       LEFT JOIN clinical_ai_modules m ON m.module_key = r.module_key
       WHERE r.tenant_id = $1::uuid
         AND ($2::text IS NULL OR r.decision = $2)
         AND ($3::text IS NULL OR r.module_key = $3)
         AND ($4::text IS NULL OR COALESCE(m.settings->'reviewRoles', '[]'::jsonb) ? $4)
       ORDER BY r.created_at DESC
       LIMIT $5`,
      tid,
      decision || null,
      moduleKey || null,
      normalizedRole,
      clampInt(limit, { min: 1, max: 500, fallback: 100 })
    );
  } catch (err) {
    throw clinicalAiSchemaUnavailable(err, 'review_list');
  }
  return { reviews: rows, count: rows.length };
}

// AI-2 (WS5 B5.1): the ONLY sanctioned read path for surfacing a clinical AI
// output to a patient. Until now "the patient app reads only accepted rows"
// was a comment in patientExplainersService; this makes the invariant code.
//
// Hard rules baked into the query (not optional params a caller can drop):
//   1. clinical_ai_reviews.decision = 'accepted' — pending/rejected/
//      needs_revision/edited reviews are NEVER published.
//   2. clinical_ai_generations.status = 'draft' — a generation that was
//      dead-lettered (status='failed') or is mid-review (pending) or was
//      mutated post-review (reviewed/edited/rejected) is NEVER published.
//      Note: 'draft' is the status a clean generation keeps; the workflow
//      sets status='failed' for critical-flag drafts, and updateReview()
//      moves accepted generations to status='accepted'. We therefore also
//      accept 'accepted' generation status (the post-signoff state) — but
//      NOT failed/pending/reviewed/rejected/edited.
//   3. tenant scope — r.tenant_id must match.
//   4. patient scope — r.patient_uid must match the requesting patient.
//
// Returns ONLY publishable fields. Internal artefacts — safety_flags,
// reviewer identity/notes, provider/model, generation metadata, rejection
// reasons — are deliberately omitted. When the reviewer edited the draft,
// the edited (reviewer-authored) version is what gets published.
export async function getPublishedAiOutputForPatient({
  patientUid,
  tenantId = null,
  moduleKey = null,
  limit = 50,
} = {}) {
  const uid = cleanText(patientUid);
  if (!uid) {
    throw AppError.badRequest('patientUid is required', 'CLINICAL_AI_PUBLISHED_PATIENT_REQUIRED');
  }
  const tid = resolveTenantId({ tenantId });
  if (tid === null) {
    // Patient-facing reads are always tenant-scoped; a null (all-tenants)
    // scope is a SUPER_ADMIN affordance that must never publish PHI to a
    // patient surface.
    throw AppError.badRequest(
      'tenantId is required for patient-facing AI output',
      'CLINICAL_AI_PUBLISHED_TENANT_REQUIRED'
    );
  }
  // moduleKey is bound as a parameter ($3) so it's injection-safe; normalize
  // to the registry's lowercase form for an exact-match filter.
  const key = moduleKey
    ? cleanText(moduleKey).toLowerCase().replace(/[^a-z0-9_-]/g, '') || null
    : null;

  let rows;
  try {
    rows = await prisma.$queryRawUnsafe(
      `SELECT r.id AS review_id,
              r.generation_id,
              r.module_key,
              r.patient_uid,
              r.updated_at AS published_at,
              COALESCE(r.edited_draft, g.draft) AS published_draft,
              g.citations AS source_citations,
              COALESCE(g.metadata->>'model_tier', g.metadata->>'tier') AS model_tier
       FROM clinical_ai_reviews r
       JOIN clinical_ai_generations g
         ON g.id = r.generation_id
        AND g.tenant_id = r.tenant_id
       WHERE r.tenant_id = $1::uuid
         AND r.patient_uid = $2::uuid
         AND r.decision = 'accepted'
         AND g.status IN ('draft', 'accepted')
         AND ($3::text IS NULL OR r.module_key = $3)
       ORDER BY r.updated_at DESC
       LIMIT $4`,
      tid,
      uid,
      key,
      clampInt(limit, { min: 1, max: 200, fallback: 50 })
    );
  } catch (err) {
    throw clinicalAiSchemaUnavailable(err, 'published_patient_output');
  }

  const outputs = asArray(rows).map((row) => ({
    review_id: row.review_id,
    generation_id: row.generation_id,
    module_key: row.module_key,
    patient_uid: row.patient_uid,
    published_at: row.published_at,
    output: row.published_draft || {},
    source_citations: asArray(row.source_citations),
    model_tier: row.model_tier || null,
  }));

  return { outputs, count: outputs.length };
}

export async function updateReview(reviewId, data = {}, reviewerUid = null, reviewerRole = null, options = {}) {
  const tid = resolveTenantId(options);
  const decision = cleanText(data.decision || 'pending').toLowerCase();
  const reviewerNote = normalizeReviewerNote(data);
  const id = Number.parseInt(reviewId, 10);
  let existingRows;
  try {
    existingRows = await prisma.$queryRawUnsafe(
      `SELECT r.id, r.generation_id, r.module_key, r.patient_uid, r.admission_id,
              r.metadata, COALESCE(tm.settings->'reviewRoles', m.settings->'reviewRoles', r.metadata->'review_roles') AS module_review_roles
       FROM clinical_ai_reviews r
       LEFT JOIN clinical_ai_tenant_modules tm
         ON tm.tenant_id = r.tenant_id
        AND tm.module_key = r.module_key
       LEFT JOIN clinical_ai_modules m
         ON m.module_key = r.module_key
       WHERE r.id = $1
         AND r.tenant_id = $2::uuid
       LIMIT 1`,
      id,
      tid
    );
  } catch (err) {
    throw clinicalAiSchemaUnavailable(err, 'review_lookup');
  }
  const existing = existingRows[0];
  if (!existing) throw AppError.notFound('Clinical AI review not found');
  if (!roleAllowedForReview({
    review: existing,
    reviewerRole,
    allowOverride: Boolean(options.allowReviewRoleOverride),
  })) {
    throw AppError.forbidden(
      'Your role is not allowed to update this Clinical AI review',
      'CLINICAL_AI_REVIEW_ROLE_FORBIDDEN'
    );
  }
  if (REVIEW_NOTE_REQUIRED_DECISIONS.has(decision) && !hasSubstantiveReviewerNote(reviewerNote)) {
    throw AppError.badRequest(
      `Accepted Clinical AI reviews require a reviewer_note with at least ${REVIEW_NOTE_MIN_WORDS} words.`,
      'CLINICAL_AI_REVIEW_NOTE_REQUIRED',
      {
        field: 'reviewer_note',
        min_chars: REVIEW_NOTE_MIN_CHARS,
        min_words: REVIEW_NOTE_MIN_WORDS,
        decision,
      }
    );
  }

  let rows;
  try {
    rows = await prisma.$queryRawUnsafe(
      `UPDATE clinical_ai_reviews
       SET reviewer_uid = $2::uuid,
           reviewer_role = $3,
           decision = $4,
           edited_draft = $5::jsonb,
           rejection_reason = $6,
           reviewer_note = $7,
           metadata = COALESCE(metadata, '{}'::jsonb) || $8::jsonb,
           updated_at = NOW()
       WHERE id = $1
         AND tenant_id = $9::uuid
       RETURNING id, generation_id, module_key, patient_uid, admission_id,
                 reviewer_uid, reviewer_role, decision, edited_draft,
                 rejection_reason, reviewer_note, metadata, created_at, updated_at`,
      id,
      reviewerUid,
      reviewerRole || null,
      decision,
      data.edited_draft ? JSON.stringify(data.edited_draft) : null,
      data.rejection_reason || null,
      reviewerNote || null,
      JSON.stringify({
        reviewed_at: new Date().toISOString(),
        reviewer_note_required: REVIEW_NOTE_REQUIRED_DECISIONS.has(decision),
      }),
      tid
    );
  } catch (err) {
    throw clinicalAiSchemaUnavailable(err, 'review_update');
  }
  const review = rows[0];
  if (!review) throw AppError.notFound('Clinical AI review not found');

  const generationStatus = REVIEW_STATUS_BY_DECISION[decision] || 'reviewed';
  await prisma.$queryRawUnsafe(
    `UPDATE clinical_ai_generations
     SET status = $2, reviewed_by = $3::uuid, updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $4::uuid`,
    review.generation_id,
    generationStatus,
    reviewerUid,
    tid
  );

  // Decision memory: project this review into the cross-run memory table
  // so subsequent drafts on the same patient (and matching cross-patient
  // contexts) can see what reviewers do with this kind of draft. Only
  // final decisions are projected; pending is not supervision signal. The
  // call is best-effort — projection failures do not abort the review.
  if (review.generation_id) {
    try {
      const genRows = await prisma.$queryRawUnsafe(
        `SELECT draft, metadata FROM clinical_ai_generations
         WHERE id = $1 AND tenant_id = $2::uuid LIMIT 1`,
        review.generation_id,
        tid
      );
      const genRow = genRows[0];
      if (genRow) {
        const originalDraft = genRow.draft || null;
        const editedDraft = data.edited_draft || null;
        const meta = genRow.metadata || {};
        await recordDecisionMemory({
          tenantId: tid,
          moduleKey: review.module_key,
          patientUid: review.patient_uid,
          admissionId: review.admission_id,
          generationId: review.generation_id,
          reviewId: review.id,
          decision,
          originalDraft,
          editedDraft,
          rejectionReason: data.rejection_reason,
          // Workflow service stashes the signature on the generation
          // metadata when available; if absent, the projection will skip
          // cross-patient retrieval candidacy.
          contextSignature: meta.context_signature || null,
          reviewerRole,
          reviewerUid,
        });
      }
    } catch (err) {
      logger.warn('Decision memory projection skipped', {
        reviewId: review.id,
        error: err.message,
      });
    }
  }

  // Results-inbox wiring (#4): when an abnormal_result_triage review is
  // ACCEPTED, promote it into the ack-tracked results-inbox via the
  // pre-existing bridge in resultsInboxService.  Best-effort (never throws,
  // never blocks the accept response).  The bridge itself gates on the module
  // being enabled for the tenant, so a disabled module is a silent no-op.
  if (decision === 'accepted' && review.module_key === 'abnormal_result_triage') {
    try {
      const { promoteAbnormalTriageResult } = await import('../results/resultsInboxService.js');
      await promoteAbnormalTriageResult(
        {
          generationId: review.generation_id,
          patientUid: review.patient_uid || null,
          // The draft's urgency_band may be in the generation row; pass what we
          // have — the bridge defaults gracefully to 'high' when absent.
          urgencyBand: null,
          title: null,
          summary: null,
        },
        { tenantId: tid },
      );
    } catch (err) {
      logger.warn('abnormal_result_triage inbox promotion skipped', {
        reviewId: review.id,
        error: err.message,
      });
    }
  }

  return review;
}

export async function listApprovals({ status = null, moduleKey = null, limit = 100, tenantId = null } = {}) {
  const tid = resolveTenantId({ tenantId });
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, approval_type, module_key, status, requested_by, approved_by,
            rejected_by, reason, payload, expires_at, decided_at, created_at, updated_at
     FROM clinical_ai_approvals
     WHERE tenant_id = $1::uuid
       AND ($2::text IS NULL OR status = $2)
       AND ($3::text IS NULL OR module_key = $3)
     ORDER BY created_at DESC
     LIMIT $4`,
    tid,
    status || null,
    moduleKey || null,
    clampInt(limit, { min: 1, max: 500, fallback: 100 })
  );
  return { approvals: rows, count: rows.length };
}

export async function startBreakGlass(data = {}, startedBy = null, options = {}) {
  const tid = resolveTenantId(options);
  const hours = clampInt(data.expires_in_hours, { min: 1, max: 24, fallback: 2 });
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO clinical_ai_break_glass_sessions
       (tenant_id, scope, reason, status, started_by, approved_by, expires_at, created_at, updated_at)
     VALUES ($1::uuid, $2, $3, 'active', $4::uuid, $5::uuid, NOW() + ($6::int * INTERVAL '1 hour'), NOW(), NOW())
     RETURNING id, scope, reason, status, started_by, approved_by, expires_at, created_at`,
    tid,
    cleanText(data.scope, 'clinical_ai'),
    cleanText(data.reason, 'Emergency Clinical AI governance access'),
    startedBy,
    data.approved_by || startedBy,
    hours
  );
  return rows[0];
}

export async function endBreakGlass(sessionId, endedBy = null, options = {}) {
  const tid = resolveTenantId(options);
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE clinical_ai_break_glass_sessions
     SET status = 'ended', ended_at = NOW(), updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $2::uuid
       AND status = 'active'
     RETURNING id, scope, reason, status, started_by, approved_by, expires_at, ended_at, created_at`,
    Number.parseInt(sessionId, 10),
    tid
  );
  if (!rows[0]) throw AppError.notFound('Active break-glass session not found');
  await publishEvent({
    eventType: 'clinical_ai.break_glass_ended',
    aggregateType: 'clinical_ai_break_glass',
    aggregateId: rows[0].id,
    payload: { tenant_id: tid, ended_by: endedBy },
  });
  return rows[0];
}

export async function getActiveBreakGlass(options = {}) {
  const tid = resolveTenantId(options);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, scope, reason, status, started_by, approved_by, expires_at, created_at
     FROM clinical_ai_break_glass_sessions
     WHERE tenant_id = $1::uuid
       AND status = 'active'
       AND expires_at > NOW()
     ORDER BY expires_at DESC
     LIMIT 20`,
    tid
  );
  return { sessions: rows, count: rows.length };
}

export default {
  activatePrompt,
  createApproval,
  createPrompt,
  decideApproval,
  endBreakGlass,
  generateAdmissionAiDraft,
  generateDenialRiskAssist,
  generateWardRoundBrief,
  getActiveBreakGlass,
  getBedForecast,
  getPharmacyStockoutForecast,
  getPublishedAiOutputForPatient,
  listApprovals,
  listPrompts,
  listReviews,
  startBreakGlass,
  updateReview,
};
