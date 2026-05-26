/**
 * Voice-to-SOAP pipeline.
 *
 * Flow:
 *   1. Clinician POSTs audio (multipart). Route calls persistVoiceNote +
 *      transcribeVoiceNote; row is saved immediately so the raw audio is
 *      captured even if STT fails.
 *   2. Separately, the clinician (or auto-trigger) calls generateSoapDraft
 *      with the voice_note id. That produces a clinical AI draft that
 *      enters the review queue like any other module.
 *
 * Every write is tenant-scoped and passes through the same hallucination
 * defense matrix. No voice note is promoted to a chart note without a
 * reviewer signing off on the SOAP draft first.
 */

import crypto from 'crypto';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { publishEvent } from '../events/eventOutboxService.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenantService.js';
import { generateClinicalText } from './localLlmClient.js';
import {
  getClinicalAiModule,
} from './clinicalAiModuleService.js';
import { runOutputDefenses } from './hallucinationDefenses.js';
import { transcribe } from './sttService.js';

const MODULE_KEY = 'soap_from_dictation';
const MAX_AUDIO_BYTES = 20 * 1024 * 1024; // 20 MB cap — enough for ~2 minutes of WAV
const ALLOWED_MIMES = new Set([
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
  'audio/mpeg',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
  'audio/ogg',
  'audio/webm',
  'audio/aac',
]);

function resolveTenantId(req) {
  return req?.tenantId || DEFAULT_TENANT_ID;
}

