// Clinician EHR Query — chart-grounded answers that separate the CURRENT
// ADMISSION from PRIOR HISTORY.
//
// This file currently hosts two pure-ish helpers (Task 1). The orchestration
// entrypoint `answerEhrQuery` and the route handler arrive in later tasks —
// leave room for them here.
//
// The clinical record is assembled by the existing EMR services
// (`services/emr/clinicalTimelineService.js`), so there is no embedding /
// vector store here — we reuse the canonical timeline.
//
// Timeline event shape (from getPatientTimeline / collectAdmissionClinicalContext):
//   { id, event_type, summary, timestamp, payload, ... }
// Note: real timeline events expose `event_type` (not `type`) and do NOT carry
// a per-event `citation`; citations are derived at the packet level via the
// timeline service's `makeCitation`. serializeEhrContext therefore reads the
// type slot as `event.type ?? event.event_type` and harvests any `event.citation`
// the caller chose to attach (the orchestrator in a later task is responsible
// for wiring real citations onto the events it passes in).

import prisma, { prismaReadOnly } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import logger from '../../logging/logger.js';
import {
  collectAdmissionClinicalContext,
  getPatientTimeline,
  makeCitation,
} from '../emr/clinicalTimelineService.js';
import { generateClinicalText } from './localLlmClient.js';
import { runOutputDefenses } from './hallucinationDefenses.js';
import { getClinicalAiModule } from './clinicalAiModuleService.js';

const CURRENT_ADMISSION_HEADER = '[CURRENT ADMISSION]';
const PRIOR_HISTORY_HEADER = '[PRIOR HISTORY]';

/**
 * Format a single timeline event as one context line:
 *   `- [<timestamp>] <type>: <summary>`
 * Tolerant of both the real event shape (`event_type`) and the lighter test
 * shape (`type`).
 */
function formatEventLine(event) {
  const timestamp = event?.timestamp ?? '';
  const type = event?.type ?? event?.event_type ?? '';
  const summary = event?.summary ?? '';
  return `- [${timestamp}] ${type}: ${summary}`;
}

/**
 * Serialize an assembled EHR context into a single labelled text block plus a
 * flat, ordered citation list.
 *
 * @param {object}   params
 * @param {object|null} params.currentAdmission - packet from
 *   collectAdmissionClinicalContext (has `.timeline`), or null for an
 *   outpatient with no active admission.
 * @param {Array<object>} [params.history] - prior-history timeline events.
 * @param {'both'|'current_admission'|'history'} [params.scope='both'] - which
 *   sections to emit.
 * @returns {{ text: string, citations: Array<object> }}
 */
function serializeEhrContext({ currentAdmission, history, scope = 'both' } = {}) {
  const sections = [];
  const citations = [];

  const admissionEvents = Array.isArray(currentAdmission?.timeline)
    ? currentAdmission.timeline
    : [];
  const historyEvents = Array.isArray(history) ? history : [];

  // CURRENT ADMISSION — emitted unless scope is history-only, and only when an
  // active admission packet is actually present (outpatients have none).
  if (scope !== 'history' && currentAdmission) {
    const lines = admissionEvents.map(formatEventLine);
    sections.push([CURRENT_ADMISSION_HEADER, ...lines].join('\n'));
    for (const event of admissionEvents) {
      if (event?.citation) citations.push(event.citation);
    }
  }

  // PRIOR HISTORY — emitted unless scope is current-admission-only.
  if (scope !== 'current_admission') {
    const lines = historyEvents.map(formatEventLine);
    sections.push([PRIOR_HISTORY_HEADER, ...lines].join('\n'));
    for (const event of historyEvents) {
      if (event?.citation) citations.push(event.citation);
    }
  }

  return { text: sections.join('\n\n'), citations };
}

/**
 * Resolve the patient's currently-active admission id within a tenant, or null
 * when the patient is not currently admitted (outpatient / discharged).
 *
 * Active condition (from src/migrations/000_baseline.sql admissions table):
 *   status = 'admitted' AND discharged_at IS NULL
 * Recency ordering: admitted_at DESC (NULLS LAST) — admitted_at is the
 * semantic admit timestamp; rows missing it fall to the back.
 *
 * @param {string} patientUid - patient uuid.
 * @param {string} tenantId   - tenant uuid.
 * @returns {Promise<number|null>}
 */
