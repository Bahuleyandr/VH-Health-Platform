/**
 * Tier A patient explainers (lab / radiology / generic / prescription / invoice).
 *
 * Five thin "explain X to the patient in plain language" wrappers. They
 * share the same draft → defenses → persist → enqueue-review pipeline,
 * differing only in (a) which DB row is loaded into context, (b) which
 * system prompt is used, and (c) which module_key tags the output.
 *
 * Output shape (all five):
 *   {
 *     explanation_summary  : string  — 2-4 sentences, lay language
 *     key_points           : Array<{ label, value?, what_it_means }>
 *     next_steps           : Array<string>
 *     when_to_seek_help    : Array<string>   — red-flag symptoms
 *     source_citations     : Array<{ source_type, source_id, label }>
 *     safety_flags         : Array<{...}>    — populated by defenses
 *   }
 *
 * Persistence:
 *   - clinical_ai_generations row stores the draft + metadata.
 *   - clinical_ai_reviews row enqueues sign-off (decision='pending').
 * Decision and listing surface through the existing
 * clinicalAiWorkflowService.listReviews / updateReview helpers — these
 * explainers don't add their own per-module table.
 *
 * Decision-support only: nothing here ever auto-publishes to the patient
 * app. The patient app reads ONLY rows whose review.decision='accepted'
 * AND generation.status is non-failed/non-pending — and that invariant is
 * now ENFORCED IN CODE, not just documented here: the single sanctioned
 * patient read path is
 * clinicalAiWorkflowService.getPublishedAiOutputForPatient(), which hard-
 * filters decision='accepted' + status IN ('draft','accepted') + tenant +
 * patient scope and strips all internal fields. Patient surfaces MUST go
 * through that helper; never query clinical_ai_generations directly. (AI-2.)
 */

import crypto from 'crypto';

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { getClinicalAiModule } from './clinicalAiModuleService.js';
import { runOutputDefenses } from './hallucinationDefenses.js';
import { generateClinicalText } from './localLlmClient.js';
import { groundWithKnowledgeBases } from './knowledgeGroundingService.js';
import { resolvePatientForAccess } from '../security/accessDecisionService.js';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

// Build a compact free-text query from an explainer payload so the curated
// KB can be searched semantically. Pulls the high-signal string fields the
// gated OPD modules carry (diagnosis, treatment plan, result text, clinical
// question) without dragging the whole JSON in. Returns '' when nothing
// useful is present — the grounding helper then no-ops.
function groundingQueryFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const parts = [];
  const pushString = (value, max = 600) => {
    if (typeof value === 'string' && value.trim()) parts.push(value.trim().slice(0, max));
  };
  pushString(payload.diagnosis);
  pushString(payload.treatment_plan);
  pushString(payload.clinical_question);
  pushString(payload.monitoring_context);
  pushString(payload.result_text);
  const inv = payload.investigation;
  if (inv && typeof inv === 'object') {
    pushString(inv.test_name, 200);
    pushString(inv.interpretation, 400);
    pushString(inv.conclusion, 400);
  }
  return parts.join('. ').slice(0, 2000);
}

// Legacy allowlist kept for back-compat with tests that reference it via
// `__testing__.EXPLAINER_MODULES`. The pipeline itself no longer enforces
// this set — module validity comes from getClinicalAiModule(moduleKey)
// which trusts the clinical_ai_modules registry. New tier-A / tier-C / etc.
// modules consume runExplainerPipeline directly without needing entries here.
const EXPLAINER_MODULES = new Set([
  'lab_patient_explanation',
  'radiology_patient_explanation',
  'patient_report_explainer',
  'prescription_patient_explainer',
  'invoice_patient_explainer',
]);