function sourceHash(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex');
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

function buildSoapFallback(transcript) {
  const body = String(transcript || '').trim();
  return {
    subjective: body ? `Patient-reported (from dictation): ${body.slice(0, 600)}` : 'Not documented',
    objective: 'Review current vitals, exam findings, and objective data from chart before accepting.',
    assessment: 'Clinician must confirm assessment against chart context.',
    plan: 'Clinician must confirm plan against standing orders + chart context.',
    source: 'fallback_from_transcript',
  };
}

function validateAudio(audioBuffer, mimeType) {
  if (!audioBuffer || !(audioBuffer instanceof Buffer || audioBuffer instanceof Uint8Array)) {
    throw AppError.badRequest('audio buffer required');
  }
  if (audioBuffer.length > MAX_AUDIO_BYTES) {
    throw AppError.badRequest(`audio exceeds ${MAX_AUDIO_BYTES} bytes`);
  }
  const normalizedMime = String(mimeType || '').toLowerCase();
  if (!ALLOWED_MIMES.has(normalizedMime)) {
    throw AppError.badRequest(`unsupported audio type: ${normalizedMime || 'unknown'}`);
  }
}

function summarizeVoiceCapturePolicy(module, tenantId) {
  const settings = module?.settings || {};
  const moduleEnabled = module?.enabled === true;
  return {
    module_key: MODULE_KEY,
    tenant_id: tenantId,
    module_enabled: moduleEnabled,
    audio_capture_allowed: moduleEnabled,
    blocking_reason: moduleEnabled ? null : 'VOICE_MODULE_DISABLED',
    decision_support_only: true,
    human_review_required: settings.requiresClinicianSignoff !== false,
    patient_dispatch_allowed: false,
    consent_policy_required: true,
    retention_days: Number.parseInt(settings.retentionDays, 10) || 30,
    approval_policy: settings.approvalPolicy || null,
    review_roles: Array.isArray(settings.reviewRoles) ? settings.reviewRoles : [],
  };
}

export async function getVoiceCapturePolicy({ req, tenantId = null, refresh = false } = {}) {
  const tid = tenantId || resolveTenantId(req);
  const module = await getClinicalAiModule(MODULE_KEY, { tenantId: tid, refresh });
  return summarizeVoiceCapturePolicy(module, tid);
}

async function assertVoiceCaptureAllowed({ req, tenantId = null } = {}) {
  const policy = await getVoiceCapturePolicy({ req, tenantId });
  if (!policy.audio_capture_allowed) {
    throw AppError.forbidden(
      'Voice dictation is disabled until the tenant enables SOAP from Dictation',
      'CLINICAL_AI_VOICE_CAPTURE_DISABLED',
      policy,
    );
  }
  return policy;
}

/**
 * Save the voice-note row (audio metadata + transcript). The audio bytes
 * themselves live in R2 — caller passes in the storage_key after uploading,
 * or passes null and we skip long-term storage (useful for test + mock).
 */
async function persistVoiceNote({
  tenantId,
  recordedBy,
  patientUid = null,
  admissionId = null,
  storageKey = null,
  mimeType,
  durationSeconds = null,
  transcriptResult,
  capturePolicy = null,
}) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO clinical_voice_notes
       (tenant_id, recorded_by, patient_uid, admission_id, audio_storage_key,
        audio_mime, audio_duration_seconds, stt_provider, stt_model, stt_language,
        transcript, transcript_status, transcript_failure_reason, metadata,
        created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10,
             $11, $12, $13, $14::jsonb, NOW(), NOW())
     RETURNING id, tenant_id, recorded_by, patient_uid, admission_id,
               audio_storage_key, audio_mime, audio_duration_seconds,
               stt_provider, stt_model, stt_language, transcript,
               transcript_status, transcript_failure_reason, metadata,
               generation_id, created_at, updated_at`,
    tenantId,
    recordedBy,
    patientUid,
    admissionId,
    storageKey,
    mimeType || null,
    durationSeconds,
    transcriptResult.provider || 'none',
    transcriptResult.model || null,
    transcriptResult.language || null,
    transcriptResult.text || null,
    transcriptResult.status || 'skipped',
    transcriptResult.reason || null,
    JSON.stringify({
      audio_bytes: null,
      capture_policy: capturePolicy,
    })
  );
  return rows[0];
}

/**
 * POST /clinical/voice-note/transcribe handler entry point. Takes a raw
 * audio buffer + mime, runs STT, saves the row. Returns the saved row so
 * the client can immediately render the transcript or surface a failure.
 */
export async function createAndTranscribeVoiceNote({
  req,
  audioBuffer,
  mimeType,
  patientUid = null,
  admissionId = null,
  storageKey = null,
  durationSeconds = null,
  language = null,
}) {
  const tenantId = resolveTenantId(req);
  const capturePolicy = await assertVoiceCaptureAllowed({ req, tenantId });
  validateAudio(audioBuffer, mimeType);
  const tenantRegion = req?.tenant?.region || null;
  const recordedBy = req?.user?.uid || null;

  const transcriptResult = await transcribe({
    audioBuffer,
    mimeType,
    language,
    tenantRegion,
  });

  const saved = await persistVoiceNote({
    tenantId,
    recordedBy,
    patientUid,
    admissionId,
    storageKey,
    mimeType,
    durationSeconds,
    transcriptResult,
    capturePolicy,
  });

  await publishEvent({
    eventType: 'clinical_voice_note.created',
    aggregateType: 'clinical_voice_note',
    aggregateId: saved.id,
    patientUid,
    payload: {
      tenant_id: tenantId,
      status: saved.transcript_status,
      provider: saved.stt_provider,
    },
  });

  return saved;
}

/**
 * Turn the transcript into a structured SOAP draft and persist as a
 * clinical_ai_generation. Runs through the standard hallucination-defense
 * matrix; saves as status='failed' if a CRITICAL flag fires.
 */
export async function generateSoapDraftFromVoiceNote({ req, voiceNoteId }) {
  const tenantId = resolveTenantId(req);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, tenant_id, recorded_by, patient_uid, admission_id, transcript,
            transcript_status, stt_language, generation_id
     FROM clinical_voice_notes
     WHERE id = $1 AND tenant_id = $2::uuid
     LIMIT 1`,
    Number.parseInt(voiceNoteId, 10),
    tenantId
  );
  const voiceNote = rows[0];
  if (!voiceNote) throw AppError.notFound('Voice note not found');
  if (voiceNote.transcript_status !== 'completed' || !voiceNote.transcript) {
    throw AppError.badRequest('Voice note has no completed transcript');
  }
  if (voiceNote.generation_id) {
    throw AppError.conflict('SOAP draft already generated for this voice note');
  }

  const module = await getClinicalAiModule(MODULE_KEY, { tenantId });
  if (!module.enabled) {
    throw AppError.forbidden(`Clinical AI module is disabled: ${module.display_name}`);
  }

  const systemPrompt = [
    'You are a hospital SOAP-note assistant.',
    'Convert the clinician dictation into a structured JSON object with subjective, objective, assessment, plan.',
    'Do not invent objective findings, vital signs, lab values, or medications that are not explicitly in the dictation.',
    'When the dictation does not cover a section, use "not documented".',
    'Return JSON only.',
  ].join('\n');
  const userPrompt = `Dictation transcript:\n${voiceNote.transcript}`;

  const aiResult = await generateClinicalText({
    systemPrompt,
    userPrompt,
    taskType: MODULE_KEY,
    tenantRegion: req?.tenant?.region || null,
  });

  const fallback = buildSoapFallback(voiceNote.transcript);
  const draft = safeJsonParse(aiResult.text, fallback);
  const citations = [{
    source_type: 'clinical_voice_note',
    source_id: String(voiceNote.id),
    label: `Dictation transcript (${voiceNote.transcript.length} chars)`,
    timestamp: null,
  }];

  const safetyFlags = [];
  safetyFlags.push(...runOutputDefenses({
    draft,
    module,
    context: { transcript: voiceNote.transcript },
    citations,
  }));
  if (!aiResult.usedAi) {
    safetyFlags.push({
      severity: 'medium',
      code: 'TRANSCRIPT_FALLBACK_ONLY',
      message: 'SOAP draft derived from transcript alone (no AI model used). Reviewer must confirm all four sections.',
    });
  }

  const hasCritical = safetyFlags.some((flag) => flag.severity === 'critical');
  const usage = aiResult.usage || {};
  const generationRows = await prisma.$queryRawUnsafe(
    `INSERT INTO clinical_ai_generations
       (tenant_id, patient_uid, admission_id, task_type, module_key, provider, model,
        prompt_version, source_hash, status, used_ai, safety_flags, citations, draft,
        generated_by, prompt_tokens, completion_tokens, total_tokens, estimated_cost_minor,
        latency_ms, provider_request_id, finish_reason, metadata, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, $4, $5, $6, 'v1', $7, $8, $9, $10::jsonb,
             $11::jsonb, $12::jsonb, $13::uuid, $14, $15, $16, $17, $18, $19, $20,
             $21::jsonb, NOW(), NOW())
     RETURNING id, status, created_at`,
    tenantId,
    voiceNote.patient_uid,
    voiceNote.admission_id,
    MODULE_KEY,
    aiResult.provider || 'template',
    aiResult.model || null,
    sourceHash(voiceNote.transcript),
    hasCritical ? 'failed' : 'draft',
    Boolean(aiResult.usedAi),
    JSON.stringify(safetyFlags),
    JSON.stringify(citations),
    JSON.stringify(draft),
    req?.user?.uid || null,
    usage.prompt_tokens || 0,
    usage.completion_tokens || 0,
    usage.total_tokens || 0,
    aiResult.estimatedCostMinor ?? null,
    usage.latency_ms || null,
    usage.provider_request_id || null,
    usage.finish_reason || null,
    JSON.stringify({
      voice_note_id: voiceNote.id,
      stt_provider: voiceNote.stt_provider,
      stt_language: voiceNote.stt_language,
      defense_flag_codes: safetyFlags.map((flag) => flag.code),
      failure_reason: hasCritical
        ? (safetyFlags.find((flag) => flag.severity === 'critical')?.code || 'critical_defense_failure')
        : null,
    })
  );
  const generation = generationRows[0];

  // Review placeholder — doctor / nursing / med-records sign off.
  try {
    await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_reviews
         (tenant_id, generation_id, module_key, patient_uid, admission_id, decision, metadata, created_at, updated_at)
       VALUES ($1::uuid, $2, $3, $4::uuid, $5, 'pending', $6::jsonb, NOW(), NOW())`,
      tenantId,
      generation.id,
      MODULE_KEY,
      voiceNote.patient_uid,
      voiceNote.admission_id,
      JSON.stringify({
        review_roles: module.settings?.reviewRoles || ['DOCTOR'],
        source: 'voice_note',
        voice_note_id: voiceNote.id,
      })
    );
  } catch (err) {
    logger.warn('SOAP review placeholder insert failed', { voiceNoteId: voiceNote.id, error: err.message });
  }

  // Link voice note to its generation for traceability.
  await prisma.$queryRawUnsafe(
    `UPDATE clinical_voice_notes
     SET generation_id = $2, updated_at = NOW()
     WHERE id = $1 AND tenant_id = $3::uuid`,
    voiceNote.id,
    generation.id,
    tenantId
  );

  await publishEvent({
    eventType: 'clinical_voice_note.soap_generated',
    aggregateType: 'clinical_voice_note',
    aggregateId: voiceNote.id,
    patientUid: voiceNote.patient_uid,
    payload: {
      tenant_id: tenantId,
      generation_id: generation.id,
      used_ai: Boolean(aiResult.usedAi),
      blocked: hasCritical,
    },
  });

  return {
    draft,
    module_key: MODULE_KEY,
    prompt_version: 'v1',
    source_citations: citations,
    safety_flags: safetyFlags,
    ai_metadata: {
      provider: aiResult.provider || 'template',
      model: aiResult.model || null,
      used_ai: Boolean(aiResult.usedAi),
      fallback_reason: aiResult.usedAi ? null : (aiResult.reason || 'template_or_rule_output'),
      usage,
    },
    review_status: hasCritical ? 'failed' : 'pending',
    generation_id: generation.id,
    voice_note_id: voiceNote.id,
    requires_signoff: Boolean(module.settings?.requiresClinicianSignoff),
  };
}

export async function listVoiceNotes({ tenantId, recordedBy = null, limit = 50 } = {}) {
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, tenant_id, recorded_by, patient_uid, admission_id, audio_storage_key,
            audio_mime, audio_duration_seconds, stt_provider, stt_model, stt_language,
            transcript, transcript_status, transcript_failure_reason, generation_id,
            metadata, created_at, updated_at
     FROM clinical_voice_notes
     WHERE tenant_id = $1::uuid
       AND ($2::uuid IS NULL OR recorded_by = $2::uuid)
     ORDER BY created_at DESC
     LIMIT $3`,
    tenantId || DEFAULT_TENANT_ID,
    recordedBy,
    safeLimit
  );
  return { voice_notes: rows, count: rows.length };
}

export default {
  getVoiceCapturePolicy,
  createAndTranscribeVoiceNote,
  generateSoapDraftFromVoiceNote,
  listVoiceNotes,
};