async function resolveCurrentAdmission(patientUid, tenantId) {
  const rows = await prismaReadOnly.$queryRawUnsafe(
    `SELECT id FROM admissions
       WHERE patient_uid = $1::uuid
         AND tenant_id = $2::uuid
         AND status = 'admitted'
         AND discharged_at IS NULL
       ORDER BY admitted_at DESC NULLS LAST
       LIMIT 1`,
    patientUid,
    tenantId,
  );
  return rows?.[0]?.id ?? null;
}

const MODULE_KEY = 'clinician_ehr_query';
const HISTORY_LOOKBACK_MS = 365 * 24 * 60 * 60 * 1000;
const HISTORY_LIMIT = 300;

const SYSTEM_PROMPT = [
  'You are answering a clinician\'s question using ONLY the provided patient record.',
  'Clearly attribute every finding to THIS ADMISSION vs PRIOR HISTORY.',
  'Cite the supporting events.',
  'If the record does not contain the answer, say so plainly — do not speculate.',
].join(' ');

/**
 * Answer a clinician's free-text question about a patient with a LIVE,
 * chart-grounded response that differentiates the CURRENT ADMISSION from PRIOR
 * HISTORY, attaches per-event citations, runs PHI-leak / hallucination defenses
 * (a CRITICAL flag suppresses the answer), and writes one audit row to
 * `clinical_ai_generations`. The asking clinician is the human-in-the-loop, so
 * there is no review queue.
 *
 * @param {object}  params
 * @param {string}  params.patientUid  - patient uuid (required).
 * @param {string}  params.question    - clinician's free-text question (required).
 * @param {'both'|'current_admission'|'history'} [params.scope='both']
 * @param {number|null} [params.admissionId=null] - pin a specific admission;
 *   otherwise the active admission is resolved (unless scope='history').
 * @param {string|null} [params.dateFrom=null] - history window lower bound (ISO).
 * @param {string|null} [params.dateTo=null]   - history window upper bound (ISO).
 * @param {object}  params.req - Express request (tenantId, tenant_region, user.uid).
 * @returns {Promise<{ answer: string|null, citations: Array<object>, scope: string,
 *   window: object, safety_flags: Array<object>, used_ai: boolean }>}
 */