const SHARED_OUTPUT_SCHEMA_INSTRUCTION = [
  'Return JSON only with these top-level keys:',
  '  - explanation_summary (string, 2-4 sentences, plain language; no medical jargon without explanation)',
  '  - key_points (array of { label, value?, what_it_means })',
  '  - next_steps (array of strings — what the patient should do)',
  '  - when_to_seek_help (array of strings — red-flag symptoms)',
  '  - source_citations (array of { source_type, source_id, label })',
  '  - safety_flags (array — leave empty; defenses populate this)',
  'Do NOT invent values. If the source row is missing a field, omit it from key_points.',
  'Never give specific dosing changes, never recommend stopping medications, never diagnose. Defer to the treating clinician.',
].join('\n');

const SAFETY_NUDGE = [
  'This is a draft for clinician review before the patient sees it.',
  'Add a safety_flag instead of guessing when uncertain.',
].join('\n');

function resolveTenantId(options = {}) {
  return requireTenantId(options.tenantId);
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

function maybeUuid(value, fieldName = 'patient_uid') {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw AppError.badRequest(`${fieldName} must be a UUID`);
  }
  return text;
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

/**
 * Shared draft pipeline used by every "generate a clinician-reviewable
 * draft" module — patient explainers (this file), tier-A assistants,
 * and future tier C/D/E modules. Loads the module config from the
 * registry (which is the source of truth for "is this module valid"),
 * builds the LLM call, runs defenses, persists to clinical_ai_generations
 * + clinical_ai_reviews. Exported so other services can consume it
 * without import-from-__testing__.
 */
export async function runExplainerPipeline({
  moduleKey,
  tenantId,
  patientUid,
  admissionId,
  systemPrompt,
  userPromptPayload,
  contextForDefenses,
  citations,
  metadata,
  generatedBy,
  req,
}) {
  const tid = resolveTenantId({ tenantId });
  const module = await getClinicalAiModule(moduleKey, { tenantId: tid });
  if (!module.enabled) {
    throw AppError.forbidden(`Clinical AI module is disabled: ${module.display_name}`);
  }

  // WS5 B5.5 — curated knowledge-base grounding. ADDITIVE + GATED: only
  // modules whose registry settings.knowledgeBases declares kb_types pull
  // curation-approved chunks. Graceful: no gate / no chunks / KB down →
  // payload + citations are unchanged and the draft proceeds exactly as
  // before. The supplied `citations` remain authoritative for the
  // requiresCitations fail-close; KB citations are only UNIONed in.
  const kbGrounding = await groundWithKnowledgeBases({
    module,
    tenantId: tid,
    queryText: groundingQueryFromPayload(userPromptPayload),
    role: req?.user?.role || null,
    retrievedBy: generatedBy || req?.user?.uid || null,
    moduleKey,
  });
  const effectivePayload = kbGrounding.used
    ? { ...userPromptPayload, curated_knowledge: kbGrounding.groundingChunks }
    : userPromptPayload;
  // baseCitations = the caller-supplied chart citations ONLY (NO curated KB).
  // Any citation-presence / allowlist decision in the defense layer is made
  // on these, so a curated-KB citation can NEVER satisfy a fail-close that
  // must require chart grounding. effectiveCitations is the full union
  // (base + KB) that is persisted, returned, and displayed for traceability.
  const baseCitations = asArray(citations);
  const effectiveCitations = kbGrounding.used
    ? [...baseCitations, ...kbGrounding.citations]
    : citations;

  const aiResult = await generateClinicalText({
    systemPrompt: [systemPrompt, SHARED_OUTPUT_SCHEMA_INSTRUCTION, SAFETY_NUDGE].join('\n\n'),
    userPrompt: JSON.stringify(effectivePayload),
    taskType: moduleKey,
    tenantRegion: req?.tenant?.region || null,
    tenantId: tid,
  });
  const draft = safeJsonParse(aiResult.text, null) || {
    explanation_summary: '',
    key_points: [],
    next_steps: [],
    when_to_seek_help: [],
    source_citations: effectiveCitations,
    safety_flags: [],
    fallback_used: true,
  };

  // Always preserve / merge the supplied citations so the defense layer
  // and the patient app can trace back to the source row.
  if (!Array.isArray(draft.source_citations)) draft.source_citations = effectiveCitations;
  if (!Array.isArray(draft.safety_flags)) draft.safety_flags = [];
  if (!Array.isArray(draft.key_points)) draft.key_points = [];
  if (!Array.isArray(draft.next_steps)) draft.next_steps = [];
  if (!Array.isArray(draft.when_to_seek_help)) draft.when_to_seek_help = [];
  if (typeof draft.explanation_summary !== 'string') draft.explanation_summary = '';

  const defenseFlags = runOutputDefenses({
    draft,
    module,
    context: contextForDefenses || {},
    // Defense layer sees base (non-KB) citations only for any citation
    // anchoring / presence check; KB labels never widen the allowlist or
    // satisfy a citation gate. (detectPhiLeaks also self-filters KB by
    // source_type as a second guard.)
    citations: baseCitations,
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
      patientUid || null,
      admissionId || null,
      moduleKey,
      aiResult.provider || 'template',
      aiResult.model || null,
      sourceHash({ moduleKey, payload: userPromptPayload }),
      status,
      Boolean(aiResult.usedAi),
      JSON.stringify(safetyFlags),
      JSON.stringify(effectiveCitations),
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
        explainer_kind: moduleKey,
      }),
    );
    generationId = rows[0]?.id || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn(`${moduleKey} generation persist failed`, { error: err.message });
    }
  }

  let reviewId = null;
  if (generationId) {
    try {
      const reviewRows = await prisma.$queryRawUnsafe(
        `INSERT INTO clinical_ai_reviews
           (tenant_id, generation_id, module_key, patient_uid, admission_id, decision, metadata, created_at, updated_at)
         VALUES ($1::uuid, $2, $3, $4::uuid, $5, 'pending', $6::jsonb, NOW(), NOW())
         RETURNING id`,
        tid,
        generationId,
        moduleKey,
        patientUid || null,
        admissionId || null,
        JSON.stringify({
          review_roles: module.settings?.reviewRoles || ['DOCTOR'],
          source: metadata?.source || 'clinical_ai_pipeline',
        }),
      );
      reviewId = reviewRows?.[0]?.id ?? null;
    } catch (err) {
      if (!isMissingSchemaError(err)) {
        logger.warn(`${moduleKey} review enqueue failed`, { error: err.message });
      }
    }
  }

  return {
    module_key: moduleKey,
    generation_id: generationId,
    review_id: reviewId,
    draft,
    safety_flags: safetyFlags,
    source_citations: effectiveCitations,
    kb_grounded: kbGrounding.used,
    used_ai: Boolean(aiResult.usedAi),
    provider: aiResult.provider || 'template',
    status,
    review_status: status === 'failed' ? 'failed' : 'pending',
    requires_signoff: Boolean(module.settings?.requiresClinicianSignoff),
    decision_support_only: true,
  };
}

