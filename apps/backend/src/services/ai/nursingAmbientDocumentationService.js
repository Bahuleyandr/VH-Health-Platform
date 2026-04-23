/**
 * Nursing Ambient Documentation.
 *
 * Bedside nursing shift documentation from a multi-speaker ambient
 * transcript. Extracts structured observations across wounds, drains,
 * IV lines, intake/output, mobility, falls, shift summary, handover,
 * and patient education. Outputs a clinician-reviewable draft that a
 * nurse/doctor signs off; never auto-charts or changes orders.
 */

import crypto from 'crypto';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { publishEvent } from '../events/eventOutboxService.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenantService.js';
import { getClinicalAiModule } from './clinicalAiModuleService.js';
import { runOutputDefenses } from './hallucinationDefenses.js';
import { generateClinicalText } from './localLlmClient.js';

const MODULE_KEY = 'nursing_ambient_documentation';
const MAX_SEGMENTS = 500;
const MAX_DURATION_SECONDS = 4 * 60 * 60;
const ALLOWED_SPEAKERS = new Set(['nurse', 'patient', 'caregiver', 'doctor', 'other']);
const ALLOWED_SHIFTS = new Set(['day', 'evening', 'night', 'custom']);
const DECISIONS = new Set(['pending', 'accepted', 'deferred', 'rejected', 'edited']);
const FINAL_DECISIONS = new Set(['accepted', 'deferred', 'rejected', 'edited']);
const DEFAULT_PROMPT = {
  version: 'v1',
  system_prompt: 'You produce structured nursing shift documentation from a multi-speaker transcript. Use only transcript content. Return JSON only.',
  user_prompt_template: 'Return nursing shift note draft. Every non-trivial observation must cite a transcript segment. Never change orders.',
};

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

