/**
 * Teleconsult AI module (Phase B1).
 *
 * Two thin generators backing the telemedicine vertical:
 *   - teleconsult_pre_visit_summary : pre-consult patient summary the
 *                                      doctor reads before the call
 *   - teleconsult_note_draft        : structured note from chat
 *                                      transcript + chief complaint +
 *                                      patient context after consult
 *
 * Both follow the standard runOutputDefenses + clinical_ai_generations
 * + clinical_ai_reviews pipeline used by every other AI module.
 *
 * Decision-support only: drafts are persisted as ai_note_generation_id /
 * ai_pre_visit_summary_id on the parent teleconsultation row, but never
 * auto-finalize the consult or auto-publish to the patient app.
 */

import crypto from 'crypto';

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenantService.js';
import { getClinicalAiModule } from './clinicalAiModuleService.js';
import { runOutputDefenses } from './hallucinationDefenses.js';
import { generateClinicalText } from './localLlmClient.js';

const TELECONSULT_AI_MODULES = new Set([
  'teleconsult_pre_visit_summary',
  'teleconsult_note_draft',
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

async function loadConsult({ tenantId, teleconsultationId }) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, patient_uid, doctor_uid, chief_complaint, pre_consult_form,
            consult_type, status, scheduled_start, actual_start, actual_end
     FROM teleconsultations
     WHERE id = $1 AND tenant_id = $2::uuid LIMIT 1`,
    teleconsultationId, tenantId,
  );
  if (!rows[0]) throw AppError.notFound('Teleconsultation not found');
  return rows[0];
}

async function loadChatTranscript({ tenantId, teleconsultationId, limit = 200 }) {
  try {
    return await prisma.$queryRawUnsafe(
      `SELECT m.id, m.authored_role, m.body, m.body_kind, m.created_at
       FROM chat_session_messages m
       JOIN chat_sessions s ON s.id = m.chat_session_id
       WHERE s.tenant_id = $1::uuid AND s.teleconsultation_id = $2
         AND m.redacted = false AND m.body_kind = 'text'
       ORDER BY m.created_at ASC
       LIMIT $3`,
      tenantId, teleconsultationId, limit,
    );
  } catch (err) {
    if (isMissingSchemaError(err)) return [];
    throw err;
  }
}

async function runTeleconsultPipeline({
  moduleKey,
  tenantId,
  consult,
  systemPrompt,
  userPromptPayload,
  contextForDefenses,
  citations,
  metadata,
  generatedBy,
  req,
  generationFkColumn, // 'ai_note_generation_id' | 'ai_pre_visit_summary_id'
}) {
  if (!TELECONSULT_AI_MODULES.has(moduleKey)) {
    throw AppError.badRequest(`Unknown teleconsult AI module_key: ${moduleKey}`);
  }
  const tid = resolveTenantId({ tenantId });
  const module = await getClinicalAiModule(moduleKey);
  if (!module.enabled) {
    throw AppError.forbidden(`Clinical AI module is disabled: ${module.display_name}`);
  }

  const aiResult = await generateClinicalText({
    systemPrompt: [
      systemPrompt,
      'Return JSON only.',
      'Cite every clinical claim. Do not invent values.',
      'Decision-support only — never finalize the consult or publish to the patient app.',
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
    draft, module, context: contextForDefenses || {}, citations,
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
       VALUES ($1::uuid, $2::uuid, NULL, $3, $3, $4, $5, 'v1', $6, $7, $8,
               $9::jsonb, $10::jsonb, $11::jsonb, $12::uuid, $13, $14, $15,
               $16, $17, $18, $19, $20::jsonb, NOW(), NOW())
       RETURNING id`,
      tid, consult.patient_uid || null,
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
      JSON.stringify({ ...(metadata || {}), teleconsultation_id: consult.id }),
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
        tid, generationId, moduleKey, consult.patient_uid || null,
        JSON.stringify({
          review_roles: module.settings?.reviewRoles || ['DOCTOR'],
          source: 'teleconsult_ai',
          teleconsultation_id: consult.id,
        }),
      );

      // Link the draft generation back onto the parent consult row so the UI
      // can find it without scanning generations by metadata.
      if (generationFkColumn === 'ai_note_generation_id'
          || generationFkColumn === 'ai_pre_visit_summary_id') {
        await prisma.$queryRawUnsafe(
          `UPDATE teleconsultations
           SET ${generationFkColumn} = $1, updated_at = NOW()
           WHERE id = $2 AND tenant_id = $3::uuid`,
          generationId, consult.id, tid,
        );
      }
    } catch (err) {
      if (!isMissingSchemaError(err)) {
        logger.warn(`${moduleKey} review/link enqueue failed`, { error: err.message });
      }
    }
  }

  return {
    module_key: moduleKey,
    generation_id: generationId,
    teleconsultation_id: consult.id,
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

export async function generatePreVisitSummary({
  tenantId = null, teleconsultationId, generatedBy = null, req = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const consultId = normalizeId(teleconsultationId, 'teleconsultation_id');
  const consult = await loadConsult({ tenantId: tid, teleconsultationId: consultId });

  const citations = [{
    source_type: 'teleconsultation',
    source_id: String(consult.id),
    label: `Pre-visit summary for consult ${consult.id}`,
  }];

  return runTeleconsultPipeline({
    moduleKey: 'teleconsult_pre_visit_summary',
    tenantId: tid, consult,
    systemPrompt: [
      'You are a clinician assistant. Build a 60-second pre-visit summary the doctor reads before joining the teleconsult.',
      'Output JSON: { chief_complaint, current_medications: Array<string>, relevant_history: Array<string>, recent_vitals: Array<{ kind, value, when }>, suggested_questions: Array<string>, red_flags: Array<string>, source_citations, safety_flags }.',
      'If pre-consult form is missing, leave fields empty rather than guessing. Surface "patient has not completed intake" as a red flag.',
    ].join('\n'),
    userPromptPayload: {
      chief_complaint: consult.chief_complaint,
      pre_consult_form: consult.pre_consult_form || {},
      consult_type: consult.consult_type,
    },
    contextForDefenses: { consult },
    citations,
    metadata: { teleconsultation_id: consultId },
    generatedBy, req,
    generationFkColumn: 'ai_pre_visit_summary_id',
  });
}

export async function generateTeleconsultNoteDraft({
  tenantId = null, teleconsultationId, generatedBy = null, req = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const consultId = normalizeId(teleconsultationId, 'teleconsultation_id');
  const consult = await loadConsult({ tenantId: tid, teleconsultationId: consultId });
  const transcript = await loadChatTranscript({ tenantId: tid, teleconsultationId: consultId });

  const citations = [
    {
      source_type: 'teleconsultation',
      source_id: String(consult.id),
      label: `Teleconsult ${consult.id} — ${consult.consult_type}`,
    },
    ...transcript.slice(0, 10).map((m) => ({
      source_type: 'chat_message',
      source_id: String(m.id),
      label: `${m.authored_role}: ${String(m.body || '').slice(0, 60)}`,
    })),
  ];

  return runTeleconsultPipeline({
    moduleKey: 'teleconsult_note_draft',
    tenantId: tid, consult,
    systemPrompt: [
      'You are a clinician scribe drafting a structured note from a teleconsult chat transcript + chief complaint.',
      'Output JSON: { subjective, objective: { vitals_reported, exam }, assessment, plan: { medications, investigations, follow_up }, patient_education, red_flags, source_citations, safety_flags }.',
      'Do NOT invent measurements / exam findings the transcript does not include. A teleconsult exam is limited — write only what was actually observed (e.g. "no objective exam — video only").',
      'If the chat is empty, surface "no consultation transcript available" as a red flag rather than fabricating a note.',
    ].join('\n'),
    userPromptPayload: {
      chief_complaint: consult.chief_complaint,
      pre_consult_form: consult.pre_consult_form || {},
      transcript: transcript.map((m) => ({
        role: m.authored_role,
        body: m.body,
        when: m.created_at,
      })),
    },
    contextForDefenses: { consult, transcript },
    citations,
    metadata: { teleconsultation_id: consultId, transcript_msgs: transcript.length },
    generatedBy, req,
    generationFkColumn: 'ai_note_generation_id',
  });
}

export const __testing__ = {
  TELECONSULT_AI_MODULES,
};

export default {
  generatePreVisitSummary,
  generateTeleconsultNoteDraft,
};
