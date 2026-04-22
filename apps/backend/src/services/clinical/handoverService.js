// src/services/clinical/handoverService.js
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { generateClinicalText } from '../ai/localLlmClient.js';
import { publishEvent } from '../events/eventOutboxService.js';
import { getPatientTimeline } from '../emr/clinicalTimelineService.js';
import { AppError } from '../../utils/AppError.js';
import { emitHandover } from '../../utils/websocket/realtimeEmitter.js';

// ===================================================================
// Nurse Handover Service
// ===================================================================

const VALID_SHIFTS = ['morning', 'afternoon', 'night'];
const HANDOVER_PROMPT_VERSION = 'handover-doc-v1';

function recent(events, type, count = 5) {
  return events.filter((event) => event.event_type === type).slice(0, count);
}

function buildHandoverFallback(patientUid, timeline) {
  const latestVitals = recent(timeline, 'vitals', 1)[0];
  const activeMeds = recent(timeline, 'medication', 8)
    .filter((event) => /scheduled|held|administered/i.test(String(event.sub_type || '')));
  const pendingInvestigations = recent(timeline, 'investigation', 8)
    .filter((event) => /pending|requested|ordered/i.test(String(event.sub_type || '')));
  const diagnoses = recent(timeline, 'diagnosis', 5).map((event) => event.summary);
  const notes = recent(timeline, 'clinical_note', 5).map((event) => event.summary);

  return {
    patient_uid: patientUid,
    patient_summary: [
      diagnoses.length ? `Problems: ${diagnoses.join('; ')}.` : 'Problems: not documented.',
      notes.length ? `Recent notes: ${notes.join(' ')}` : 'Recent notes: not documented.',
      latestVitals ? `Latest vitals: ${latestVitals.summary}.` : 'Latest vitals: not documented.',
    ].join('\n'),
    active_issues: [
      ...pendingInvestigations.map((event) => `Pending investigation: ${event.summary}`),
      ...(latestVitals && /high|medium|low spo2/i.test(`${latestVitals.summary} ${latestVitals.payload?.clinical_risk || ''}`)
        ? [`Review vitals risk: ${latestVitals.summary}`]
        : []),
    ],
    pending_tasks: pendingInvestigations.map((event) => `Follow up ${event.summary}`),
    medications_due: activeMeds.map((event) => event.summary),
    special_instructions: 'Review allergies, code status, pending orders, and escalation plan before accepting handover.',
  };
}

