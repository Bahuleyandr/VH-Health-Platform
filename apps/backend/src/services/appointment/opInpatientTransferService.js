import { createHash, randomUUID } from 'node:crypto';

import { isTenantTransactionClient, setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { canonicalizeRequestRole } from '../../utils/roles.js';
import { requireTenantId } from '../tenant/tenantService.js';
import {
  createOpInpatientTransferReviewTaskTx,
  settleOpInpatientTransferReviewTaskTx,
} from '../workflow/taskService.js';
import { isPathwayNamedClinicalOwnerRole } from '../workflow/workflowHumanOwnerService.js';
import {
  assertPathwayTenantScopeTx,
  lockPathwayRuntimeTx,
  resolvePathwayModeTx,
  resolvePathwayRuntimeRegistryVersionTx,
} from '../pathways/pathwayRuntimePersistence.js';
import {
  appendPathwayTransitionEventTx,
  findPathwayTransitionReplayTx,
} from '../pathways/pathwayTransitionEventService.js';
import { CARE_PATHWAY_KEYS, PATHWAY_MODES } from '../pathways/pathwayMode.js';
import { lockAppointmentForLifecycleTx } from './appointmentLifecycleService.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_RE = /^[A-Za-z0-9_.:-]+$/;
const RECORD_SEPARATOR = '\u001e';
const LIVE_PATHWAY_STATUSES = new Set(['planned', 'active', 'on_hold']);
const LIVE_RUN_STATUSES = new Set(['started', 'running', 'blocked']);
const LIVE_STEP_STATUSES = new Set(['pending', 'in_progress', 'blocked']);
const ACTIONABLE_TASK_STATUSES = new Set(['open', 'in_progress', 'blocked', 'overdue']);
const ADMISSION_PHYSICIAN_ROLES = new Set([
  'DOCTOR',
  'CONSULTANT',
  'JUNIOR_DOCTOR',
  'SENIOR_DOCTOR',
  'ANAESTHETIST',
]);

export const OP_INPATIENT_TRANSFER_HANDOFF_TYPE = 'op_to_inpatient_transfer';
export const OP_INPATIENT_TRANSFER_TASK_KIND = 'op_to_inpatient_transfer_review';
export const OP_INPATIENT_TRANSFER_TASK_CONTRACT = 'op_to_inpatient_transfer_review_v1';

const HANDOFF_COLUMNS = `id, tenant_id, patient_uid, sending_pathway_instance_id,
  sending_workflow_run_id, sending_step_key, receiving_pathway_instance_id,
  receiving_workflow_run_id, receiving_step_key, handoff_type, source_resource_type,
  source_resource_id, urgency_code, policy_due_at, sender_uid, sender_system_key,
  recipient_kind, intended_recipient_uid, intended_recipient_role, intended_team_id,
  external_recipient_ref, status, decline_reason, cancellation_reason, requested_at,
  acknowledged_at, accepted_at, accepted_by_uid, declined_at, completed_at,
  originator_closed_at, cancelled_at, task_id, idempotency_key, request_reason,
  request_fingerprint, metadata, created_at, updated_at`;
const TASK_COLUMNS = `id, tenant_id, workflow_run_id, workflow_step_id, task_kind,
  title, description, patient_uid, encounter_id, related_resource_type,
  related_resource_id, priority, status, assigned_to_uid, assigned_to_role,
  created_by, due_at, completed_at, cancelled_at, cancellation_reason,
  workflow_sla_instance_id, sla_completion_semantics, metadata, created_at, updated_at`;

function requireUuid(value, label, code = 'OP_INPATIENT_TRANSFER_INPUT_INVALID') {
  const text = String(value || '').trim().toLowerCase();
  if (!UUID_RE.test(text)) {
    throw AppError.badRequest(`${label} must be a UUID`, code);
  }
  return text;
}

function isUuid(value) {
  return UUID_RE.test(String(value || '').trim());
}

function hasControlCharacters(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      return true;
    }
  }
  return false;
}

function requireAppointmentId(value) {
  const text = String(value ?? '').trim();
  const id = Number.parseInt(text, 10);
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(id)) {
    throw AppError.badRequest(
      'appointment_id must be a positive integer',
      'OP_INPATIENT_TRANSFER_INPUT_INVALID',
    );
  }
  return id;
}

function requireReason(value) {
  const reason = typeof value === 'string' ? value.trim() : '';
  if (!reason || reason.length > 2000 || hasControlCharacters(reason)) {
    throw AppError.badRequest(
      'reason must be nonblank, at most 2000 characters, and contain no control characters',
      'OP_INPATIENT_TRANSFER_INPUT_INVALID',
    );
  }
  return reason;
}

