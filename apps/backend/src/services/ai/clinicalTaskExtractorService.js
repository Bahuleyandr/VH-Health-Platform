/**
 * Clinical Task Extractor.
 *
 * Finds reviewable pending tasks from chart evidence. It never assigns work,
 * creates orders, sends notifications, or marks tasks complete.
 */

import crypto from 'crypto';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { collectAdmissionClinicalContext } from '../emr/clinicalTimelineService.js';
import { publishEvent } from '../events/eventOutboxService.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { getClinicalAiModule } from './clinicalAiModuleService.js';
import { runOutputDefenses } from './hallucinationDefenses.js';
import { generateClinicalText } from './localLlmClient.js';

const MODULE_KEY = 'clinical_task_extractor';
const DEFAULT_PROMPT = {
  version: 'v1',
  system_prompt: 'You extract reviewable hospital tasks from supplied chart evidence. Return JSON only.',
  user_prompt_template: 'Return task candidates only when grounded in source citations. Do not assign tasks.',
};

const TASK_ACTION_RE = /\b(repeat|recheck|follow(?:\s|-)?up|follow|arrange|schedule|book|call|consult|review|send|collect|monitor|remove|replace|change|start|stop|continue|check|ensure|prepare|obtain|trace|escalate|report|pending|ordered)\b/i;
const URGENT_RE = /\b(stat|urgent|asap|today|now|critical|sepsis|stroke|acs|desaturat|shock|code blue|culture|oxygen|spo2|fever)\b/i;
const SOON_RE = /\b(tomorrow|morning|evening|night|next shift|within 24|24h|48h|before discharge|prior to discharge)\b/i;
const ROUTINE_DECISIONS = new Set(['pending', 'accepted', 'rejected', 'deferred', 'completed']);
const PRIORITIES = new Set(['routine', 'soon', 'urgent', 'critical', 'unknown']);

