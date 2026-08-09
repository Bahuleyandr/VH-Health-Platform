/**
 * Batch clinical-coding suggestions (governed Claude-adoption Part 2, feature B).
 *
 * Sweeps recently discharged admissions that have signed documentation and no
 * coding draft yet, and generates ICD coding SUGGESTIONS for the coding team
 * through the existing clinical-AI framework:
 *
 *   candidates → de-identify (deidentificationService, BEFORE any egress)
 *     → generateClinicalText (module `clinical_coding_assist`: enablement,
 *       budget guardrails, CLINICAL_AI_ALLOW_EXTERNAL + per-module
 *       external_allowed + region allowlist all enforced inside the client)
 *     → annotateCodingDraft (terminology validation) + output defenses
 *     → clinical_ai_generations + clinical_ai_safety_reviews
 *     → PENDING clinical_ai_reviews row for the coding team.
 *
 * Guardrails (non-negotiable):
 *   - NOTHING is ever auto-applied to claims, billing, or the patient record.
 *     The only writes are the framework's clinical_ai_* draft/review tables;
 *     suggestions enter the record solely through the existing review-decision
 *     flow.
 *   - Off by default: the `clinical_coding_assist` module ships disabled and
 *     the scheduled sweep is additionally gated by
 *     CLINICAL_AI_CODING_BATCH_ENABLED (see utils/scheduler.js).
 *   - De-identification is fail-closed: an admission whose packet cannot be
 *     provably redacted is skipped, never sent.
 *   - The batch persists REAL AI suggestions only. When the provider degrades
 *     (blocked or template fallback) the run stops and reports why, instead of
 *     flooding the coder queue with empty template rows; the existing
 *     on-demand admission route stays available for rule-based drafts.
 *
 * Provider note: calls are sequential through localLlmClient rather than the
 * Anthropic Message Batches API — the framework's budget/egress/usage
 * accounting is per-call and synchronous, and a durable async-batch tracker
 * would need new tables. See the PR description.
 */

import crypto from 'crypto';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { collectAdmissionClinicalContext } from '../emr/clinicalTimelineService.js';
import { publishEvent } from '../events/eventOutboxService.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { getClinicalAiModule } from './clinicalAiModuleService.js';
import { deidentifyText, collectKnownIdentifiers } from './deidentificationService.js';
import { runOutputDefenses } from './hallucinationDefenses.js';
import { generateClinicalText } from './localLlmClient.js';
import { saveGeneration, createReviewPlaceholder } from './clinicalAiWorkflowService.js';

export const CODING_BATCH_MODULE_KEY = 'clinical_coding_assist';

const DEFAULT_LIMIT = 25;
const DEFAULT_LOOKBACK_DAYS = 14;

/**
 * Well-formed JSON contract for the suggestion draft. Every object node
 * declares its properties, so localLlmClient's structured-output normalizer
 * accepts it and enforces it server-side on the Anthropic provider; other
 * providers fall back to the fence-stripping parser below.
 */
export const CODING_SUGGESTION_SCHEMA = {
  type: 'object',
  required: ['suggested_codes', 'evidence', 'coder_notes'],
  properties: {
    suggested_codes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['system', 'code', 'description', 'confidence'],
        properties: {
          system: { type: 'string' },
          code: { type: 'string' },
          description: { type: 'string' },
          confidence: { type: 'string' },
        },
      },
    },
    evidence: { type: 'array', items: { type: 'string' } },
    coder_notes: { type: 'string' },
  },
};

const SYSTEM_PROMPT = [
  'You are a hospital clinical coding assistant.',
  'Suggest ICD-10 diagnosis codes strictly from the supplied de-identified, signed documentation excerpts.',
  'Do not invent diagnoses, do not infer identity, and do not include any patient identifiers.',
  'Return JSON only. Every suggestion is a draft that requires human coder approval before any billing use.',
].join(' ');

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function clampInt(value, { min, max, fallback }) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
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

async function resolveTenantRegion(tenantId) {
  try {
    const rows = await prisma.$queryRawUnsafe(
      'SELECT region FROM tenants WHERE id = $1::uuid',
      tenantId
    );
    return rows?.[0]?.region || null;
  } catch (err) {
    logger.warn('Coding batch: tenant region lookup failed; treating region as unknown', {
      error: err.message,
    });
    return null;
  }
}

/**
 * Discharged admissions with no non-failed coding generation yet, newest
 * first. Signed-documentation and de-id checks run per candidate later.
 */
