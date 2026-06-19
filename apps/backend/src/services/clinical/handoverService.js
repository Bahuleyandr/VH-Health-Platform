// src/services/clinical/handoverService.js
import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { generateClinicalText } from '../ai/localLlmClient.js';
import { publishEvent } from '../events/eventOutboxService.js';
import {
  readCanonicalPatientTimeline,
  recordCanonicalClinicalEvent,
} from './canonicalClinicalPlatformService.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenantService.js';
import { AppError } from '../../utils/AppError.js';
import { emitHandover } from '../../utils/websocket/realtimeEmitter.js';

// ===================================================================
// Nurse Handover Service
// ===================================================================

const VALID_SHIFTS = ['morning', 'afternoon', 'night'];
const HANDOVER_PROMPT_VERSION = 'handover-doc-v1';

function eventMatches(event, type) {
  const eventType = String(event.event_type || event.type || '').toLowerCase();
  const resourceType = String(event.resource_type || '').toLowerCase();
  const subtype = String(event.sub_type || event.event_subtype || '').toLowerCase();
  return eventType === type
    || eventType.startsWith(`${type}.`)
    || resourceType === type
    || subtype === type;
}

function recent(events, type, count = 5) {
  return events.filter((event) => eventMatches(event, type)).slice(0, count);
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

  const timelineEnvelope = await readCanonicalPatientTimeline(patientUid, {
    tenantId,
    limit: 120,
    includeLegacy: true,
  });
  const timeline = timelineEnvelope.events || [];
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
    tenantId,
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
    tenant_id,
    tenantId: tenantIdInput,
  } = data;
  const tenantId = tenant_id || tenantIdInput || DEFAULT_TENANT_ID;

  if (!patient_uid || !outgoing_nurse || !shift || !patient_summary) {
    throw AppError.badRequest('patient_uid, outgoing_nurse, shift, and patient_summary are required');
  }

  if (!VALID_SHIFTS.includes(shift.toLowerCase())) {
    throw AppError.badRequest(`Invalid shift: ${shift}. Must be one of: ${VALID_SHIFTS.join(', ')}`);
  }

  // Canonical clinical timeline invariant (docs/CANONICAL_CLINICAL_TIMELINE.md)
  // + Phase 0/1 transaction rule (apps/backend CLAUDE.md): the SBAR handover
  // detail row and its canonical handover.created timeline + audit event are ONE
  // atomic unit. Previously the canonical event ran post-commit inside the
  // swallowing bestEffortHandoverTimelineEvent, so a handover (a shift-safety
  // artifact) could persist with no timeline/audit row. Emitting it on `tx`
  // (via { db: tx }) means a canonical-write failure rolls the handover back.
  const rows = await setTenantTx(tenantId, async (tx) => {
    const inserted = await tx.$queryRawUnsafe(
      `INSERT INTO nurse_handovers
         (tenant_id, patient_uid, ward, bed_number, outgoing_nurse, incoming_nurse, shift,
          patient_summary, active_issues, pending_tasks, medications_due,
          special_instructions)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6::uuid, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12)
       RETURNING id, tenant_id, patient_uid, ward, bed_number, outgoing_nurse, incoming_nurse,
                 shift, patient_summary, summary, active_issues, pending_tasks, medications_due,
                 alerts, special_instructions, status, acknowledged, created_at, updated_at`,
      tenantId,
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

    const createdRow = inserted[0];
    await recordCanonicalClinicalEvent({
      tenantId: createdRow.tenant_id,
      patientUid: patient_uid,
      eventType: 'handover.created',
      eventSubtype: createdRow.shift,
      eventStatus: createdRow.status || 'pending',
      sourceTable: 'nurse_handovers',
      sourceId: createdRow.id,
      resourceType: 'handover',
      resourceId: createdRow.id,
      actorUid: outgoing_nurse,
      summary: `Handover created for ${createdRow.shift || shift.toLowerCase()} shift`,
      payload: {
        ward: createdRow.ward,
        bed_number: createdRow.bed_number,
        outgoing_nurse: createdRow.outgoing_nurse,
        incoming_nurse: createdRow.incoming_nurse,
        active_issues: active_issues || [],
        pending_tasks: pending_tasks || [],
        medications_due: medications_due || [],
      },
      afterState: createdRow,
      timelineIdempotencyKey: `nurse_handovers:${createdRow.id}:created`,
      auditIdempotencyKey: `nurse_handovers:${createdRow.id}:audit:created`,
    }, { db: tx });

    return inserted;
  });

  logger.info(`Handover created by nurse ${outgoing_nurse} for patient ${patient_uid} (${shift} shift)`);
  const created = { ...rows[0], patient_uid, ward: ward || null, bed_number: bed_number || null, outgoing_nurse, incoming_nurse: incoming_nurse || null, shift: shift.toLowerCase() };

  // Realtime emit + event outbox are fire-and-forget downstreams (Phase 1.5,
  // post-commit) — they must never roll back the handover write.
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
  // Phase 0 — pre-flight existence/state check on plain prisma so a not-found /
  // already-acknowledged surfaces as 4xx, never a 500 inside the tx.
  const existing = await prisma.$queryRawUnsafe(
    'SELECT id, tenant_id, patient_uid, acknowledged, incoming_nurse FROM nurse_handovers WHERE id = $1',
    id
  );

  if (existing.length === 0) {
    throw AppError.notFound('Handover record not found');
  }

  if (existing[0].acknowledged) {
    throw AppError.conflict('Handover has already been acknowledged');
  }

  const tenantId = existing[0].tenant_id || DEFAULT_TENANT_ID;

  // Canonical timeline invariant + Phase 0/1 rule: the acknowledgement state
  // flip and its canonical handover.acknowledged timeline + audit event are ONE
  // atomic unit (previously the canonical event was swallowed post-commit). On
  // `tx` so a canonical-write failure rolls the acknowledgement back.
  const rows = await setTenantTx(tenantId, async (tx) => {
    const updated = await tx.$queryRawUnsafe(
      `UPDATE nurse_handovers
       SET acknowledged = true,
           acknowledged_at = NOW(),
           incoming_nurse = COALESCE(incoming_nurse, $2)
       WHERE id = $1
       RETURNING id, tenant_id, patient_uid, ward, bed_number, outgoing_nurse, incoming_nurse,
                 shift, patient_summary, summary, active_issues, pending_tasks, medications_due,
                 alerts, special_instructions, status, acknowledged, acknowledged_at, created_at, updated_at`,
      id, nurseUid
    );

    const updatedRow = updated[0];
    await recordCanonicalClinicalEvent({
      tenantId: updatedRow.tenant_id,
      patientUid: updatedRow.patient_uid,
      eventType: 'handover.acknowledged',
      eventSubtype: updatedRow.shift,
      eventStatus: 'acknowledged',
      sourceTable: 'nurse_handovers',
      sourceId: updatedRow.id,
      resourceType: 'handover',
      resourceId: updatedRow.id,
      actorUid: nurseUid,
      summary: `Handover acknowledged for ${updatedRow.shift || 'shift'}`,
      payload: { acknowledged_by: nurseUid, incoming_nurse: updatedRow.incoming_nurse },
      beforeState: { acknowledged: false, incoming_nurse: existing[0].incoming_nurse },
      afterState: { acknowledged: true, incoming_nurse: updatedRow.incoming_nurse },
      timelineIdempotencyKey: `nurse_handovers:${updatedRow.id}:acknowledged`,
      auditIdempotencyKey: `nurse_handovers:${updatedRow.id}:audit:acknowledged`,
    }, { db: tx });

    return updated;
  });

  logger.info(`Handover ${id} acknowledged by nurse ${nurseUid}`);
  // Event outbox publish is a fire-and-forget downstream (Phase 1.5 post-commit).
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
     WHERE patient_uid = $1::uuid
     ORDER BY created_at DESC
     LIMIT $2::int`,
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
