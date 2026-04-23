/**
 * Appeal Letter Generator for Denied Claims.
 *
 * Drafts a payer-specific appeal letter from a denied insurance claim plus
 * cited chart evidence. Classifies denial reason (medical_necessity,
 * coding_error, prior_auth_missing, documentation_insufficient, etc.) and
 * builds matching cover letter, medical necessity narrative, evidence
 * bundle, and requested action. Billing/insurance coordinator reviews,
 * edits, and submits; the service never auto-submits or writes off claims.
 */

import crypto from 'crypto';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { collectAdmissionClinicalContext } from '../emr/clinicalTimelineService.js';
import { publishEvent } from '../events/eventOutboxService.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenantService.js';
import { getClinicalAiModule } from './clinicalAiModuleService.js';
import { runOutputDefenses } from './hallucinationDefenses.js';
import { generateClinicalText } from './localLlmClient.js';

const MODULE_KEY = 'appeal_letter_generator';
const DEFAULT_PROMPT = {
  version: 'v1',
  system_prompt: 'You draft payer appeal letters for denied insurance claims. Use only supplied chart evidence. Return JSON only. Never auto-submit.',
  user_prompt_template: 'Return a structured appeal letter draft: cover_letter, medical_necessity, clinical_evidence, supporting_documentation, requested_action, procedure_codes, diagnosis_codes. Every claim must cite source evidence.',
};

const APPEAL_STATUSES = new Set(['draft', 'ready_for_submission', 'submitted', 'approved', 'denied', 'withdrawn']);
const DECISIONS = new Set(['pending', 'accepted', 'deferred', 'rejected', 'edited']);
const FINAL_DECISIONS = new Set(['accepted', 'deferred', 'rejected', 'edited']);
const APPEAL_TYPES = new Set(['first_level', 'second_level', 'external_review', 'reconsideration']);
const FINAL_PAYER_STATUSES = new Set(['approved', 'denied', 'withdrawn']);

const DENIAL_CLASSIFICATIONS = [
  {
    classification: 'medical_necessity',
    patterns: [/medical(ly)?\s*necess/i, /not\s*medically\s*necessary/i, /lack\s*of\s*medical\s*necess/i, /\bmn\s*denial\b/i],
    severity: 'high',
  },
  {
    classification: 'prior_auth_missing',
    patterns: [/prior\s*auth/i, /pre(-|\s)?auth/i, /authorization\s*(missing|required|not\s*obtained)/i, /no\s*authorization/i],
    severity: 'high',
  },
  {
    classification: 'documentation_insufficient',
    patterns: [/insufficient\s*documentation/i, /missing\s*documentation/i, /records?\s*not\s*(attached|received)/i, /supporting\s*documents?\s*missing/i],
    severity: 'medium',
  },
  {
    classification: 'coding_error',
    patterns: [/coding\s*error/i, /incorrect\s*(code|coding)/i, /invalid\s*(icd|cpt|hcpcs)/i, /code\s*mismatch/i, /dx.*mismatch/i, /procedure.*mismatch/i],
    severity: 'medium',
  },
  {
    classification: 'duplicate_claim',
    patterns: [/duplicate\s*claim/i, /already\s*(paid|submitted|processed)/i, /resubmission\s*of\s*paid/i],
    severity: 'low',
  },
  {
    classification: 'timely_filing',
    patterns: [/timely\s*filing/i, /filing\s*deadline/i, /claim\s*(filed|submitted)\s*late/i, /past\s*filing\s*limit/i],
    severity: 'medium',
  },
  {
    classification: 'bundled_service',
    patterns: [/bundled\s*service/i, /included\s*in\s*another\s*service/i, /\bincidental\b/i, /global\s*period/i],
    severity: 'medium',
  },
  {
    classification: 'non_covered_service',
    patterns: [/non(-|\s)?covered/i, /not\s*covered/i, /excluded\s*service/i, /benefit\s*excluded/i, /experimental/i],
    severity: 'high',
  },
  {
    classification: 'coverage',
    patterns: [/eligibility/i, /coverage\s*(terminated|lapsed|inactive)/i, /policy\s*(expired|not\s*active|inactive)/i, /patient\s*not\s*eligible/i],
    severity: 'high',
  },
];

