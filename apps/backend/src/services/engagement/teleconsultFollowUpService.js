import { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { createTask } from '../workflow/taskService.js';

const DEFAULT_TRIGGER_DEFAULTS = {
  clinician_follow_up_due_date: { enabled: true, offset_days: 0 },
  investigation_ordered: { enabled: true, offset_days: 3 },
  prescription_created: { enabled: true, offset_days: 2 },
  secure_message_fallback: { enabled: true, offset_days: 1 },
  teleconsult_completed: { enabled: true, offset_days: 7 },
};

const FORBIDDEN_FACT_KEYS = new Set([
  'ai_note_draft',
  'teleconsult_note_draft',
  'draft_plan_follow_up',
  'plan_follow_up',
  'raw_transcript',
  'transcript',
  'chat_transcript',
]);

const TERMINAL_LOOP_STATUSES = new Set(['completed', 'cancelled', 'suppressed']);
const CLOSE_STATUSES = new Set(['completed', 'cancelled', 'suppressed']);

function safeText(value, max = 8000) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return max ? text.slice(0, max) : text;
}

function normalizeUuid(value, label = 'uid') {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw AppError.badRequest(`${label} must be a UUID`);
  }
  return text;
}

function normalizeId(value, label = 'id') {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw AppError.badRequest(`${label} must be a positive integer`);
  }
  return parsed;
}

function normalizeTimestamp(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw AppError.badRequest(`${label} must be a valid timestamp`);
  return date.toISOString();
}

function normalizeJsonObject(value, label) {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw AppError.badRequest(`${label} must be a JSON object`);
  }
  return value;
}

function activeBoolean(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function addDaysIso(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return date.toISOString();
}

function triggerConfig(settings = {}) {
  const configured = normalizeJsonObject(settings.trigger_defaults, 'trigger_defaults');
  return {
    ...DEFAULT_TRIGGER_DEFAULTS,
    ...configured,
  };
}

function isTriggerEnabled(config, trigger) {
  const item = config?.[trigger];
  if (item === false) return false;
  if (item && typeof item === 'object' && item.enabled === false) return false;
  return true;
}

function triggerOffsetDays(config, trigger) {
  const value = config?.[trigger]?.offset_days;
  const parsed = Number.parseInt(value, 10);
  if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 365) return parsed;
  return DEFAULT_TRIGGER_DEFAULTS[trigger]?.offset_days || 0;
}

export function normalizeTeleconsultCompletionFacts(facts = {}) {
  const payload = normalizeJsonObject(facts, 'completion_facts');
  for (const key of Object.keys(payload)) {
    if (FORBIDDEN_FACT_KEYS.has(key)) {
      throw AppError.badRequest(
        'Unapproved teleconsult AI draft or transcript fields cannot drive follow-up loops',
        'TELECONSULT_FOLLOW_UP_UNAPPROVED_SOURCE',
      );
    }
  }

  const status = safeText(payload.source_status || payload.status || payload.approval_status, 40);
  const approved = activeBoolean(payload.approved)
    || activeBoolean(payload.signed)
    || ['approved', 'signed', 'final', 'clinician_approved'].includes(String(status || '').toLowerCase());
  if (!approved) {
    throw AppError.badRequest(
      'Teleconsult completion facts must be signed or clinician-approved',
      'TELECONSULT_FOLLOW_UP_APPROVAL_REQUIRED',
    );
  }

  return {
    source_status: status || (activeBoolean(payload.signed) ? 'signed' : 'approved'),
    follow_up_due_at: normalizeTimestamp(
      payload.follow_up_due_at || payload.follow_up_due_date || payload.clinician_follow_up_due_at || null,
      'follow_up_due_at',
    ),
    investigation_ordered: activeBoolean(payload.investigation_ordered)
      || Number(payload.investigation_order_count || payload.investigation_count || 0) > 0,
    prescription_created: activeBoolean(payload.prescription_created)
      || activeBoolean(payload.prescription_issued)
      || Number(payload.prescription_count || 0) > 0,
    secure_message_fallback: activeBoolean(payload.secure_message_fallback)
      || activeBoolean(payload.secure_message_fallback_unresolved)
      || activeBoolean(payload.fallback_message_unresolved),
    metadata: normalizeJsonObject(payload.metadata, 'completion_facts.metadata'),
  };
}