async function listCandidateAdmissions({ tenantId, lookbackDays, limit }) {
  return prisma.$queryRawUnsafe(
    `SELECT a.id, a.patient_uid
     FROM admissions a
     WHERE a.tenant_id = $1::uuid
       AND a.status = 'discharged'
       AND a.discharged_at >= NOW() - make_interval(days => $2::int)
       AND NOT EXISTS (
         SELECT 1 FROM clinical_ai_generations g
         WHERE g.admission_id = a.id
           AND g.module_key = $4
           AND g.status <> 'failed'
       )
     ORDER BY a.discharged_at DESC
     LIMIT $3::int`,
    tenantId,
    lookbackDays,
    limit,
    CODING_BATCH_MODULE_KEY
  );
}

/**
 * Compact coding packet from the chart context: diagnoses + signed-note
 * excerpts only. Kept deliberately small — the model needs documentation
 * evidence, not the whole chart.
 */
function buildCodingPacket(context) {
  const signedNotes = asArray(context.notes).filter((event) => event.payload?.is_signed === true);
  const diagnoses = asArray(context.diagnoses).map((event) => event.payload || {});
  return {
    signedNotes,
    packet: {
      documentation_basis: 'signed_notes_only',
      diagnoses: diagnoses.map((d) => ({
        description: d.description || d.icd10_description || null,
        recorded_code: d.icd10_code || null,
      })),
      signed_note_excerpts: signedNotes.map((event) => ({
        type: event.sub_type || event.event_type || 'note',
        text: String(event.payload?.content || event.summary || '').slice(0, 2000),
      })),
    },
  };
}

/**
 * De-identify every string leaf of the packet (fail-closed). Redacting each
 * leaf — rather than the serialized JSON — keeps the JSON structure intact and
 * lets the chart-anchored matcher see the raw field values.
 */
function deidentifyPacket(packet, { knownIdentifiers }) {
  const redactionCounts = {};
  const residualFlags = [];
  let failed = false;

  const walk = (value) => {
    if (typeof value === 'string') {
      const result = deidentifyText(value, { knownIdentifiers });
      for (const { category, count } of result.redactions) {
        redactionCounts[category] = (redactionCounts[category] || 0) + count;
      }
      for (const flag of result.residualFlags) {
        if (flag.code === 'DEID_FAILED') failed = true;
        residualFlags.push(flag);
      }
      return result.text;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
    }
    return value;
  };

  const deidentified = walk(packet);
  return { deidentified, redactionCounts, residualFlags, failed };
}

function noteCitations(signedNotes) {
  return signedNotes.map((event) => ({
    source_type: event.event_type || 'clinical_note',
    source_id: event.id === null || event.id === undefined ? null : String(event.id),
    label: event.summary || 'Signed clinical note',
    timestamp: event.timestamp || null,
  }));
}

/**
 * Run one coding-suggestion batch for a tenant. Returns a PHI-free summary.
 *
 * @param {object} opts
 * @param {string} opts.tenantId       tenant to sweep (required)
 * @param {number} [opts.limit]        max admissions per run
 * @param {number} [opts.lookbackDays] discharge recency window
 * @param {string|null} [opts.triggeredBy] admin uid for manual runs
 * @param {string} [opts.source]       'scheduled' | 'admin'
 */
