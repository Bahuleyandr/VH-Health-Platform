import { setTenantTx } from '../../lib/prisma.js';
import { canonicalizeRequestRole } from '../../utils/roles.js';
import {
  currentCanonicalTransactionRevision,
  recordCanonicalClinicalEvent,
} from '../clinical/canonicalClinicalPlatformService.js';
import { publishEvent } from '../events/eventOutboxService.js';
import { PATHWAY_MODES } from '../pathways/pathwayMode.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { AppError } from '../../utils/AppError.js';
import { isPathwayNamedClinicalOwnerRole } from '../workflow/workflowHumanOwnerService.js';
import {
  evaluateAppointmentPathwayWorkTx,
  resolveOpPathwayModeTx,
} from './opPathwayWorkService.js';

export const APPOINTMENT_TRANSITIONS = Object.freeze({
  SCHEDULED: Object.freeze([
    'CONFIRMED',
    'IN_PROGRESS',
    'COMPLETED',
    'CANCELLED',
    'NO_SHOW',
    'RESCHEDULED',
  ]),
  CONFIRMED: Object.freeze([
    'SCHEDULED',
    'IN_PROGRESS',
    'COMPLETED',
    'CANCELLED',
    'NO_SHOW',
    'RESCHEDULED',
  ]),
  IN_PROGRESS: Object.freeze(['COMPLETED', 'CANCELLED']),
  COMPLETED: Object.freeze([]),
  CANCELLED: Object.freeze([]),
  NO_SHOW: Object.freeze([]),
  RESCHEDULED: Object.freeze([]),
});

const EVENT_BY_STATUS = Object.freeze({
  CONFIRMED: 'appointment.confirmed',
  IN_PROGRESS: 'appointment.in_progress',
  COMPLETED: 'appointment.completed',
  CANCELLED: 'appointment.cancelled',
  NO_SHOW: 'appointment.no_show',
  RESCHEDULED: 'appointment.rescheduled',
});

const FRONT_OFFICE_TRANSITION_ROLES = new Set([
  'ADMIN',
  'SUPER_ADMIN',
  'CMO',
  'MEDICAL_SUPERINTENDENT',
  'RECEPTIONIST',
  'RECEPTION_INCHARGE',
  'NURSING_STAFF',
  'OP_STAFF_NURSE',
  'OP_INCHARGE',
]);
const FRONT_OFFICE_TARGETS = new Set([
  'CONFIRMED',
  'CANCELLED',
  'NO_SHOW',
  'RESCHEDULED',
]);
const PATIENT_TRANSITION_SOURCES = Object.freeze({
  CANCELLED: new Set(['cancel', 'delete', 'delete_cancel']),
  RESCHEDULED: new Set(['reschedule']),
  SCHEDULED: new Set(['reschedule_patch']),
});

function normalizeStatus(value) {
  return String(value || '').trim().toUpperCase();
}

function parseAppointmentId(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw AppError.badRequest('appointment id must be a positive integer', 'APPOINTMENT_ID_INVALID');
  }
  return parsed;
}