function requireIdempotencyKey(value) {
  const key = typeof value === 'string' ? value.trim() : '';
  if (!key || key.length > 200 || !IDEMPOTENCY_RE.test(key)) {
    throw AppError.badRequest(
      'Idempotency-Key must be 1-200 chars [A-Za-z0-9_-:.]',
      'OP_INPATIENT_TRANSFER_IDEMPOTENCY_INVALID',
    );
  }
  return key;
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function requestFingerprint({
  tenantId,
  appointmentId,
  pathwayInstanceId,
  senderUid,
  recipientUid,
  reason,
}) {
  return sha256([
    'op_to_inpatient_transfer_request_v1',
    `tenant_id=${tenantId}`,
    `appointment_id=${appointmentId}`,
    `pathway_instance_id=${pathwayInstanceId}`,
    `sender_uid=${senderUid}`,
    `recipient_uid=${recipientUid}`,
    `reason=${reason}`,
  ].join(RECORD_SEPARATOR));
}

function acceptFingerprint({
  tenantId,
  appointmentId,
  pathwayInstanceId,
  handoffId,
  senderUid,
  recipientUid,
}) {
  return sha256([
    'op_to_inpatient_transfer_accept_v1',
    `tenant_id=${tenantId}`,
    `appointment_id=${appointmentId}`,
    `pathway_instance_id=${pathwayInstanceId}`,
    `handoff_id=${handoffId}`,
    `sender_uid=${senderUid}`,
    `recipient_uid=${recipientUid}`,
  ].join(RECORD_SEPARATOR));
}

function namespaceIdempotencyKey(actorUid, operation, rawKey) {
  return `u:${actorUid}:${sha256(
    [operation, `raw_key=${rawKey}`].join(RECORD_SEPARATOR),
  )}`;
}

function normalizeActor(actor) {
  if (!actor || actor.kind !== 'user') {
    throw AppError.unauthorized('Authenticated transfer actor is required');
  }
  const uid = requireUuid(actor.uid, 'actor.uid');
  const roles = [
    ...new Set(
      (Array.isArray(actor.roles) ? actor.roles : [])
        .map(canonicalizeRequestRole)
        .filter(Boolean),
    ),
  ];
  const primaryRole = canonicalizeRequestRole(actor.primaryRole);
  const rawRole = String(actor.rawRole || '').trim().toUpperCase();
  const authorizationMode = String(
    actor.authorizationMode || 'authenticated_appointment_transfer_route',
  ).trim();
  if (
    roles.length === 0
    || !primaryRole
    || !roles.includes(primaryRole)
    || !rawRole
    || !authorizationMode
  ) {
    throw AppError.unauthorized('Authenticated transfer actor role is required');
  }
  return Object.freeze({
    kind: 'user',
    uid,
    roles: Object.freeze(roles),
    primaryRole,
    rawRole,
    authorizationMode,
  });
}

function activeUserRow(row) {
  return Boolean(
    row
    && row.is_active === true
    && String(row.status || '').trim().toLowerCase() === 'active'
    && row.is_deleted === false
    && row.deleted_at === null,
  );
}

function currentActorRowMatches(row, actor, rolePredicate) {
  const rawRole = String(row?.role || '').trim().toUpperCase();
  const role = canonicalizeRequestRole(rawRole);
  return Boolean(
    activeUserRow(row)
    && rawRole === actor.rawRole
    && role === actor.primaryRole
    && actor.roles.includes(role)
    && rolePredicate(role),
  );
}

function transitionActor(actor, currentRole) {
  return Object.freeze({
    kind: 'user',
    uid: actor.uid,
    roles: Object.freeze([currentRole]),
    primaryRole: currentRole,
    rawRole: actor.rawRole,
    authorizationMode: actor.authorizationMode,
  });
}

async function preAuthorizeRecipientTx(tx, tenantId, actor) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT uid, role, is_active, status, is_deleted, deleted_at
       FROM users
      WHERE tenant_id = $1::uuid
        AND uid = $2::uuid
      LIMIT 1`,
    tenantId,
    actor.uid,
  );
  if (!currentActorRowMatches(rows[0], actor, role => ADMISSION_PHYSICIAN_ROLES.has(role))) {
    throw AppError.forbidden(
      'Not authorized for this OP-to-inpatient transfer',
      'OP_INPATIENT_TRANSFER_FORBIDDEN',
    );
  }
}

async function lockTransferActorsTx({
  tx,
  tenantId,
  actor,
  senderUid,
  recipientUid,
  actorMustBeRecipient,
}) {
  const sender = requireUuid(senderUid, 'sender_uid');
  const recipient = requireUuid(recipientUid, 'recipient_uid');
  const uids = [...new Set([sender, recipient])].sort();
  const rows = await tx.$queryRawUnsafe(
    `SELECT uid, role, is_active, status, is_deleted, deleted_at
       FROM users
      WHERE tenant_id = $1::uuid
        AND uid = ANY($2::uuid[])
      ORDER BY uid
      FOR SHARE`,
    tenantId,
    uids,
  );
  const byUid = new Map(rows.map(row => [String(row.uid).toLowerCase(), row]));
  const senderRow = byUid.get(sender);
  const recipientRow = byUid.get(recipient);
  const actorPredicate = actorMustBeRecipient
    ? role => ADMISSION_PHYSICIAN_ROLES.has(role)
    : isPathwayNamedClinicalOwnerRole;
  if (
    sender === recipient
    || !currentActorRowMatches(byUid.get(actor.uid), actor, actorPredicate)
    || !activeUserRow(senderRow)
    || !isPathwayNamedClinicalOwnerRole(senderRow.role)
    || !activeUserRow(recipientRow)
    || !ADMISSION_PHYSICIAN_ROLES.has(canonicalizeRequestRole(recipientRow.role))
  ) {
    throw AppError.forbidden(
      'Not authorized for this OP-to-inpatient transfer',
      'OP_INPATIENT_TRANSFER_FORBIDDEN',
    );
  }
  const currentRole = canonicalizeRequestRole(byUid.get(actor.uid).role);
  return Object.freeze({
    senderUid: sender,
    recipientUid: recipient,
    actor: transitionActor(actor, currentRole),
    currentRole,
  });
}

async function inTenantTx(tenantId, suppliedTx, fn) {
  if (suppliedTx) {
    if (!isTenantTransactionClient(suppliedTx)) {
      throw AppError.internal(
        'OP-to-inpatient transfer requires a tenant transaction',
        'OP_INPATIENT_TRANSFER_TX_REQUIRED',
      );
    }
    await assertPathwayTenantScopeTx({ tx: suppliedTx, tenantId });
    return fn(suppliedTx);
  }
  return setTenantTx(tenantId, async tx => {
    await assertPathwayTenantScopeTx({ tx, tenantId });
    return fn(tx);
  });
}

async function loadExactOpInstanceTx(tx, tenantId, patientUid, appointmentId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT id
       FROM care_pathway_instances
      WHERE tenant_id = $1::uuid
        AND patient_uid = $2::uuid
        AND pathway_key = $3::text
        AND source_episode_type = 'appointment'
        AND source_episode_id = $4::integer::text
      ORDER BY created_at DESC, id DESC
      LIMIT 2
      FOR UPDATE`,
    tenantId,
    patientUid,
    CARE_PATHWAY_KEYS.OP,
    appointmentId,
  );
  if (rows.length !== 1) {
    throw AppError.conflict(
      rows.length === 0
        ? 'The exact OP pathway has not been projected'
        : 'More than one OP pathway is bound to this appointment',
      rows.length === 0
        ? 'OP_INPATIENT_TRANSFER_PATHWAY_PENDING'
        : 'OP_INPATIENT_TRANSFER_PATHWAY_AMBIGUOUS',
    );
  }
  return String(rows[0].id).toLowerCase();
}

