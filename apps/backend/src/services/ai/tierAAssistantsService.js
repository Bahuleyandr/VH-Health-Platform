/**
 * Tier A "fastest wins" assistants — the 10 module wrappers from
 * docs/AI_FEATURE_GAP_BACKLOG.md "Tier A" section that weren't covered
 * by the patient-explainer batch shipped earlier.
 *
 * Each module reuses runExplainerPipeline (renamed to "draft pipeline"
 * conceptually — see comment in patientExplainersService.js). The module
 * varies only in:
 *   1. Which DB row(s) it reads to build the LLM context
 *   2. The system prompt
 *   3. The module_key tagging the persisted draft + review row
 *
 * Persistence + review queue are handled by the shared pipeline.
 *
 * Modules registered by migration 133:
 *   Patient-facing       lab_trend_summary, discharge_medication_explanation,
 *                        patient_faq_assistant, lab_pending_result_reminder
 *   Staff/operations     front_desk_assistant, audit_log_summary, call_summary,
 *                        handwritten_note_assistant, voice_to_prescription_draft,
 *                        pending_report_tracker
 *
 * Decision-support only — every output is gated by clinical_ai_reviews
 * before any patient sees it.
 */

import crypto from 'crypto';

import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { runExplainerPipeline } from './patientExplainersService.js';

const TEXT_INPUT_MAX = 12_000;

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

function maybeUuid(value, label = 'uid') {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw AppError.badRequest(`${label} must be a UUID`);
  }
  return text;
}

function requireText(value, label, { min = 1, max = TEXT_INPUT_MAX } = {}) {
  const text = String(value || '').trim();
  if (text.length < min) throw AppError.badRequest(`${label} must be at least ${min} characters`);
  return text.slice(0, max);
}

function normalizeInt(value, label, { min = null, max = null, fallback = null } = {}) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw AppError.badRequest(`${label} must be an integer`);
  if (min !== null && parsed < min) throw AppError.badRequest(`${label} must be >= ${min}`);
  if (max !== null && parsed > max) throw AppError.badRequest(`${label} must be <= ${max}`);
  return parsed;
}

function shortHash(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload || {})).digest('hex').slice(0, 16);
}