function resolveTenantId(options = {}) {
  return requireTenantId(options.tenantId);
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

function optionalInt(value, fieldName = 'id') {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw AppError.badRequest(`${fieldName} must be a positive integer`);
  }
  return parsed;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i;

// Returns null for null/undefined/empty, throws AppError.badRequest for
// non-UUID strings, and the lowercase canonical form for valid UUIDs.
// Cheaper + clearer than letting `$N::uuid` blow up at the Postgres
// layer with a generic invalid-syntax error.
function optionalUuid(value, fieldName) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (!UUID_RE.test(text)) {
    throw AppError.badRequest(`${fieldName} must be a UUID`);
  }
  return text.toLowerCase();
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

function statusOf(event) {
  return cleanText(event?.payload?.status || event?.sub_type).toLowerCase();
}

function isPendingInvestigation(event) {
  const status = statusOf(event);
  return event?.event_type === 'investigation'
    && status
    && !['completed', 'reported', 'cancelled', 'canceled', 'resulted', 'done'].includes(status);
}

function isActiveOrder(event) {
  const status = statusOf(event);
  return event?.event_type === 'clinical_order'
    && ['ordered', 'active', 'pending', 'in_progress', 'verified'].includes(status);
}

function eventCitation(event, label = null) {
  if (!event) return null;
  return {
    source_type: event.event_type || 'chart',
    source_id: event.id === null || event.id === undefined ? null : String(event.id),
    label: label || event.summary || event.event_type || 'Chart evidence',
    timestamp: event.timestamp || event.payload?.created_at || null,
  };
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

function splitTaskSentences(text) {
  return cleanText(text)
    .split(/(?:[.;]\s+|\n+|(?:\s+-\s+))/)
    .map((item) => item.replace(/^[\s*\u2022\-\d.)]+/, '').replace(/[.]+$/, '').trim())
    .filter((item) => item.length >= 6 && item.length <= 360);
}

function payloadTextFragments(payload = {}) {
  if (!payload || typeof payload !== 'object') return [];
  const fields = [
    'summary',
    'assessment',
    'plan',
    'current_status',
    'notes',
    'content',
    'pending_tasks',
    'special_instructions',
    'medications_due',
    'details',
    'result_summary',
    'interpretation',
    'conclusion',
    'discharge_plan',
    'follow_up',
  ];
  return fields.flatMap((field) => {
    const value = payload[field];
    if (Array.isArray(value)) return value.map(cleanText).filter(Boolean);
    if (value && typeof value === 'object') return Object.values(value).map(cleanText).filter(Boolean);
    return cleanText(value) ? [cleanText(value)] : [];
  });
}

function eventTextFragments(event) {
  return [
    cleanText(event?.summary),
    ...payloadTextFragments(event?.payload || {}),
  ].filter(Boolean);
}

function titleFromSentence(sentence) {
  const text = cleanText(sentence).replace(/^(plan|todo|task|pending)\s*:\s*/i, '');
  if (text.length <= 82) return text;
  return `${text.slice(0, 79).trim()}...`;
}

function inferPriority(text, event = null) {
  const combined = `${text} ${event?.payload?.priority || ''} ${event?.payload?.status || ''}`;
  if (/\b(critical|stat|shock|code blue|stroke|acs|sepsis)\b/i.test(combined)) return 'critical';
  if (URGENT_RE.test(combined) || String(event?.payload?.priority || '').toLowerCase() === 'urgent') return 'urgent';
  if (SOON_RE.test(combined)) return 'soon';
  if (!cleanText(text)) return 'unknown';
  return 'routine';
}

function inferCategory(text, event = null) {
  const combined = `${text} ${event?.event_type || ''} ${event?.sub_type || ''}`.toLowerCase();
  if (/lab|cbc|culture|x-?ray|ct\b|mri|echo|ultrasound|usg|imaging|scan|report|investigation/.test(combined)) {
    return 'investigation';
  }
  if (/antibiotic|medication|medicine|drug|insulin|dose|iv\b|oral|pharmacy|mar\b/.test(combined)) {
    return 'medication';
  }
  if (/call family|family|caregiver|counsel|consent|relative/.test(combined)) {
    return 'family_communication';
  }
  if (/discharge|follow-?up|referral|summary|billing|insurance|claim/.test(combined)) {
    return 'discharge';
  }
  if (/wound|dressing|drain|catheter|line|iv line|mobility|fall|intake|output|nursing/.test(combined)) {
    return 'nursing_care';
  }
  if (/consult|refer|opinion|specialist/.test(combined)) return 'consult';
  if (/monitor|vital|oxygen|spo2|temperature|bp|heart rate|respiratory/.test(combined)) return 'monitoring';
  return 'follow_up';
}

function inferOwnerRole(text, category) {
  const combined = `${text} ${category}`.toLowerCase();
  if (/billing|insurance|claim/.test(combined)) return 'BILLING_STAFF';
  if (/pharmacy|stock|dispense|drug/.test(combined)) return 'PHARMACY_STAFF';
  if (/lab|sample|culture|cbc|report/.test(combined)) return 'LAB_STAFF';
  if (category === 'nursing_care' || /nurse|dressing|drain|catheter|vitals|mobility|fall/.test(combined)) {
    return 'NURSING_STAFF';
  }
  if (/summary|record|document|coding/.test(combined)) return 'MEDICAL_RECORDS';
  return 'DOCTOR';
}

function inferDueHint(text, priority) {
  const normalized = cleanText(text);
  const match = normalized.match(/\b(today|tomorrow|this morning|this evening|tonight|next shift|before discharge|within 24 hours|within 48 hours)\b/i);
  if (match) return match[0].toLowerCase();
  if (priority === 'critical') return 'immediate review';
  if (priority === 'urgent') return 'today';
  if (priority === 'soon') return 'next shift';
  return null;
}

function makeTaskCandidate(sentence, event, overrides = {}) {
  const priority = overrides.priority || inferPriority(sentence, event);
  const category = overrides.category || inferCategory(sentence, event);
  const citation = eventCitation(event, overrides.citationLabel || event?.summary || sentence);
  return {
    task_title: overrides.task_title || titleFromSentence(sentence),
    task_description: cleanText(overrides.task_description || sentence),
    category,
    priority,
    owner_role: overrides.owner_role || inferOwnerRole(sentence, category),
    due_hint: overrides.due_hint || inferDueHint(sentence, priority),
    source_event_type: event?.event_type || overrides.source_event_type || null,
    source_event_id: event?.id === null || event?.id === undefined ? overrides.source_event_id || null : String(event.id),
    source_citations: uniqueCitations([citation, ...asArray(overrides.source_citations)]),
    confidence: Number.isFinite(Number(overrides.confidence)) ? Number(overrides.confidence) : 0.7,
    metadata: {
      extraction: overrides.extraction || 'rules',
      source_scope: overrides.source_scope || 'admission',
    },
  };
}

function taskSignature(task) {
  return `${cleanText(task.task_title).toLowerCase()}|${task.category}|${task.source_event_type}|${task.source_event_id}`;
}

function mergeTaskCandidates(tasks) {
  const seen = new Set();
  return tasks.filter((task) => {
    if (!task?.task_title) return false;
    const key = taskSignature(task);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function extractRuleBasedTasksFromEvents(events = []) {
  const tasks = [];
  for (const event of asArray(events)) {
    if (isPendingInvestigation(event)) {
      tasks.push(makeTaskCandidate(
        `Follow up pending investigation: ${event.summary || event.payload?.test_name || 'investigation'}`,
        event,
        {
          category: 'investigation',
          priority: inferPriority(event.summary, event),
          owner_role: 'DOCTOR',
          due_hint: 'today',
          citationLabel: 'Pending investigation',
          extraction: 'pending_investigation_rule',
          confidence: 0.9,
        }
      ));
    }

    if (isActiveOrder(event)) {
      const category = inferCategory(event.summary, event);
      tasks.push(makeTaskCandidate(
        `Review active order: ${event.summary || event.payload?.order_type || 'clinical order'}`,
        event,
        {
          category,
          priority: inferPriority(event.summary, event),
          owner_role: inferOwnerRole(event.summary, category),
          citationLabel: 'Active clinical order',
          extraction: 'active_order_rule',
          confidence: 0.82,
        }
      ));
    }

    for (const fragment of eventTextFragments(event)) {
      for (const sentence of splitTaskSentences(fragment)) {
        if (!TASK_ACTION_RE.test(sentence)) continue;
        tasks.push(makeTaskCandidate(sentence, event));
      }
    }
  }
  return mergeTaskCandidates(tasks).slice(0, 80);
}

function normalizeTask(raw, defaultCitations = []) {
  if (!raw || typeof raw !== 'object') return null;
  const title = cleanText(raw.task_title || raw.title || raw.task || raw.summary);
  const description = cleanText(raw.task_description || raw.description || raw.note || title);
  if (!title && !description) return null;
  const priority = PRIORITIES.has(cleanText(raw.priority).toLowerCase())
    ? cleanText(raw.priority).toLowerCase()
    : inferPriority(`${title} ${description}`);
  const category = cleanText(raw.category) || inferCategory(`${title} ${description}`);
  const citations = uniqueCitations([
    ...asArray(raw.source_citations),
    ...asArray(raw.citations),
    ...defaultCitations,
  ]).slice(0, 6);
  return {
    task_title: title || titleFromSentence(description),
    task_description: description || title,
    category,
    priority,
    owner_role: cleanText(raw.owner_role || raw.ownerRole) || inferOwnerRole(`${title} ${description}`, category),
    due_hint: cleanText(raw.due_hint || raw.dueHint) || inferDueHint(`${title} ${description}`, priority),
    source_event_type: cleanText(raw.source_event_type) || citations[0]?.source_type || null,
    source_event_id: raw.source_event_id === undefined || raw.source_event_id === null
      ? citations[0]?.source_id || null
      : String(raw.source_event_id),
    source_citations: citations,
    confidence: Number.isFinite(Number(raw.confidence)) ? Number(raw.confidence) : 0.6,
    metadata: {
      extraction: raw.metadata?.extraction || 'ai',
      source_scope: raw.metadata?.source_scope || 'admission',
    },
  };
}

function normalizeAiTasks(parsed, fallbackTasks, packetCitations) {
  const parsedTasks = asArray(parsed?.tasks)
    .map((task) => normalizeTask(task, packetCitations.slice(0, 2)))
    .filter(Boolean);
  return mergeTaskCandidates([...fallbackTasks, ...parsedTasks]).slice(0, 80);
}

function buildTaskPacket(context) {
  const timeline = asArray(context.timeline).slice(-120).map((event) => ({
    id: event.id,
    event_type: event.event_type,
    sub_type: event.sub_type,
    summary: event.summary,
    timestamp: event.timestamp,
    status: event.payload?.status || event.sub_type || null,
    priority: event.payload?.priority || null,
  }));
  return {
    patient: {
      uid: context.patient?.uid || context.admission?.patient_uid || null,
      name: context.patient?.name || null,
    },
    admission: {
      id: context.admission?.id || null,
      status: context.admission?.status || null,
      ward: context.admission?.ward || null,
      bed_number: context.admission?.bed_number || null,
      chief_complaint: context.admission?.chief_complaint || null,
      admitting_diagnosis: context.admission?.admitting_diagnosis || null,
      admitted_at: context.admission?.admitted_at || context.admission?.created_at || null,
    },
    timeline,
    counts: {
      notes: asArray(context.notes).length,
      investigations: asArray(context.investigations).length,
      orders: asArray(context.orders).length,
      handovers: asArray(context.handovers).length,
    },
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
    aiResult?.estimatedCostMinor ?? null,
    usage.latency_ms || null,
    usage.provider_request_id || null,
    usage.finish_reason || null,
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
        source: 'clinical_task_extraction',
        requires_signoff: Boolean(module.settings?.requiresClinicianSignoff),
        no_auto_assign: true,
      })
    );
    return rows[0] || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Clinical task review placeholder failed', { error: err.message });
    }
    return null;
  }
}