// ---------------------------------------------------------------------------
// Lab result explainer
// ---------------------------------------------------------------------------

export async function generateLabPatientExplanation({
  tenantId = null,
  investigationId,
  language = 'en',
  generatedBy = null,
  req = null,
} = {}) {
  const investigationIdInt = normalizeId(investigationId, 'investigation_id');
  const tid = resolveTenantId({ tenantId });
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, uid, patient_id, test_name, status, requested_at, completed_at,
            result_value, result_unit, reference_range, abnormal_flag, notes
     FROM investigations
     WHERE id = $1
       AND tenant_id = $2::uuid
     LIMIT 1`,
    investigationIdInt,
    tid,
  );
  const row = rows[0];
  if (!row) throw AppError.notFound('Investigation not found');
  if (!row.test_name) throw AppError.badRequest('Investigation has no test_name to explain');

  const citations = [{
    source_type: 'investigation',
    source_id: String(row.id),
    label: `${row.test_name} (${row.completed_at ? 'completed' : 'pending'})`,
    timestamp: row.completed_at || row.requested_at || null,
  }];

  return runExplainerPipeline({
    moduleKey: 'lab_patient_explanation',
    tenantId,
    patientUid: row.uid || null,
    admissionId: null,
    systemPrompt: [
      'You are a hospital patient-education writer. Explain a single lab result to the patient in plain language.',
      `Target language: ${language}.`,
      'Always state whether the value is in range, slightly off, or markedly off — using the supplied reference_range, do not invent ranges.',
      'Never recommend specific medication or dose changes. If the result is critical, prompt urgent contact with the doctor.',
    ].join('\n'),
    userPromptPayload: {
      test_name: row.test_name,
      result_value: row.result_value,
      result_unit: row.result_unit,
      reference_range: row.reference_range,
      abnormal_flag: row.abnormal_flag,
      status: row.status,
      notes: row.notes,
    },
    contextForDefenses: {
      lab_row: {
        test_name: row.test_name,
        result_value: row.result_value,
        result_unit: row.result_unit,
        reference_range: row.reference_range,
        abnormal_flag: row.abnormal_flag,
      },
    },
    citations,
    metadata: { investigation_id: row.id, language },
    generatedBy,
    req,
  });
}

// ---------------------------------------------------------------------------
// Radiology explainer
// ---------------------------------------------------------------------------

export async function generateRadiologyPatientExplanation({
  tenantId = null,
  radiologyOrderId,
  reportText = null,
  language = 'en',
  generatedBy = null,
  req = null,
} = {}) {
  const orderId = normalizeId(radiologyOrderId, 'radiology_order_id');
  const tid = resolveTenantId({ tenantId });
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, patient_uid, modality, body_part, indication, ordered_date,
            status, urgency, performed_at, finalized_at, findings, impression
     FROM radiology_orders
     WHERE id = $1
       AND tenant_id = $2::uuid
     LIMIT 1`,
    orderId,
    tid,
  );
  const row = rows[0];
  if (!row) throw AppError.notFound('Radiology order not found');
  if (!row.modality && !row.body_part) {
    throw AppError.badRequest('Radiology order is missing modality / body_part');
  }

  const citations = [{
    source_type: 'radiology_order',
    source_id: String(row.id),
    label: `${row.modality || 'imaging'} ${row.body_part || ''}`.trim(),
    timestamp: row.finalized_at || row.performed_at || row.ordered_date || null,
  }];

  return runExplainerPipeline({
    moduleKey: 'radiology_patient_explanation',
    tenantId,
    patientUid: row.patient_uid || null,
    admissionId: null,
    systemPrompt: [
      'You are a hospital patient-education writer. Explain a radiology report to the patient in plain language.',
      `Target language: ${language}.`,
      'Translate technical findings into lay terms. State severity (incidental / actionable / urgent) but do not diagnose new conditions.',
      'If the impression suggests urgent follow-up, surface that prominently in next_steps and when_to_seek_help.',
    ].join('\n'),
    userPromptPayload: {
      modality: row.modality,
      body_part: row.body_part,
      indication: row.indication,
      urgency: row.urgency,
      findings: row.findings || reportText || null,
      impression: row.impression,
    },
    contextForDefenses: {
      radiology_row: {
        modality: row.modality,
        body_part: row.body_part,
        findings: row.findings,
        impression: row.impression,
      },
    },
    citations,
    metadata: { radiology_order_id: row.id, language },
    generatedBy,
    req,
  });
}

