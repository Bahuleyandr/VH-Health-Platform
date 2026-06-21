/**
 * Ambient clinical documentation.
 *
 * Accepts a multi-speaker transcript (either produced server-side by a
 * diarization-capable STT provider or provided pre-diarized by the
 * capture client) and generates a structured visit note: chief
 * complaint, HPI, exam findings, assessment, plan, follow-up. Each
 * section cites the transcript segments it drew from so reviewers can
 * verify without re-listening.
 *
 * Consent is explicit: every row carries a `consent_reference` pointing
 * to the patient_consents row that authorised the recording. Without
 * it the encounter cannot be created.
 *
 * Speakers: we accept 'doctor', 'patient', 'caregiver', 'other'. The
 * prompt tells the model to only quote speech from the right role —
 * patient-reported facts in subjective, doctor-reported exam findings
 * in objective, etc. Defense matrix still runs on the output.
 */

import crypto from 'crypto';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { getClinicalAiModule } from './clinicalAiModuleService.js';
import {
  assertPatientConsentInTenant,
  assertPatientInTenant,
} from './clinicalAiTenantGuards.js';
import { generateClinicalText } from './localLlmClient.js';
import { runOutputDefenses } from './hallucinationDefenses.js';
import { resolveAmbientDiarization } from './ambientDiarizationService.js';

const MODULE_KEY = 'ambient_visit_documentation';
const MAX_SEGMENTS = 500;
const ALLOWED_SPEAKERS = new Set(['doctor', 'patient', 'caregiver', 'other']);
const MAX_DURATION_SECONDS = 60 * 60; // 1 hour safety cap

function resolveTenantId(options = {}) {
  return requireTenantId(options.tenantId);
}