function selectTrigger(facts, settings) {
  const config = triggerConfig(settings);
  if (facts.follow_up_due_at && isTriggerEnabled(config, 'clinician_follow_up_due_date')) {
    return {
      loopType: 'clinician_follow_up_due_date',
      dueAt: facts.follow_up_due_at,
      duePolicy: {
        source: 'clinician_selected',
        honored_first: true,
        trigger: 'clinician_follow_up_due_date',
      },
    };
  }

  const ordered = [
    ['secure_message_fallback', facts.secure_message_fallback],
    ['investigation_ordered', facts.investigation_ordered],
    ['prescription_created', facts.prescription_created],
    ['teleconsult_completed', true],
  ];
  for (const [trigger, present] of ordered) {
    if (present && isTriggerEnabled(config, trigger)) {
      const offsetDays = triggerOffsetDays(config, trigger);
      return {
        loopType: trigger,
        dueAt: addDaysIso(offsetDays),
        duePolicy: {
          source: 'default_trigger_offset',
          trigger,
          offset_days: offsetDays,
        },
      };
    }
  }
  return null;
}

function safeLinkForTrigger(settings, trigger) {
  if (trigger === 'secure_message_fallback') {
    return safeText(settings.secure_message_route, 160) || '/portal/messages';
  }
  return safeText(settings.patient_route, 160) || '/appointments';
}

async function loadSettings(tx, tenantId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, tenant_id, enabled, consent_type, patient_route, secure_message_route,
            staff_task_role, trigger_defaults, metadata
       FROM teleconsult_follow_up_settings
      WHERE tenant_id = $1::uuid
      LIMIT 1`,
    tenantId,
  );
  return rows[0] || null;
}

async function loadCompletedConsult(tx, tenantId, teleconsultationId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, tenant_id::text AS tenant_id, appointment_id, patient_uid::text AS patient_uid,
            doctor_uid::text AS doctor_uid, status, scheduled_start, actual_end, metadata
       FROM teleconsultations
      WHERE id = $1::int
        AND tenant_id = $2::uuid
      LIMIT 1`,
    normalizeId(teleconsultationId, 'teleconsultation_id'),
    tenantId,
  );
  if (!rows[0]) throw AppError.notFound('Teleconsultation not found');
  if (rows[0].status !== 'completed') {
    throw AppError.badRequest('Teleconsultation must be completed before creating follow-up loops');
  }
  if (!rows[0].patient_uid) {
    throw AppError.badRequest('Teleconsultation is missing patient_uid');
  }
  return rows[0];
}

async function loadActiveConsent(tx, { tenantId, patientUid, consentType }) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, consent_type, granted_at, expires_at
       FROM patient_consents
      WHERE tenant_id = $1::uuid
        AND patient_uid = $2::uuid
        AND consent_type = $3
        AND granted = true
        AND status = 'active'
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY granted_at DESC NULLS LAST, id DESC
      LIMIT 1`,
    tenantId,
    patientUid,
    consentType,
  );
  return rows[0] || null;
}

async function findOpenLoop(tx, { tenantId, sourceRef, loopType }) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, tenant_id, source_type, source_ref, appointment_id, patient_uid::text AS patient_uid,
            owner_uid::text AS owner_uid, loop_type, status, consent_type, due_policy,
            due_at, safe_link_path, close_reason, closed_at, closed_by::text AS closed_by,
            created_by::text AS created_by, metadata, created_at, updated_at
       FROM engagement_follow_up_loops
      WHERE tenant_id = $1::uuid
        AND source_type = 'teleconsultation'
        AND source_ref = $2
        AND loop_type = $3
        AND status IN ('open', 'scheduled', 'waiting_patient', 'staff_review')
      LIMIT 1`,
    tenantId,
    sourceRef,
    loopType,
  );
  return rows[0] || null;
}

async function insertEvent(tx, {
  tenantId,
  loopId,
  eventKind,
  previousStatus = null,
  nextStatus = null,
  actorUid = null,
  reason = null,
  metadata = null,
}) {
  await tx.$queryRawUnsafe(
    `INSERT INTO engagement_follow_up_events
       (tenant_id, loop_id, event_kind, previous_status, next_status,
        actor_uid, reason, metadata)
     VALUES ($1::uuid, $2::bigint, $3, $4, $5, $6::uuid, $7, $8::jsonb)`,
    tenantId,
    loopId,
    eventKind,
    safeText(previousStatus, 30),
    safeText(nextStatus, 30),
    normalizeUuid(actorUid, 'actor_uid'),
    safeText(reason, 160),
    JSON.stringify(normalizeJsonObject(metadata, 'event.metadata')),
  );
}