function currentRuntimeStep(runtime) {
  const key = String(runtime.run.current_step_key || '').trim();
  if (!key) return null;
  return runtime.steps.find(step => step.step_key === key) || null;
}

async function assertImmutableOpRuntimeTx({
  tx,
  tenantId,
  appointment,
  runtime,
  expectedSenderUid,
}) {
  const registryVersion = await resolvePathwayRuntimeRegistryVersionTx({
    tx,
    tenantId,
    pathwayInstanceId: runtime.instance.id,
  });
  const definitionModule = await import('../pathways/opPathwayDefinition.js');
  const registryModule = await import('../workflow/workflowRuntimeRegistry.js');
  const compiled = definitionModule.compileOpContactToRecoveryDefinition({
    registry: registryModule.workflowRuntimeRegistryV4,
  });
  const exact = (
    String(runtime.instance.patient_uid).toLowerCase()
      === String(appointment.patient_uid).toLowerCase()
    && runtime.instance.pathway_key === CARE_PATHWAY_KEYS.OP
    && Number(runtime.instance.pathway_version) === 1
    && runtime.instance.source_episode_type === 'appointment'
    && String(runtime.instance.source_episode_id) === String(appointment.id)
    && runtime.run.workflow_key === CARE_PATHWAY_KEYS.OP
    && Number(runtime.run.workflow_version) === 1
    && Number(runtime.instance.workflow_run_id) === Number(runtime.run.id)
    && String(runtime.instance.definition_checksum || '') === compiled.checksum
    && String(runtime.run.pathway_definition_checksum || '') === compiled.checksum
    && registryVersion === 4
    && String(runtime.instance.owning_clinician_uid || '').toLowerCase()
      === String(expectedSenderUid).toLowerCase()
  );
  if (!exact) {
    throw AppError.conflict(
      'The OP transfer source binding or V4 definition pin is invalid',
      'OP_INPATIENT_TRANSFER_SOURCE_INVALID',
    );
  }
}