function resolveTenantId(options = {}) {
  return options.tenantId || DEFAULT_TENANT_ID;
}

function isMissingSchemaError(err) {
  return /does not exist|column .* does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizedText(value) {
  return cleanText(value).toLowerCase();
}

function optionalInt(value, fieldName = 'id') {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw AppError.badRequest(`${fieldName} must be a positive integer`);
  }
  return parsed;
}

function optionalIntOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : null;
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

function normalizeAppealType(value) {
  const normalized = normalizedText(value || 'first_level').replace(/\s+/g, '_');
  return APPEAL_TYPES.has(normalized) ? normalized : 'first_level';
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

function eventCitation(event, label = null) {
  if (!event) return null;
  return {
    source_type: event.event_type || event.source_type || 'chart',
    source_id: event.id === null || event.id === undefined ? null : String(event.id),
    label: label || event.summary || event.event_type || 'Chart evidence',
    timestamp: event.timestamp || event.payload?.created_at || event.created_at || null,
  };
}

function claimCitation(claim) {
  if (!claim) return null;
  return {
    source_type: 'insurance_claim',
    source_id: String(claim.id),
    label: claim.claim_number || 'Denied claim',
    timestamp: claim.submitted_at || null,
  };
}

export function classifyDenialReason({ denialReason = '', denialCode = '', rejectionReason = '' } = {}) {
  const combined = `${denialReason} ${denialCode} ${rejectionReason}`.trim();
  if (!combined) return { classification: 'other', severity: 'medium', matched_pattern: null };
  for (const entry of DENIAL_CLASSIFICATIONS) {
    for (const pattern of entry.patterns) {
      if (pattern.test(combined)) {
        return {
          classification: entry.classification,
          severity: entry.severity,
          matched_pattern: pattern.source,
        };
      }
    }
  }
  return { classification: 'other', severity: 'medium', matched_pattern: null };
}

function signedNotesFrom(context) {
  return asArray(context.notes).filter((note) => note?.payload?.is_signed);
}

function activeDiagnosesFrom(context) {
  return asArray(context.diagnoses)
    .filter((d) => String(d.status || 'active').toLowerCase() === 'active' || !d.status)
    .slice(0, 12);
}

function proceduresFrom(context) {
  const procedures = [];
  for (const order of asArray(context.orders)) {
    if (/procedure|surgery|operation/i.test(order?.summary || '') || order?.payload?.order_type === 'procedure') {
      procedures.push({
        code: order.payload?.procedure_code || order.payload?.cpt_code || null,
        description: order.payload?.procedure_description || order.summary || null,
        ordered_at: order.timestamp,
        citation: eventCitation(order, 'Procedure order'),
      });
    }
  }
  return procedures.slice(0, 10);
}

function investigationsFrom(context) {
  return asArray(context.investigations).slice(-8).map((inv) => ({
    summary: inv.summary,
    status: inv.payload?.status || inv.sub_type,
    result_summary: inv.payload?.result_summary || null,
    citation: eventCitation(inv, 'Investigation'),
  }));
}

function medicationsFrom(context) {
  return asArray(context.medications).slice(-10).map((med) => ({
    summary: med.summary,
    ordered_at: med.timestamp,
    citation: eventCitation(med, 'Medication'),
  }));
}

export function extractClinicalEvidence(context = {}) {
  const diagnoses = activeDiagnosesFrom(context);
  const procedures = proceduresFrom(context);
  const signedNotes = signedNotesFrom(context);
  const investigations = investigationsFrom(context);
  const medications = medicationsFrom(context);
  const citations = [
    ...diagnoses.slice(0, 8).map((d) => ({
      source_type: 'diagnosis',
      source_id: String(d.id),
      label: d.description || d.summary || d.icd10_code || 'Diagnosis',
      timestamp: d.timestamp || null,
    })),
    ...procedures.slice(0, 5).map((p) => p.citation).filter(Boolean),
    ...signedNotes.slice(0, 5).map((note) => eventCitation(note, note.summary || 'Signed clinical note')),
    ...investigations.slice(0, 5).map((inv) => inv.citation).filter(Boolean),
    ...medications.slice(0, 5).map((m) => m.citation).filter(Boolean),
  ];
  return {
    diagnoses: diagnoses.map((d) => ({
      icd10: d.icd10_code,
      description: d.description || d.summary,
      diagnosed_at: d.timestamp,
    })),
    diagnosis_codes: diagnoses.map((d) => d.icd10_code).filter(Boolean),
    procedures,
    procedure_codes: procedures.map((p) => p.code).filter(Boolean),
    signed_notes: signedNotes.slice(0, 6).map((note) => ({
      type: note.sub_type || note.payload?.note_type,
      summary: note.summary,
      signed: true,
      signed_at: note.timestamp,
    })),
    investigations,
    medications,
    citations: uniqueCitations(citations),
  };
}

function coverLetterText({ claim, classification, appealType }) {
  const payer = claim?.insurance_provider || 'Payer';
  const claimNumber = claim?.claim_number || 'the referenced claim';
  const policy = claim?.policy_number ? ` (policy ${claim.policy_number})` : '';
  const appealTypeLabel = appealType.replace(/_/g, ' ');
  return `Dear ${payer} Claims Review Team,\n\nWe are submitting a ${appealTypeLabel} appeal for claim ${claimNumber}${policy}. The denial reason received (${classification.classification.replace(/_/g, ' ')}) is respectfully contested. The attached clinical documentation supports medical necessity and coverage of the services provided. Please review the evidence below and reconsider the adjudication of this claim.`;
}

function medicalNecessityNarrative({ claim, classification, evidence }) {
  const dxSummary = evidence.diagnoses
    .slice(0, 4)
    .map((d) => (d.icd10 ? `${d.icd10} ${d.description || ''}`.trim() : d.description))
    .filter(Boolean)
    .join('; ') || 'active diagnoses documented in the chart';
  const noteCount = evidence.signed_notes.length;
  const procCount = evidence.procedures.length;
  const base = `The patient presented with ${dxSummary}. Treatment was clinically indicated based on ${noteCount} signed clinical note(s), ${procCount} documented procedure(s), and the supporting investigations and medications listed in the evidence bundle.`;
  const supplement = {
    medical_necessity: ' Standard of care required the services billed; delaying or omitting them would have risked preventable deterioration.',
    prior_auth_missing: ' Authorization gaps were due to urgent/emergent clinical presentation, which is an exception under the plan\'s urgent-care provisions.',
    documentation_insufficient: ' The chart contains signed documentation, investigations, and orders that were not previously transmitted; they are attached to this appeal.',
    coding_error: ' The services rendered match the diagnosis and procedure codes attached to this appeal; corrected codes are listed in the procedure_codes/diagnosis_codes fields.',
    duplicate_claim: ' This claim is not a duplicate; the attached details demonstrate a distinct encounter with separate documentation.',
    timely_filing: ' The original claim was submitted within the filing deadline; proof of timely submission is attached.',
    bundled_service: ' The service billed is distinct from any bundled component and is separately reimbursable per the attached documentation.',
    non_covered_service: ' The service is covered under the member\'s plan per the attached benefit summary and medical necessity documentation.',
    coverage: ' Coverage was active on the date of service; eligibility documentation is attached.',
    other: ' Please reconsider based on the attached clinical evidence bundle.',
  };
  return `${base}${supplement[classification.classification] || supplement.other}`.trim();
}

function requestedActionFor(classification) {
  const requests = {
    medical_necessity: 'Overturn the denial and process the claim at the contracted rate based on the attached medical necessity evidence.',
    prior_auth_missing: 'Apply the urgent-care exception and reprocess the claim.',
    documentation_insufficient: 'Reprocess the claim with the attached additional documentation.',
    coding_error: 'Reprocess the claim with the corrected procedure and diagnosis codes provided.',
    duplicate_claim: 'Remove the duplicate-claim flag and process the distinct encounter.',
    timely_filing: 'Apply the timely-filing exception based on the attached submission proof.',
    bundled_service: 'Unbundle and reimburse the distinct service as documented.',
    non_covered_service: 'Reclassify the service as covered under the member\'s plan and reprocess.',
    coverage: 'Verify eligibility on date of service and reprocess the claim.',
    other: 'Reconsider the denial based on the attached evidence.',
  };
  return requests[classification.classification] || requests.other;
}

function supportingDocumentationFor(evidence) {
  const docs = [];
  if (evidence.signed_notes.length) docs.push(`${evidence.signed_notes.length} signed clinical note(s)`);
  if (evidence.diagnoses.length) docs.push(`${evidence.diagnoses.length} active diagnosis / diagnoses`);
  if (evidence.procedures.length) docs.push(`${evidence.procedures.length} procedure record(s)`);
  if (evidence.investigations.length) docs.push(`${evidence.investigations.length} investigation report(s)`);
  if (evidence.medications.length) docs.push('Active medication list');
  if (!docs.length) docs.push('Admission history and physical');
  return docs;
}

export function buildAppealLetterSections({ claim, classification, evidence, appealType }) {
  const resolvedAppealType = normalizeAppealType(appealType);
  return {
    cover_letter: coverLetterText({ claim, classification, appealType: resolvedAppealType }),
    medical_necessity: medicalNecessityNarrative({ claim, classification, evidence }),
    clinical_evidence: {
      diagnoses: evidence.diagnoses,
      procedures: evidence.procedures,
      signed_notes_count: evidence.signed_notes.length,
      investigations_count: evidence.investigations.length,
      medications_count: evidence.medications.length,
    },
    supporting_documentation: supportingDocumentationFor(evidence),
    requested_action: requestedActionFor(classification),
    procedure_codes: evidence.procedure_codes,
    diagnosis_codes: evidence.diagnosis_codes,
    appeal_type: resolvedAppealType,
    classification: classification.classification,
  };
}

function buildFallbackDraft({ claim, classification, evidence, appealType }) {
  const sections = buildAppealLetterSections({ claim, classification, evidence, appealType });
  const safetyFlags = [];
  if (!evidence.signed_notes.length) {
    safetyFlags.push({
      severity: 'high',
      code: 'APPEAL_MISSING_SIGNED_NOTES',
      message: 'No signed clinical notes were available for the appeal evidence bundle.',
    });
  }
  if (!evidence.diagnoses.length) {
    safetyFlags.push({
      severity: 'high',
      code: 'APPEAL_MISSING_DIAGNOSES',
      message: 'No active diagnoses were available for the appeal evidence bundle.',
    });
  }
  return {
    ...sections,
    summary: `${classification.classification.replace(/_/g, ' ')} appeal with ${evidence.signed_notes.length} signed note(s), ${evidence.diagnoses.length} diagnosis/diagnoses, ${evidence.procedures.length} procedure(s).`,
    source_citations: uniqueCitations([claimCitation(claim), ...evidence.citations]),
    safety_flags: safetyFlags,
    rules_authoritative: true,
    decision_support_only: true,
  };
}

function normalizeAiSummary(parsed, fallbackDraft) {
  return {
    ...fallbackDraft,
    cover_letter: cleanText(parsed?.cover_letter) || fallbackDraft.cover_letter,
    medical_necessity: cleanText(parsed?.medical_necessity) || fallbackDraft.medical_necessity,
    requested_action: cleanText(parsed?.requested_action) || fallbackDraft.requested_action,
    supporting_documentation: asArray(parsed?.supporting_documentation).length
      ? asArray(parsed.supporting_documentation).map(cleanText).filter(Boolean)
      : fallbackDraft.supporting_documentation,
    summary: cleanText(parsed?.summary) || fallbackDraft.summary,
    source_citations: uniqueCitations([
      ...asArray(fallbackDraft.source_citations),
      ...asArray(parsed?.source_citations),
    ]),
    safety_flags: [
      ...asArray(fallbackDraft.safety_flags),
      ...asArray(parsed?.safety_flags),
    ],
  };
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

async function loadClaim(tenantId, claimId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT c.id, c.claim_number, c.patient_uid, c.invoice_id,
            c.insurance_provider, c.policy_number, c.claim_amount,
            c.approved_amount, c.status, c.documents, c.submitted_at,
            c.reviewed_at, c.rejection_reason,
            u.name AS patient_name
     FROM insurance_claims c
     LEFT JOIN users u ON u.uid = c.patient_uid
     WHERE c.id = $1
     LIMIT 1`,
    claimId
  );
  const claim = rows[0];
  if (!claim) throw AppError.notFound('Insurance claim not found');
  return claim;
}

async function insertGeneration({
  tenantId,
  admissionId,
  patientUid,
  prompt,
  sourceHashValue,
  draft,
  citations,
  safetyFlags,
  requestedBy,
  aiResult,
  metadata,
}) {
  const usage = aiResult?.usage || {};
  const hasCritical = safetyFlags.some((flag) => flag.severity === 'critical');
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
    prompt.version || 'v1',
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
    JSON.stringify(metadata || {})
  );
  return rows[0] || null;
}

async function createReviewPlaceholder({ tenantId, generationId, patientUid, module }) {
  if (!generationId) return null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_reviews
         (tenant_id, generation_id, module_key, patient_uid, decision, metadata, created_at, updated_at)
       VALUES ($1::uuid, $2, $3, $4::uuid, 'pending', $5::jsonb, NOW(), NOW())
       RETURNING id, decision`,
      tenantId,
      generationId,
      MODULE_KEY,
      patientUid,
      JSON.stringify({
        review_roles: module.settings?.reviewRoles || ['BILLING_STAFF', 'INSURANCE_COORDINATOR', 'ADMIN'],
        source: 'appeal_letter_generator',
        rules_authoritative: true,
        decision_support_only: true,
      })
    );
    return rows[0] || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Appeal letter review placeholder failed', { error: err.message });
    }
    return null;
  }
}