function actorIntId(value) {
  if (value == null || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function ensureAppointmentIdentity(appointment, current, tenantId, targetStatus) {
  if (
    !appointment
    || String(appointment.id) !== String(current.id)
    || String(appointment.tenant_id) !== String(tenantId)
    || normalizeStatus(appointment.status) !== targetStatus
  ) {
    throw AppError.internal(
      'Appointment transition mutation returned inconsistent state',
      'APPOINTMENT_TRANSITION_STATE_INVALID',
    );
  }
  return {
    ...current,
    ...appointment,
    patient_uid: appointment.patient_uid || current.patient_uid,
    doctor_uid: appointment.doctor_uid || current.doctor_uid,
  };
}

export function assertAppointmentTransition(fromStatus, toStatus, { allowSameStatus = false } = {}) {
  const from = normalizeStatus(fromStatus);
  const to = normalizeStatus(toStatus);
  if (!Object.hasOwn(APPOINTMENT_TRANSITIONS, from)) {
    throw AppError.invalidTransition(from, to, []);
  }
  if (from === to) {
    if (allowSameStatus) return;
    return;
  }
  if (!APPOINTMENT_TRANSITIONS[from].includes(to)) {
    throw AppError.invalidTransition(from, to, APPOINTMENT_TRANSITIONS[from]);
  }
}

async function currentOpOwnerUidTx(tx, tenantId, current) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT owning_clinician_uid
       FROM care_pathway_instances
      WHERE tenant_id = $1::uuid
        AND patient_uid = $2::uuid
        AND pathway_key = 'op_contact_to_recovery'
        AND source_episode_type = 'appointment'
        AND source_episode_id = $3::text
        AND clinical_status IN ('planned', 'active', 'on_hold')
      ORDER BY created_at DESC, id DESC
      LIMIT 1
      FOR SHARE`,
    tenantId,
    current.patient_uid,
    String(current.id),
  );
  return rows[0]?.owning_clinician_uid || current.doctor_uid || null;
}

export async function authorizeAppointmentTransitionTx(tx, {
  tenantId,
  current,
  targetStatus,
  actorUid,
  actorId,
  actorRole,
  source,
} = {}) {
  const normalizedRole = canonicalizeRequestRole(actorRole);
  const rawRole = String(actorRole || '').trim().toUpperCase();
  const uid = String(actorUid || '').trim().toLowerCase();
  const id = actorIntId(actorId);
  if (!normalizedRole || !rawRole || !uid) {
    throw AppError.forbidden(
      'Current actor is not authorized for this appointment transition',
      'APPOINTMENT_TRANSITION_FORBIDDEN',
    );
  }
  const actorRows = await tx.$queryRawUnsafe(
    `SELECT id, uid, role, is_active, status, is_deleted, deleted_at
       FROM users
      WHERE tenant_id = $1::uuid
        AND uid = $2::uuid
      LIMIT 1
      FOR SHARE`,
    tenantId,
    uid,
  );
  const actor = actorRows[0];
  if (
    !actor
    || actor.is_active !== true
    || String(actor.status || '').trim().toLowerCase() !== 'active'
    || actor.is_deleted !== false
    || actor.deleted_at !== null
    || String(actor.role || '').trim().toUpperCase() !== rawRole
    || canonicalizeRequestRole(actor.role) !== normalizedRole
    || (id && Number(actor.id) !== id)
  ) {
    throw AppError.forbidden(
      'Current actor is not authorized for this appointment transition',
      'APPOINTMENT_TRANSITION_FORBIDDEN',
    );
  }

  const target = normalizeStatus(targetStatus);
  const normalizedSource = String(source || '').trim().toLowerCase();
  if (normalizedRole === 'PATIENT') {
    const allowedSources = PATIENT_TRANSITION_SOURCES[target];
    if (
      Number(current.patient_id) === Number(actor.id)
      && allowedSources?.has(normalizedSource)
    ) {
      return Object.freeze({ authority: 'patient_self_service', actor });
    }
    throw AppError.forbidden(
      'Patients may only cancel or reschedule their own appointment through the dedicated workflow',
      'APPOINTMENT_TRANSITION_FORBIDDEN',
    );
  }

  if (
    FRONT_OFFICE_TRANSITION_ROLES.has(normalizedRole)
    && (
      FRONT_OFFICE_TARGETS.has(target)
      || (
        target === 'SCHEDULED'
        && normalizedSource === 'reschedule_patch'
      )
    )
  ) {
    return Object.freeze({ authority: 'front_office_queue', actor });
  }

  if (isPathwayNamedClinicalOwnerRole(normalizedRole)) {
    const ownerUid = await currentOpOwnerUidTx(tx, tenantId, current);
    if (ownerUid && String(ownerUid).toLowerCase() === uid) {
      return Object.freeze({ authority: 'current_op_owner', actor });
    }
  }
  throw AppError.forbidden(
    'Current actor is not authorized for this appointment transition',
    'APPOINTMENT_TRANSITION_FORBIDDEN',
  );
}

export async function lockAppointmentForLifecycleTx(tx, { tenantId, appointmentId } = {}) {
  const tid = requireTenantId(tenantId);
  const id = parseAppointmentId(appointmentId);
  const rows = await tx.$queryRawUnsafe(
    `SELECT a.id, a.uid, a.phone, a.patient_id, patient.uid AS patient_uid,
            COALESCE(NULLIF(a.patient_name, ''), patient.name) AS patient_name,
            a.doctor_id, clinician.uid AS doctor_uid,
            COALESCE(NULLIF(a.doctor_name, ''), clinician.name) AS doctor_name,
            a.appointment_date, a.appointment_time, a.status, a.reason, a.notes,
            a.token_number, a.visit_no, a.confirmed_at, a.department, a.visit_type,
            a.queue_id, a.parent_appointment_id, a.payer_type,
            a.patient_category, a.insurer_name, a.policy_number, a.scheme_name,
            a.triage_acuity, a.advised_for_admission_at,
            a.advised_for_admission_by, a.advised_for_admission_note,
            a.tenant_id, a.created_at, a.updated_at
       FROM appointments AS a
       JOIN users AS patient
         ON patient.id = a.patient_id
        AND patient.tenant_id = a.tenant_id
       LEFT JOIN users AS clinician
         ON clinician.id = a.doctor_id
        AND clinician.tenant_id = a.tenant_id
      WHERE a.id = $1::integer
        AND a.tenant_id = $2::uuid
      LIMIT 1
      FOR UPDATE OF a`,
    id,
    tid,
  );
  if (!rows[0]) {
    throw AppError.notFound('Appointment not found', 'APPOINTMENT_NOT_FOUND');
  }
  if (!rows[0].patient_uid) {
    throw AppError.conflict(
      'Appointment is not linked to a patient identity',
      'APPOINTMENT_PATIENT_REQUIRED',
    );
  }
  return rows[0];
}

export async function appendAppointmentStatusHistoryTx(tx, {
  tenantId,
  appointmentId,
  fromStatus,
  toStatus,
  actorId = null,
  actorRole = null,
  reason = null,
} = {}) {
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO appointment_status_history
       (tenant_id, appointment_id, from_status, to_status,
        changed_by, changed_by_role, reason)
     VALUES ($1::uuid, $2::integer, $3::text, $4::text,
             $5::integer, $6::text, $7::text)
     RETURNING id::text, appointment_id, from_status, to_status, created_at`,
    requireTenantId(tenantId),
    parseAppointmentId(appointmentId),
    fromStatus == null ? null : normalizeStatus(fromStatus),
    normalizeStatus(toStatus),
    actorIntId(actorId),
    actorRole || null,
    reason || null,
  );
  if (!rows[0]) {
    throw AppError.internal(
      'Appointment status history was not recorded',
      'APPOINTMENT_STATUS_HISTORY_REQUIRED',
    );
  }
  return rows[0];
}