async function answerEhrQuery({
  patientUid,
  question,
  scope = 'both',
  admissionId = null,
  dateFrom = null,
  dateTo = null,
  req,
} = {}) {
  if (!patientUid || !String(patientUid).trim()) {
    throw AppError.badRequest('patientUid is required', 'EHR_QUERY_PATIENT_REQUIRED');
  }
  if (!question || !String(question).trim()) {
    throw AppError.badRequest('question is required', 'EHR_QUERY_QUESTION_REQUIRED');
  }

  const tenantId = req?.tenantId;
  const generatedBy = req?.user?.uid ?? null;

  // Module gate (tenant-aware). The asking clinician is the reviewer, so a
  // disabled module is a hard stop rather than a degraded path.
  const module = await getClinicalAiModule(MODULE_KEY, { tenantId });
  if (!module?.enabled) {
    throw AppError.forbidden('clinician_ehr_query module is disabled', 'EHR_QUERY_MODULE_DISABLED');
  }

  // Resolve the active admission unless the caller scoped to history-only.
  const admId = admissionId
    || (scope !== 'history' ? await resolveCurrentAdmission(patientUid, tenantId) : null);

  // CURRENT ADMISSION packet — only when in-scope and an admission exists.
  const cur = (scope !== 'history' && admId)
    ? await collectAdmissionClinicalContext(admId)
    : null;

  // Attach the packet's own 1:1 citations onto its timeline events by zipping
  // the parallel arrays the EMR service returns (citations === timeline.map(makeCitation)).
  const currentAdmission = cur
    ? {
      admission: cur.admission,
      timeline: (Array.isArray(cur.timeline) ? cur.timeline : []).map((e, i) => ({
        ...e,
        citation: cur.citations?.[i],
      })),
    }
    : null;

  // PRIOR HISTORY window. Bound the upper edge to the current admission's
  // admit time so we don't double-count events the current section already shows.
  const histFrom = dateFrom || new Date(Date.now() - HISTORY_LOOKBACK_MS).toISOString();
  const histTo = dateTo || (cur?.admission?.admitted_at ?? null);

  const rawHistory = (scope !== 'current_admission')
    ? await getPatientTimeline(patientUid, { dateFrom: histFrom, dateTo: histTo, limit: HISTORY_LIMIT })
    : [];

  // History events carry no citation of their own; derive via the canonical
  // builder so provenance is consistent with the current-admission section.
  const history = (Array.isArray(rawHistory) ? rawHistory : []).map((e) => ({
    ...e,
    citation: makeCitation(e),
  }));

  // Serialize into the labelled prompt block + flat ordered citation list.
  const { text, citations } = serializeEhrContext({ currentAdmission, history, scope });

  // Generate the grounded answer.
  const aiResult = await generateClinicalText({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `${text}\n\nCLINICIAN QUESTION: ${question}`,
    taskType: MODULE_KEY,
    tenantId,
    tenantRegion: req?.tenant_region ?? null,
  });

  // Heuristic output defenses (PHI-leak / numeric / schema). A CRITICAL flag
  // (e.g. PHI_LEAK_SUSPECTED) suppresses the rendered answer; the row is still
  // audited with a null draft answer for traceability.
  const safetyFlags = runOutputDefenses({
    draft: { answer: aiResult.text },
    module,
    context: { text },
    citations,
  });
  const critical = Array.isArray(safetyFlags)
    && safetyFlags.some((flag) => flag?.severity === 'critical');

  const answer = critical ? null : aiResult.text;
  const window = {
    dateFrom: histFrom,
    dateTo: histTo,
    current_admission_id: admId,
    event_count: (currentAdmission?.timeline?.length || 0) + history.length,
  };

  // Audit row — mirrors clinicalAiWorkflowService.saveGeneration's column list.
  // jsonb params are JSON.stringify'd + ::jsonb cast; uuid params are ::uuid cast.
  try {
    const usage = aiResult.usage || {};
    await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_generations
         (tenant_id, patient_uid, admission_id, task_type, module_key, provider, model, prompt_version,
          source_hash, status, used_ai, safety_flags, citations, draft, generated_by,
          prompt_tokens, completion_tokens, total_tokens, estimated_cost_minor, latency_ms,
          provider_request_id, finish_reason, metadata, created_at, updated_at)
       VALUES
         ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb,
          $13::jsonb, $14::jsonb, $15::uuid, $16, $17, $18, $19, $20, $21, $22,
          $23::jsonb, NOW(), NOW())`,
      tenantId,
      patientUid,
      admId,
      MODULE_KEY,
      MODULE_KEY,
      aiResult.provider || 'template',
      aiResult.model || null,
      'v1',
      null,
      critical ? 'failed' : 'completed',
      Boolean(aiResult.usedAi),
      JSON.stringify(safetyFlags || []),
      JSON.stringify(citations || []),
      JSON.stringify({ answer }),
      generatedBy,
      usage.prompt_tokens || 0,
      usage.completion_tokens || 0,
      usage.total_tokens || 0,
      aiResult.estimatedCostMinor ?? null,
      usage.latency_ms || null,
      usage.provider_request_id || null,
      usage.finish_reason || null,
      JSON.stringify({
        question,
        scope,
        window: { dateFrom: histFrom, dateTo: histTo },
        admission_id: admId,
        tier: aiResult.tier || 'quick',
        generation_mode: aiResult.generation_mode || (aiResult.usedAi ? 'ai' : 'template_fallback'),
        provider_status: aiResult.provider_status || (aiResult.usedAi ? 'used' : 'template_fallback'),
        critical_suppressed: critical,
      }),
    );
  } catch (err) {
    // Audit failure must not drop the clinician's answer; log and continue.
    logger.warn('Clinician EHR query audit insert failed', {
      patient_uid: patientUid,
      admission_id: admId,
      error: err?.message,
    });
  }

  return {
    answer,
    citations,
    scope,
    window,
    safety_flags: safetyFlags,
    used_ai: aiResult.usedAi,
  };
}

export { serializeEhrContext, resolveCurrentAdmission, answerEhrQuery };

export const __testing__ = { serializeEhrContext, resolveCurrentAdmission };