export async function runCodingSuggestionBatch({
  tenantId = null,
  limit = null,
  lookbackDays = null,
  triggeredBy = null,
  source = 'scheduled',
} = {}) {
  const resolvedTenantId = requireTenantId(tenantId);
  const summary = {
    module_key: CODING_BATCH_MODULE_KEY,
    source,
    tenant_id: resolvedTenantId,
    candidates: 0,
    suggested: 0,
    review_items: 0,
    skipped: [],
    stopped_reason: null,
  };

  const module = await getClinicalAiModule(CODING_BATCH_MODULE_KEY, { tenantId: resolvedTenantId });
  if (!module.enabled) {
    summary.stopped_reason = 'module_disabled';
    return summary;
  }

  const effectiveLimit = clampInt(
    limit ?? process.env.CLINICAL_AI_CODING_BATCH_LIMIT,
    { min: 1, max: 100, fallback: DEFAULT_LIMIT }
  );
  const effectiveLookback = clampInt(
    lookbackDays ?? process.env.CLINICAL_AI_CODING_BATCH_LOOKBACK_DAYS,
    { min: 1, max: 90, fallback: DEFAULT_LOOKBACK_DAYS }
  );
  const tenantRegion = await resolveTenantRegion(resolvedTenantId);

  const candidates = await listCandidateAdmissions({
    tenantId: resolvedTenantId,
    lookbackDays: effectiveLookback,
    limit: effectiveLimit,
  });
  summary.candidates = candidates.length;

  for (const candidate of candidates) {
    const context = await collectAdmissionClinicalContext(candidate.id, resolvedTenantId);
    const { signedNotes, packet } = buildCodingPacket(context);

    if (!signedNotes.length) {
      summary.skipped.push({ admission_id: candidate.id, reason: 'no_signed_documentation' });
      continue;
    }

    // De-identify BEFORE any egress; fail-closed on any redaction failure.
    const knownIdentifiers = await collectKnownIdentifiers(candidate.patient_uid, {
      tenantId: resolvedTenantId,
    });
    const deid = deidentifyPacket(packet, { knownIdentifiers });
    if (deid.failed) {
      summary.skipped.push({ admission_id: candidate.id, reason: 'deidentification_failed' });
      continue;
    }

    const aiResult = await generateClinicalText({
      taskType: CODING_BATCH_MODULE_KEY,
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: `Suggest ICD-10 codes for this de-identified encounter.\n\n${JSON.stringify(deid.deidentified)}`,
      tenantRegion,
      tenantId: resolvedTenantId,
      jsonSchema: CODING_SUGGESTION_SCHEMA,
    });

    if (!aiResult.usedAi) {
      // Blocked (egress/budget/module) or provider degraded to template —
      // either way the batch must not synthesize suggestions. Stop the run
      // and surface the reason; nothing is persisted for this admission.
      summary.stopped_reason = aiResult.reason || aiResult.generation_mode || 'provider_unavailable';
      break;
    }

    const draft = safeJsonParse(aiResult.text, { suggested_codes: [], evidence: [], coder_notes: '' });
    draft.signed_documentation_only = true;

    // Terminology validation (fail-closed annotation) + safety flags.
    const { annotateCodingDraft } = await import('./codingValidationService.js');
    const { suggested_codes: annotatedCodes, safety_flags: codeFlags } =
      await annotateCodingDraft(draft, { tenantId: resolvedTenantId });
    draft.suggested_codes = annotatedCodes;

    const citations = noteCitations(signedNotes);
    const safetyFlags = [
      ...codeFlags,
      ...deid.residualFlags.map((flag) => ({
        severity: flag.severity,
        code: flag.code,
        message: flag.message,
      })),
      ...runOutputDefenses({ draft, module, context, citations }),
    ];
    const hasCriticalFlag = safetyFlags.some((flag) => flag.severity === 'critical');

    const generation = await saveGeneration({
      tenantId: resolvedTenantId,
      patientUid: candidate.patient_uid,
      admissionId: candidate.id,
      moduleKey: CODING_BATCH_MODULE_KEY,
      promptVersion: 'batch-v1',
      sourceHash: crypto.createHash('sha256').update(JSON.stringify(deid.deidentified)).digest('hex'),
      draft,
      citations,
      safetyFlags,
      generatedBy: triggeredBy,
      aiResult,
      status: hasCriticalFlag ? 'failed' : 'draft',
      failureReason: hasCriticalFlag
        ? safetyFlags.find((flag) => flag.severity === 'critical')?.code || 'critical_defense_failure'
        : null,
      metadata: {
        batch: true,
        batch_source: source,
        deidentified_egress: true,
        deid_redaction_counts: deid.redactionCounts,
        tenant_region: tenantRegion,
      },
    });
    summary.suggested += 1;

    if (!hasCriticalFlag) {
      const review = await createReviewPlaceholder({
        tenantId: resolvedTenantId,
        generationId: generation.id,
        module,
        patientUid: candidate.patient_uid,
        admissionId: candidate.id,
      });
      if (review) summary.review_items += 1;

      await publishEvent({
        eventType: 'clinical_ai.draft_generated',
        aggregateType: 'clinical_ai_generation',
        aggregateId: generation.id,
        patientUid: candidate.patient_uid,
        payload: {
          tenant_id: resolvedTenantId,
          module_key: CODING_BATCH_MODULE_KEY,
          admission_id: candidate.id,
          review_id: review?.id || null,
          batch: true,
        },
      });
    }
  }

  logger.info('Coding suggestion batch complete', {
    tenant_id: resolvedTenantId,
    source,
    candidates: summary.candidates,
    suggested: summary.suggested,
    review_items: summary.review_items,
    skipped: summary.skipped.length,
    stopped_reason: summary.stopped_reason,
  });
  return summary;
}

export const __testing__ = { buildCodingPacket, deidentifyPacket, listCandidateAdmissions };

export default { runCodingSuggestionBatch };