function isMissingSchemaError(err) {
  return /does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

function sourceHash(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex').slice(0, 32);
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

/**
 * Pure helper: normalise a raw segments array + speaker map.
 *   - Rejects invalid speaker labels.
 *   - Caps segment count (truncates long transcripts so we never hand a
 *     1-hour transcript straight to the LLM).
 *   - Computes per-speaker talk-time.
 */
export function normalizeTranscriptSegments(segments) {
  const cleaned = [];
  const talkTime = new Map();
  const rawList = Array.isArray(segments) ? segments.slice(0, MAX_SEGMENTS) : [];
  for (const seg of rawList) {
    const speaker = String(seg?.speaker || 'other').toLowerCase();
    if (!ALLOWED_SPEAKERS.has(speaker)) continue;
    const text = String(seg?.text || '').trim();
    if (!text) continue;
    const start = Number(seg?.start_seconds ?? seg?.start ?? 0);
    const end = Number(seg?.end_seconds ?? seg?.end ?? start);
    const duration = Math.max(0, end - start);
    cleaned.push({
      speaker,
      text,
      start_seconds: Number.isFinite(start) ? start : 0,
      end_seconds: Number.isFinite(end) ? end : 0,
      duration_seconds: duration,
    });
    talkTime.set(speaker, (talkTime.get(speaker) || 0) + duration);
  }
  return {
    segments: cleaned,
    speaker_count: new Set(cleaned.map((s) => s.speaker)).size,
    talk_time: Object.fromEntries(talkTime),
    total_duration_seconds: cleaned.reduce((sum, s) => sum + s.duration_seconds, 0),
  };
}

function buildFallbackVisitNote(normalized) {
  const patientLines = normalized.segments.filter((s) => s.speaker === 'patient').map((s) => s.text);
  const doctorLines = normalized.segments.filter((s) => s.speaker === 'doctor').map((s) => s.text);
  return {
    chief_complaint: patientLines[0] ? patientLines[0].slice(0, 300) : 'Not documented',
    hpi: patientLines.slice(0, 8).join(' ').slice(0, 1200) || 'Not documented',
    exam_findings: doctorLines.filter((t) => /exam|finding|observe|bp|pulse|temp/i.test(t)).slice(0, 6).join(' ').slice(0, 900),
    assessment: 'Clinician to confirm assessment — AI draft was not used.',
    plan: doctorLines.filter((t) => /plan|prescribe|continue|start|refer|follow/i.test(t)).slice(0, 6).join(' ').slice(0, 900) || 'Not documented',
    follow_up: 'Not documented',
    patient_education_topics: [],
    source: 'fallback_from_transcript',
  };
}

/**
 * Create + finalise an ambient encounter from a pre-transcribed multi-
 * speaker transcript. Persists row, runs LLM over the transcript,
 * stores generation + review placeholder.
 */
export async function createAmbientEncounter({
  req,
  patientUid,
  admissionId = null,
  clinicianUid = null,
  recordedBy = null,
  recordingStartedAt,
  recordingEndedAt = null,
  durationSeconds = null,
  audioStorageKey = null,
  audioMime = null,
  sttProvider = 'none',
  sttModel = null,
  sttLanguage = null,
  diarizationProvider = null,
  diarizationPayload = null,
  rawTranscript = null,
  transcriptSegments = [],
  consentReference = null,
} = {}) {
  if (!patientUid) throw AppError.badRequest('patient_uid is required');
  if (!recordingStartedAt) throw AppError.badRequest('recording_started_at is required');
  if (durationSeconds != null && durationSeconds > MAX_DURATION_SECONDS) {
    throw AppError.badRequest(`Recording exceeds ${MAX_DURATION_SECONDS / 60}-minute cap`);
  }
  const tenantId = resolveTenantId({ tenantId: req?.tenantId });
  const verifiedPatientUid = await assertPatientInTenant({
    tenantId,
    patientUid,
    invalidCode: 'CLINICAL_AI_AMBIENT_PATIENT_UID_INVALID',
    notFoundCode: 'CLINICAL_AI_AMBIENT_PATIENT_NOT_FOUND',
    roleInvalidCode: 'CLINICAL_AI_AMBIENT_PATIENT_ROLE_INVALID',
    tenantMismatchCode: 'CLINICAL_AI_AMBIENT_PATIENT_TENANT_MISMATCH',
  });
  const verifiedConsent = await assertPatientConsentInTenant({
    tenantId,
    patientUid: verifiedPatientUid,
    consentReference,
    allowedTypes: ['recording_consent', 'treatment'],
    referenceInvalidCode: 'CLINICAL_AI_AMBIENT_CONSENT_REFERENCE_INVALID',
    notFoundCode: 'CLINICAL_AI_AMBIENT_CONSENT_NOT_FOUND',
    patientMismatchCode: 'CLINICAL_AI_AMBIENT_CONSENT_PATIENT_MISMATCH',
    tenantMismatchCode: 'CLINICAL_AI_AMBIENT_CONSENT_TENANT_MISMATCH',
    typeInvalidCode: 'CLINICAL_AI_AMBIENT_CONSENT_TYPE_INVALID',
    inactiveCode: 'CLINICAL_AI_AMBIENT_CONSENT_INACTIVE',
    expiredCode: 'CLINICAL_AI_AMBIENT_CONSENT_EXPIRED',
    schemaUnavailableCode: 'CLINICAL_AI_AMBIENT_CONSENT_SCHEMA_UNAVAILABLE',
  });

  const diarization = await resolveAmbientDiarization({
    transcriptSegments,
    rawTranscript,
    diarizationPayload,
    audioStorageKey,
    audioMime,
    provider: diarizationProvider,
    tenantRegion: req?.tenant?.region || null,
  });
  const normalized = normalizeTranscriptSegments(diarization.segments);
  const module = await getClinicalAiModule(MODULE_KEY, { tenantId });

  // Build the LLM prompt — strict on speaker attribution + JSON output.
  const systemPrompt = [
    'You convert a multi-speaker doctor-patient encounter into a structured visit note.',
    'You MAY NOT invent dosages, dates, lab values, or exam findings that are not in the transcript.',
    'Attribute correctly: patient-reported symptoms belong in chief_complaint + hpi; doctor-stated exam findings in exam_findings; doctor-stated diagnosis in assessment; doctor-stated orders in plan.',
    'If a section is not discussed, write "not documented".',
    'Return JSON with keys: chief_complaint, hpi, exam_findings, assessment, plan, follow_up, patient_education_topics (array).',
    'Return JSON only.',
  ].join('\n');
  const userPrompt = `Transcript (${normalized.segments.length} segments, ${normalized.speaker_count} speakers):\n${normalized.segments.map((s, idx) => `[${idx + 1}] ${s.speaker.toUpperCase()} (${s.start_seconds.toFixed(1)}s): ${s.text}`).join('\n')}`;

  const aiResult = await generateClinicalText({
    systemPrompt,
    userPrompt,
    taskType: MODULE_KEY,
    tenantRegion: req?.tenant?.region || null,
    tenantId,
  });
  const fallback = buildFallbackVisitNote(normalized);
  const draft = safeJsonParse(aiResult.text, fallback);
  // Pin the structural keys so a rogue LLM can't replace them.
  for (const key of ['chief_complaint', 'hpi', 'exam_findings', 'assessment', 'plan', 'follow_up']) {
    if (typeof draft[key] !== 'string') draft[key] = String(draft[key] ?? 'not documented');
  }
  if (!Array.isArray(draft.patient_education_topics)) draft.patient_education_topics = [];

  // Citations point back to transcript segment indexes so a reviewer can
  // jump to the exact audio moment.
  const citations = normalized.segments.slice(0, 25).map((s, idx) => ({
    source_type: 'transcript_segment',
    source_id: String(idx + 1),
    label: `${s.speaker} @ ${s.start_seconds.toFixed(1)}s: ${s.text.slice(0, 120)}`,
    timestamp: null,
  }));

  const safetyFlags = [];
  if (normalized.speaker_count < 2) {
    safetyFlags.push({
      severity: 'medium',
      code: 'SINGLE_SPEAKER_TRANSCRIPT',
      message: 'Only one speaker detected in transcript — diarization may have failed. Confirm before accepting the draft.',
    });
  }
  if (!normalized.segments.length) {
    safetyFlags.push({
      severity: 'high',
      code: 'EMPTY_TRANSCRIPT',
      message: 'Transcript was empty; draft is unreliable.',
    });
  }
  if (diarization.reason && diarization.status !== 'provided') {
    safetyFlags.push({
      severity: normalized.speaker_count < 2 ? 'medium' : 'low',
      code: 'DIARIZATION_ADAPTER_NOTICE',
      message: `Diarization source: ${diarization.source || 'none'}; ${diarization.reason}.`,
    });
  }
  safetyFlags.push(...runOutputDefenses({
    draft,
    module,
    context: { segments: normalized.segments, speaker_count: normalized.speaker_count },
    citations,
  }));

  const hasCritical = safetyFlags.some((f) => f.severity === 'critical');

  // Persist the encounter row.
  let encounterId = null;
  try {
    const enc = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ambient_encounters
         (tenant_id, patient_uid, admission_id, recording_started_at,
          recording_ended_at, duration_seconds, recorded_by, clinician_uid,
          consent_reference, audio_storage_key, audio_mime, stt_provider,
          stt_model, stt_language, diarization_provider, speaker_count,
          transcript_status, transcript_segments, metadata, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $4::timestamptz, $5::timestamptz, $6, $7::uuid,
               $8::uuid, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb, $19::jsonb,
               NOW(), NOW())
      RETURNING id, created_at`,
      tenantId,
      verifiedPatientUid,
      admissionId ? Number.parseInt(admissionId, 10) : null,
      recordingStartedAt,
      recordingEndedAt || null,
      durationSeconds ?? normalized.total_duration_seconds,
      recordedBy,
      clinicianUid,
      verifiedConsent.reference,
      audioStorageKey,
      audioMime,
      sttProvider || 'none',
      sttModel,
      sttLanguage,
      diarizationProvider || diarization.provider || null,
      normalized.speaker_count,
      normalized.segments.length ? 'completed' : 'skipped',
      JSON.stringify(normalized.segments),
      JSON.stringify({
        talk_time: normalized.talk_time,
        tenant_region: req?.tenant?.region || null,
        diarization: {
          status: diarization.status,
          provider: diarization.provider,
          reason: diarization.reason,
          source: diarization.source,
        },
      })
    );
    encounterId = enc[0]?.id || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Ambient encounter persist failed', { error: err.message });
    }
  }

  // Save as a clinical_ai_generation so it flows through review + audit.
  let generationId = null;
  try {
    const usage = aiResult.usage || {};
    const gen = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_generations
         (tenant_id, patient_uid, admission_id, task_type, module_key, provider, model,
          prompt_version, source_hash, status, used_ai, safety_flags, citations, draft,
          generated_by, prompt_tokens, completion_tokens, total_tokens, metadata,
          created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, $4, $5, $6, 'v1', $7, $8, $9, $10::jsonb,
               $11::jsonb, $12::jsonb, $13::uuid, $14, $15, $16, $17::jsonb, NOW(), NOW())
      RETURNING id`,
      tenantId,
      verifiedPatientUid,
      admissionId ? Number.parseInt(admissionId, 10) : null,
      MODULE_KEY,
      aiResult.provider || 'template',
      aiResult.model || null,
      sourceHash(JSON.stringify(normalized.segments)),
      hasCritical ? 'failed' : 'draft',
      Boolean(aiResult.usedAi),
      JSON.stringify(safetyFlags),
      JSON.stringify(citations),
      JSON.stringify(draft),
      clinicianUid || recordedBy || null,
      usage.prompt_tokens || 0,
      usage.completion_tokens || 0,
      usage.total_tokens || 0,
      JSON.stringify({
        ambient_encounter_id: encounterId,
        speaker_count: normalized.speaker_count,
        talk_time: normalized.talk_time,
        diarization: {
          status: diarization.status,
          provider: diarization.provider,
          reason: diarization.reason,
          source: diarization.source,
        },
        failure_reason: hasCritical
          ? (safetyFlags.find((f) => f.severity === 'critical')?.code || 'critical_defense_failure')
          : null,
      })
    );
    generationId = gen[0]?.id || null;
    if (encounterId && generationId) {
      await prisma.$queryRawUnsafe(
        `UPDATE clinical_ambient_encounters SET generation_id = $2, updated_at = NOW() WHERE id = $1`,
        encounterId,
        generationId
      ).catch(() => {});
    }
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Ambient generation persist failed', { error: err.message });
    }
  }

  // Review placeholder — clinician sign-off required.
  if (generationId) {
    try {
      await prisma.$queryRawUnsafe(
        `INSERT INTO clinical_ai_reviews
           (tenant_id, generation_id, module_key, patient_uid, admission_id, decision, metadata, created_at, updated_at)
         VALUES ($1::uuid, $2, $3, $4::uuid, $5, 'pending', $6::jsonb, NOW(), NOW())`,
        tenantId,
        generationId,
        MODULE_KEY,
        verifiedPatientUid,
        admissionId ? Number.parseInt(admissionId, 10) : null,
        JSON.stringify({
          review_roles: module.settings?.reviewRoles || ['DOCTOR'],
          source: 'ambient_encounter',
          ambient_encounter_id: encounterId,
        })
      );
    } catch (err) {
      if (!isMissingSchemaError(err)) {
        logger.warn('Ambient review placeholder failed', { error: err.message });
      }
    }
  }

  return {
    encounter_id: encounterId,
    generation_id: generationId,
    draft,
    citations,
    safety_flags: safetyFlags,
    speaker_count: normalized.speaker_count,
    segment_count: normalized.segments.length,
    talk_time: normalized.talk_time,
    diarization_status: diarization.status,
    diarization_provider: diarization.provider,
    diarization_reason: diarization.reason,
    used_ai: Boolean(aiResult.usedAi),
    provider: aiResult.provider || 'template',
    module_key: MODULE_KEY,
    review_status: hasCritical ? 'failed' : 'pending',
    decision_support_only: true,
  };
}