export async function generateAppealLetter({
  req = null,
  claimId,
  denialReason = null,
  denialCode = null,
  appealType = 'first_level',
  admissionId = null,
} = {}) {
  const tenantId = resolveTenantId({ tenantId: req?.tenantId });
  const safeClaimId = optionalInt(claimId, 'claim_id');
  const safeAdmissionId = optionalIntOrNull(admissionId);
  const resolvedAppealType = normalizeAppealType(appealType);
  const module = await getClinicalAiModule(MODULE_KEY, { tenantId });
  if (!module.enabled) {
    throw AppError.forbidden(`Clinical AI module is disabled: ${module.display_name}`);
  }

  const claim = await loadClaim(tenantId, safeClaimId);
  const classification = classifyDenialReason({
    denialReason: denialReason || claim.rejection_reason || '',
    denialCode: denialCode || '',
    rejectionReason: claim.rejection_reason || '',
  });

  let context = { diagnoses: [], notes: [], orders: [], investigations: [], medications: [], allergies: [] };
  if (safeAdmissionId) {
    context = await collectAdmissionClinicalContext(safeAdmissionId);
  }
  const evidence = extractClinicalEvidence(context);
  const fallbackDraft = buildFallbackDraft({ claim, classification, evidence, appealType: resolvedAppealType });

  const prompt = await getActivePrompt(tenantId);
  const aiResult = await generateClinicalText({
    taskType: MODULE_KEY,
    systemPrompt: prompt.system_prompt,
    userPrompt: `${prompt.user_prompt_template}\n\n${JSON.stringify({
      claim: {
        id: claim.id,
        claim_number: claim.claim_number,
        payer: claim.insurance_provider,
        policy_number: claim.policy_number,
        claim_amount: claim.claim_amount,
        rejection_reason: claim.rejection_reason,
        status: claim.status,
      },
      denial: {
        reason: denialReason || claim.rejection_reason,
        code: denialCode,
        classification: classification.classification,
      },
      appeal_type: resolvedAppealType,
      rule_based_appeal: fallbackDraft,
    })}`,
    tenantRegion: req?.tenant?.region || null,
  });
  const parsed = safeJsonParse(aiResult.text, {});
  const draft = normalizeAiSummary(parsed, fallbackDraft);
  const citations = uniqueCitations(
    asArray(draft.source_citations).length ? draft.source_citations : fallbackDraft.source_citations
  );
  const safetyFlags = [
    ...(citations.length ? [] : [{
      severity: 'high',
      code: 'NO_APPEAL_CITATIONS',
      message: 'Appeal letter has no source citations.',
    }]),
    ...asArray(draft.safety_flags),
    ...runOutputDefenses({
      draft,
      module,
      context: { claim, evidence },
      citations,
    }),
  ];
  draft.safety_flags = safetyFlags;

  const generation = await insertGeneration({
    tenantId,
    admissionId: safeAdmissionId,
    patientUid: claim.patient_uid,
    prompt,
    sourceHashValue: sourceHash({
      claim_id: safeClaimId,
      denial: { reason: denialReason, code: denialCode },
      classification: classification.classification,
      appeal_type: resolvedAppealType,
    }),
    draft,
    citations,
    safetyFlags,
    requestedBy: req?.user?.uid || null,
    aiResult,
    metadata: {
      claim_id: safeClaimId,
      admission_id: safeAdmissionId,
      denial_classification: classification.classification,
      appeal_type: resolvedAppealType,
      fallback_reason: aiResult.usedAi ? null : aiResult.reason || 'template_or_rule_output',
      rules_authoritative: true,
    },
  });

  let appealRow = null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_appeal_letters
         (tenant_id, claim_id, patient_uid, admission_id, generation_id,
          denial_reason, denial_code, denial_classification, appeal_type,
          letter_draft, clinical_evidence, source_citations, safety_flags,
          appeal_status, reviewer_decision, metadata, created_at, updated_at)
       VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7, $8, $9,
               $10::jsonb, $11::jsonb, $12::jsonb, $13::jsonb,
               'draft', 'pending', $14::jsonb, NOW(), NOW())
       RETURNING id, tenant_id, claim_id, patient_uid, admission_id, generation_id,
                 denial_reason, denial_code, denial_classification, appeal_type,
                 letter_draft, clinical_evidence, source_citations, safety_flags,
                 appeal_status, reviewer_decision, reviewed_by, reviewed_at,
                 reviewer_note, submitted_at, submitted_by, payer_reference_id,
                 payer_response, payer_response_at, metadata,
                 created_at, updated_at`,
      tenantId,
      safeClaimId,
      claim.patient_uid,
      safeAdmissionId,
      generation?.id || null,
      denialReason || claim.rejection_reason || null,
      denialCode || null,
      classification.classification,
      resolvedAppealType,
      JSON.stringify(draft),
      JSON.stringify(evidence),
      JSON.stringify(citations),
      JSON.stringify(safetyFlags),
      JSON.stringify({
        used_ai: Boolean(aiResult.usedAi),
        provider: aiResult.provider || 'template',
        model: aiResult.model || null,
        classification_severity: classification.severity,
        rules_authoritative: true,
      })
    );
    appealRow = rows[0] || null;
  } catch (err) {
    if (isMissingSchemaError(err)) {
      return {
        appeal_id: null,
        generation_id: generation?.id || null,
        draft,
        claim,
        classification,
        source_citations: citations,
        safety_flags: safetyFlags,
        module_key: MODULE_KEY,
        prompt_version: prompt.version || 'v1',
        appeal_status: 'schema_unavailable',
        reason: 'clinical_ai_appeal_letters_unavailable',
        decision_support_only: true,
      };
    }
    throw err;
  }

  const clinicalReview = await createReviewPlaceholder({
    tenantId,
    generationId: generation?.id || null,
    patientUid: claim.patient_uid,
    module,
  });

  await publishEvent({
    eventType: 'clinical_ai.appeal_letter_generated',
    aggregateType: 'clinical_ai_appeal_letter',
    aggregateId: appealRow?.id || generation?.id || safeClaimId,
    patientUid: claim.patient_uid,
    payload: {
      tenant_id: tenantId,
      claim_id: safeClaimId,
      appeal_id: appealRow?.id || null,
      generation_id: generation?.id || null,
      classification: classification.classification,
      appeal_type: resolvedAppealType,
    },
  });

  return {
    appeal_id: appealRow?.id || null,
    generation_id: generation?.id || null,
    clinical_review_id: clinicalReview?.id || null,
    draft,
    appeal: appealRow,
    claim: {
      id: claim.id,
      claim_number: claim.claim_number,
      insurance_provider: claim.insurance_provider,
      policy_number: claim.policy_number,
      claim_amount: claim.claim_amount,
      status: claim.status,
    },
    classification,
    source_citations: citations,
    safety_flags: safetyFlags,
    module_key: MODULE_KEY,
    prompt_version: prompt.version || 'v1',
    appeal_status: appealRow?.appeal_status || 'draft',
    review_status: clinicalReview?.decision || appealRow?.reviewer_decision || 'pending',
    ai_metadata: {
      provider: aiResult.provider || 'template',
      model: aiResult.model || null,
      used_ai: Boolean(aiResult.usedAi),
      usage: aiResult.usage || {},
    },
    rules_authoritative: true,
    decision_support_only: true,
  };
}

export async function listAppealLetters({
  tenantId = null,
  claimId = null,
  patientUid = null,
  appealStatus = null,
  decision = null,
  classification = null,
  limit = 50,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const cid = claimId ? optionalInt(claimId, 'claim_id') : null;
  const normalizedAppealStatus = appealStatus && APPEAL_STATUSES.has(cleanText(appealStatus).toLowerCase())
    ? cleanText(appealStatus).toLowerCase()
    : null;
  const normalizedDecision = decision && DECISIONS.has(cleanText(decision).toLowerCase())
    ? cleanText(decision).toLowerCase()
    : null;
  const normalizedClassification = classification
    ? cleanText(classification).toLowerCase().replace(/\s+/g, '_')
    : null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT a.id, a.tenant_id, a.claim_id, c.claim_number, c.insurance_provider,
              a.patient_uid, u.name AS patient_name, a.admission_id, a.generation_id,
              a.denial_reason, a.denial_code, a.denial_classification, a.appeal_type,
              a.letter_draft, a.clinical_evidence, a.source_citations, a.safety_flags,
              a.appeal_status, a.reviewer_decision, a.reviewed_by, a.reviewed_at,
              a.reviewer_note, a.submitted_at, a.submitted_by, a.payer_reference_id,
              a.payer_response, a.payer_response_at, a.metadata,
              a.created_at, a.updated_at
       FROM clinical_ai_appeal_letters a
       LEFT JOIN insurance_claims c ON c.id = a.claim_id
       LEFT JOIN users u ON u.uid = a.patient_uid
       WHERE a.tenant_id = $1::uuid
         AND ($2::int IS NULL OR a.claim_id = $2)
         AND ($3::uuid IS NULL OR a.patient_uid = $3::uuid)
         AND ($4::text IS NULL OR a.appeal_status = $4)
         AND ($5::text IS NULL OR a.reviewer_decision = $5)
         AND ($6::text IS NULL OR a.denial_classification = $6)
       ORDER BY
         CASE a.appeal_status
           WHEN 'draft' THEN 0
           WHEN 'ready_for_submission' THEN 1
           WHEN 'submitted' THEN 2
           WHEN 'approved' THEN 3
           WHEN 'denied' THEN 4
           ELSE 5
         END,
         a.created_at DESC
       LIMIT $7`,
      tid,
      cid,
      patientUid || null,
      normalizedAppealStatus,
      normalizedDecision,
      normalizedClassification,
      safeLimit
    );
    return { appeals: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { appeals: [], count: 0 };
    throw err;
  }
}