async function appendLifecycleEvidenceTx(tx, {
  mode,
  tenantId,
  appointment,
  prior,
  eventType,
  source,
  statusHistory,
  actorUid,
  actorRole,
  payload = {},
} = {}) {
  if (mode === PATHWAY_MODES.OFF) {
    return { canonical: null, outbox: null };
  }
  const revision = await currentCanonicalTransactionRevision(tx);
  const basePayload = {
    appointment_id: Number(appointment.id),
    appointment_uid: appointment.uid || null,
    patient_uid: appointment.patient_uid,
    tenant_id: tenantId,
    from_status: normalizeStatus(prior.status),
    to_status: normalizeStatus(appointment.status),
    source,
    source_status_history_id: statusHistory?.id || null,
    ...payload,
  };
  const canonical = await recordCanonicalClinicalEvent({
    tenantId,
    patientUid: appointment.patient_uid,
    eventType,
    eventStatus: normalizeStatus(appointment.status).toLowerCase(),
    sourceTable: 'appointments',
    sourceId: String(appointment.id),
    resourceType: 'appointment',
    resourceId: String(appointment.id),
    actorUid,
    actorRole,
    occurredAt: statusHistory?.created_at || appointment.updated_at || null,
    summary: `Appointment ${eventType.slice('appointment.'.length).replaceAll('_', ' ')}`,
    payload: basePayload,
    beforeState: {
      status: normalizeStatus(prior.status),
      appointment_date: prior.appointment_date,
      appointment_time: prior.appointment_time,
      doctor_id: prior.doctor_id,
    },
    afterState: {
      status: normalizeStatus(appointment.status),
      appointment_date: appointment.appointment_date,
      appointment_time: appointment.appointment_time,
      doctor_id: appointment.doctor_id,
    },
    timelineIdempotencyKey:
      `appointments:${appointment.id}:${eventType}:timeline:tx:${revision}`,
    auditIdempotencyKey:
      `appointments:${appointment.id}:${eventType}:audit:tx:${revision}`,
  }, { db: tx, strict: true });
  const outboxPayload = {
    ...basePayload,
    canonical_timeline_event_id: canonical.timeline.id,
    canonical_audit_event_id: canonical.audit.id,
  };
  const outbox = await publishEvent({
    eventType,
    aggregateType: 'appointment',
    aggregateId: String(appointment.id),
    patientUid: appointment.patient_uid,
    payload: outboxPayload,
    tx,
    tenantId,
  });
  if (!outbox) {
    throw AppError.internal(
      'Appointment outbox event was not recorded',
      'APPOINTMENT_OUTBOX_REQUIRED',
    );
  }
  return { canonical, outbox };
}