// ---------------------------------------------------------------------------
// Generic patient report explainer (free-form input)
// ---------------------------------------------------------------------------

export async function generatePatientReportExplanation({
  tenantId = null,
  reportType,
  reportText,
  patientUid = null,
  admissionId = null,
  language = 'en',
  generatedBy = null,
  req = null,
} = {}) {
  const cleanType = String(reportType || '').trim();
  if (!cleanType) throw AppError.badRequest('report_type is required');
  const cleanText = String(reportText || '').trim();
  if (cleanText.length < 30) {
    throw AppError.badRequest('report_text must be at least 30 characters');
  }
  const normalizedUid = patientUid ? maybeUuid(patientUid, 'patient_uid') : null;
  const normalizedAdm = admissionId ? normalizeId(admissionId, 'admission_id') : null;

  // #7a — the patient/admission binding is caller-asserted on this free-text
  // route (unlike the row-backed explainers there is no source row to scope
  // from). Verify it resolves to a REAL, in-tenant patient before persisting so
  // a generation + review row can't be mislabeled onto — and later published to
  // — an arbitrary, cross-tenant, or non-existent patient. The route's
  // patientAccessGuard adds the care-relationship check (shadow-mode pre-
  // GO_LIVE); this existence + consistency check is load-bearing today, and the
  // SERVER-resolved uid (never the raw caller value) is what gets persisted.
  const scopeTenant = requireTenantId(tenantId);
  let resolvedUid = normalizedUid;
  if (normalizedAdm != null) {
    const admRows = await prisma.$queryRawUnsafe(
      `SELECT patient_uid FROM admissions WHERE id = $1::int AND tenant_id = $2::uuid LIMIT 1`,
      normalizedAdm,
      scopeTenant,
    );
    const admPatientUid = admRows[0]?.patient_uid ? String(admRows[0].patient_uid) : null;
    if (!admPatientUid) {
      throw AppError.notFound('admission_id not found in this tenant', 'EXPLAINER_ADMISSION_NOT_FOUND');
    }
    if (normalizedUid && String(normalizedUid) !== admPatientUid) {
      throw AppError.badRequest(
        'patient_uid does not match the admission patient',
        'EXPLAINER_PATIENT_ADMISSION_MISMATCH',
      );
    }
    resolvedUid = admPatientUid;
  }
  if (resolvedUid != null) {
    const patient = await resolvePatientForAccess(req, { uid: resolvedUid });
    if (!patient?.uid) {
      throw AppError.notFound('patient_uid not found in this tenant', 'EXPLAINER_PATIENT_NOT_FOUND');
    }
    resolvedUid = String(patient.uid);
  }

  const citations = [{
    source_type: 'free_text_report',
    source_id: sourceHash(cleanText).slice(0, 12),
    label: `${cleanType} report (free-text)`,
    timestamp: null,
  }];

  return runExplainerPipeline({
    moduleKey: 'patient_report_explainer',
    tenantId,
    patientUid: resolvedUid,
    admissionId: normalizedAdm,
    systemPrompt: [
      'You are a hospital patient-education writer. Explain a clinical document to the patient in plain language.',
      `Target language: ${language}.`,
      'The reportType label tells you the document genre (consultation, procedure, second-opinion, etc.). Tailor the explanation accordingly.',
      'Do NOT add diagnoses or recommendations the report does not state. Stay strictly within the supplied text.',
    ].join('\n'),
    userPromptPayload: {
      report_type: cleanType,
      report_text: cleanText.slice(0, 12_000),
    },
    contextForDefenses: { report_text: cleanText },
    citations,
    metadata: { report_type: cleanType, language, report_chars: cleanText.length },
    generatedBy,
    req,
  });
}