async function safeQuery(sql, params, fallback = []) {
  try {
    const rows = await prisma.$queryRawUnsafe(sql, ...params);
    return Array.isArray(rows) ? rows : fallback;
  } catch (err) {
    if (isMissingSchemaError(err)) return fallback;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 1. Lab trend summary — patient-facing
// ---------------------------------------------------------------------------

export async function generateLabTrendSummary({
  tenantId = null,
  patientUid,
  analyte,
  windowDays = 180,
  language = 'en',
  generatedBy = null,
  req = null,
} = {}) {
  const uid = maybeUuid(patientUid, 'patient_uid');
  if (!uid) throw AppError.badRequest('patient_uid is required');
  const cleanAnalyte = requireText(analyte, 'analyte', { min: 2, max: 120 });
  const days = normalizeInt(windowDays, 'window_days', { min: 7, max: 1825, fallback: 180 });

  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, test_name, status, requested_at, completed_at,
            result_value, result_unit, reference_range, abnormal_flag
     FROM investigations
     WHERE patient_uid = $1::uuid
       AND LOWER(test_name) = LOWER($2)
       AND completed_at IS NOT NULL
       AND completed_at >= NOW() - $3::int * INTERVAL '1 day'
     ORDER BY completed_at DESC
     LIMIT 50`,
    uid, cleanAnalyte, days,
  );
  if (!rows.length) {
    throw AppError.notFound(`No completed results for ${cleanAnalyte} in the last ${days} days`);
  }

  const citations = rows.slice(0, 10).map((r) => ({
    source_type: 'investigation',
    source_id: String(r.id),
    label: `${r.test_name} ${r.completed_at ? `(${new Date(r.completed_at).toISOString().slice(0,10)})` : ''}`.trim(),
    timestamp: r.completed_at,
  }));

  return runExplainerPipeline({
    moduleKey: 'lab_trend_summary',
    tenantId, patientUid: uid, admissionId: null,
    systemPrompt: [
      'You are a hospital patient-education writer. Summarise the patient\'s trend for a single analyte.',
      `Target language: ${language}.`,
      'Compare the most recent value to the prior values and to the reference range.',
      'Use plain language. State whether the trend is improving, stable, worsening, or mixed.',
      'Do NOT recommend dose changes or new medications. If the trend is concerning, prompt the patient to contact their doctor.',
    ].join('\n'),
    userPromptPayload: {
      analyte: cleanAnalyte,
      window_days: days,
      results_recent_first: rows.map((r) => ({
        completed_at: r.completed_at,
        value: r.result_value, unit: r.result_unit,
        reference_range: r.reference_range, abnormal_flag: r.abnormal_flag,
      })),
    },
    contextForDefenses: { lab_rows: rows },
    citations,
    metadata: { analyte: cleanAnalyte, window_days: days, language, sample_size: rows.length },
    generatedBy, req,
  });
}

// ---------------------------------------------------------------------------
// 2. Discharge medication explanation — patient-facing
// ---------------------------------------------------------------------------

export async function generateDischargeMedicationExplanation({
  tenantId = null,
  admissionId,
  language = 'en',
  generatedBy = null,
  req = null,
} = {}) {
  const admId = normalizeId(admissionId, 'admission_id');

  const admRows = await prisma.$queryRawUnsafe(
    `SELECT a.id, a.patient_uid, a.discharge_date, a.discharge_diagnosis
     FROM admissions a WHERE a.id = $1 LIMIT 1`,
    admId,
  );
  if (!admRows[0]) throw AppError.notFound('Admission not found');
  const admission = admRows[0];

  const meds = await safeQuery(
    `SELECT id, medication_name, dosage, frequency, duration, instructions, status
     FROM prescriptions
     WHERE patient_uid = $1::uuid AND admission_id = $2
     ORDER BY id DESC`,
    [admission.patient_uid, admId],
  );
  if (!meds.length) {
    throw AppError.notFound('No discharge prescriptions found for this admission');
  }

  const citations = meds.map((m) => ({
    source_type: 'prescription',
    source_id: String(m.id),
    label: `${m.medication_name} ${m.dosage || ''}`.trim(),
    timestamp: null,
  }));

  return runExplainerPipeline({
    moduleKey: 'discharge_medication_explanation',
    tenantId, patientUid: admission.patient_uid, admissionId: admId,
    systemPrompt: [
      'You are a hospital patient-education writer. Explain the discharge medication regimen to the patient in plain language.',
      `Target language: ${language}.`,
      'For each medication: what it is for (in lay terms), how to take it (timing, with/without food, full duration), common side effects vs side effects to call the doctor about, and red-flag symptoms (anaphylaxis, severe rash, confusion, bleeding).',
      'Quote dosing and duration verbatim. NEVER suggest stopping a medication; tell the patient to call the doctor if they want to stop.',
      'If the discharge_diagnosis suggests a particular drug-disease interaction, surface it gently.',
    ].join('\n'),
    userPromptPayload: {
      discharge_date: admission.discharge_date,
      discharge_diagnosis: admission.discharge_diagnosis,
      medications: meds.map((m) => ({
        name: m.medication_name, dosage: m.dosage, frequency: m.frequency,
        duration: m.duration, instructions: m.instructions,
      })),
    },
    contextForDefenses: { medications: meds, admission },
    citations,
    metadata: { admission_id: admId, language, medication_count: meds.length },
    generatedBy, req,
  });
}

// ---------------------------------------------------------------------------
// 3. Patient FAQ assistant — patient-facing, RAG against KB
// ---------------------------------------------------------------------------

async function retrieveKnowledgePassages({ tenantId, knowledgeBaseId, query, limit }) {
  // Phase A1 KB tables: knowledge_chunks. Read-only, best-effort.
  const filters = [`kb.tenant_id = $1::uuid`, `kc.is_active = true`];
  const params = [tenantId];
  if (knowledgeBaseId) {
    params.push(normalizeId(knowledgeBaseId, 'knowledge_base_id'));
    filters.push(`kb.id = $${params.length}`);
  }
  // Token-prefix match — the proper retrieval path uses pgvector embeddings,
  // but for the FAQ assistant we lean on lexical overlap (the FAQ corpus is
  // small + indexed enough that simple ts_rank works). Falls back to LIKE
  // if to_tsvector functions are absent.
  params.push(query);
  const tsParam = params.length;
  params.push(limit);
  const limitParam = params.length;
  return safeQuery(
    `SELECT kc.id, kc.knowledge_base_id, kc.document_id, kc.content,
            kb.title AS kb_title
     FROM knowledge_chunks kc
     JOIN knowledge_bases kb ON kb.id = kc.knowledge_base_id
     WHERE ${filters.join(' AND ')}
       AND (kc.content ILIKE '%' || $${tsParam} || '%')
     ORDER BY length(kc.content) ASC
     LIMIT $${limitParam}`,
    params, [],
  );
}

export async function generatePatientFaqAnswer({
  tenantId = null,
  query,
  knowledgeBaseId = null,
  language = 'en',
  generatedBy = null,
  req = null,
} = {}) {
  const tid = tenantId || '00000000-0000-4000-8000-000000000001';
  const cleanQuery = requireText(query, 'query', { min: 5, max: 500 });
  const passages = await retrieveKnowledgePassages({
    tenantId: tid, knowledgeBaseId, query: cleanQuery, limit: 6,
  });

  const citations = passages.map((p) => ({
    source_type: 'knowledge_chunk',
    source_id: String(p.id),
    label: `${p.kb_title || 'KB'} — chunk ${p.id}`,
    timestamp: null,
  }));

  return runExplainerPipeline({
    moduleKey: 'patient_faq_assistant',
    tenantId: tid, patientUid: null, admissionId: null,
    systemPrompt: [
      'You are a hospital patient-relations assistant. Answer patient FAQs using ONLY the supplied retrieved_passages.',
      `Target language: ${language}.`,
      'If the passages do not contain the answer, say so explicitly and suggest the patient call the front desk or their care team — DO NOT guess.',
      'NEVER provide clinical advice (diagnoses, dose changes, contraindications). Refer those questions to the doctor.',
      'Cite each passage you used by its source_id in source_citations.',
    ].join('\n'),
    userPromptPayload: {
      query: cleanQuery,
      retrieved_passages: passages.map((p) => ({
        chunk_id: p.id, kb_title: p.kb_title, content: String(p.content || '').slice(0, 1500),
      })),
    },
    contextForDefenses: { passages, query: cleanQuery },
    citations,
    metadata: { language, query_hash: shortHash(cleanQuery), passage_count: passages.length },
    generatedBy, req,
  });
}

// ---------------------------------------------------------------------------
// 4. Lab pending result reminder — patient-facing
// ---------------------------------------------------------------------------

export async function generateLabPendingReminder({
  tenantId = null,
  patientUid,
  language = 'en',
  generatedBy = null,
  req = null,
} = {}) {
  const uid = maybeUuid(patientUid, 'patient_uid');
  if (!uid) throw AppError.badRequest('patient_uid is required');

  const pending = await prisma.$queryRawUnsafe(
    `SELECT id, test_name, status, requested_at,
            EXTRACT(DAY FROM NOW() - requested_at)::int AS days_pending
     FROM investigations
     WHERE patient_uid = $1::uuid
       AND status IN ('ordered', 'in_progress', 'pending')
       AND requested_at <= NOW() - INTERVAL '2 days'
     ORDER BY requested_at ASC
     LIMIT 25`,
    uid,
  );
  if (!pending.length) {
    throw AppError.notFound('No pending labs older than 2 days for this patient');
  }

  const citations = pending.map((p) => ({
    source_type: 'investigation',
    source_id: String(p.id),
    label: `${p.test_name} (ordered ${p.requested_at ? new Date(p.requested_at).toISOString().slice(0,10) : '?'})`,
    timestamp: p.requested_at,
  }));

  return runExplainerPipeline({
    moduleKey: 'lab_pending_result_reminder',
    tenantId, patientUid: uid, admissionId: null,
    systemPrompt: [
      'You are a hospital patient-relations assistant. Draft a single-paragraph reminder for a patient about pending lab results.',
      `Target language: ${language}.`,
      'For each test, note when it was ordered and that it is still pending. Reassure but be clear about expected turnaround (most labs return within 1-3 days).',
      'Tell the patient how to escalate (call the lab front desk) if a result is overdue beyond 5 working days.',
      'Do NOT speculate about the eventual result.',
    ].join('\n'),
    userPromptPayload: {
      pending_tests: pending.map((p) => ({
        test_name: p.test_name, days_pending: Number(p.days_pending), status: p.status,
      })),
    },
    contextForDefenses: { pending },
    citations,
    metadata: { language, pending_count: pending.length },
    generatedBy, req,
  });
}

// ---------------------------------------------------------------------------
// 5. Front desk assistant — staff-facing, RAG against FAQ KB
// ---------------------------------------------------------------------------

export async function generateFrontDeskResponse({
  tenantId = null,
  query,
  knowledgeBaseId = null,
  language = 'en',
  generatedBy = null,
  req = null,
} = {}) {
  const tid = tenantId || '00000000-0000-4000-8000-000000000001';
  const cleanQuery = requireText(query, 'query', { min: 3, max: 500 });
  const passages = await retrieveKnowledgePassages({
    tenantId: tid, knowledgeBaseId, query: cleanQuery, limit: 6,
  });

  const citations = passages.map((p) => ({
    source_type: 'knowledge_chunk',
    source_id: String(p.id),
    label: `${p.kb_title || 'KB'} — chunk ${p.id}`,
    timestamp: null,
  }));

  return runExplainerPipeline({
    moduleKey: 'front_desk_assistant',
    tenantId: tid, patientUid: null, admissionId: null,
    systemPrompt: [
      'You are a hospital reception scripting assistant. Help front-desk staff draft an answer to a non-clinical visitor question (visiting hours, department location, document checklists, parking, billing intake).',
      `Target language: ${language}.`,
      'Use ONLY the retrieved_passages. If the question is clinical (symptoms, medication, dose), refuse: front desk does not give clinical advice.',
      'If the answer is not in the passages, recommend transferring to the relevant department.',
      'Keep the tone professional and concise.',
    ].join('\n'),
    userPromptPayload: {
      query: cleanQuery,
      retrieved_passages: passages.map((p) => ({
        chunk_id: p.id, kb_title: p.kb_title, content: String(p.content || '').slice(0, 1500),
      })),
    },
    contextForDefenses: { passages, query: cleanQuery },
    citations,
    metadata: { language, query_hash: shortHash(cleanQuery), passage_count: passages.length },
    generatedBy, req,
  });
}

// ---------------------------------------------------------------------------
// 6. Audit log summary — staff-facing, governance
// ---------------------------------------------------------------------------

export async function generateAuditLogSummary({
  tenantId = null,
  windowDays = 7,
  generatedBy = null,
  req = null,
} = {}) {
  const tid = tenantId || '00000000-0000-4000-8000-000000000001';
  const days = normalizeInt(windowDays, 'window_days', { min: 1, max: 90, fallback: 7 });

  const rows = await safeQuery(
    `SELECT method, path, module, status_code, COUNT(*)::int AS occurrences
     FROM audit_log
     WHERE created_at >= NOW() - $1::int * INTERVAL '1 day'
     GROUP BY method, path, module, status_code
     ORDER BY occurrences DESC
     LIMIT 50`,
    [days],
  );
  if (!rows.length) {
    throw AppError.notFound(`No audit_log activity in the last ${days} days`);
  }

  const errorRows = rows.filter((r) => Number(r.status_code) >= 500);
  const citations = rows.slice(0, 10).map((r) => ({
    source_type: 'audit_log_aggregate',
    source_id: shortHash({ m: r.method, p: r.path, s: r.status_code }),
    label: `${r.method} ${r.path} ${r.status_code} (×${r.occurrences})`,
    timestamp: null,
  }));

  return runExplainerPipeline({
    moduleKey: 'audit_log_summary',
    tenantId: tid, patientUid: null, admissionId: null,
    systemPrompt: [
      'You are a hospital governance analyst. Summarise the last window of audit_log activity.',
      'Surface: top error patterns (status_code >= 500), endpoints with unusual call volume, and any module that suddenly became hot.',
      'Do NOT include any patient-identifying data (none is in the supplied data; do not synthesise any).',
      'End with 2-3 specific recommendations (which paths to investigate, which alerts to add).',
    ].join('\n'),
    userPromptPayload: {
      window_days: days,
      total_calls: rows.reduce((s, r) => s + Number(r.occurrences), 0),
      error_calls: errorRows.reduce((s, r) => s + Number(r.occurrences), 0),
      top_patterns: rows.slice(0, 30),
      top_errors: errorRows.slice(0, 15),
    },
    contextForDefenses: { rows },
    citations,
    metadata: { window_days: days, distinct_patterns: rows.length, error_pattern_count: errorRows.length },
    generatedBy, req,
  });
}

// ---------------------------------------------------------------------------
// 7. Call summary — staff-facing
// ---------------------------------------------------------------------------

export async function generateCallSummary({
  tenantId = null,
  transcript,
  patientUid = null,
  callMetadata = null,
  language = 'en',
  generatedBy = null,
  req = null,
} = {}) {
  const cleanTranscript = requireText(transcript, 'transcript', { min: 50 });
  const uid = patientUid ? maybeUuid(patientUid, 'patient_uid') : null;

  const citations = [{
    source_type: 'call_transcript',
    source_id: shortHash(cleanTranscript),
    label: `Call transcript (${cleanTranscript.length} chars)`,
    timestamp: callMetadata?.started_at || null,
  }];

  return runExplainerPipeline({
    moduleKey: 'call_summary',
    tenantId, patientUid: uid, admissionId: null,
    systemPrompt: [
      'You are a hospital clinical scribe. Summarise a call transcript between a clinician/staff and a patient/caregiver.',
      `Target language: ${language}.`,
      'Extract: who spoke, the chief concern raised, decisions made, follow-up actions agreed (with assignee), patient questions left unanswered, and any escalation triggers (red-flag symptoms mentioned).',
      'Quote the transcript span when citing a specific decision.',
      'Do NOT add diagnoses or actions that were not discussed in the call.',
    ].join('\n'),
    userPromptPayload: {
      call_metadata: callMetadata,
      transcript: cleanTranscript,
    },
    contextForDefenses: { transcript: cleanTranscript },
    citations,
    metadata: { language, transcript_chars: cleanTranscript.length },
    generatedBy, req,
  });
}

// ---------------------------------------------------------------------------
// 8. Handwritten note assistant — staff-facing, OCR'd input
// ---------------------------------------------------------------------------

export async function generateHandwrittenNoteStructure({
  tenantId = null,
  ocrText,
  patientUid = null,
  admissionId = null,
  ocrConfidenceMap = null,
  generatedBy = null,
  req = null,
} = {}) {
  const cleanText = requireText(ocrText, 'ocr_text', { min: 30 });
  const uid = patientUid ? maybeUuid(patientUid, 'patient_uid') : null;
  const admId = admissionId ? normalizeId(admissionId, 'admission_id') : null;

  const citations = [{
    source_type: 'ocr_handwritten_note',
    source_id: shortHash(cleanText),
    label: `Handwritten note (${cleanText.length} chars OCR'd)`,
    timestamp: null,
  }];

  return runExplainerPipeline({
    moduleKey: 'handwritten_note_assistant',
    tenantId, patientUid: uid, admissionId: admId,
    systemPrompt: [
      'You are a clinical documentation assistant. Take OCR-extracted handwritten clinical notes and structure them into a draft (Subjective / Objective / Assessment / Plan).',
      'When the OCR text is illegible, low-confidence, or ambiguous, FLAG IT in safety_flags rather than guessing — the clinician will fill it in.',
      'Do NOT invent vital signs, diagnoses, drug names, or doses. Stay strictly within what the OCR text says.',
      'When ocr_confidence_map is provided and a span is below 0.6 confidence, surface that span verbatim with a [LOW_CONFIDENCE] marker.',
    ].join('\n'),
    userPromptPayload: {
      ocr_text: cleanText,
      ocr_confidence_map: ocrConfidenceMap,
    },
    contextForDefenses: { ocr_text: cleanText },
    citations,
    metadata: {
      ocr_chars: cleanText.length,
      has_confidence_map: Boolean(ocrConfidenceMap),
    },
    generatedBy, req,
  });
}

// ---------------------------------------------------------------------------
// 9. Voice-to-prescription draft — staff-facing
// ---------------------------------------------------------------------------

export async function generateVoiceToPrescriptionDraft({
  tenantId = null,
  transcript,
  patientUid = null,
  doctorUid = null,
  generatedBy = null,
  req = null,
} = {}) {
  const cleanTranscript = requireText(transcript, 'transcript', { min: 30 });
  const uid = patientUid ? maybeUuid(patientUid, 'patient_uid') : null;
  const docUid = doctorUid ? maybeUuid(doctorUid, 'doctor_uid') : null;

  const citations = [{
    source_type: 'voice_transcript',
    source_id: shortHash(cleanTranscript),
    label: `Doctor dictation (${cleanTranscript.length} chars)`,
    timestamp: null,
  }];

  return runExplainerPipeline({
    moduleKey: 'voice_to_prescription_draft',
    tenantId, patientUid: uid, admissionId: null,
    systemPrompt: [
      'You are a clinical documentation assistant. Draft a prescription from a doctor\'s dictated transcript.',
      'Output STRICT structure: medications array of { name, dosage, route, frequency, duration, instructions, transcript_span }.',
      'For EACH medication, the transcript_span MUST quote the exact dictated phrase. If you cannot identify a clear medication name + dose + frequency for an item, do not include it — flag it in safety_flags instead.',
      'Use SI units. Do NOT auto-fill dosing the doctor did not say. Do NOT add medications the doctor did not mention.',
      'This is a DRAFT — the doctor reviews + signs before any e-Rx is issued. Tag every output with the prominent reminder "DRAFT — clinician signoff required".',
    ].join('\n'),
    userPromptPayload: {
      doctor_uid: docUid,
      transcript: cleanTranscript,
    },
    contextForDefenses: { transcript: cleanTranscript },
    citations,
    metadata: { transcript_chars: cleanTranscript.length },
    generatedBy, req,
  });
}

// ---------------------------------------------------------------------------
// 10. Pending report tracker — staff-facing
// ---------------------------------------------------------------------------

export async function generatePendingReportTracker({
  tenantId = null,
  staleDays = 3,
  scope = 'all',
  generatedBy = null,
  req = null,
} = {}) {
  const tid = tenantId || '00000000-0000-4000-8000-000000000001';
  const days = normalizeInt(staleDays, 'stale_days', { min: 1, max: 30, fallback: 3 });
  const cleanScope = ['all', 'investigations', 'radiology'].includes(scope) ? scope : 'all';

  const investigations = (cleanScope === 'all' || cleanScope === 'investigations')
    ? await safeQuery(
        `SELECT id, test_name, status, requested_at,
                EXTRACT(DAY FROM NOW() - requested_at)::int AS days_pending
         FROM investigations
         WHERE status IN ('ordered', 'in_progress', 'pending')
           AND requested_at <= NOW() - $1::int * INTERVAL '1 day'
         ORDER BY requested_at ASC LIMIT 50`,
        [days],
      )
    : [];

  const radiology = (cleanScope === 'all' || cleanScope === 'radiology')
    ? await safeQuery(
        `SELECT id, modality, body_part, status, ordered_date,
                EXTRACT(DAY FROM NOW() - ordered_date)::int AS days_pending
         FROM radiology_orders
         WHERE status IN ('ordered', 'scheduled', 'in_progress', 'awaiting_report')
           AND ordered_date <= NOW() - $1::int * INTERVAL '1 day'
         ORDER BY ordered_date ASC LIMIT 50`,
        [days],
      )
    : [];

  const total = investigations.length + radiology.length;
  if (total === 0) {
    throw AppError.notFound(`No pending reports older than ${days} days`);
  }

  const citations = [
    ...investigations.slice(0, 5).map((r) => ({
      source_type: 'investigation', source_id: String(r.id),
      label: `${r.test_name} (ordered ${r.requested_at ? new Date(r.requested_at).toISOString().slice(0,10) : '?'})`,
      timestamp: r.requested_at,
    })),
    ...radiology.slice(0, 5).map((r) => ({
      source_type: 'radiology_order', source_id: String(r.id),
      label: `${r.modality || 'imaging'} ${r.body_part || ''} (ordered ${r.ordered_date ? new Date(r.ordered_date).toISOString().slice(0,10) : '?'})`,
      timestamp: r.ordered_date,
    })),
  ];

  return runExplainerPipeline({
    moduleKey: 'pending_report_tracker',
    tenantId: tid, patientUid: null, admissionId: null,
    systemPrompt: [
      'You are a hospital operations analyst. Summarise overdue diagnostic reports for the on-call coordinator.',
      'Group findings by (department / modality / test_name). Surface the longest-pending items first.',
      'Recommend 2-3 specific chase actions (e.g. "ping radiology head about MRI backlog", "audit lab vendor X turnaround").',
      'Do NOT include patient identifiers in the summary; the coordinator will look up specific cases via the citations.',
    ].join('\n'),
    userPromptPayload: {
      stale_days: days,
      scope: cleanScope,
      investigations_overdue: investigations.length,
      radiology_overdue: radiology.length,
      top_overdue_investigations: investigations.slice(0, 20).map((r) => ({
        test_name: r.test_name, days_pending: Number(r.days_pending), status: r.status,
      })),
      top_overdue_radiology: radiology.slice(0, 20).map((r) => ({
        modality: r.modality, body_part: r.body_part,
        days_pending: Number(r.days_pending), status: r.status,
      })),
    },
    contextForDefenses: { investigations, radiology },
    citations,
    metadata: { stale_days: days, scope: cleanScope, total_overdue: total },
    generatedBy, req,
  });
}

export const __testing__ = {
  retrieveKnowledgePassages,
  shortHash,
  isMissingSchemaError,
};

export default {
  generateLabTrendSummary,
  generateDischargeMedicationExplanation,
  generatePatientFaqAnswer,
  generateLabPendingReminder,
  generateFrontDeskResponse,
  generateAuditLogSummary,
  generateCallSummary,
  generateHandwrittenNoteStructure,
  generateVoiceToPrescriptionDraft,
  generatePendingReportTracker,
};