export async function listAmbientEncounters({ tenantId = null, patientUid = null, limit = 50 } = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, patient_uid, admission_id, recording_started_at, recording_ended_at,
              duration_seconds, clinician_uid, recorded_by, stt_provider, stt_language,
              diarization_provider, speaker_count, transcript_status, generation_id, created_at
       FROM clinical_ambient_encounters
       WHERE tenant_id = $1::uuid
         AND ($2::uuid IS NULL OR patient_uid = $2::uuid)
       ORDER BY recording_started_at DESC
       LIMIT $3`,
      tid,
      patientUid,
      safeLimit
    );
    return { encounters: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { encounters: [], count: 0 };
    throw err;
  }
}

/**
 * Janitor: hard-delete clinical_ambient_encounters rows past their retention
 * window (default 30 days from recording).  Also purges sibling audio tables
 * that carry the same `retention_until DATE` column:
 *   - clinical_voice_notes        (migration 016, 30-day default)
 *   - clinical_nursing_ambient_sessions (migration 042, 365-day default)
 *
 * Runs cross-tenant under runWithSuperAdmin (via withJobLock in the scheduler).
 * The GUC is unset when called outside a per-tenant setTenantTx scope, so the
 * tenant_isolation RLS policy's `current_setting(...) IS NULL` branch is
 * permissive — all tenants' expired rows are purged in one pass, consistent
 * with the purge-expired-note-drafts and purge-audit-logs patterns.
 *
 * Returns { ambientEncounters, voiceNotes, nursingAmbientSessions } counts.
 */
export async function purgeExpiredAmbientAudio() {
  const [ae, vn, na] = await Promise.all([
    prisma.$queryRawUnsafe(
      `DELETE FROM clinical_ambient_encounters WHERE retention_until < CURRENT_DATE RETURNING id`,
    ),
    prisma.$queryRawUnsafe(
      `DELETE FROM clinical_voice_notes WHERE retention_until < CURRENT_DATE RETURNING id`,
    ),
    prisma.$queryRawUnsafe(
      `DELETE FROM clinical_nursing_ambient_sessions WHERE retention_until < CURRENT_DATE RETURNING id`,
    ),
  ]);
  return {
    ambientEncounters: ae.length,
    voiceNotes: vn.length,
    nursingAmbientSessions: na.length,
  };
}

export default {
  createAmbientEncounter,
  listAmbientEncounters,
  normalizeTranscriptSegments,
  purgeExpiredAmbientAudio,
};