// ---------------------------------------------------------------------------
// Prescription explainer
// ---------------------------------------------------------------------------

export async function generatePrescriptionPatientExplanation({
  tenantId = null,
  prescriptionId,
  language = 'en',
  generatedBy = null,
  req = null,
} = {}) {
  const rxId = normalizeId(prescriptionId, 'prescription_id');
  const tid = resolveTenantId({ tenantId });
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, patient_uid, medication_name, dosage, frequency, duration,
            instructions, status, prescribed_at
     FROM prescriptions
     WHERE id = $1
       AND tenant_id = $2::uuid
     LIMIT 1`,
    rxId,
    tid,
  );
  const row = rows[0];
  if (!row) throw AppError.notFound('Prescription not found');
  if (!row.medication_name) {
    throw AppError.badRequest('Prescription is missing medication_name');
  }

  const citations = [{
    source_type: 'prescription',
    source_id: String(row.id),
    label: `${row.medication_name} (${row.dosage || ''} ${row.frequency || ''}).trim()`,
    timestamp: row.prescribed_at || null,
  }];

  return runExplainerPipeline({
    moduleKey: 'prescription_patient_explainer',
    tenantId,
    patientUid: row.patient_uid || null,
    admissionId: null,
    systemPrompt: [
      'You are a hospital patient-education writer. Explain a prescription to the patient in plain language.',
      `Target language: ${language}.`,
      'For each medication, cover: what it is for, how to take it (timing, with/without food, full duration), common side effects to expect vs side effects to call the doctor about, and red-flag symptoms (anaphylaxis, severe rash, confusion).',
      'Do NOT change dose, schedule, or duration. Quote the prescription verbatim where dosing is concerned.',
      'Do NOT recommend stopping a medication. If a side effect is concerning, the patient calls the doctor — they do not stop on their own.',
    ].join('\n'),
    userPromptPayload: {
      medication_name: row.medication_name,
      dosage: row.dosage,
      frequency: row.frequency,
      duration: row.duration,
      instructions: row.instructions,
      status: row.status,
    },
    contextForDefenses: {
      prescription_row: {
        medication_name: row.medication_name,
        dosage: row.dosage,
        frequency: row.frequency,
        duration: row.duration,
      },
    },
    citations,
    metadata: { prescription_id: row.id, language },
    generatedBy,
    req,
  });
}

// ---------------------------------------------------------------------------
// Invoice explainer
// ---------------------------------------------------------------------------

export async function generateInvoicePatientExplanation({
  tenantId = null,
  invoiceId,
  language = 'en',
  generatedBy = null,
  req = null,
} = {}) {
  const invId = normalizeId(invoiceId, 'invoice_id');
  const tid = resolveTenantId({ tenantId });
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, patient_uid, total_amount, paid_amount, balance_amount,
            insurance_covered_amount, status, line_items, billing_period_start,
            billing_period_end, created_at
     FROM invoices
     WHERE id = $1
       AND tenant_id = $2::uuid
     LIMIT 1`,
    invId,
    tid,
  );
  const row = rows[0];
  if (!row) throw AppError.notFound('Invoice not found');

  const citations = [{
    source_type: 'invoice',
    source_id: String(row.id),
    label: `Invoice #${row.id}`,
    timestamp: row.created_at || null,
  }];

  return runExplainerPipeline({
    moduleKey: 'invoice_patient_explainer',
    tenantId,
    patientUid: row.patient_uid || null,
    admissionId: null,
    systemPrompt: [
      'You are a hospital patient-education writer. Explain a hospital invoice to the patient in plain language.',
      `Target language: ${language}.`,
      'Walk through what each line item represents, separate hospital-charged amounts from insurance-covered amounts, and highlight the patient\'s outstanding balance.',
      'Tell the patient how to dispute a charge or request an itemised bill (point to billing@hospital). Do NOT promise discounts, write-offs, or refunds — those require a billing-staff review.',
    ].join('\n'),
    userPromptPayload: {
      total_amount: row.total_amount,
      paid_amount: row.paid_amount,
      balance_amount: row.balance_amount,
      insurance_covered_amount: row.insurance_covered_amount,
      status: row.status,
      line_items: row.line_items,
      billing_period_start: row.billing_period_start,
      billing_period_end: row.billing_period_end,
    },
    contextForDefenses: {
      invoice_row: {
        total_amount: row.total_amount,
        paid_amount: row.paid_amount,
        balance_amount: row.balance_amount,
      },
    },
    citations,
    metadata: { invoice_id: row.id, language },
    generatedBy,
    req,
  });
}

export const __testing__ = {
  EXPLAINER_MODULES,
  runExplainerPipeline,
};

export default {
  generateInvoicePatientExplanation,
  generateLabPatientExplanation,
  generatePatientReportExplanation,
  generatePrescriptionPatientExplanation,
  generateRadiologyPatientExplanation,
};