async function insertStep(tx, {
  tenantId,
  loopId,
  stepKind,
  status,
  scheduledAt = null,
  templateKey = null,
  staffTaskId = null,
  result = null,
  suppressionReason = null,
  safeLinkPath = null,
  metadata = null,
}) {
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO engagement_follow_up_steps
       (tenant_id, loop_id, step_kind, status, scheduled_at,
        template_key, staff_task_id, result, suppression_reason,
        safe_link_path, metadata)
     VALUES ($1::uuid, $2::bigint, $3, $4, $5::timestamptz,
             $6, $7::int, $8::jsonb, $9, $10, $11::jsonb)
     RETURNING id, tenant_id, loop_id, step_kind, status, scheduled_at,
               template_key, staff_task_id, result, suppression_reason,
               safe_link_path, metadata, created_at, updated_at`,
    tenantId,
    loopId,
    stepKind,
    status,
    normalizeTimestamp(scheduledAt, 'scheduled_at'),
    safeText(templateKey, 120),
    staffTaskId ? normalizeId(staffTaskId, 'staff_task_id') : null,
    JSON.stringify(normalizeJsonObject(result, 'step.result')),
    safeText(suppressionReason, 120),
    safeText(safeLinkPath, 160),
    JSON.stringify(normalizeJsonObject(metadata, 'step.metadata')),
  );
  return rows[0];
}

export async function createTeleconsultFollowUpFromCompletion({
  tenantId = null,
  teleconsultationId,
  completionFacts,
  actorUid = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  const facts = normalizeTeleconsultCompletionFacts(completionFacts);

  return setTenantTx(tid, async (tx) => {
    const settings = await loadSettings(tx, tid);
    if (!settings || settings.enabled !== true) {
      return { created: false, reason: 'tenant_follow_up_flag_disabled' };
    }

    const consult = await loadCompletedConsult(tx, tid, teleconsultationId);
    const trigger = selectTrigger(facts, settings);
    if (!trigger) return { created: false, reason: 'no_enabled_trigger' };

    const sourceRef = String(consult.id);
    const existing = await findOpenLoop(tx, {
      tenantId: tid,
      sourceRef,
      loopType: trigger.loopType,
    });
    if (existing) {
      return { created: false, reason: 'open_loop_exists', loop: existing };
    }

    const consentType = safeText(settings.consent_type, 80) || 'teleconsult_followup';
    const consent = await loadActiveConsent(tx, {
      tenantId: tid,
      patientUid: consult.patient_uid,
      consentType,
    });
    const safeLinkPath = safeLinkForTrigger(settings, trigger.loopType);
    const actor = normalizeUuid(actorUid, 'actor_uid') || null;
    const metadata = {
      source: 'nl9_p3_teleconsult_follow_up',
      completion_facts: {
        source_status: facts.source_status,
        investigation_ordered: facts.investigation_ordered,
        prescription_created: facts.prescription_created,
        secure_message_fallback: facts.secure_message_fallback,
        clinician_follow_up_due_at: facts.follow_up_due_at,
      },
      appointment_id: consult.appointment_id || null,
      patient_outbound_policy: 'generic_template_bound_only',
      ai_note_draft_used: false,
      ...facts.metadata,
    };

    const loopRows = await tx.$queryRawUnsafe(
      `INSERT INTO engagement_follow_up_loops
         (tenant_id, source_type, source_ref, appointment_id, patient_uid,
          owner_uid, loop_type, status, consent_type, due_policy, due_at,
          safe_link_path, created_by, metadata)
       VALUES ($1::uuid, 'teleconsultation', $2, $3::int, $4::uuid,
               $5::uuid, $6, 'scheduled', $7, $8::jsonb, $9::timestamptz,
               $10, $11::uuid, $12::jsonb)
       RETURNING id, tenant_id, source_type, source_ref, appointment_id,
                 patient_uid::text AS patient_uid, owner_uid::text AS owner_uid,
                 loop_type, status, consent_type, due_policy, due_at,
                 safe_link_path, metadata, created_at, updated_at`,
      tid,
      sourceRef,
      consult.appointment_id || null,
      consult.patient_uid,
      consult.doctor_uid || null,
      trigger.loopType,
      consentType,
      JSON.stringify(trigger.duePolicy),
      trigger.dueAt,
      safeLinkPath,
      actor,
      JSON.stringify(metadata),
    );
    const loop = loopRows[0];

    await insertEvent(tx, {
      tenantId: tid,
      loopId: loop.id,
      eventKind: 'created',
      nextStatus: 'scheduled',
      actorUid: actor,
      reason: trigger.loopType,
      metadata: trigger.duePolicy,
    });

    const task = await createTask({
      tenantId: tid,
      taskKind: 'follow_up',
      title: 'Teleconsult follow-up due',
      description: 'Review the completed teleconsultation follow-up and decide the next staff action.',
      patientUid: consult.patient_uid,
      relatedResourceType: 'engagement_follow_up_loop',
      relatedResourceId: String(loop.id),
      priority: trigger.loopType === 'secure_message_fallback' ? 'high' : 'normal',
      assignedToUid: consult.doctor_uid || null,
      assignedToRole: consult.doctor_uid ? null : (safeText(settings.staff_task_role, 80) || 'DOCTOR'),
      createdBy: actor,
      dueAt: trigger.dueAt,
      metadata: {
        source: 'nl9_p3_teleconsult_follow_up',
        teleconsultation_id: consult.id,
        appointment_id: consult.appointment_id || null,
        loop_type: trigger.loopType,
      },
      tx,
      onConflictResourceDoNothing: true,
    });

    const staffStep = await insertStep(tx, {
      tenantId: tid,
      loopId: loop.id,
      stepKind: 'staff_task',
      status: task ? 'scheduled' : 'suppressed',
      scheduledAt: trigger.dueAt,
      staffTaskId: task?.id || null,
      result: task ? { task_id: task.id } : {},
      suppressionReason: task ? null : 'open_staff_task_exists',
      metadata: { trigger: trigger.loopType },
    });
    await insertEvent(tx, {
      tenantId: tid,
      loopId: loop.id,
      eventKind: task ? 'task_created' : 'step_suppressed',
      actorUid: actor,
      reason: staffStep.suppression_reason || 'staff_task',
      metadata: { staff_task_id: task?.id || null },
    });

    const patientStepStatus = consent ? 'scheduled' : 'suppressed';
    const patientStep = await insertStep(tx, {
      tenantId: tid,
      loopId: loop.id,
      stepKind: trigger.loopType === 'secure_message_fallback' ? 'secure_message_fallback' : 'patient_outreach',
      status: patientStepStatus,
      scheduledAt: trigger.dueAt,
      templateKey: 'teleconsult_follow_up_generic',
      result: consent
        ? {
          consent_id: consent.id,
          route: safeLinkPath,
          message_policy: 'generic_follow_up_only',
        }
        : {},
      suppressionReason: consent ? null : 'teleconsult_followup_consent_missing',
      safeLinkPath,
      metadata: {
        trigger: trigger.loopType,
        consent_type: consentType,
      },
    });
    await insertEvent(tx, {
      tenantId: tid,
      loopId: loop.id,
      eventKind: consent ? 'step_scheduled' : 'step_suppressed',
      actorUid: actor,
      reason: patientStep.suppression_reason || 'consented_patient_outreach',
      metadata: { step_kind: patientStep.step_kind, consent_type: consentType },
    });

    return {
      created: true,
      loop,
      task: task || null,
      steps: [staffStep, patientStep],
      consent: consent
        ? { status: 'fresh', id: consent.id, consent_type: consent.consent_type }
        : { status: 'missing', consent_type: consentType },
      safe_link_path: safeLinkPath,
    };
  });
}

export async function closeTeleconsultFollowUpLoop({
  tenantId = null,
  id,
  nextStatus = 'completed',
  closeReason,
  actorUid = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  const loopId = normalizeId(id, 'follow_up_loop id');
  const cleanStatus = safeText(nextStatus, 30);
  if (!CLOSE_STATUSES.has(cleanStatus)) {
    throw AppError.badRequest('next_status must be one of: completed, cancelled, suppressed');
  }
  const reason = safeText(closeReason, 120);
  if (!reason) throw AppError.badRequest('close_reason is required');
  const actor = normalizeUuid(actorUid, 'actor_uid') || null;

  return setTenantTx(tid, async (tx) => {
    const currentRows = await tx.$queryRawUnsafe(
      `SELECT id, status
         FROM engagement_follow_up_loops
        WHERE id = $1::bigint
          AND tenant_id = $2::uuid
        LIMIT 1`,
      loopId,
      tid,
    );
    const current = currentRows[0];
    if (!current) throw AppError.notFound('Follow-up loop not found');
    if (TERMINAL_LOOP_STATUSES.has(current.status)) {
      throw AppError.invalidTransition(current.status, cleanStatus, []);
    }

    const rows = await tx.$queryRawUnsafe(
      `UPDATE engagement_follow_up_loops
          SET status = $1,
              close_reason = $2,
              closed_at = NOW(),
              closed_by = $3::uuid,
              updated_at = NOW()
        WHERE id = $4::bigint
          AND tenant_id = $5::uuid
        RETURNING id, tenant_id, source_type, source_ref, appointment_id,
                  patient_uid::text AS patient_uid, owner_uid::text AS owner_uid,
                  loop_type, status, consent_type, due_policy, due_at,
                  safe_link_path, close_reason, closed_at, closed_by::text AS closed_by,
                  metadata, created_at, updated_at`,
      cleanStatus,
      reason,
      actor,
      loopId,
      tid,
    );
    await insertEvent(tx, {
      tenantId: tid,
      loopId,
      eventKind: 'closed',
      previousStatus: current.status,
      nextStatus: cleanStatus,
      actorUid: actor,
      reason,
    });
    return rows[0];
  });
}

export const __testing__ = {
  DEFAULT_TRIGGER_DEFAULTS,
  FORBIDDEN_FACT_KEYS,
  selectTrigger,
  triggerConfig,
};

export default {
  createTeleconsultFollowUpFromCompletion,
  closeTeleconsultFollowUpLoop,
};