async function insertTaskCandidates({ tenantId, admissionId, patientUid, generationId, tasks, safetyFlags }) {
  const inserted = [];
  for (const task of tasks) {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_task_candidates
         (tenant_id, patient_uid, admission_id, generation_id, source_scope,
          source_event_type, source_event_id, task_title, task_description,
          category, priority, owner_role, due_hint, source_citations,
          safety_flags, reviewer_decision, metadata, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, 'admission', $5, $6, $7, $8,
               $9, $10, $11, $12, $13::jsonb, $14::jsonb, 'pending',
               $15::jsonb, NOW(), NOW())
       RETURNING id, tenant_id, patient_uid, admission_id, generation_id,
                 source_scope, source_event_type, source_event_id, task_title,
                 task_description, category, priority, owner_role, due_hint,
                 source_citations, safety_flags, reviewer_decision, metadata,
                 created_at, updated_at`,
      tenantId,
      patientUid,
      admissionId,
      generationId,
      task.source_event_type || null,
      task.source_event_id || null,
      task.task_title,
      task.task_description || null,
      task.category || 'follow_up',
      PRIORITIES.has(task.priority) ? task.priority : 'routine',
      task.owner_role || null,
      task.due_hint || null,
      JSON.stringify(task.source_citations || []),
      JSON.stringify(safetyFlags || []),
      JSON.stringify({
        ...task.metadata,
        confidence: task.confidence,
        no_auto_assign: true,
      })
    );
    if (rows[0]) inserted.push(rows[0]);
  }
  return inserted;
}

export async function generateClinicalTaskExtraction({ req = null, admissionId } = {}) {
  const tenantId = resolveTenantId({ tenantId: req?.tenantId });
  const safeAdmissionId = optionalInt(admissionId, 'admission_id');
  const module = await getClinicalAiModule(MODULE_KEY, { tenantId });
  if (!module.enabled) {
    throw AppError.forbidden(`Clinical AI module is disabled: ${module.display_name}`);
  }

  const context = await collectAdmissionClinicalContext(safeAdmissionId, tenantId);
  const packet = buildTaskPacket(context);
  const fallbackTasks = extractRuleBasedTasksFromEvents(context.timeline);
  const prompt = await getActivePrompt(tenantId);
  const aiResult = await generateClinicalText({
    taskType: MODULE_KEY,
    systemPrompt: prompt.system_prompt,
    userPrompt: `${prompt.user_prompt_template}\n\n${JSON.stringify({
      chart_packet: packet,
      rule_based_tasks: fallbackTasks,
    })}`,
    tenantRegion: req?.tenant?.region || null,
    tenantId,
  });
  const parsed = safeJsonParse(aiResult.text, { tasks: [] });
  const packetCitations = uniqueCitations(context.citations || []);
  const tasks = normalizeAiTasks(parsed, fallbackTasks, packetCitations);
  const citations = uniqueCitations([
    ...tasks.flatMap((task) => asArray(task.source_citations)),
    ...asArray(parsed?.source_citations),
  ]);
  const draft = {
    tasks,
    summary: cleanText(parsed?.summary) || `${tasks.length} task candidate(s) require human review.`,
    source_citations: citations,
    safety_flags: asArray(parsed?.safety_flags),
    no_auto_assign: true,
  };
  const safetyFlags = [
    ...(tasks.length ? [] : [{
      severity: 'low',
      code: 'NO_TASKS_DETECTED',
      message: 'No pending task candidates were detected from the supplied chart packet.',
    }]),
    ...(tasks.some((task) => !asArray(task.source_citations).length) ? [{
      severity: 'high',
      code: 'TASK_WITHOUT_CITATION',
      message: 'At least one task candidate has no supporting citation.',
    }] : []),
    ...runOutputDefenses({
      draft,
      module,
      context: packet,
      citations,
    }),
  ];
  draft.safety_flags = safetyFlags;

  const generation = await insertGeneration({
    tenantId,
    admissionId: safeAdmissionId,
    patientUid: context.admission?.patient_uid || null,
    prompt,
    sourceHashValue: sourceHash({ admission_id: safeAdmissionId, packet, tasks }),
    draft,
    citations,
    safetyFlags,
    requestedBy: req?.user?.uid || null,
    aiResult,
    metadata: {
      admission_id: safeAdmissionId,
      tenant_region: req?.tenant?.region || null,
      task_count: tasks.length,
      fallback_reason: aiResult.usedAi ? null : aiResult.reason || 'template_or_rule_output',
      no_auto_assign: true,
    },
  });

  let taskRows = [];
  try {
    taskRows = await insertTaskCandidates({
      tenantId,
      admissionId: safeAdmissionId,
      patientUid: context.admission?.patient_uid || null,
      generationId: generation?.id || null,
      tasks,
      safetyFlags,
    });
  } catch (err) {
    if (isMissingSchemaError(err)) {
      return {
        generation_id: generation?.id || null,
        task_count: tasks.length,
        tasks,
        source_citations: citations,
        safety_flags: safetyFlags,
        module_key: MODULE_KEY,
        prompt_version: prompt.version || 'v1',
        review_status: 'schema_unavailable',
        reason: 'clinical_ai_task_candidates_unavailable',
        requires_signoff: Boolean(module.settings?.requiresClinicianSignoff),
        decision_support_only: true,
        no_auto_assign: true,
      };
    }
    throw err;
  }

  const review = await createReviewPlaceholder({
    tenantId,
    generationId: generation?.id || null,
    admissionId: safeAdmissionId,
    patientUid: context.admission?.patient_uid || null,
    module,
  });

  await publishEvent({
    eventType: 'clinical_ai.task_extraction_generated',
    aggregateType: 'clinical_ai_task_candidate',
    aggregateId: generation?.id || safeAdmissionId,
    patientUid: context.admission?.patient_uid || null,
    payload: {
      tenant_id: tenantId,
      admission_id: safeAdmissionId,
      generation_id: generation?.id || null,
      task_count: taskRows.length,
      priorities: taskRows.map((task) => task.priority),
      no_auto_assign: true,
    },
  });

  return {
    generation_id: generation?.id || null,
    review_id: review?.id || null,
    task_count: taskRows.length,
    tasks: taskRows,
    draft,
    source_citations: citations,
    safety_flags: safetyFlags,
    module_key: MODULE_KEY,
    prompt_version: prompt.version || 'v1',
    review_status: review?.decision || 'pending',
    requires_signoff: Boolean(module.settings?.requiresClinicianSignoff),
    ai_metadata: {
      provider: aiResult.provider || 'template',
      model: aiResult.model || null,
      used_ai: Boolean(aiResult.usedAi),
      usage: aiResult.usage || {},
    },
    decision_support_only: true,
    no_auto_assign: true,
  };
}

export async function listClinicalTaskCandidates({
  tenantId = null,
  admissionId = null,
  patientUid = null,
  decision = null,
  priority = null,
  ownerRole = null,
  limit = 50,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const aid = admissionId ? optionalInt(admissionId, 'admission_id') : null;
  const uid = optionalUuid(patientUid, 'patient_uid');
  const normalizedDecision = decision && ROUTINE_DECISIONS.has(cleanText(decision).toLowerCase())
    ? cleanText(decision).toLowerCase()
    : null;
  const normalizedPriority = priority && PRIORITIES.has(cleanText(priority).toLowerCase())
    ? cleanText(priority).toLowerCase()
    : null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT t.id, t.tenant_id, t.patient_uid, u.name AS patient_name,
              t.admission_id, t.generation_id, t.source_scope,
              t.source_event_type, t.source_event_id, t.task_title,
              t.task_description, t.category, t.priority, t.owner_role,
              t.due_hint, t.source_citations, t.safety_flags,
              t.reviewer_decision, t.reviewed_by, t.reviewed_at,
              t.reviewer_note, t.metadata, t.created_at, t.updated_at
       FROM clinical_ai_task_candidates t
       LEFT JOIN users u ON u.uid = t.patient_uid
       WHERE t.tenant_id = $1::uuid
         AND ($2::int IS NULL OR t.admission_id = $2)
         AND ($3::uuid IS NULL OR t.patient_uid = $3::uuid)
         AND ($4::text IS NULL OR t.reviewer_decision = $4)
         AND ($5::text IS NULL OR t.priority = $5)
         AND ($6::text IS NULL OR t.owner_role = $6)
       ORDER BY
         CASE t.priority
           WHEN 'critical' THEN 0
           WHEN 'urgent' THEN 1
           WHEN 'soon' THEN 2
           WHEN 'routine' THEN 3
           ELSE 4
         END,
         t.created_at DESC
       LIMIT $7`,
      tid,
      aid,
      uid,
      normalizedDecision,
      normalizedPriority,
      ownerRole || null,
      safeLimit
    );
    return { tasks: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { tasks: [], count: 0 };
    throw err;
  }
}