async function defaultStatusMutationTx(tx, {
  current,
  targetStatus,
  notes,
  actorUid,
  tenantId,
} = {}) {
  const rows = await tx.$queryRawUnsafe(
    `UPDATE appointments
        SET status = $1::text,
            notes = CASE
              WHEN $2::text IS NOT NULL
              THEN COALESCE(notes || ' | ', '') || $2::text
              ELSE notes
            END,
            updated_by = COALESCE($3::uuid, updated_by),
            updated_at = NOW()
      WHERE id = $4::integer
        AND tenant_id = $5::uuid
      RETURNING id, uid, phone, patient_id, patient_name, doctor_id, doctor_name,
                appointment_date, appointment_time, status, reason, notes,
                token_number, visit_no, confirmed_at, department, visit_type,
                queue_id, tenant_id, created_at, updated_at`,
    targetStatus,
    notes || null,
    actorUid || null,
    Number(current.id),
    tenantId,
  );
  return { appointment: rows[0] };
}

export async function transitionAppointment({
  tenantId,
  appointmentId,
  toStatus,
  actorUid = null,
  actorId = null,
  actorRole = null,
  reason = null,
  notes = null,
  source = 'status_update',
  eventType = null,
  allowSameStatus = false,
  authorize = null,
  resolveIdempotent = null,
  mutate = null,
  eventPayload = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  const id = parseAppointmentId(appointmentId);
  const targetStatus = normalizeStatus(toStatus);
  return setTenantTx(tid, async (tx) => {
    const current = await lockAppointmentForLifecycleTx(tx, {
      tenantId: tid,
      appointmentId: id,
    });
    await authorizeAppointmentTransitionTx(tx, {
      tenantId: tid,
      current,
      targetStatus,
      actorUid,
      actorId,
      actorRole,
      source,
    });
    if (authorize) {
      await authorize({ tx, current });
    }
    const fromStatus = normalizeStatus(current.status);
    assertAppointmentTransition(fromStatus, targetStatus, { allowSameStatus });
    if (
      targetStatus === 'SCHEDULED'
      && fromStatus !== targetStatus
      && eventType !== 'appointment.rescheduled'
    ) {
      throw AppError.badRequest(
        'Returning an appointment to SCHEDULED requires the reschedule workflow',
        'APPOINTMENT_RESCHEDULE_WORKFLOW_REQUIRED',
      );
    }
    const mode = await resolveOpPathwayModeTx(tx, tid);

    if (fromStatus === targetStatus && !allowSameStatus) {
      const idempotentResult = resolveIdempotent
        ? await resolveIdempotent({ tx, current, mode })
        : null;
      return {
        appointment: current,
        previous: current,
        from_status: fromStatus,
        to_status: targetStatus,
        mode,
        pathway_work: null,
        idempotent: true,
        status_history: null,
        canonical: null,
        outbox: null,
        ...(idempotentResult || {}),
      };
    }

    let pathwayWork = null;
    if (targetStatus === 'COMPLETED') {
      pathwayWork = await evaluateAppointmentPathwayWorkTx({
        tx,
        tenantId: tid,
        appointment: current,
        mode,
      });
      if (mode === PATHWAY_MODES.ACTIVE && !pathwayWork.visit_completion.allowed) {
        throw AppError.conflict(
          'Appointment has unresolved pathway work',
          'APPOINTMENT_PATHWAY_WORK_BLOCKED',
          { pathway_work: pathwayWork },
        );
      }
    }

    const mutationResult = mutate
      ? await mutate({ tx, current, mode, pathwayWork })
      : await defaultStatusMutationTx(tx, {
        current,
        targetStatus,
        notes,
        actorUid,
        tenantId: tid,
      });
    const appointment = ensureAppointmentIdentity(
      mutationResult?.appointment,
      current,
      tid,
      targetStatus,
    );
    const statusHistory = await appendAppointmentStatusHistoryTx(tx, {
      tenantId: tid,
      appointmentId: id,
      fromStatus,
      toStatus: targetStatus,
      actorId,
      actorRole,
      reason,
    });
    const resolvedPayload = typeof eventPayload === 'function'
      ? eventPayload({ current, appointment, mutationResult })
      : (eventPayload || mutationResult?.eventPayload || {});
    const resolvedEventType = eventType || EVENT_BY_STATUS[targetStatus];
    if (!resolvedEventType) {
      throw AppError.internal(
        `Appointment transition ${fromStatus} to ${targetStatus} has no lifecycle event`,
        'APPOINTMENT_EVENT_TYPE_REQUIRED',
      );
    }
    const evidence = await appendLifecycleEvidenceTx(tx, {
      mode,
      tenantId: tid,
      appointment,
      prior: current,
      eventType: resolvedEventType,
      source,
      statusHistory,
      actorUid,
      actorRole,
      payload: resolvedPayload,
    });
    return {
      ...mutationResult,
      appointment,
      previous: current,
      from_status: fromStatus,
      to_status: targetStatus,
      mode,
      pathway_work: pathwayWork,
      idempotent: false,
      status_history: statusHistory,
      ...evidence,
    };
  });
}

export async function recordAppointmentCreatedEvidenceTx(tx, {
  tenantId,
  appointment,
  actorUid = null,
  actorId = null,
  actorRole = null,
  source = 'book',
} = {}) {
  const tid = requireTenantId(tenantId);
  if (!appointment?.id || !appointment?.patient_uid) {
    throw AppError.internal(
      'Created appointment identity is incomplete',
      'APPOINTMENT_CREATED_IDENTITY_REQUIRED',
    );
  }
  const mode = await resolveOpPathwayModeTx(tx, tid);
  const statusHistory = await appendAppointmentStatusHistoryTx(tx, {
    tenantId: tid,
    appointmentId: appointment.id,
    fromStatus: null,
    toStatus: appointment.status,
    actorId,
    actorRole,
    reason: 'Appointment created',
  });
  if (mode === PATHWAY_MODES.OFF) {
    return { mode, status_history: statusHistory, canonical: null, outbox: null };
  }
  const canonical = await recordCanonicalClinicalEvent({
    tenantId: tid,
    patientUid: appointment.patient_uid,
    eventType: 'appointment.created',
    eventStatus: normalizeStatus(appointment.status).toLowerCase(),
    sourceTable: 'appointments',
    sourceId: String(appointment.id),
    resourceType: 'appointment',
    resourceId: String(appointment.id),
    actorUid,
    actorRole,
    occurredAt: statusHistory.created_at || appointment.created_at || null,
    summary: 'Appointment created',
    payload: {
      appointment_id: Number(appointment.id),
      appointment_uid: appointment.uid || null,
      patient_uid: appointment.patient_uid,
      tenant_id: tid,
      from_status: null,
      to_status: normalizeStatus(appointment.status),
      source,
      source_status_history_id: statusHistory.id,
    },
    beforeState: null,
    afterState: { status: normalizeStatus(appointment.status) },
    timelineIdempotencyKey: `appointments:${appointment.id}:created:timeline`,
    auditIdempotencyKey: `appointments:${appointment.id}:created:audit`,
  }, { db: tx, strict: true });
  const outbox = await publishEvent({
    eventType: 'appointment.created',
    aggregateType: 'appointment',
    aggregateId: String(appointment.id),
    patientUid: appointment.patient_uid,
    payload: {
      appointment_id: Number(appointment.id),
      appointment_uid: appointment.uid || null,
      patient_uid: appointment.patient_uid,
      tenant_id: tid,
      from_status: null,
      to_status: normalizeStatus(appointment.status),
      source,
      source_status_history_id: statusHistory.id,
      canonical_timeline_event_id: canonical.timeline.id,
      canonical_audit_event_id: canonical.audit.id,
    },
    tx,
    tenantId: tid,
  });
  if (!outbox) {
    throw AppError.internal(
      'Appointment created outbox event was not recorded',
      'APPOINTMENT_OUTBOX_REQUIRED',
    );
  }
  return { mode, status_history: statusHistory, canonical, outbox };
}

export async function recordAppointmentMutationEvidenceTx(tx, {
  tenantId,
  appointment,
  prior,
  eventType,
  source,
  actorUid = null,
  actorRole = null,
  statusHistory = null,
  payload = {},
} = {}) {
  const tid = requireTenantId(tenantId);
  const mode = await resolveOpPathwayModeTx(tx, tid);
  const evidence = await appendLifecycleEvidenceTx(tx, {
    mode,
    tenantId: tid,
    appointment,
    prior,
    eventType,
    source,
    statusHistory,
    actorUid,
    actorRole,
    payload,
  });
  return { mode, ...evidence };
}

export async function recordAppointmentCheckinEvidenceTx(tx, {
  tenantId,
  appointment,
  checkin,
  actorUid = null,
  actorRole = null,
  source = 'kiosk_checkin',
} = {}) {
  const tid = requireTenantId(tenantId);
  if (
    !appointment?.id
    || !appointment?.patient_uid
    || String(appointment.tenant_id) !== String(tid)
    || !checkin?.id
  ) {
    throw AppError.internal(
      'Appointment check-in identity is incomplete',
      'APPOINTMENT_CHECKIN_IDENTITY_REQUIRED',
    );
  }
  const mode = await resolveOpPathwayModeTx(tx, tid);
  if (mode === PATHWAY_MODES.OFF) {
    return { mode, canonical: null, outbox: null };
  }
  const payload = {
    appointment_id: Number(appointment.id),
    appointment_uid: appointment.uid || null,
    patient_uid: appointment.patient_uid,
    tenant_id: tid,
    from_status: normalizeStatus(appointment.status),
    to_status: normalizeStatus(appointment.status),
    source,
    source_status_history_id: null,
    checkin_id: Number(checkin.id),
    checkin_status: String(checkin.status || 'checked_in').toLowerCase(),
    channel: checkin.checkin_channel || checkin.channel || null,
    identity_method: checkin.identity_method || null,
  };
  const canonical = await recordCanonicalClinicalEvent({
    tenantId: tid,
    patientUid: appointment.patient_uid,
    eventType: 'appointment.checked_in',
    eventStatus: payload.checkin_status,
    sourceTable: 'patient_flow_checkins',
    sourceId: String(checkin.id),
    resourceType: 'appointment',
    resourceId: String(appointment.id),
    actorUid,
    actorRole,
    occurredAt: checkin.checked_in_at || checkin.updated_at || null,
    summary: 'Appointment checked in',
    payload,
    beforeState: null,
    afterState: {
      checkin_id: payload.checkin_id,
      checkin_status: payload.checkin_status,
      channel: payload.channel,
    },
    timelineIdempotencyKey:
      `patient_flow_checkins:${checkin.id}:appointment_checked_in:timeline`,
    auditIdempotencyKey:
      `patient_flow_checkins:${checkin.id}:appointment_checked_in:audit`,
  }, { db: tx, strict: true });
  const outbox = await publishEvent({
    eventType: 'appointment.checked_in',
    aggregateType: 'appointment',
    aggregateId: String(appointment.id),
    patientUid: appointment.patient_uid,
    payload: {
      ...payload,
      canonical_timeline_event_id: canonical.timeline.id,
      canonical_audit_event_id: canonical.audit.id,
    },
    tx,
    tenantId: tid,
  });
  if (!outbox) {
    throw AppError.internal(
      'Appointment check-in outbox event was not recorded',
      'APPOINTMENT_OUTBOX_REQUIRED',
    );
  }
  return { mode, canonical, outbox };
}

export default {
  appendAppointmentStatusHistoryTx,
  assertAppointmentTransition,
  lockAppointmentForLifecycleTx,
  recordAppointmentCheckinEvidenceTx,
  recordAppointmentCreatedEvidenceTx,
  recordAppointmentMutationEvidenceTx,
  transitionAppointment,
};