async function saveHandoverAiGeneration(patientUid, draft, requestedBy, tenantId) {
  const metadata = {
    fallback_reason: draft.ai_metadata?.fallback_reason || null,
    usage: {
      prompt_tokens: draft.ai_metadata?.prompt_tokens || 0,
      completion_tokens: draft.ai_metadata?.completion_tokens || 0,
      total_tokens: draft.ai_metadata?.total_tokens || 0,
    },
  };
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO clinical_ai_generations
       (tenant_id, patient_uid, task_type, module_key, provider, model, prompt_version,
        status, used_ai, safety_flags, citations, draft, generated_by,
        prompt_tokens, completion_tokens, total_tokens, estimated_cost_minor,
        latency_ms, provider_request_id, finish_reason, metadata, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, 'handover_summary', $3, $4, $5, $6,
             'draft', $7, '[]'::jsonb, $8::jsonb, $9::jsonb, $10::uuid,
             $11, $12, $13, $14, $15, $16, $17, $18::jsonb, NOW(), NOW())
     RETURNING id`,
    tenantId || '00000000-0000-4000-8000-000000000001',
    patientUid,
    draft.ai_metadata?.module_key || 'handover_summary',
    draft.ai_metadata?.provider || 'template',
    draft.ai_metadata?.model || null,
    HANDOVER_PROMPT_VERSION,
    Boolean(draft.ai_metadata?.used_ai),
    JSON.stringify(draft.source_citations || []),
    JSON.stringify(draft),
    requestedBy || null,
    draft.ai_metadata?.prompt_tokens || 0,
    draft.ai_metadata?.completion_tokens || 0,
    draft.ai_metadata?.total_tokens || 0,
    draft.ai_metadata?.estimated_cost_minor || null,
    draft.ai_metadata?.latency_ms || null,
    draft.ai_metadata?.provider_request_id || null,
    draft.ai_metadata?.finish_reason || null,
    JSON.stringify(metadata)
  );
  return rows[0]?.id || null;
}

export async function generateHandoverDraft(patientUid, requestedBy, tenantId = null) {
  if (!patientUid) throw AppError.badRequest('patientUid is required');

  const timeline = await getPatientTimeline(patientUid, { limit: 120 });
  const fallback = buildHandoverFallback(patientUid, timeline);
  const systemPrompt = [
    'You are a hospital nurse handover assistant.',
    'Use only the provided EMR timeline.',
    'Return a concise JSON object with patient_summary, active_issues, pending_tasks, medications_due, special_instructions.',
    'Never invent undocumented facts. Use "not documented" when missing.',
  ].join('\n');
  const userPrompt = JSON.stringify({
    patient_uid: patientUid,
    timeline: timeline.map((event) => ({
      type: event.event_type,
      sub_type: event.sub_type,
      id: event.id,
      timestamp: event.timestamp,
      summary: event.summary,
    })),
  });

  const aiResult = await generateClinicalText({
    systemPrompt,
    userPrompt,
    taskType: 'handover_summary',
  });

  let parsed = null;
  if (aiResult.usedAi) {
    try {
      parsed = JSON.parse(aiResult.text.replace(/^```json\s*/i, '').replace(/```$/i, ''));
    } catch (err) {
      logger.warn('Handover AI returned non-JSON; using fallback', { error: err.message });
    }
  }

  const draft = {
    ...fallback,
    ...(parsed && typeof parsed === 'object' ? parsed : {}),
    patient_uid: patientUid,
    generated_at: new Date().toISOString(),
    generated_by: requestedBy || null,
    ai_metadata: {
      provider: aiResult.provider,
      model: aiResult.model,
      module_key: aiResult.moduleKey,
      used_ai: aiResult.usedAi && Boolean(parsed),
      prompt_tokens: aiResult.usage?.prompt_tokens || 0,
      completion_tokens: aiResult.usage?.completion_tokens || 0,
      total_tokens: aiResult.usage?.total_tokens || 0,
      estimated_cost_minor: aiResult.estimatedCostMinor || null,
      latency_ms: aiResult.usage?.latency_ms || null,
      provider_request_id: aiResult.usage?.provider_request_id || null,
      finish_reason: aiResult.usage?.finish_reason || null,
      fallback_reason: parsed ? null : (aiResult.reason || 'AI output was not valid JSON'),
    },
    source_citations: timeline.slice(0, 80).map((event) => ({
      source_type: event.event_type,
      source_id: event.id ? String(event.id) : null,
      timestamp: event.timestamp,
      label: event.summary,
    })),
  };

  await publishEvent({
    eventType: 'clinical_ai.handover.generated',
    aggregateType: 'patient',
    aggregateId: patientUid,
    patientUid,
    payload: {
      generated_by: requestedBy || null,
      used_ai: draft.ai_metadata.used_ai,
      source_count: draft.source_citations.length,
    },
  });

  draft.draft_generation_id = await saveHandoverAiGeneration(patientUid, draft, requestedBy, tenantId);

  return draft;
}

/**
 * Create a nurse handover note.
 * @param {Object} data
 * @returns {Object} Created handover record
 */
export async function createHandover(data) {
  const {
    patient_uid,
    ward,
    bed_number,
    outgoing_nurse,
    incoming_nurse,
    shift,
    patient_summary,
    active_issues = [],
    pending_tasks = [],
    medications_due = [],
    special_instructions,
  } = data;

  if (!patient_uid || !outgoing_nurse || !shift || !patient_summary) {
    throw AppError.badRequest('patient_uid, outgoing_nurse, shift, and patient_summary are required');
  }

  if (!VALID_SHIFTS.includes(shift.toLowerCase())) {
    throw AppError.badRequest(`Invalid shift: ${shift}. Must be one of: ${VALID_SHIFTS.join(', ')}`);
  }

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO nurse_handovers
       (patient_uid, ward, bed_number, outgoing_nurse, incoming_nurse, shift,
        patient_summary, active_issues, pending_tasks, medications_due,
        special_instructions)
     VALUES ($1::uuid, $2, $3, $4::uuid, $5::uuid, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11)
     RETURNING id, patient_uid, outgoing_nurse, incoming_nurse, summary, pending_tasks, alerts, status, created_at`,
    
      patient_uid,
      ward || null,
      bed_number || null,
      outgoing_nurse,
      incoming_nurse || null,
      shift.toLowerCase(),
      patient_summary,
      JSON.stringify(active_issues),
      JSON.stringify(pending_tasks),
      JSON.stringify(medications_due),
      special_instructions || null,
    
  );

  logger.info(`Handover created by nurse ${outgoing_nurse} for patient ${patient_uid} (${shift} shift)`);
  const created = { ...rows[0], patient_uid, ward: ward || null, bed_number: bed_number || null, outgoing_nurse, incoming_nurse: incoming_nurse || null, shift: shift.toLowerCase() };
  emitHandover(created);

  await publishEvent({
    eventType: 'clinical.handover.created',
    aggregateType: 'nurse_handover',
    aggregateId: rows[0].id,
    patientUid: patient_uid,
    payload: {
      shift: shift.toLowerCase(),
      outgoing_nurse,
      incoming_nurse: incoming_nurse || null,
    },
  });

  return rows[0];
}