async function assertNewTransferStateTx({ tx, tenantId, appointment, runtime, step }) {
  const mode = await resolvePathwayModeTx({
    tx,
    tenantId,
    pathwayKey: CARE_PATHWAY_KEYS.OP,
  });
  if (
    mode !== PATHWAY_MODES.ACTIVE
    || !appointment.advised_for_admission_at
    || ['CANCELLED', 'NO_SHOW', 'RESCHEDULED'].includes(
      String(appointment.status || '').toUpperCase(),
    )
    || !LIVE_PATHWAY_STATUSES.has(String(runtime.instance.clinical_status || ''))
    || runtime.instance.closed_at
    || !LIVE_RUN_STATUSES.has(String(runtime.run.status || ''))
    || !step
    || step.step_key !== runtime.run.current_step_key
    || !LIVE_STEP_STATUSES.has(String(step.status || ''))
  ) {
    throw AppError.conflict(
      'The appointment does not have a live active-mode OP transfer stage',
      'OP_INPATIENT_TRANSFER_STAGE_UNAVAILABLE',
    );
  }
}

function assertRequestReplayEvents(events) {
  if (
    events.length !== 1
    || events[0].transition_key !== 'op_to_inpatient_transfer_requested'
    || events[0].transition_scope !== 'handoff'
  ) {
    throw AppError.conflict(
      'Transfer request idempotency evidence is invalid',
      'OP_INPATIENT_TRANSFER_REPLAY_INVALID',
    );
  }
}

function assertAcceptReplayEvents(events) {
  if (
    events.length !== 1
    || events[0].transition_key !== 'op_to_inpatient_transfer_accepted'
    || events[0].transition_scope !== 'handoff'
  ) {
    throw AppError.conflict(
      'Transfer acceptance idempotency evidence is invalid',
      'OP_INPATIENT_TRANSFER_REPLAY_INVALID',
    );
  }
}

async function loadReviewTaskTx(tx, tenantId, taskId) {
  if (!taskId) return null;
  const rows = await tx.$queryRawUnsafe(
    `SELECT ${TASK_COLUMNS}
       FROM tasks
      WHERE tenant_id = $1::uuid
        AND id = $2::bigint
      LIMIT 1`,
    tenantId,
    taskId,
  );
  return rows[0] || null;
}

function assertTransferBinding({
  handoff,
  task,
  tenantId,
  appointment,
  runtime,
  senderUid,
  recipientUid,
  requestKey = null,
  requestFingerprint: expectedFingerprint = null,
  requireCurrentStep = false,
}) {
  const sendingStep = runtime.steps.find(
    step => step.step_key === handoff?.sending_step_key,
  ) || null;
  const taskStatusValid = handoff?.status === 'accepted'
    ? task?.status === 'completed'
    : ACTIONABLE_TASK_STATUSES.has(String(task?.status || ''));
  if (
    !handoff
    || String(handoff.tenant_id).toLowerCase() !== tenantId
    || String(handoff.patient_uid).toLowerCase()
      !== String(appointment.patient_uid).toLowerCase()
    || String(handoff.sending_pathway_instance_id).toLowerCase()
      !== String(runtime.instance.id).toLowerCase()
    || Number(handoff.sending_workflow_run_id) !== Number(runtime.run.id)
    || !sendingStep
    || (requireCurrentStep && sendingStep.step_key !== runtime.run.current_step_key)
    || handoff.receiving_pathway_instance_id !== null
    || handoff.receiving_workflow_run_id !== null
    || handoff.receiving_step_key !== null
    || handoff.handoff_type !== OP_INPATIENT_TRANSFER_HANDOFF_TYPE
    || handoff.source_resource_type !== 'appointment'
    || String(handoff.source_resource_id) !== String(appointment.id)
    || handoff.urgency_code !== 'not_applicable'
    || handoff.policy_due_at !== null
    || String(handoff.sender_uid || '').toLowerCase() !== senderUid
    || handoff.sender_system_key !== null
    || handoff.recipient_kind !== 'user'
    || String(handoff.intended_recipient_uid || '').toLowerCase() !== recipientUid
    || senderUid === recipientUid
    || handoff.intended_recipient_role !== null
    || handoff.intended_team_id !== null
    || handoff.external_recipient_ref !== null
    || !handoff.task_id
    || !handoff.request_reason
    || !/^[0-9a-f]{64}$/.test(String(handoff.request_fingerprint || ''))
    || (requestKey !== null && handoff.idempotency_key !== requestKey)
    || (
      expectedFingerprint !== null
      && String(handoff.request_fingerprint) !== expectedFingerprint
    )
    || !task
    || Number(task.id) !== Number(handoff.task_id)
    || task.workflow_run_id !== null
    || task.workflow_step_id !== null
    || task.task_kind !== OP_INPATIENT_TRANSFER_TASK_KIND
    || String(task.patient_uid || '').toLowerCase()
      !== String(appointment.patient_uid).toLowerCase()
    || task.related_resource_type !== 'care_handoff_instance'
    || String(task.related_resource_id || '').toLowerCase()
      !== String(handoff.id).toLowerCase()
    || task.priority !== 'normal'
    || !taskStatusValid
    || String(task.assigned_to_uid || '').toLowerCase() !== recipientUid
    || task.assigned_to_role !== null
    || task.due_at !== null
    || task.workflow_sla_instance_id !== null
    || task.sla_completion_semantics !== 'none'
    || task.metadata?.task_contract !== OP_INPATIENT_TRANSFER_TASK_CONTRACT
    || String(task.metadata?.care_pathway_instance_id || '').toLowerCase()
      !== String(runtime.instance.id).toLowerCase()
    || String(task.metadata?.source_appointment_id || '') !== String(appointment.id)
    || String(task.metadata?.request_fingerprint || '')
      !== String(handoff.request_fingerprint)
  ) {
    throw AppError.conflict(
      'OP-to-inpatient transfer handoff or review task binding is invalid',
      'OP_INPATIENT_TRANSFER_BINDING_INVALID',
    );
  }
  return sendingStep;
}