export async function decideClinicalTaskCandidate({
  tenantId = null,
  taskId,
  decision,
  reviewerUid = null,
  note = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const normalized = cleanText(decision).toLowerCase();
  if (!['accepted', 'rejected', 'deferred', 'completed'].includes(normalized)) {
    throw AppError.badRequest('decision must be accepted, rejected, deferred, or completed');
  }
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE clinical_ai_task_candidates
     SET reviewer_decision = $2,
         reviewed_by = $3::uuid,
         reviewed_at = NOW(),
         reviewer_note = $4,
         updated_at = NOW()
     WHERE id = $1
       AND tenant_id = $5::uuid
     RETURNING id, admission_id, patient_uid, generation_id, task_title,
               category, priority, owner_role, reviewer_decision,
               reviewed_by, reviewed_at, reviewer_note`,
    optionalInt(taskId, 'task_id'),
    normalized,
    reviewerUid,
    note,
    tid
  );
  if (!rows[0]) throw AppError.notFound('Clinical AI task candidate not found');

  // Results-inbox dormant AI bridge (design §4.7). When a reviewer ACCEPTS a
  // candidate, promote it into the deterministic results-inbox / escalation
  // safety net via the same producer (resourceType='task_candidate'). This is
  // post-decision, best-effort (Phase-1.5): promoteTaskCandidate never throws,
  // and we still swallow defensively so a promotion failure can never undo the
  // reviewer's decision. INERT in practice today — the clinical_task_extractor
  // module is disabled, so this path only fires once that module is enabled and
  // a candidate is accepted. Idempotent via the mig-312 open-task index.
  if (normalized === 'accepted') {
    try {
      // Lazy import keeps this dormant bridge out of the module's static import
      // graph (resultsInboxService → taskService), avoiding any import cycle and
      // any load cost on the hot extraction path.
      const { promoteTaskCandidate } = await import('../results/resultsInboxService.js');
      await promoteTaskCandidate(rows[0].id, { tenantId: tid });
    } catch (err) {
      logger.warn('decideClinicalTaskCandidate: results-inbox promotion failed', {
        candidateId: rows[0].id,
        err: err?.message,
      });
    }
  }
  return rows[0];
}

export default {
  decideClinicalTaskCandidate,
  extractRuleBasedTasksFromEvents,
  generateClinicalTaskExtraction,
  listClinicalTaskCandidates,
};