export async function decideAppealLetter({
  tenantId = null,
  appealId,
  decision,
  reviewerUid = null,
  note = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const normalized = cleanText(decision).toLowerCase();
  if (!FINAL_DECISIONS.has(normalized)) {
    throw AppError.badRequest('decision must be accepted, deferred, rejected, or edited');
  }
  const nextAppealStatus = normalized === 'accepted' ? 'ready_for_submission' : null;
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE clinical_ai_appeal_letters
     SET reviewer_decision = $2,
         reviewed_by = $3::uuid,
         reviewed_at = NOW(),
         reviewer_note = $4,
         appeal_status = COALESCE($5, appeal_status),
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $6::uuid
     RETURNING id, claim_id, patient_uid, generation_id,
               denial_classification, appeal_type, reviewer_decision,
               reviewed_by, reviewed_at, reviewer_note, appeal_status`,
    optionalInt(appealId, 'appeal_id'),
    normalized,
    reviewerUid,
    note,
    nextAppealStatus,
    tid
  );
  if (!rows[0]) throw AppError.notFound('Appeal letter not found');
  return rows[0];
}

export async function submitAppealLetter({
  tenantId = null,
  appealId,
  submittedBy = null,
  payerReferenceId = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const id = optionalInt(appealId, 'appeal_id');
  const existingRows = await prisma.$queryRawUnsafe(
    `SELECT id, tenant_id, claim_id, appeal_status, reviewer_decision
     FROM clinical_ai_appeal_letters
     WHERE id = $1
       AND tenant_id = $2::uuid
     LIMIT 1`,
    id,
    tid
  );
  const appeal = existingRows[0];
  if (!appeal) throw AppError.notFound('Appeal letter not found');
  if (!['ready_for_submission', 'draft'].includes(appeal.appeal_status)) {
    throw AppError.invalidTransition(appeal.appeal_status, 'submitted', ['ready_for_submission', 'draft']);
  }
  if (appeal.reviewer_decision !== 'accepted') {
    throw AppError.badRequest('Appeal letter must be accepted by a reviewer before submission');
  }
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE clinical_ai_appeal_letters
     SET appeal_status = 'submitted',
         submitted_at = NOW(),
         submitted_by = $2::uuid,
         payer_reference_id = $3,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $4::uuid
     RETURNING id, claim_id, appeal_status, submitted_at, submitted_by,
               payer_reference_id, reviewer_decision`,
    id,
    submittedBy,
    payerReferenceId,
    tid
  );
  if (!rows[0]) throw AppError.notFound('Appeal letter not found');
  return rows[0];
}

export async function recordAppealPayerResponse({
  tenantId = null,
  appealId,
  status,
  response = null,
  note = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const normalized = cleanText(status).toLowerCase();
  if (!FINAL_PAYER_STATUSES.has(normalized)) {
    throw AppError.badRequest('status must be approved, denied, or withdrawn');
  }
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE clinical_ai_appeal_letters
     SET appeal_status = $2,
         payer_response = $3::jsonb,
         payer_response_at = NOW(),
         reviewer_note = COALESCE($4, reviewer_note),
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $5::uuid
       AND appeal_status IN ('submitted', 'approved', 'denied')
     RETURNING id, claim_id, appeal_status, payer_response,
               payer_response_at, submitted_at`,
    optionalInt(appealId, 'appeal_id'),
    normalized,
    JSON.stringify(response || { note }),
    note,
    tid
  );
  if (!rows[0]) throw AppError.notFound('Appeal letter not found (or not submitted)');
  return rows[0];
}

export default {
  buildAppealLetterSections,
  classifyDenialReason,
  decideAppealLetter,
  extractClinicalEvidence,
  generateAppealLetter,
  listAppealLetters,
  recordAppealPayerResponse,
  submitAppealLetter,
};
