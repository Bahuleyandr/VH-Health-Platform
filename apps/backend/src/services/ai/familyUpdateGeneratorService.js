/**
 * Consent-Aware Family Update Generator.
 *
 * Drafts a plain-language, consent-scoped status update for a named
 * caregiver or family member. Verifies an active patient consent before
 * generating; enforces PHI-boundary scrubbing (no specific medication
 * doses, no raw lab values) and returns content appropriate for a
 * non-clinical reader. Review-only: never auto-sends and never changes
 * the care plan.
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

const MODULE_KEY = 'consent_aware_family_update';
const DEFAULT_PROMPT = {
  version: 'v1',
  system_prompt: 'You write a plain-language status update for a named caregiver or family member. Use only supplied chart evidence. Do not include specific medication doses, raw lab values, or PHI outside the consent scope. Return JSON only.',
  user_prompt_template: 'Return plain_language_summary, current_status, next_steps, when_to_worry, questions_you_may_have (array), source_citations, safety_flags. Language appropriate for a non-clinical reader.',
};

const DECISIONS = new Set(['pending', 'accepted', 'deferred', 'rejected', 'edited']);
const FINAL_DECISIONS = new Set(['accepted', 'deferred', 'rejected', 'edited']);
const STATUSES = new Set(['draft', 'ready_to_send', 'sent', 'withdrawn']);
const RELATIONSHIPS = new Set([
  'spouse', 'parent', 'child', 'sibling', 'friend',
  'legal_guardian', 'guardian', 'care_manager', 'other',
]);
const SUPPORTED_LANGUAGES = new Set(['en', 'hi', 'ta', 'te', 'ml', 'mr', 'bn', 'kn']);
const ACCEPTABLE_CONSENT_TYPES = new Set([
  'family_update',
  'caregiver_communication',
  'family_communication',
  'treatment',
]);
const DEFAULT_FAMILY_SCOPE = ['current_status', 'plain_language_summary', 'next_steps', 'when_to_worry'];
const DOSE_RE = /\b\d+(?:\.\d+)?\s*(?:mg|mcg|µg|g|ml|units?|iu|meq)\b/gi;
const LAB_VALUE_RE = /\b(?:hb|hemoglobin|wbc|hba1c|sodium|potassium|na|k|creatinine|urea|bun|alt|ast|bilirubin|inr|aptt|crp|troponin|glucose|platelets)\b[^.\n]{0,40}?\d+(?:\.\d+)?[^.\n]{0,20}/gi;
const MRN_RE = /\b(?:mrn|patient\s+id|uid)[:\s-]+[\w-]{4,}/gi;

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

function normalizeRelationship(value) {
  const normalized = normalizedText(value || 'other');
  return RELATIONSHIPS.has(normalized) ? normalized : 'other';
}

function normalizeLanguage(value) {
  const normalized = normalizedText(value || 'en');
  return SUPPORTED_LANGUAGES.has(normalized) ? normalized : 'en';
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

export function scrubPhiForFamilyUpdate(text) {
  if (!text || typeof text !== 'string') return text;
  return text
    .replace(LAB_VALUE_RE, '[lab value withheld]')
    .replace(DOSE_RE, '[dose withheld]')
    .replace(MRN_RE, '[identifier withheld]');
}

function scrubDraftFields(draft) {
  if (!draft || typeof draft !== 'object') return draft;
  const scrubbed = { ...draft };
  const textFields = ['plain_language_summary', 'current_status', 'next_steps', 'when_to_worry'];
  for (const field of textFields) {
    if (typeof scrubbed[field] === 'string') {
      scrubbed[field] = scrubPhiForFamilyUpdate(scrubbed[field]);
    }
  }
  if (Array.isArray(scrubbed.questions_you_may_have)) {
    scrubbed.questions_you_may_have = scrubbed.questions_you_may_have.map(scrubPhiForFamilyUpdate);
  }
  return scrubbed;
}

export function evaluateConsentScope({ consents = [], caregiverRelationship = 'other' } = {}) {
  const caregiver = normalizeRelationship(caregiverRelationship);
  let active = null;
  const now = Date.now();
  for (const consent of asArray(consents)) {
    if (!consent) continue;
    const consentType = normalizedText(consent.consent_type);
    if (!ACCEPTABLE_CONSENT_TYPES.has(consentType)) continue;
    const status = normalizedText(consent.status);
    if (status && status !== 'active') continue;
    if (consent.expires_at) {
      const expires = new Date(consent.expires_at).getTime();
      if (Number.isFinite(expires) && expires < now) continue;
    }
    if (consent.revoked === true || consent.revoked_at) continue;
    if (consent.granted === false) continue;
    active = consent;
    break;
  }
  if (!active) {
    return {
      allowed: false,
      reason: 'No active consent for family or treatment communication found.',
      consent: null,
      caregiver_relationship: caregiver,
      scope: [],
    };
  }
  const rawScope = Array.isArray(active.scope) ? active.scope : asArray(active.allowed_sections);
  const normalizedScope = rawScope.length
    ? rawScope.map((entry) => normalizedText(entry)).filter(Boolean)
    : DEFAULT_FAMILY_SCOPE;
  return {
    allowed: true,
    reason: 'Active consent for family or treatment communication.',
    consent: active,
    caregiver_relationship: caregiver,
    scope: normalizedScope,
    consent_type: normalizedText(active.consent_type),
    expires_at: active.expires_at || null,
  };
}

async function loadPatientConsents(patientUid) {
  try {
    return await prisma.$queryRawUnsafe(
      `SELECT id, consent_type, status, granted, granted_at, expires_at, revoked_at
       FROM patient_consents
       WHERE patient_uid = $1::uuid
       ORDER BY granted_at DESC NULLS LAST, created_at DESC NULLS LAST
       LIMIT 20`,
      patientUid
    );
  } catch (err) {
    if (isMissingSchemaError(err)) return [];
    throw err;
  }
}

function statusFromContext(context) {
  const admission = context?.admission || {};
  const activeDx = asArray(context?.diagnoses).filter((d) => !d.status || normalizedText(d.status) === 'active');
  const primaryDx = activeDx[0]?.description || admission.admitting_diagnosis || 'their admission';
  const status = normalizedText(admission.status);
  if (status === 'discharged') return `The patient has been discharged after care for ${primaryDx}.`;
  if (status === 'admitted' || !status) return `The patient is admitted and receiving care for ${primaryDx}.`;
  return `The patient's current status is: ${admission.status || 'under observation'}. Care focus: ${primaryDx}.`;
}

function nextStepsFromContext(context) {
  const pendingInvestigations = asArray(context?.investigations).filter((inv) => {
    const s = normalizedText(inv.payload?.status || inv.sub_type);
    return s && !['completed', 'reported', 'resulted', 'cancelled', 'canceled', 'done'].includes(s);
  });
  const followUp = cleanText(context?.admission?.discharge_follow_up || context?.admission?.follow_up_plan);
  const parts = [];
  if (pendingInvestigations.length) {
    parts.push(`${pendingInvestigations.length} investigation result(s) are still pending.`);
  }
  if (followUp) parts.push(`Next planned follow-up: ${followUp}.`);
  if (!parts.length) parts.push('The clinical team will share the next step at their next review.');
  return parts.join(' ');
}

function warningSignsFor(context) {
  const dxText = asArray(context?.diagnoses).map((d) => normalizedText(d.description || d.icd10_description)).join(' ');
  const base = [
    'If the patient develops sudden breathing difficulty, severe chest pain, or confusion, call the hospital immediately.',
    'Call 108 (or your local emergency number) for any life-threatening change.',
  ];
  if (/infection|sepsis|pneumonia|fever|uti|cellulitis/.test(dxText)) {
    base.push('Watch for new or worsening fever, chills, or unusual drowsiness.');
  }
  if (/cardiac|chest|heart|mi|acs/.test(dxText)) {
    base.push('Watch for new chest pain, sweating, or fainting.');
  }
  if (/bleeding|post-?op|surgery|hemor/.test(dxText)) {
    base.push('Watch for new bleeding, swelling at the wound, or dizziness.');
  }
  return base.join(' ');
}

function summaryFromContext(context, caregiverRelationship) {
  const name = context?.patient?.name || 'the patient';
  const admission = context?.admission || {};
  const primaryDx = asArray(context?.diagnoses)[0]?.description
    || admission.admitting_diagnosis
    || 'the condition for which they were admitted';
  const relationPhrase = caregiverRelationship === 'other' ? 'family' : caregiverRelationship.replace(/_/g, ' ');
  return `This is a brief update for ${relationPhrase}: ${name} is receiving care for ${primaryDx}. The clinical team is monitoring their progress and will share more details as they become available.`;
}

function commonQuestions() {
  return [
    'When can I visit?',
    'Is there anything I can bring from home?',
    'Who do I contact with questions?',
    'When will the next update be shared?',
  ];
}

function citationsFromContext(context) {
  const citations = [];
  for (const dx of asArray(context?.diagnoses).slice(0, 3)) {
    citations.push({
      source_type: 'diagnosis',
      source_id: dx.id === null || dx.id === undefined ? null : String(dx.id),
      label: dx.description || dx.icd10_code || 'Diagnosis',
      timestamp: dx.timestamp || null,
    });
  }
  if (context?.admission?.id) {
    citations.push({
      source_type: 'admission',
      source_id: String(context.admission.id),
      label: `Admission for ${context.admission.admitting_diagnosis || context.admission.chief_complaint || 'inpatient care'}`,
      timestamp: context.admission.admitted_at || context.admission.created_at || null,
    });
  }
  for (const note of asArray(context?.notes).filter((note) => note?.payload?.is_signed).slice(0, 3)) {
    const citation = eventCitation(note, 'Signed clinical note');
    if (citation) citations.push(citation);
  }
  return uniqueCitations(citations);
}

function buildFallbackDraft({ context, scopeEvaluation, language, caregiverIdentifier, caregiverRelationship }) {
  const summary = summaryFromContext(context, caregiverRelationship);
  const currentStatus = statusFromContext(context);
  const nextSteps = nextStepsFromContext(context);
  const whenToWorry = warningSignsFor(context);
  const draft = {
    language,
    caregiver_identifier: caregiverIdentifier || null,
    caregiver_relationship: caregiverRelationship,
    consent_scope: scopeEvaluation.scope,
    plain_language_summary: summary,
    current_status: currentStatus,
    next_steps: nextSteps,
    when_to_worry: whenToWorry,
    questions_you_may_have: commonQuestions(),
    summary: summary,
    source_citations: citationsFromContext(context),
    safety_flags: [],
    rules_authoritative: true,
    decision_support_only: true,
  };
  return scrubDraftFields(draft);
}

function safetyFlagsFor({ draft, scopeEvaluation, citations }) {
  const flags = [];
  if (!scopeEvaluation.allowed) {
    flags.push({
      severity: 'critical',
      code: 'FAMILY_UPDATE_CONSENT_MISSING',
      message: scopeEvaluation.reason,
    });
  }
  if (!citations.length) {
    flags.push({
      severity: 'high',
      code: 'FAMILY_UPDATE_NO_CITATIONS',
      message: 'Family update has no source citations.',
    });
  }
  const textCorpus = [
    draft.plain_language_summary,
    draft.current_status,
    draft.next_steps,
    draft.when_to_worry,
    ...asArray(draft.questions_you_may_have),
  ].filter(Boolean).join(' ');
  if (DOSE_RE.test(textCorpus)) {
    flags.push({
      severity: 'high',
      code: 'FAMILY_UPDATE_DOSE_LEAK',
      message: 'Family-facing draft contains a medication dose; scrubbing should have removed it.',
    });
  }
  if (LAB_VALUE_RE.test(textCorpus)) {
    flags.push({
      severity: 'high',
      code: 'FAMILY_UPDATE_LAB_LEAK',
      message: 'Family-facing draft contains a raw lab value.',
    });
  }
  return flags;
}

function normalizeAiSummary(parsed, fallbackDraft) {
  const merged = {
    ...fallbackDraft,
    plain_language_summary: cleanText(parsed?.plain_language_summary) || fallbackDraft.plain_language_summary,
    current_status: cleanText(parsed?.current_status) || fallbackDraft.current_status,
    next_steps: cleanText(parsed?.next_steps) || fallbackDraft.next_steps,
    when_to_worry: cleanText(parsed?.when_to_worry) || fallbackDraft.when_to_worry,
    questions_you_may_have: asArray(parsed?.questions_you_may_have).length
      ? asArray(parsed.questions_you_may_have).map(cleanText).filter(Boolean)
      : fallbackDraft.questions_you_may_have,
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
  return scrubDraftFields(merged);
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
        review_roles: module.settings?.reviewRoles || ['DOCTOR', 'NURSING_STAFF', 'MEDICAL_RECORDS'],
        source: 'consent_aware_family_update',
        rules_authoritative: true,
        decision_support_only: true,
      })
    );
    return rows[0] || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Family update review placeholder failed', { error: err.message });
    }
    return null;
  }
}

async function insertUpdateRow({
  tenantId,
  patientUid,
  admissionId,
  caregiverIdentifier,
  caregiverRelationship,
  consentReference,
  consentScope,
  language,
  generationId,
  sourceGenerationId,
  draft,
  citations,
  safetyFlags,
  metadata,
}) {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_family_updates
         (tenant_id, patient_uid, admission_id, caregiver_identifier,
          caregiver_relationship, consent_reference, consent_scope, language,
          generation_id, source_generation_id, update_draft,
          source_citations, safety_flags, update_status, reviewer_decision,
          metadata, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, $8,
               $9, $10, $11::jsonb, $12::jsonb, $13::jsonb,
               'draft', 'pending', $14::jsonb, NOW(), NOW())
       RETURNING id, tenant_id, patient_uid, admission_id, caregiver_identifier,
                 caregiver_relationship, consent_reference, consent_scope, language,
                 generation_id, source_generation_id, update_draft,
                 source_citations, safety_flags, update_status, reviewer_decision,
                 reviewed_by, reviewed_at, reviewer_note, sent_at, sent_by,
                 delivery_channel, metadata, created_at, updated_at`,
      tenantId,
      patientUid,
      admissionId,
      caregiverIdentifier,
      caregiverRelationship,
      consentReference,
      JSON.stringify(consentScope),
      language,
      generationId,
      sourceGenerationId,
      JSON.stringify(draft),
      JSON.stringify(citations),
      JSON.stringify(safetyFlags),
      JSON.stringify(metadata || {})
    );
    return rows[0] || null;
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    throw err;
  }
}

export async function generateFamilyUpdate({
  req = null,
  patientUid,
  admissionId = null,
  caregiverIdentifier = null,
  caregiverRelationship = 'other',
  language = 'en',
  sourceGenerationId = null,
  consentReference = null,
} = {}) {
  if (!patientUid) throw AppError.badRequest('patient_uid is required');
  const tenantId = resolveTenantId({ tenantId: req?.tenantId });
  const module = await getClinicalAiModule(MODULE_KEY, { tenantId });
  if (!module.enabled) {
    throw AppError.forbidden(`Clinical AI module is disabled: ${module.display_name}`);
  }

  const resolvedRelationship = normalizeRelationship(caregiverRelationship);
  const resolvedLanguage = normalizeLanguage(language);
  const safeAdmissionId = optionalIntOrNull(admissionId);
  const safeSourceGenerationId = optionalIntOrNull(sourceGenerationId);

  const consents = await loadPatientConsents(patientUid);
  const scopeEvaluation = evaluateConsentScope({
    consents,
    caregiverRelationship: resolvedRelationship,
  });
  if (!scopeEvaluation.allowed) {
    throw AppError.forbidden(scopeEvaluation.reason);
  }

  let context = { diagnoses: [], notes: [], orders: [], investigations: [], admission: null, patient: null };
  if (safeAdmissionId) {
    context = await collectAdmissionClinicalContext(safeAdmissionId);
  }

  const fallbackDraft = buildFallbackDraft({
    context,
    scopeEvaluation,
    language: resolvedLanguage,
    caregiverIdentifier,
    caregiverRelationship: resolvedRelationship,
  });

  const prompt = await getActivePrompt(tenantId);
  const aiResult = await generateClinicalText({
    taskType: MODULE_KEY,
    systemPrompt: prompt.system_prompt,
    userPrompt: `${prompt.user_prompt_template}\n\nLanguage: ${resolvedLanguage}\nCaregiver relationship: ${resolvedRelationship}\nConsent scope: ${JSON.stringify(scopeEvaluation.scope)}\n${JSON.stringify({ rule_based_update: fallbackDraft })}`,
    tenantRegion: req?.tenant?.region || null,
    tenantId,
  });
  const parsed = safeJsonParse(aiResult.text, {});
  const draft = normalizeAiSummary(parsed, fallbackDraft);
  const citations = uniqueCitations(
    asArray(draft.source_citations).length ? draft.source_citations : fallbackDraft.source_citations
  );
  const safetyFlags = [
    ...safetyFlagsFor({ draft, scopeEvaluation, citations }),
    ...asArray(draft.safety_flags),
    ...runOutputDefenses({
      draft,
      module,
      context: { scopeEvaluation, admission: context.admission },
      citations,
    }),
  ];
  draft.safety_flags = safetyFlags;

  const generation = await insertGeneration({
    tenantId,
    admissionId: safeAdmissionId,
    patientUid,
    prompt,
    sourceHashValue: sourceHash({
      patient_uid: patientUid,
      admission_id: safeAdmissionId,
      caregiver_identifier: caregiverIdentifier,
      caregiver_relationship: resolvedRelationship,
      language: resolvedLanguage,
    }),
    draft,
    citations,
    safetyFlags,
    requestedBy: req?.user?.uid || null,
    aiResult,
    metadata: {
      admission_id: safeAdmissionId,
      caregiver_relationship: resolvedRelationship,
      language: resolvedLanguage,
      consent_type: scopeEvaluation.consent_type || null,
      consent_scope: scopeEvaluation.scope,
      fallback_reason: aiResult.usedAi ? null : aiResult.reason || 'template_or_rule_output',
      rules_authoritative: true,
    },
  });

  const updateRow = await insertUpdateRow({
    tenantId,
    patientUid,
    admissionId: safeAdmissionId,
    caregiverIdentifier,
    caregiverRelationship: resolvedRelationship,
    consentReference: consentReference || (scopeEvaluation.consent?.id ? String(scopeEvaluation.consent.id) : null),
    consentScope: scopeEvaluation.scope,
    language: resolvedLanguage,
    generationId: generation?.id || null,
    sourceGenerationId: safeSourceGenerationId,
    draft,
    citations,
    safetyFlags,
    metadata: {
      consent_type: scopeEvaluation.consent_type || null,
      used_ai: Boolean(aiResult.usedAi),
      provider: aiResult.provider || 'template',
      model: aiResult.model || null,
      rules_authoritative: true,
    },
  });
  if (!updateRow) {
    return {
      update_id: null,
      generation_id: generation?.id || null,
      draft,
      source_citations: citations,
      safety_flags: safetyFlags,
      module_key: MODULE_KEY,
      prompt_version: prompt.version || 'v1',
      update_status: 'schema_unavailable',
      reason: 'clinical_ai_family_updates_unavailable',
      decision_support_only: true,
      language: resolvedLanguage,
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
    eventType: 'clinical_ai.family_update_generated',
    aggregateType: 'clinical_ai_family_update',
    aggregateId: updateRow.id,
    patientUid,
    payload: {
      tenant_id: tenantId,
      admission_id: safeAdmissionId,
      update_id: updateRow.id,
      generation_id: generation?.id || null,
      caregiver_relationship: resolvedRelationship,
      language: resolvedLanguage,
    },
  });

  return {
    update_id: updateRow.id,
    generation_id: generation?.id || null,
    clinical_review_id: clinicalReview?.id || null,
    draft,
    update: updateRow,
    consent_scope: scopeEvaluation.scope,
    source_citations: citations,
    safety_flags: safetyFlags,
    module_key: MODULE_KEY,
    prompt_version: prompt.version || 'v1',
    update_status: updateRow.update_status,
    review_status: clinicalReview?.decision || updateRow.reviewer_decision || 'pending',
    requires_signoff: Boolean(module.settings?.requiresClinicianSignoff),
    ai_metadata: {
      provider: aiResult.provider || 'template',
      model: aiResult.model || null,
      used_ai: Boolean(aiResult.usedAi),
      usage: aiResult.usage || {},
    },
    rules_authoritative: true,
    decision_support_only: true,
    language: resolvedLanguage,
    caregiver_relationship: resolvedRelationship,
  };
}

export async function listFamilyUpdates({
  tenantId = null,
  patientUid = null,
  admissionId = null,
  updateStatus = null,
  decision = null,
  limit = 50,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const aid = admissionId ? optionalInt(admissionId, 'admission_id') : null;
  const normalizedStatus = updateStatus && STATUSES.has(cleanText(updateStatus).toLowerCase())
    ? cleanText(updateStatus).toLowerCase()
    : null;
  const normalizedDecision = decision && DECISIONS.has(cleanText(decision).toLowerCase())
    ? cleanText(decision).toLowerCase()
    : null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT f.id, f.tenant_id, f.patient_uid, u.name AS patient_name,
              f.admission_id, f.caregiver_identifier, f.caregiver_relationship,
              f.consent_reference, f.consent_scope, f.language,
              f.generation_id, f.source_generation_id, f.update_draft,
              f.source_citations, f.safety_flags, f.update_status,
              f.reviewer_decision, f.reviewed_by, f.reviewed_at, f.reviewer_note,
              f.sent_at, f.sent_by, f.delivery_channel, f.metadata,
              f.created_at, f.updated_at
       FROM clinical_ai_family_updates f
       LEFT JOIN users u ON u.uid = f.patient_uid
       WHERE f.tenant_id = $1::uuid
         AND ($2::int IS NULL OR f.admission_id = $2)
         AND ($3::uuid IS NULL OR f.patient_uid = $3::uuid)
         AND ($4::text IS NULL OR f.update_status = $4)
         AND ($5::text IS NULL OR f.reviewer_decision = $5)
       ORDER BY
         CASE f.update_status
           WHEN 'draft' THEN 0
           WHEN 'ready_to_send' THEN 1
           WHEN 'sent' THEN 2
           WHEN 'withdrawn' THEN 3
           ELSE 4
         END,
         f.created_at DESC
       LIMIT $6`,
      tid,
      aid,
      patientUid || null,
      normalizedStatus,
      normalizedDecision,
      safeLimit
    );
    return { updates: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { updates: [], count: 0 };
    throw err;
  }
}

export async function decideFamilyUpdate({
  tenantId = null,
  updateId,
  decision,
  reviewerUid = null,
  note = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const normalized = cleanText(decision).toLowerCase();
  if (!FINAL_DECISIONS.has(normalized)) {
    throw AppError.badRequest('decision must be accepted, deferred, rejected, or edited');
  }
  const nextStatus = normalized === 'accepted' ? 'ready_to_send' : null;
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE clinical_ai_family_updates
     SET reviewer_decision = $2,
         reviewed_by = $3::uuid,
         reviewed_at = NOW(),
         reviewer_note = $4,
         update_status = COALESCE($5, update_status),
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $6::uuid
     RETURNING id, admission_id, patient_uid, generation_id,
               caregiver_relationship, language, reviewer_decision,
               reviewed_by, reviewed_at, reviewer_note, update_status`,
    optionalInt(updateId, 'update_id'),
    normalized,
    reviewerUid,
    note,
    nextStatus,
    tid
  );
  if (!rows[0]) throw AppError.notFound('Family update not found');
  return rows[0];
}

export async function markFamilyUpdateSent({
  tenantId = null,
  updateId,
  sentBy = null,
  deliveryChannel = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const id = optionalInt(updateId, 'update_id');
  const existing = await prisma.$queryRawUnsafe(
    `SELECT id, update_status, reviewer_decision
     FROM clinical_ai_family_updates
     WHERE id = $1
       AND tenant_id = $2::uuid
     LIMIT 1`,
    id,
    tid
  );
  const update = existing[0];
  if (!update) throw AppError.notFound('Family update not found');
  if (update.reviewer_decision !== 'accepted') {
    throw AppError.badRequest('Family update must be accepted before marking as sent');
  }
  if (update.update_status !== 'ready_to_send') {
    throw AppError.invalidTransition(update.update_status, 'sent', ['ready_to_send']);
  }
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE clinical_ai_family_updates
     SET update_status = 'sent',
         sent_at = NOW(),
         sent_by = $2::uuid,
         delivery_channel = $3,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $4::uuid
     RETURNING id, admission_id, patient_uid, generation_id,
               update_status, sent_at, sent_by, delivery_channel`,
    id,
    sentBy,
    deliveryChannel,
    tid
  );
  if (!rows[0]) throw AppError.notFound('Family update not found');
  return rows[0];
}

export default {
  decideFamilyUpdate,
  evaluateConsentScope,
  generateFamilyUpdate,
  listFamilyUpdates,
  markFamilyUpdateSent,
  scrubPhiForFamilyUpdate,
};