function normalizeShift(value) {
  const normalized = normalizedText(value || 'day');
  return ALLOWED_SHIFTS.has(normalized) ? normalized : 'day';
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

export function normalizeNursingTranscript(segments) {
  const cleaned = [];
  const talkTime = new Map();
  const rawList = Array.isArray(segments) ? segments.slice(0, MAX_SEGMENTS) : [];
  rawList.forEach((segment, index) => {
    const rawSpeaker = cleanText(segment?.speaker || 'other').toLowerCase();
    const speaker = ALLOWED_SPEAKERS.has(rawSpeaker) ? rawSpeaker : 'other';
    const text = cleanText(segment?.text);
    if (!text) return;
    const start = Number(segment?.start_seconds ?? segment?.start ?? 0);
    const end = Number(segment?.end_seconds ?? segment?.end ?? start);
    const duration = Math.max(0, end - start);
    cleaned.push({
      segment_index: index + 1,
      speaker,
      text,
      start_seconds: Number.isFinite(start) ? start : 0,
      end_seconds: Number.isFinite(end) ? end : 0,
      duration_seconds: duration,
    });
    talkTime.set(speaker, (talkTime.get(speaker) || 0) + duration);
  });
  return {
    segments: cleaned,
    speaker_count: new Set(cleaned.map((s) => s.speaker)).size,
    talk_time: Object.fromEntries(talkTime),
    total_duration_seconds: cleaned.reduce((sum, segment) => sum + segment.duration_seconds, 0),
  };
}

function segmentCitation(segment) {
  return {
    source_type: 'transcript_segment',
    source_id: String(segment.segment_index),
    label: `${segment.speaker} @ ${segment.start_seconds.toFixed(1)}s: ${segment.text.slice(0, 140)}`,
    timestamp: null,
  };
}

function matchesKeyword(text, keywords) {
  const haystack = normalizedText(text);
  if (!haystack) return false;
  return keywords.some((keyword) => haystack.includes(keyword));
}

function firstNumericMatch(text, regex) {
  const match = String(text || '').match(regex);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

const WOUND_KEYWORDS = ['wound', 'dressing', 'suture', 'stitches', 'incision', 'pressure ulcer', 'bedsore', 'surgical site'];
const DRAIN_KEYWORDS = ['drain', 'jp drain', 'hemovac', 'chest tube', 'nasogastric', 'ng tube', 'ryles', 'foley'];
const IV_KEYWORDS = ['iv line', 'iv cannula', 'iv access', 'peripheral line', 'central line', 'picc', 'port', 'intravenous line'];
const INTAKE_OUTPUT_KEYWORDS = ['intake', 'output', 'urine output', 'ml in', 'ml out', 'fluid balance', 'i/o', 'i&o', 'i and o', 'drained', 'voided', 'micturition', 'urine bag'];
const MOBILITY_KEYWORDS = ['mobility', 'ambulation', 'ambulate', 'walked', 'bedrest', 'bed rest', 'assistance', 'wheelchair', 'walker', 'ot', 'physiotherapy', 'pt'];
const FALL_KEYWORDS = ['fall', 'fell', 'slipped', 'tripped', 'found on floor', 'fall risk'];
const HANDOVER_KEYWORDS = ['handover', 'shift change', 'reporting off', 'sign off', 'next shift', 'to the next nurse'];
const EDUCATION_KEYWORDS = ['educated', 'explained', 'teach-back', 'taught the patient', 'discussed with patient', 'informed the patient', 'family was told'];

function collectObservations(segments, keywords) {
  const matches = segments.filter((segment) => matchesKeyword(segment.text, keywords));
  return matches.map((segment) => ({
    description: segment.text,
    speaker: segment.speaker,
    start_seconds: segment.start_seconds,
    citation: segmentCitation(segment),
    segment_index: segment.segment_index,
  }));
}

function collectFalls(segments) {
  return collectObservations(segments, FALL_KEYWORDS).map((entry) => ({
    ...entry,
    severity: /injury|unresponsive|head|blood|hit/.test(normalizedText(entry.description)) ? 'high' : 'medium',
  }));
}

function collectIntakeOutput(segments) {
  const entries = [];
  for (const segment of segments) {
    const text = normalizedText(segment.text);
    if (!matchesKeyword(segment.text, INTAKE_OUTPUT_KEYWORDS)) continue;
    const intake = firstNumericMatch(text, /(\d+(?:\.\d+)?)\s*ml\s*in\b/)
      || firstNumericMatch(text, /intake[^\d]{0,12}(\d+(?:\.\d+)?)\s*ml/);
    const output = firstNumericMatch(text, /(\d+(?:\.\d+)?)\s*ml\s*out\b/)
      || firstNumericMatch(text, /output[^\d]{0,12}(\d+(?:\.\d+)?)\s*ml/)
      || firstNumericMatch(text, /urine[^\d]{0,12}(\d+(?:\.\d+)?)\s*ml/);
    entries.push({
      description: segment.text,
      speaker: segment.speaker,
      intake_ml: intake,
      output_ml: output,
      citation: segmentCitation(segment),
      segment_index: segment.segment_index,
    });
  }
  return entries;
}

function aggregateFluidBalance(entries) {
  let intake = 0;
  let output = 0;
  for (const entry of entries) {
    if (Number.isFinite(entry.intake_ml)) intake += entry.intake_ml;
    if (Number.isFinite(entry.output_ml)) output += entry.output_ml;
  }
  return {
    total_intake_ml: intake,
    total_output_ml: output,
    balance_ml: intake - output,
  };
}

export function extractNursingObservations(normalized) {
  const segments = asArray(normalized?.segments);
  const wounds = collectObservations(segments, WOUND_KEYWORDS);
  const drains = collectObservations(segments, DRAIN_KEYWORDS);
  const ivLines = collectObservations(segments, IV_KEYWORDS);
  const intakeOutputEntries = collectIntakeOutput(segments);
  const mobility = collectObservations(segments, MOBILITY_KEYWORDS);
  const falls = collectFalls(segments);
  const handover = collectObservations(segments, HANDOVER_KEYWORDS);
  const education = collectObservations(segments, EDUCATION_KEYWORDS);

  const nurseLines = segments.filter((segment) => segment.speaker === 'nurse').map((segment) => segment.text);
  const patientLines = segments.filter((segment) => segment.speaker === 'patient').map((segment) => segment.text);
  const shiftSummary = cleanText(nurseLines.slice(0, 4).join(' ')) || 'Shift activity not documented in transcript.';
  const patientComplaints = cleanText(patientLines.slice(0, 3).join(' ')) || '';

  return {
    shift_summary: shiftSummary,
    patient_reported: patientComplaints,
    wounds,
    drains,
    iv_lines: ivLines,
    intake_output: {
      entries: intakeOutputEntries,
      ...aggregateFluidBalance(intakeOutputEntries),
    },
    mobility,
    falls,
    handover_notes: handover,
    patient_education: education,
  };
}

function safetyFlagsFor({ normalized, observations }) {
  const flags = [];
  if (!normalized.segments.length) {
    flags.push({
      severity: 'high',
      code: 'NURSING_EMPTY_TRANSCRIPT',
      message: 'Transcript was empty; nursing draft is unreliable.',
    });
  }
  if (normalized.speaker_count < 2) {
    flags.push({
      severity: 'medium',
      code: 'NURSING_SINGLE_SPEAKER',
      message: 'Only one speaker detected; diarization may be missing.',
    });
  }
  if (observations.falls.some((fall) => fall.severity === 'high')) {
    flags.push({
      severity: 'critical',
      code: 'NURSING_FALL_WITH_INJURY',
      message: 'Possible fall with injury documented in transcript; clinician review required.',
    });
  } else if (observations.falls.length > 0) {
    flags.push({
      severity: 'high',
      code: 'NURSING_FALL_DETECTED',
      message: 'Fall event detected; confirm post-fall assessment and incident reporting.',
    });
  }
  if (!observations.wounds.length && !observations.drains.length && !observations.iv_lines.length
      && !observations.intake_output.entries.length && !observations.mobility.length) {
    flags.push({
      severity: 'medium',
      code: 'NURSING_SPARSE_OBSERVATIONS',
      message: 'No structured bedside observations detected; reviewer should confirm completeness.',
    });
  }
  return flags;
}

function buildFallbackDraft({ normalized, observations, shift }) {
  const citations = [
    ...observations.wounds.map((entry) => entry.citation),
    ...observations.drains.map((entry) => entry.citation),
    ...observations.iv_lines.map((entry) => entry.citation),
    ...observations.intake_output.entries.map((entry) => entry.citation),
    ...observations.mobility.map((entry) => entry.citation),
    ...observations.falls.map((entry) => entry.citation),
    ...observations.handover_notes.map((entry) => entry.citation),
    ...observations.patient_education.map((entry) => entry.citation),
    ...normalized.segments.slice(0, 6).map(segmentCitation),
  ];
  const uniqueCitations = [];
  const seen = new Set();
  for (const citation of citations) {
    const key = `${citation.source_type}:${citation.source_id}:${citation.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueCitations.push(citation);
  }
  return {
    shift,
    shift_summary: observations.shift_summary,
    patient_reported: observations.patient_reported,
    wounds: observations.wounds,
    drains: observations.drains,
    iv_lines: observations.iv_lines,
    intake_output: observations.intake_output,
    mobility: observations.mobility,
    falls: observations.falls,
    handover_notes: observations.handover_notes,
    patient_education: observations.patient_education,
    speaker_talk_time: normalized.talk_time,
    summary: `${observations.wounds.length} wound, ${observations.drains.length} drain, ${observations.iv_lines.length} IV, ${observations.mobility.length} mobility, ${observations.falls.length} fall, ${observations.intake_output.entries.length} I/O observation(s).`,
    source_citations: uniqueCitations,
    safety_flags: safetyFlagsFor({ normalized, observations }),
    rules_authoritative: true,
    decision_support_only: true,
  };
}

function normalizeAiSummary(parsed, fallbackDraft) {
  return {
    ...fallbackDraft,
    shift_summary: cleanText(parsed?.shift_summary) || fallbackDraft.shift_summary,
    summary: cleanText(parsed?.summary) || fallbackDraft.summary,
    safety_flags: [
      ...asArray(fallbackDraft.safety_flags),
      ...asArray(parsed?.safety_flags),
    ],
  };
}

async function verifyNursingConsent({ patientUid }) {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS active
       FROM patient_consents
       WHERE patient_uid = $1::uuid
         AND status = 'active'
         AND consent_type IN ('recording_consent', 'treatment')`,
      patientUid
    );
    if (Number(rows[0]?.active || 0) === 0) {
      throw AppError.forbidden('No active recording or treatment consent for nursing ambient capture');
    }
  } catch (err) {
    if (err?.statusCode === 403) throw err;
    if (!isMissingSchemaError(err)) {
      logger.warn('Nursing ambient consent check errored', { error: err.message });
    }
  }
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
        review_roles: module.settings?.reviewRoles || ['NURSING_STAFF', 'DOCTOR', 'MEDICAL_RECORDS'],
        source: 'nursing_ambient_documentation',
        requires_signoff: Boolean(module.settings?.requiresClinicianSignoff),
        rules_authoritative: true,
        decision_support_only: true,
      })
    );
    return rows[0] || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Nursing ambient review placeholder failed', { error: err.message });
    }
    return null;
  }
}