function transferResult({ handoff, task, transition, appointment, runtime, replayed }) {
  const result = {
    handoff: Object.freeze({
      id: String(handoff.id).toLowerCase(),
      status: handoff.status,
      requested_at: handoff.requested_at || null,
      accepted_at: handoff.accepted_at || null,
    }),
    task: Object.freeze({
      id: Number(task.id),
      task_kind: task.task_kind,
      priority: task.priority,
      status: task.status,
    }),
    transition: Object.freeze({
      transition_key: transition.transition_key,
      occurred_at: transition.occurred_at || null,
    }),
    admission_source: Object.freeze({
      appointment_id: Number(appointment.id),
      source_pathway_instance_id: String(runtime.instance.id).toLowerCase(),
      source_handoff_id: String(handoff.id).toLowerCase(),
      accepted_recipient_uid: handoff.accepted_by_uid
        ? String(handoff.accepted_by_uid).toLowerCase()
        : null,
    }),
    replayed,
  };
  Object.defineProperty(result, '__patient_uid', {
    value: String(appointment.patient_uid).toLowerCase(),
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return Object.freeze(result);
}

export async function requestOpInpatientTransfer({
  tenantId = null,
  appointmentId: rawAppointmentId,
  intendedRecipientUid,
  reason,
  idempotencyKey,
  actor,
  tx = null,
} = {}) {
  const tid = requireUuid(requireTenantId(tenantId), 'tenant_id');
  const appointmentId = requireAppointmentId(rawAppointmentId);
  const recipientUid = requireUuid(intendedRecipientUid, 'intended_recipient_uid');
  const requestReason = requireReason(reason);
  const normalizedActor = normalizeActor(actor);
  const rawKey = requireIdempotencyKey(idempotencyKey);
  if (recipientUid === normalizedActor.uid) {
    throw AppError.badRequest(
      'The inpatient recipient must be different from the OP pathway owner',
      'OP_INPATIENT_TRANSFER_RECIPIENT_INVALID',
    );
  }

  return inTenantTx(tid, tx, async db => {
    const actors = await lockTransferActorsTx({
      tx: db,
      tenantId: tid,
      actor: normalizedActor,
      senderUid: normalizedActor.uid,
      recipientUid,
      actorMustBeRecipient: false,
    });
    const appointment = await lockAppointmentForLifecycleTx(db, {
      tenantId: tid,
      appointmentId,
    });
    const pathwayInstanceId = await loadExactOpInstanceTx(
      db,
      tid,
      appointment.patient_uid,
      appointmentId,
    );
    const runtime = await lockPathwayRuntimeTx({
      tx: db,
      tenantId: tid,
      pathwayInstanceId,
    });
    await assertImmutableOpRuntimeTx({
      tx: db,
      tenantId: tid,
      appointment,
      runtime,
      expectedSenderUid: actors.senderUid,
    });
    if (
      String(runtime.instance.owning_clinician_uid || '').toLowerCase()
      !== normalizedActor.uid
    ) {
      throw AppError.forbidden(
        'Only the exact current OP pathway owner can request this transfer',
        'OP_INPATIENT_TRANSFER_FORBIDDEN',
      );
    }

    const fingerprint = requestFingerprint({
      tenantId: tid,
      appointmentId,
      pathwayInstanceId,
      senderUid: actors.senderUid,
      recipientUid: actors.recipientUid,
      reason: requestReason,
    });
    const key = namespaceIdempotencyKey(
      actors.senderUid,
      'request_op_to_inpatient_transfer',
      rawKey,
    );
    const replay = await findPathwayTransitionReplayTx({
      tx: db,
      tenantId: tid,
      pathwayInstanceId,
      idempotencyKey: key,
      commandFingerprint: fingerprint,
      lockInstance: true,
    });
    if (replay.replayed) {
      assertRequestReplayEvents(replay.events);
      const handoff = runtime.handoffs.find(item => item.idempotency_key === key) || null;
      const task = await loadReviewTaskTx(db, tid, handoff?.task_id);
      assertTransferBinding({
        handoff,
        task,
        tenantId: tid,
        appointment,
        runtime,
        senderUid: actors.senderUid,
        recipientUid: actors.recipientUid,
        requestKey: key,
        requestFingerprint: fingerprint,
      });
      return transferResult({
        handoff,
        task,
        transition: replay.events[0],
        appointment,
        runtime,
        replayed: true,
      });
    }

    const step = currentRuntimeStep(runtime);
    await assertNewTransferStateTx({
      tx: db,
      tenantId: tid,
      appointment,
      runtime,
      step,
    });
    if (runtime.handoffs.some(item => (
      item.handoff_type === OP_INPATIENT_TRANSFER_HANDOFF_TYPE
      && item.source_resource_type === 'appointment'
      && String(item.source_resource_id) === String(appointmentId)
      && ['requested', 'accepted'].includes(item.status)
    ))) {
      throw AppError.conflict(
        'An OP-to-inpatient transfer is already pending or accepted',
        'OP_INPATIENT_TRANSFER_ALREADY_EXISTS',
      );
    }

    const handoffId = randomUUID();
    const task = await createOpInpatientTransferReviewTaskTx({
      tenantId: tid,
      handoffId,
      pathwayInstanceId,
      sourceAppointmentId: appointmentId,
      patientUid: appointment.patient_uid,
      recipientUid: actors.recipientUid,
      senderUid: actors.senderUid,
      requestFingerprint: fingerprint,
      tx: db,
    });
    if (!task) {
      throw AppError.internal(
        'OP-to-inpatient transfer review task was not created',
        'OP_INPATIENT_TRANSFER_TASK_CREATE_FAILED',
      );
    }
    const handoffRows = await db.$queryRawUnsafe(
      `INSERT INTO care_handoff_instances
         (id, tenant_id, patient_uid,
          sending_pathway_instance_id, sending_workflow_run_id, sending_step_key,
          receiving_pathway_instance_id, receiving_workflow_run_id, receiving_step_key,
          handoff_type, source_resource_type, source_resource_id,
          urgency_code, policy_due_at, sender_uid, sender_system_key,
          recipient_kind, intended_recipient_uid, intended_recipient_role,
          intended_team_id, external_recipient_ref, status, task_id,
          idempotency_key, request_reason, request_fingerprint, metadata)
       VALUES
         ($1::uuid, $2::uuid, $3::uuid,
          $4::uuid, $5::integer, $6::text,
          NULL, NULL, NULL,
          'op_to_inpatient_transfer', 'appointment', $7::integer::text,
          'not_applicable', NULL, $8::uuid, NULL,
          'user', $9::uuid, NULL,
          NULL, NULL, 'requested', $10::bigint,
          $11::text, $12::text, $13::char(64), $14::jsonb)
       RETURNING ${HANDOFF_COLUMNS}`,
      handoffId,
      tid,
      appointment.patient_uid,
      pathwayInstanceId,
      runtime.run.id,
      step.step_key,
      appointmentId,
      actors.senderUid,
      actors.recipientUid,
      task.id,
      key,
      requestReason,
      fingerprint,
      JSON.stringify({
        appointment_uid: appointment.uid || null,
        requested_by_uid: actors.senderUid,
        requested_by_role: actors.currentRole,
        registry_version: 4,
      }),
    );
    const handoff = handoffRows[0];
    if (!handoff) {
      throw AppError.internal(
        'OP-to-inpatient transfer handoff was not created',
        'OP_INPATIENT_TRANSFER_CREATE_FAILED',
      );
    }
    const appended = await appendPathwayTransitionEventTx({
      tx: db,
      tenantId: tid,
      pathwayInstanceId,
      pathwayInstance: runtime.instance,
      workflowRunId: runtime.run.id,
      workflowStepId: step.id,
      idempotencyKey: key,
      commandFingerprint: fingerprint,
      transitionScope: 'handoff',
      transitionKey: 'op_to_inpatient_transfer_requested',
      stageKey: step.step_key,
      previousState: { transfer_status: null },
      newState: { transfer_status: 'requested' },
      sourceResourceType: 'care_handoff_instance',
      sourceResourceId: handoffId,
      actor: actors.actor,
      eventPayload: {
        handoff_id: handoffId,
        appointment_id: appointmentId,
        pathway_instance_id: pathwayInstanceId,
        sender_uid: actors.senderUid,
        intended_recipient_uid: actors.recipientUid,
        review_task_id: task.id,
        request_fingerprint: fingerprint,
      },
      metadata: {
        pathway_runtime: {
          definition_checksum: runtime.instance.definition_checksum,
          registry_version: 4,
        },
      },
    });
    return transferResult({
      handoff,
      task,
      transition: appended.event,
      appointment,
      runtime,
      replayed: false,
    });
  });
}

async function loadRecipientPointerTx(tx, tenantId, handoffId, appointmentId, actorUid) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT sending_pathway_instance_id, sending_workflow_run_id,
            sending_step_key, source_resource_id, sender_uid,
            intended_recipient_uid, task_id
       FROM care_handoff_instances
      WHERE tenant_id = $1::uuid
        AND id = $2::uuid
        AND handoff_type = 'op_to_inpatient_transfer'
        AND source_resource_type = 'appointment'
        AND source_resource_id = $3::integer::text
        AND recipient_kind = 'user'
        AND intended_recipient_uid = $4::uuid
      LIMIT 1`,
    tenantId,
    handoffId,
    appointmentId,
    actorUid,
  );
  if (!rows[0]) {
    throw AppError.forbidden(
      'Not authorized for this OP-to-inpatient transfer',
      'OP_INPATIENT_TRANSFER_FORBIDDEN',
    );
  }
  return rows[0];
}

export async function acceptOpInpatientTransfer({
  tenantId = null,
  appointmentId: rawAppointmentId,
  handoffId: rawHandoffId,
  idempotencyKey,
  actor,
  tx = null,
} = {}) {
  const tid = requireUuid(requireTenantId(tenantId), 'tenant_id');
  const appointmentId = requireAppointmentId(rawAppointmentId);
  const normalizedActor = normalizeActor(actor);
  const rawKey = requireIdempotencyKey(idempotencyKey);

  return inTenantTx(tid, tx, async db => {
    await preAuthorizeRecipientTx(db, tid, normalizedActor);
    if (!isUuid(rawHandoffId)) {
      throw AppError.forbidden(
        'Not authorized for this OP-to-inpatient transfer',
        'OP_INPATIENT_TRANSFER_FORBIDDEN',
      );
    }
    const handoffId = String(rawHandoffId).trim().toLowerCase();
    const pointer = await loadRecipientPointerTx(
      db,
      tid,
      handoffId,
      appointmentId,
      normalizedActor.uid,
    );
    const actors = await lockTransferActorsTx({
      tx: db,
      tenantId: tid,
      actor: normalizedActor,
      senderUid: pointer.sender_uid,
      recipientUid: pointer.intended_recipient_uid,
      actorMustBeRecipient: true,
    });
    const appointment = await lockAppointmentForLifecycleTx(db, {
      tenantId: tid,
      appointmentId,
    });
    const runtime = await lockPathwayRuntimeTx({
      tx: db,
      tenantId: tid,
      pathwayInstanceId: pointer.sending_pathway_instance_id,
    });
    await assertImmutableOpRuntimeTx({
      tx: db,
      tenantId: tid,
      appointment,
      runtime,
      expectedSenderUid: actors.senderUid,
    });

    const fingerprint = acceptFingerprint({
      tenantId: tid,
      appointmentId,
      pathwayInstanceId: runtime.instance.id,
      handoffId,
      senderUid: actors.senderUid,
      recipientUid: actors.recipientUid,
    });
    const key = namespaceIdempotencyKey(
      actors.recipientUid,
      'accept_op_to_inpatient_transfer',
      rawKey,
    );
    const replay = await findPathwayTransitionReplayTx({
      tx: db,
      tenantId: tid,
      pathwayInstanceId: runtime.instance.id,
      idempotencyKey: key,
      commandFingerprint: fingerprint,
      lockInstance: true,
    });
    const handoff = runtime.handoffs.find(
      item => String(item.id).toLowerCase() === handoffId,
    ) || null;
    const task = await loadReviewTaskTx(db, tid, handoff?.task_id);
    const sendingStep = assertTransferBinding({
      handoff,
      task,
      tenantId: tid,
      appointment,
      runtime,
      senderUid: actors.senderUid,
      recipientUid: actors.recipientUid,
    });
    if (replay.replayed) {
      assertAcceptReplayEvents(replay.events);
      if (
        handoff.status !== 'accepted'
        || !handoff.accepted_at
        || String(handoff.accepted_by_uid || '').toLowerCase() !== actors.recipientUid
        || task.status !== 'completed'
      ) {
        throw AppError.conflict(
          'Transfer acceptance replay state is invalid',
          'OP_INPATIENT_TRANSFER_REPLAY_INVALID',
        );
      }
      return transferResult({
        handoff,
        task,
        transition: replay.events[0],
        appointment,
        runtime,
        replayed: true,
      });
    }

    await assertNewTransferStateTx({
      tx: db,
      tenantId: tid,
      appointment,
      runtime,
      step: sendingStep,
    });
    if (
      sendingStep.step_key !== runtime.run.current_step_key
      || Number(pointer.sending_workflow_run_id) !== Number(runtime.run.id)
      || pointer.sending_step_key !== sendingStep.step_key
      || String(pointer.source_resource_id) !== String(appointmentId)
      || Number(pointer.task_id) !== Number(handoff.task_id)
      || handoff.status !== 'requested'
      || handoff.accepted_at !== null
      || handoff.accepted_by_uid !== null
    ) {
      throw AppError.conflict(
        'The OP-to-inpatient transfer is no longer pending at its exact source stage',
        'OP_INPATIENT_TRANSFER_NOT_PENDING',
      );
    }

    const settledTask = await settleOpInpatientTransferReviewTaskTx({
      tenantId: tid,
      id: task.id,
      handoffId,
      pathwayInstanceId: runtime.instance.id,
      appointmentId,
      patientUid: appointment.patient_uid,
      requestFingerprint: handoff.request_fingerprint,
      recipientUid: actors.recipientUid,
      actorUid: actors.recipientUid,
      tx: db,
    });
    const handoffRows = await db.$queryRawUnsafe(
      `UPDATE care_handoff_instances
          SET status = 'accepted',
              accepted_at = NOW(),
              accepted_by_uid = $3::uuid,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND id = $2::uuid
          AND status = 'requested'
          AND accepted_at IS NULL
          AND accepted_by_uid IS NULL
          AND sending_pathway_instance_id = $4::uuid
          AND sending_workflow_run_id = $5::integer
          AND sending_step_key = $6::text
          AND receiving_pathway_instance_id IS NULL
          AND receiving_workflow_run_id IS NULL
          AND receiving_step_key IS NULL
          AND handoff_type = 'op_to_inpatient_transfer'
          AND source_resource_type = 'appointment'
          AND source_resource_id = $7::integer::text
          AND sender_uid = $8::uuid
          AND recipient_kind = 'user'
          AND intended_recipient_uid = $3::uuid
          AND task_id = $9::bigint
          AND request_fingerprint = $10::char(64)
        RETURNING ${HANDOFF_COLUMNS}`,
      tid,
      handoffId,
      actors.recipientUid,
      runtime.instance.id,
      runtime.run.id,
      sendingStep.step_key,
      appointmentId,
      actors.senderUid,
      task.id,
      handoff.request_fingerprint,
    );
    const acceptedHandoff = handoffRows[0];
    if (!acceptedHandoff) {
      throw AppError.conflict(
        'The OP-to-inpatient transfer changed before acceptance',
        'OP_INPATIENT_TRANSFER_CAS_CONFLICT',
      );
    }
    const appended = await appendPathwayTransitionEventTx({
      tx: db,
      tenantId: tid,
      pathwayInstanceId: runtime.instance.id,
      pathwayInstance: runtime.instance,
      workflowRunId: runtime.run.id,
      workflowStepId: sendingStep.id,
      idempotencyKey: key,
      commandFingerprint: fingerprint,
      transitionScope: 'handoff',
      transitionKey: 'op_to_inpatient_transfer_accepted',
      stageKey: sendingStep.step_key,
      previousState: { transfer_status: 'requested' },
      newState: { transfer_status: 'accepted' },
      sourceResourceType: 'care_handoff_instance',
      sourceResourceId: handoffId,
      actor: actors.actor,
      eventPayload: {
        handoff_id: handoffId,
        appointment_id: appointmentId,
        pathway_instance_id: runtime.instance.id,
        sender_uid: actors.senderUid,
        intended_recipient_uid: actors.recipientUid,
        accepted_by_uid: actors.recipientUid,
        review_task_id: task.id,
        request_fingerprint: handoff.request_fingerprint,
      },
      metadata: {
        pathway_runtime: {
          definition_checksum: runtime.instance.definition_checksum,
          registry_version: 4,
        },
      },
    });
    return transferResult({
      handoff: acceptedHandoff,
      task: settledTask,
      transition: appended.event,
      appointment,
      runtime,
      replayed: false,
    });
  });
}

export const __testing__ = Object.freeze({
  ADMISSION_PHYSICIAN_ROLES,
  acceptFingerprint,
  assertTransferBinding,
  namespaceIdempotencyKey,
  requestFingerprint,
});

export default {
  acceptOpInpatientTransfer,
  requestOpInpatientTransfer,
};