/**
 * Acknowledge a handover as the incoming nurse.
 * @param {number} id - Handover ID
 * @param {string} nurseUid - Incoming nurse UID
 * @returns {Object} Updated handover record
 */
export async function acknowledgeHandover(id, nurseUid) {
  const existing = await prisma.$queryRawUnsafe(
    'SELECT id, acknowledged, incoming_nurse FROM nurse_handovers WHERE id = $1',
    id
  );

  if (existing.length === 0) {
    throw AppError.notFound('Handover record not found');
  }

  if (existing[0].acknowledged) {
    throw AppError.conflict('Handover has already been acknowledged');
  }

  const rows = await prisma.$queryRawUnsafe(
    `UPDATE nurse_handovers
     SET acknowledged = true,
         acknowledged_at = NOW(),
         incoming_nurse = COALESCE(incoming_nurse, $2)
     WHERE id = $1
     RETURNING id, patient_uid, outgoing_nurse, incoming_nurse, summary, pending_tasks, alerts, status, created_at`,
    id, nurseUid
  );

  logger.info(`Handover ${id} acknowledged by nurse ${nurseUid}`);
  await publishEvent({
    eventType: 'clinical.handover.acknowledged',
    aggregateType: 'nurse_handover',
    aggregateId: id,
    patientUid: rows[0].patient_uid,
    payload: { acknowledged_by: nurseUid },
  });
  return rows[0];
}

/**
 * Get active (unacknowledged) handovers for an incoming nurse.
 * @param {string} nurseUid
 * @returns {Array} Pending handover records
 */
export async function getActiveHandovers(nurseUid) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, patient_uid, ward, bed_number, outgoing_nurse, incoming_nurse,
            shift, patient_summary, active_issues, pending_tasks,
            medications_due, special_instructions, acknowledged, created_at
     FROM nurse_handovers
     WHERE (incoming_nurse = $1 OR incoming_nurse IS NULL)
       AND acknowledged = false
     ORDER BY created_at DESC`,
    nurseUid
  );

  return rows;
}

/**
 * Get handover history for a patient.
 * @param {string} patientUid
 * @param {number} limit
 * @returns {Array} Handover records
 */
export async function getPatientHandoverHistory(patientUid, limit = 50) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, patient_uid, ward, bed_number, outgoing_nurse, incoming_nurse,
            shift, patient_summary, active_issues, pending_tasks,
            medications_due, special_instructions, acknowledged,
            acknowledged_at, created_at
     FROM nurse_handovers
     WHERE patient_uid = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    patientUid, limit
  );

  return rows;
}

export default {
  generateHandoverDraft,
  createHandover,
  acknowledgeHandover,
  getActiveHandovers,
  getPatientHandoverHistory,
};