async function insertSessionRow({
  tenantId,
  patientUid,
  admissionId,
  nurseUid,
  shift,
  recordingStartedAt,
  recordingEndedAt,
  durationSeconds,
  consentReference,
  audioStorageKey,
  audioMime,
  sttProvider,
  sttModel,
  sttLanguage,
  diarizationProvider,
  speakerCount,
  transcriptStatus,
  segments,
  draft,
  citations,
  safetyFlags,
  generationId,
  metadata,
}) {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_nursing_ambient_sessions
         (tenant_id, patient_uid, admission_id, nurse_uid, shift,
          recording_started_at, recording_ended_at, duration_seconds,
          consent_reference, audio_storage_key, audio_mime, stt_provider,
          stt_model, stt_language, diarization_provider, speaker_count,
          transcript_status, transcript_segments, nursing_note_draft,
          generation_id, source_citations, safety_flags, reviewer_decision,
          metadata, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6::timestamptz,
               $7::timestamptz, $8, $9, $10, $11, $12, $13, $14, $15, $16,
               $17, $18::jsonb, $19::jsonb, $20, $21::jsonb, $22::jsonb,
               'pending', $23::jsonb, NOW(), NOW())
       RETURNING id, tenant_id, patient_uid, admission_id, nurse_uid, shift,
                 recording_started_at, recording_ended_at, duration_seconds,
                 consent_reference, speaker_count, transcript_status,
                 transcript_segments, nursing_note_draft, generation_id,
                 source_citations, safety_flags, reviewer_decision,
                 reviewed_by, reviewed_at, reviewer_note, metadata,
                 created_at, updated_at`,
      tenantId,
      patientUid,
      admissionId,
      nurseUid,
      shift,
      recordingStartedAt,
      recordingEndedAt,
      durationSeconds,
      consentReference,
      audioStorageKey,
      audioMime,
      sttProvider || 'none',
      sttModel,
      sttLanguage,
      diarizationProvider,
      speakerCount,
      transcriptStatus,
      JSON.stringify(segments),
      JSON.stringify(draft),
      generationId,
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

export async function generateNursingAmbientSession({
  req = null,
  patientUid,
  admissionId = null,
  nurseUid = null,
  shift = 'day',
  recordingStartedAt = null,
  recordingEndedAt = null,
  durationSeconds = null,
  consentReference = null,
  audioStorageKey = null,
  audioMime = null,
  sttProvider = 'none',
  sttModel = null,
  sttLanguage = null,
  diarizationProvider = null,
  transcriptSegments = [],
} = {}) {
  if (!patientUid) throw AppError.badRequest('patient_uid is required');
  const tenantId = resolveTenantId({ tenantId: req?.tenantId });
  const module = await getClinicalAiModule(MODULE_KEY, { tenantId });
  if (!module.enabled) {
    throw AppError.forbidden(`Clinical AI module is disabled: ${module.display_name}`);
  }

  const resolvedShift = normalizeShift(shift);
  const safeAdmissionId = optionalIntOrNull(admissionId);
  const startedAt = recordingStartedAt ? new Date(recordingStartedAt) : new Date();
  if (Number.isNaN(startedAt.getTime())) {
    throw AppError.badRequest('recording_started_at must be a valid timestamp');
  }
  const endedAt = recordingEndedAt ? new Date(recordingEndedAt) : null;
  if (endedAt && Number.isNaN(endedAt.getTime())) {
    throw AppError.badRequest('recording_ended_at must be a valid timestamp');
  }
  if (durationSeconds !== null && durationSeconds !== undefined && Number(durationSeconds) > MAX_DURATION_SECONDS) {
    throw AppError.badRequest(`Recording exceeds ${MAX_DURATION_SECONDS / 60}-minute cap`);
  }

  await verifyNursingConsent({ patientUid });

  const normalized = normalizeNursingTranscript(transcriptSegments);
  const observations = extractNursingObservations(normalized);
  const fallbackDraft = buildFallbackDraft({
    normalized,
    observations,
    shift: resolvedShift,
  });

  const prompt = await getActivePrompt(tenantId);
  const aiResult = await generateClinicalText({
    taskType: MODULE_KEY,
    systemPrompt: prompt.system_prompt,
    userPrompt: `${prompt.user_prompt_template}\n\n${JSON.stringify({
      shift: resolvedShift,
      transcript: normalized.segments.slice(0, 120),
      rule_based_observations: fallbackDraft,
    })}`,
    tenantRegion: req?.tenant?.region || null,
  });
  const parsed = safeJsonParse(aiResult.text, {});
  const draft = normalizeAiSummary(parsed, fallbackDraft);
  const citations = asArray(draft.source_citations);
  const safetyFlags = [
    ...asArray(draft.safety_flags),
    ...runOutputDefenses({
      draft,
      module,
      context: { segments: normalized.segments },
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
      shift: resolvedShift,
      segments: normalized.segments,
    }),
    draft,
    citations,
    safetyFlags,
    requestedBy: nurseUid || req?.user?.uid || null,
    aiResult,
    metadata: {
      admission_id: safeAdmissionId,
      shift: resolvedShift,
      speaker_count: normalized.speaker_count,
      talk_time: normalized.talk_time,
      fallback_reason: aiResult.usedAi ? null : aiResult.reason || 'template_or_rule_output',
      rules_authoritative: true,
    },
  });

  const sessionRow = await insertSessionRow({
    tenantId,
    patientUid,
    admissionId: safeAdmissionId,
    nurseUid: nurseUid || req?.user?.uid || null,
    shift: resolvedShift,
    recordingStartedAt: startedAt.toISOString(),
    recordingEndedAt: endedAt ? endedAt.toISOString() : null,
    durationSeconds: durationSeconds ?? normalized.total_duration_seconds,
    consentReference,
    audioStorageKey,
    audioMime,
    sttProvider,
    sttModel,
    sttLanguage,
    diarizationProvider,
    speakerCount: normalized.speaker_count,
    transcriptStatus: normalized.segments.length ? 'completed' : 'skipped',
    segments: normalized.segments,
    draft,
    citations,
    safetyFlags,
    generationId: generation?.id || null,
    metadata: {
      used_ai: Boolean(aiResult.usedAi),
      provider: aiResult.provider || 'template',
      model: aiResult.model || null,
      talk_time: normalized.talk_time,
      rules_authoritative: true,
    },
  });
  if (!sessionRow) {
    return {
      session_id: null,
      generation_id: generation?.id || null,
      draft,
      source_citations: citations,
      safety_flags: safetyFlags,
      module_key: MODULE_KEY,
      prompt_version: prompt.version || 'v1',
      session_status: 'schema_unavailable',
      reason: 'clinical_nursing_ambient_sessions_unavailable',
      requires_signoff: Boolean(module.settings?.requiresClinicianSignoff),
      decision_support_only: true,
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
    eventType: 'clinical_ai.nursing_ambient_session_generated',
    aggregateType: 'clinical_nursing_ambient_session',
    aggregateId: sessionRow.id,
    patientUid,
    payload: {
      tenant_id: tenantId,
      admission_id: safeAdmissionId,
      session_id: sessionRow.id,
      generation_id: generation?.id || null,
      shift: resolvedShift,
      speaker_count: normalized.speaker_count,
      fall_count: observations.falls.length,
      wound_count: observations.wounds.length,
    },
  });

  return {
    session_id: sessionRow.id,
    generation_id: generation?.id || null,
    clinical_review_id: clinicalReview?.id || null,
    draft,
    session: sessionRow,
    source_citations: citations,
    safety_flags: safetyFlags,
    module_key: MODULE_KEY,
    prompt_version: prompt.version || 'v1',
    session_status: sessionRow.reviewer_decision || 'pending',
    review_status: clinicalReview?.decision || sessionRow.reviewer_decision || 'pending',
    requires_signoff: Boolean(module.settings?.requiresClinicianSignoff),
    ai_metadata: {
      provider: aiResult.provider || 'template',
      model: aiResult.model || null,
      used_ai: Boolean(aiResult.usedAi),
      usage: aiResult.usage || {},
    },
    rules_authoritative: true,
    decision_support_only: true,
    shift: resolvedShift,
  };
}

export async function listNursingAmbientSessions({
  tenantId = null,
  patientUid = null,
  admissionId = null,
  shift = null,
  decision = null,
  limit = 50,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const aid = admissionId ? optionalInt(admissionId, 'admission_id') : null;
  const normalizedDecision = decision && DECISIONS.has(cleanText(decision).toLowerCase())
    ? cleanText(decision).toLowerCase()
    : null;
  const normalizedShift = shift && ALLOWED_SHIFTS.has(cleanText(shift).toLowerCase())
    ? cleanText(shift).toLowerCase()
    : null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT s.id, s.tenant_id, s.patient_uid, u.name AS patient_name,
              s.admission_id, s.nurse_uid, s.shift,
              s.recording_started_at, s.recording_ended_at, s.duration_seconds,
              s.speaker_count, s.transcript_status, s.nursing_note_draft,
              s.generation_id, s.source_citations, s.safety_flags,
              s.reviewer_decision, s.reviewed_by, s.reviewed_at, s.reviewer_note,
              s.metadata, s.created_at, s.updated_at
       FROM clinical_nursing_ambient_sessions s
       LEFT JOIN users u ON u.uid = s.patient_uid
       WHERE s.tenant_id = $1::uuid
         AND ($2::int IS NULL OR s.admission_id = $2)
         AND ($3::uuid IS NULL OR s.patient_uid = $3::uuid)
         AND ($4::text IS NULL OR s.shift = $4)
         AND ($5::text IS NULL OR s.reviewer_decision = $5)
       ORDER BY s.created_at DESC
       LIMIT $6`,
      tid,
      aid,
      patientUid || null,
      normalizedShift,
      normalizedDecision,
      safeLimit
    );
    return { sessions: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { sessions: [], count: 0 };
    throw err;
  }
}

export async function decideNursingAmbientSession({
  tenantId = null,
  sessionId,
  decision,
  reviewerUid = null,
  note = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const normalized = cleanText(decision).toLowerCase();
  if (!FINAL_DECISIONS.has(normalized)) {
    throw AppError.badRequest('decision must be accepted, deferred, rejected, or edited');
  }
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE clinical_nursing_ambient_sessions
     SET reviewer_decision = $2,
         reviewed_by = $3::uuid,
         reviewed_at = NOW(),
         reviewer_note = $4,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $5::uuid
     RETURNING id, admission_id, patient_uid, generation_id, shift,
               reviewer_decision, reviewed_by, reviewed_at, reviewer_note`,
    optionalInt(sessionId, 'session_id'),
    normalized,
    reviewerUid,
    note,
    tid
  );
  if (!rows[0]) throw AppError.notFound('Nursing ambient session not found');
  return rows[0];
}

export default {
  decideNursingAmbientSession,
  extractNursingObservations,
  generateNursingAmbientSession,
  listNursingAmbientSessions,
  normalizeNursingTranscript,
};
