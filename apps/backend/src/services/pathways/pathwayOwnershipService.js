import { createHash, randomUUID } from 'node:crypto';

import { isTenantTransactionClient, setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { canonicalizeRequestRole } from '../../utils/roles.js';
import {
  assertInpatientPendingResultOwnerTransferAllowedTx,
} from '../emr/inpatientPendingResultOwnerTransferGuard.js';
import { requireTenantId } from '../tenant/tenantService.js';
import {
  createCoveringTransferReviewTaskTx,
  settleCoveringTransferReviewTaskTx,
} from '../workflow/taskService.js';
import {
  isPathwayNamedClinicalOwnerRole,
} from '../workflow/workflowHumanOwnerService.js';
import {
  assignPathwayOwnerCasTx,
  assertPathwayTenantScopeTx,
  getCarePathwayInstanceTx,
  lockPathwayRuntimeTx,
} from './pathwayRuntimePersistence.js';
import {
  appendPathwayTransitionEventTx,
  findPathwayTransitionReplayTx,
} from './pathwayTransitionEventService.js';
import { isPathwayOwnerTransferStepSupported } from './pathwayOwnershipStagePolicy.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_RE = /^[A-Za-z0-9_.:-]+$/;
const ACTIONABLE_TASK_STATUSES = new Set(['open', 'in_progress', 'blocked', 'overdue']);
const LIVE_SLA_STATUSES = new Set(['active', 'breached', 'escalated']);
const TRANSFER_TASK_CONTRACT = 'covering_clinician_transfer_review_v1';
const TRANSFER_HANDOFF_TYPE = 'covering_clinician_reassignment';
const TRANSFER_URGENCY_SENTINEL = 'not_applicable';
const HANDOFF_COLUMNS = `id, tenant_id, patient_uid, sending_pathway_instance_id,
  sending_workflow_run_id, sending_step_key, receiving_pathway_instance_id,
  receiving_workflow_run_id, receiving_step_key, handoff_type, source_resource_type,
  source_resource_id, urgency_code, policy_due_at, sender_uid, sender_system_key,
  recipient_kind, intended_recipient_uid, intended_recipient_role, intended_team_id,
  external_recipient_ref, status, decline_reason, cancellation_reason, requested_at,
  acknowledged_at, accepted_at, accepted_by_uid, declined_at, completed_at,
  originator_closed_at, cancelled_at, task_id, idempotency_key, request_reason,
  request_fingerprint, metadata, created_at, updated_at`;
const TRANSFER_TASK_COLUMNS = `id, tenant_id, workflow_run_id, workflow_step_id,
  task_kind, title, patient_uid, related_resource_type, related_resource_id,
  priority, status, assigned_to_uid, assigned_to_role, created_by, due_at,
  completed_at, cancelled_at, cancellation_reason, workflow_sla_instance_id,
  sla_completion_semantics, metadata, created_at, updated_at`;

function requireUuid(value, label) {
  const text = String(value || '').trim().toLowerCase();
  if (!UUID_RE.test(text)) {
    throw AppError.badRequest(`${label} must be a UUID`, 'PATHWAY_OWNERSHIP_INPUT_INVALID');
  }
  return text;
}

function requireText(value, label, max = 4000) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > max) {
    throw AppError.badRequest(
      `${label} must be nonblank and at most ${max} characters`,
      'PATHWAY_OWNERSHIP_INPUT_INVALID',
    );
  }
  return text;
}

function requireIdempotencyKey(value) {
  const key = typeof value === 'string' ? value.trim() : '';
  if (!key || key.length > 200 || !IDEMPOTENCY_RE.test(key)) {
    throw AppError.badRequest(
      'Idempotency-Key must be 1-200 chars [A-Za-z0-9_-:.]',
      'PATHWAY_OWNERSHIP_IDEMPOTENCY_INVALID',
    );
  }
  return key;
}

function stableJson(value) {
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function namespaceKey(actorUid, operation, rawKey) {
  return `u:${actorUid}:${fingerprint({ operation, rawKey })}`;
}

function normalizeActor(actor) {
  if (!actor || actor.kind !== 'user') {
    throw AppError.unauthorized('Authenticated pathway actor is required');
  }
  const uid = requireUuid(actor.uid, 'actor.uid');
  const roles = [...new Set((Array.isArray(actor.roles) ? actor.roles : [])
    .map(canonicalizeRequestRole)
    .filter(Boolean))];
  const primaryRole = canonicalizeRequestRole(actor.primaryRole);
  const rawRole = String(actor.rawRole || '').trim().toUpperCase();
  if (!primaryRole || !roles.includes(primaryRole)) {
    throw AppError.unauthorized('Authenticated primary pathway role is required');
  }
  if (!rawRole) {
    throw AppError.unauthorized('Authenticated raw pathway role is required');
  }
  return Object.freeze({ ...actor, uid, roles: Object.freeze(roles), primaryRole, rawRole });
}

function isEligiblePathwayOwnerUserRow(row) {
  return Boolean(
    row
    && row.is_active === true
    && String(row.status || '').trim().toLowerCase() === 'active'
    && row.is_deleted === false
    && row.deleted_at === null
    && isPathwayNamedClinicalOwnerRole(row.role),
  );
}

async function lockClinicalActorsTx(
  tx,
  tenantId,
  actor,
  additionalUids = [],
  requiredEligibleUids = [],
) {
  const normalized = normalizeActor(actor);
  const uids = [...new Set([normalized.uid, ...additionalUids.map((uid) => (
    requireUuid(uid, 'clinical_actor_uid')
  ))])].sort();
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
  const byUid = new Map(rows.map((row) => [String(row.uid).toLowerCase(), row]));
  const currentRow = byUid.get(normalized.uid);
  const currentRawRole = String(currentRow?.role || '').trim().toUpperCase();
  const currentRole = canonicalizeRequestRole(currentRawRole);
  const requiredEligible = [...new Set(requiredEligibleUids.map((uid) => (
    requireUuid(uid, 'required_clinical_actor_uid')
  )))];
  if (
    !isEligiblePathwayOwnerUserRow(currentRow)
    || currentRawRole !== normalized.rawRole
    || currentRole !== normalized.primaryRole
    || !normalized.roles.includes(normalized.primaryRole)
    || requiredEligible.some((uid) => !isEligiblePathwayOwnerUserRow(byUid.get(uid)))
  ) {
    throw AppError.forbidden('Current actor is not authorized for pathway ownership');
  }
  return Object.freeze({
    actor: Object.freeze({
      ...normalized,
      roles: Object.freeze([currentRole]),
      primaryRole: currentRole,
      rawRole: currentRawRole,
    }),
    uid: normalized.uid,
    role: currentRole,
    usersByUid: byUid,
  });
}

async function inTenantTx(tenantId, suppliedTx, fn) {
  if (suppliedTx) {
    if (!isTenantTransactionClient(suppliedTx)) {
      throw AppError.internal(
        'Pathway ownership requires a branded tenant transaction',
        'PATHWAY_RUNTIME_TX_REQUIRED',
      );
    }
    await assertPathwayTenantScopeTx({ tx: suppliedTx, tenantId });
    return fn(suppliedTx);
  }
  return setTenantTx(tenantId, async (tx) => {
    await assertPathwayTenantScopeTx({ tx, tenantId });
    return fn(tx);
  });
}

function currentStep(runtime) {
  const key = String(runtime.run.current_step_key || '').trim();
  if (!key) return null;
  return runtime.steps.find((step) => step.step_key === key) || null;
}

function requireLiveOwnershipStep(runtime) {
  const step = currentStep(runtime);
  const stepSupportsOwnerTransfer = isPathwayOwnerTransferStepSupported({
    pathwayKey: runtime.instance.pathway_key,
    stepKind: step?.step_kind,
  });
  if (
    !['planned', 'active', 'on_hold'].includes(runtime.instance.clinical_status)
    || runtime.instance.closed_at
    || !['started', 'running', 'blocked'].includes(runtime.run.status)
    || !step
    || !['pending', 'in_progress', 'blocked'].includes(step.status)
    || !stepSupportsOwnerTransfer
  ) {
    throw AppError.conflict(
      'Care pathway has no live human ownership stage',
      'PATHWAY_OWNER_STAGE_UNAVAILABLE',
    );
  }
  return step;
}

function actionableTasks(runtime) {
  return runtime.tasks.filter((task) => ACTIONABLE_TASK_STATUSES.has(String(task.status || '')));
}

function liveSlaIdsForTasks(runtime, tasks) {
  const linked = new Set(tasks.map((task) => String(task.workflow_sla_instance_id || ''))
    .filter(Boolean));
  return [...new Set(runtime.slas
    .filter((sla) => (
      linked.has(String(sla.id))
      && !sla.completed_at
      && LIVE_SLA_STATUSES.has(String(sla.status || ''))
    ))
    .map((sla) => String(sla.id)))].sort();
}

async function moveActionableWorkTx({
  tx,
  tenantId,
  runtime,
  expectedOwnerUid,
  nextOwnerUid,
}) {
  const tasks = actionableTasks(runtime);
  const taskIds = tasks.map((task) => Number(task.id)).sort((a, b) => a - b);
  if (taskIds.length > 0) {
    const taskRows = await tx.$queryRawUnsafe(
      `UPDATE tasks
          SET assigned_to_uid = $3::uuid,
              assigned_to_role = NULL,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND id = ANY($2::bigint[])
          AND status IN ('open', 'in_progress', 'blocked', 'overdue')
          AND (
            ($4::uuid IS NULL AND assigned_to_uid IS NULL AND assigned_to_role IS NOT NULL)
            OR
            ($4::uuid IS NOT NULL
             AND assigned_to_uid = $4::uuid
             AND assigned_to_role IS NULL)
          )
        RETURNING id`,
      tenantId,
      taskIds,
      nextOwnerUid,
      expectedOwnerUid,
    );
    if (taskRows.length !== taskIds.length) {
      throw AppError.conflict(
        'Pathway task ownership changed before ownership operation completion',
        'PATHWAY_OWNER_TASK_CAS_CONFLICT',
      );
    }
  }

  const slaIds = liveSlaIdsForTasks(runtime, tasks);
  if (slaIds.length > 0) {
    const slaRows = await tx.$queryRawUnsafe(
      `UPDATE workflow_sla_instances
          SET assigned_user_uid = $3::uuid,
              assigned_role_codes = ARRAY[]::text[],
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND id = ANY($2::uuid[])
          AND completed_at IS NULL
          AND status IN ('active', 'breached', 'escalated')
          AND (
            ($4::uuid IS NULL
             AND assigned_user_uid IS NULL
             AND CARDINALITY(COALESCE(assigned_role_codes, ARRAY[]::text[])) = 1)
            OR
            ($4::uuid IS NOT NULL
             AND assigned_user_uid = $4::uuid
             AND CARDINALITY(COALESCE(assigned_role_codes, ARRAY[]::text[])) = 0)
          )
        RETURNING id`,
      tenantId,
      slaIds,
      nextOwnerUid,
      expectedOwnerUid,
    );
    if (slaRows.length !== slaIds.length) {
      throw AppError.conflict(
        'Pathway SLA ownership changed before ownership operation completion',
        'PATHWAY_OWNER_SLA_CAS_CONFLICT',
      );
    }
  }
  return Object.freeze({ taskIds: Object.freeze(taskIds), slaIds: Object.freeze(slaIds) });
}

function transitionMetadata(runtime) {
  return {
    pathway_runtime: {
      definition_checksum: runtime.instance.definition_checksum,
    },
  };
}

async function replayForOperationTx({
  tx,
  tenantId,
  runtime,
  idempotencyKey,
  commandFingerprint,
  transitionKey,
}) {
  const replay = await findPathwayTransitionReplayTx({
    tx,
    tenantId,
    pathwayInstanceId: runtime.instance.id,
    idempotencyKey,
    commandFingerprint,
    lockInstance: true,
  });
  if (!replay.replayed) return null;
  if (
    replay.events.length !== 1
    || replay.events[0].transition_key !== transitionKey
  ) {
    throw AppError.conflict(
      'Pathway ownership idempotency key was reused for a different operation',
      'PATHWAY_IDEMPOTENCY_KEY_REUSED',
    );
  }
  return replay.events;
}

async function ownershipResultTx({ tx, tenantId, instanceId, handoff = null, task = null, events, replayed }) {
  return Object.freeze({
    instance: await getCarePathwayInstanceTx({ tx, tenantId, id: instanceId }),
    ...(handoff ? { handoff } : {}),
    ...(task ? { task } : {}),
    events,
    replayed,
  });
}

async function loadHandoffByIdTx(tx, tenantId, handoffId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT ${HANDOFF_COLUMNS}
       FROM care_handoff_instances
      WHERE tenant_id = $1::uuid
        AND id = $2::uuid
      LIMIT 1`,
    tenantId,
    handoffId,
  );
  return rows[0] || null;
}

async function loadTransferTaskTx(tx, tenantId, taskId) {
  if (!taskId) return null;
  const rows = await tx.$queryRawUnsafe(
    `SELECT ${TRANSFER_TASK_COLUMNS} FROM tasks
      WHERE tenant_id = $1::uuid AND id = $2::bigint
      LIMIT 1`,
    tenantId,
    taskId,
  );
  return rows[0] || null;
}

export async function resolvePathwayInstanceIdForHandoff({ tenantId = null, handoffId } = {}) {
  const tid = requireUuid(requireTenantId(tenantId), 'tenant_id');
  const id = requireUuid(handoffId, 'handoff_id');
  return inTenantTx(tid, null, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `SELECT sending_pathway_instance_id
         FROM care_handoff_instances
        WHERE tenant_id = $1::uuid
          AND id = $2::uuid
          AND handoff_type = 'covering_clinician_reassignment'
        LIMIT 1`,
      tid,
      id,
    );
    if (!rows[0]?.sending_pathway_instance_id) {
      throw AppError.notFound('Care pathway handoff not found', 'CARE_PATHWAY_HANDOFF_NOT_FOUND');
    }
    return String(rows[0].sending_pathway_instance_id).toLowerCase();
  });
}

export async function getCarePathwayOwnerTransferForRecipient({
  tenantId = null,
  handoffId,
  actor,
} = {}) {
  const tid = requireUuid(requireTenantId(tenantId), 'tenant_id');
  const id = requireUuid(handoffId, 'handoff_id');
  const normalizedActor = normalizeActor(actor);
  return inTenantTx(tid, null, async (tx) => {
    const currentActor = await lockClinicalActorsTx(tx, tid, normalizedActor);
    const rows = await tx.$queryRawUnsafe(
      `SELECT chi.id AS handoff_id,
              chi.sending_pathway_instance_id AS pathway_instance_id,
              chi.patient_uid,
              cpi.pathway_key,
              cpi.clinical_status AS pathway_clinical_status,
              chi.status,
              chi.sender_uid,
              chi.intended_recipient_uid,
              chi.request_reason,
              chi.requested_at,
              chi.accepted_at,
              chi.declined_at,
              chi.cancelled_at
         FROM care_handoff_instances chi
         JOIN care_pathway_instances cpi
           ON cpi.tenant_id = chi.tenant_id
          AND cpi.id = chi.sending_pathway_instance_id
          AND cpi.patient_uid = chi.patient_uid
          AND cpi.workflow_run_id = chi.sending_workflow_run_id
         JOIN tasks review_task
           ON review_task.tenant_id = chi.tenant_id
          AND review_task.id = chi.task_id
          AND review_task.patient_uid = chi.patient_uid
        WHERE chi.tenant_id = $1::uuid
          AND chi.id = $2::uuid
          AND chi.handoff_type = 'covering_clinician_reassignment'
          AND chi.recipient_kind = 'user'
          AND chi.intended_recipient_uid = $3::uuid
          AND chi.sender_uid IS NOT NULL
          AND chi.receiving_pathway_instance_id = chi.sending_pathway_instance_id
          AND chi.receiving_workflow_run_id = chi.sending_workflow_run_id
          AND chi.receiving_step_key = chi.sending_step_key
          AND chi.source_resource_type = 'care_pathway_instance'
          AND chi.source_resource_id = chi.sending_pathway_instance_id::text
          AND NULLIF(BTRIM(chi.request_reason), '') IS NOT NULL
          AND chi.request_fingerprint ~ '^[a-f0-9]{64}$'
          AND review_task.workflow_run_id IS NULL
          AND review_task.workflow_step_id IS NULL
          AND review_task.task_kind = 'pathway_owner_transfer_review'
          AND review_task.related_resource_type = 'care_handoff_instance'
          AND review_task.related_resource_id = chi.id::text
          AND review_task.assigned_to_uid = chi.intended_recipient_uid
          AND review_task.assigned_to_role IS NULL
          AND review_task.workflow_sla_instance_id IS NULL
          AND review_task.sla_completion_semantics = 'none'
          AND review_task.metadata ->> 'task_contract' = $4::text
          AND review_task.metadata ->> 'request_fingerprint' = chi.request_fingerprint
          AND (
            (chi.status = 'requested'
             AND review_task.status IN ('open', 'in_progress', 'blocked', 'overdue')
             AND cpi.owning_clinician_uid = chi.sender_uid)
            OR
            (
              (
                (chi.status = 'accepted'
                 AND chi.accepted_at IS NOT NULL
                 AND chi.accepted_by_uid = chi.intended_recipient_uid
                 AND review_task.status = 'completed'
                 AND review_task.completed_at IS NOT NULL)
                OR
                (chi.status = 'declined'
                 AND chi.declined_at IS NOT NULL
                 AND NULLIF(BTRIM(chi.decline_reason), '') IS NOT NULL
                 AND review_task.status = 'cancelled'
                 AND review_task.cancelled_at IS NOT NULL
                 AND review_task.cancellation_reason IS NOT DISTINCT FROM chi.decline_reason)
                OR
                (chi.status = 'cancelled'
                 AND chi.cancelled_at IS NOT NULL
                 AND NULLIF(BTRIM(chi.cancellation_reason), '') IS NOT NULL
                 AND review_task.status = 'cancelled'
                 AND review_task.cancelled_at IS NOT NULL
                 AND review_task.cancellation_reason IS NOT DISTINCT FROM chi.cancellation_reason)
              )
              AND EXISTS (
                SELECT 1
                  FROM care_pathway_transition_events evidence
                 WHERE evidence.tenant_id = chi.tenant_id
                   AND evidence.pathway_instance_id = cpi.id
                   AND evidence.patient_uid = chi.patient_uid
                   AND evidence.transition_scope = 'handoff'
                   AND evidence.transition_key = CASE chi.status
                     WHEN 'accepted' THEN 'pathway_owner_transfer_accepted'
                     WHEN 'declined' THEN 'pathway_owner_transfer_declined'
                     WHEN 'cancelled' THEN 'pathway_owner_transfer_cancelled'
                   END
                   AND evidence.source_resource_type = 'care_handoff_instance'
                   AND evidence.source_resource_id = chi.id::text
                   AND evidence.actor_uid = CASE
                     WHEN chi.status IN ('accepted', 'declined') THEN chi.intended_recipient_uid
                     WHEN chi.status = 'cancelled' THEN chi.sender_uid
                   END
                   AND evidence.system_actor_key IS NULL
                   AND evidence.effect_ordinal = 0
                   AND evidence.new_state ->> 'transfer_status' = chi.status
              )
            )
          )
        LIMIT 1`,
      tid,
      id,
      currentActor.uid,
      TRANSFER_TASK_CONTRACT,
    );
    if (!rows[0]) {
      throw AppError.forbidden('Not authorized for this covering transfer');
    }
    return Object.freeze(rows[0]);
  });
}

export async function claimCarePathwayOwner({
  tenantId = null,
  pathwayInstanceId,
  idempotencyKey,
  actor,
  tx = null,
} = {}) {
  const tid = requireUuid(requireTenantId(tenantId), 'tenant_id');
  const instanceId = requireUuid(pathwayInstanceId, 'pathway_instance_id');
  const normalizedActor = normalizeActor(actor);
  const rawKey = requireIdempotencyKey(idempotencyKey);
  const key = namespaceKey(normalizedActor.uid, 'claim_care_pathway_owner', rawKey);
  return inTenantTx(tid, tx, async (db) => {
    const currentActor = await lockClinicalActorsTx(db, tid, normalizedActor);
    const runtime = await lockPathwayRuntimeTx({ tx: db, tenantId: tid, pathwayInstanceId: instanceId });
    const commandFingerprint = fingerprint({
      operation: 'claim_care_pathway_owner',
      tenantId: tid,
      pathwayInstanceId: instanceId,
      actorUid: currentActor.uid,
      actorRole: currentActor.role,
    });
    const replayEvents = await replayForOperationTx({
      tx: db,
      tenantId: tid,
      runtime,
      idempotencyKey: key,
      commandFingerprint,
      transitionKey: 'pathway_owner_claimed',
    });
    if (replayEvents) {
      if (String(runtime.instance.owning_clinician_uid || '').toLowerCase() !== currentActor.uid) {
        throw AppError.forbidden('Not authorized to claim this care pathway');
      }
      return ownershipResultTx({
        tx: db, tenantId: tid, instanceId, events: replayEvents, replayed: true,
      });
    }

    if (
      runtime.instance.owning_clinician_uid
      || !['planned', 'active', 'on_hold'].includes(runtime.instance.clinical_status)
      || runtime.instance.closed_at
    ) {
      throw AppError.conflict(
        'Care pathway is not available for role-queue claim',
        'PATHWAY_OWNER_CLAIM_UNAVAILABLE',
      );
    }
    const step = requireLiveOwnershipStep(runtime);
    const stepTasks = step
      ? actionableTasks(runtime).filter((task) => Number(task.workflow_step_id) === Number(step.id))
      : [];
    const queueRole = String(step?.assigned_role || runtime.instance.accountable_role || '')
      .trim().toUpperCase();
    if (
      stepTasks.length === 0
      || !queueRole
      || currentActor.role !== queueRole
      || stepTasks.some((task) => (
        task.assigned_to_uid
        || String(task.assigned_to_role || '').trim().toUpperCase() !== queueRole
      ))
    ) {
      throw AppError.forbidden('Not authorized to claim this care pathway');
    }

    const updatedInstance = await assignPathwayOwnerCasTx({
      tx: db,
      tenantId: tid,
      instanceId,
      expectedOwnerUid: null,
      nextOwnerUid: currentActor.uid,
      actorUid: currentActor.uid,
    });
    const affected = await moveActionableWorkTx({
      tx: db,
      tenantId: tid,
      runtime,
      expectedOwnerUid: null,
      nextOwnerUid: currentActor.uid,
    });
    const appended = await appendPathwayTransitionEventTx({
      tx: db,
      tenantId: tid,
      pathwayInstanceId: instanceId,
      pathwayInstance: updatedInstance,
      workflowRunId: runtime.run.id,
      idempotencyKey: key,
      commandFingerprint,
      transitionScope: 'pathway',
      transitionKey: 'pathway_owner_claimed',
      stageKey: step.step_key,
      workflowStepId: step.id,
      previousState: { owning_clinician_uid: null, owning_role: queueRole },
      newState: { owning_clinician_uid: currentActor.uid, owning_role: null },
      sourceResourceType: 'care_pathway_instance',
      sourceResourceId: instanceId,
      actor: currentActor.actor,
      eventPayload: {
        prior_role: queueRole,
        new_owner_uid: currentActor.uid,
        current_database_role: currentActor.role,
        affected_task_ids: affected.taskIds,
        affected_sla_ids: affected.slaIds,
      },
      metadata: transitionMetadata(runtime),
    });
    return ownershipResultTx({
      tx: db,
      tenantId: tid,
      instanceId,
      events: [appended.event],
      replayed: false,
    });
  });
}

export async function requestCarePathwayOwnerTransfer({
  tenantId = null,
  pathwayInstanceId,
  coveringClinicianUid,
  reason,
  idempotencyKey,
  actor,
  tx = null,
} = {}) {
  const tid = requireUuid(requireTenantId(tenantId), 'tenant_id');
  const instanceId = requireUuid(pathwayInstanceId, 'pathway_instance_id');
  const targetUid = requireUuid(coveringClinicianUid, 'covering_clinician_uid');
  const requestReason = requireText(reason, 'reason');
  const normalizedActor = normalizeActor(actor);
  const rawKey = requireIdempotencyKey(idempotencyKey);
  const key = namespaceKey(normalizedActor.uid, 'request_care_pathway_owner_transfer', rawKey);
  return inTenantTx(tid, tx, async (db) => {
    const currentActor = await lockClinicalActorsTx(db, tid, normalizedActor, [targetUid]);
    const runtime = await lockPathwayRuntimeTx({ tx: db, tenantId: tid, pathwayInstanceId: instanceId });
    const commandFingerprint = fingerprint({
      operation: 'request_care_pathway_owner_transfer',
      tenantId: tid,
      pathwayInstanceId: instanceId,
      coveringClinicianUid: targetUid,
      reason: requestReason,
      actorUid: currentActor.uid,
      actorRole: currentActor.role,
    });
    const replayEvents = await replayForOperationTx({
      tx: db,
      tenantId: tid,
      runtime,
      idempotencyKey: key,
      commandFingerprint,
      transitionKey: 'pathway_owner_transfer_requested',
    });
    if (String(runtime.instance.owning_clinician_uid || '').toLowerCase() !== currentActor.uid) {
      throw AppError.forbidden('Not authorized to transfer this care pathway');
    }
    if (replayEvents) {
      const handoffRows = await db.$queryRawUnsafe(
        `SELECT ${HANDOFF_COLUMNS} FROM care_handoff_instances
          WHERE tenant_id = $1::uuid AND idempotency_key = $2::text LIMIT 1`,
        tid,
        key,
      );
      const handoff = handoffRows[0];
      if (!handoff) {
        throw AppError.conflict(
          'Transfer request evidence is missing its handoff',
          'PATHWAY_TRANSFER_BINDING_INVALID',
        );
      }
      const task = await loadTransferTaskTx(db, tid, handoff.task_id);
      return ownershipResultTx({
        tx: db, tenantId: tid, instanceId, handoff, task, events: replayEvents, replayed: true,
      });
    }

    await assertInpatientPendingResultOwnerTransferAllowedTx({
      tx: db,
      tenantId: tid,
      pathwayInstance: runtime.instance,
      outcome: 'requested',
    });
    if (!isEligiblePathwayOwnerUserRow(currentActor.usersByUid.get(targetUid))) {
      throw AppError.forbidden('Covering clinician is not eligible for pathway ownership');
    }

    const step = requireLiveOwnershipStep(runtime);
    if (targetUid === currentActor.uid) {
      throw AppError.badRequest(
        'Covering clinician must be different from the current owner',
        'PATHWAY_TRANSFER_TARGET_INVALID',
      );
    }
    if (runtime.handoffs.some((handoff) => (
      handoff.handoff_type === TRANSFER_HANDOFF_TYPE
      && handoff.status === 'requested'
    ))) {
      throw AppError.conflict(
        'A covering clinician transfer is already pending',
        'PATHWAY_TRANSFER_ALREADY_PENDING',
      );
    }
    const handoffId = randomUUID();
    const task = await createCoveringTransferReviewTaskTx({
      tenantId: tid,
      handoffId,
      pathwayInstanceId: instanceId,
      patientUid: runtime.instance.patient_uid,
      encounterId: runtime.instance.encounter_id || null,
      recipientUid: targetUid,
      senderUid: currentActor.uid,
      requestFingerprint: commandFingerprint,
      tx: db,
    });
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
          $4::uuid, $5::integer, $6::text,
          $7::text, 'care_pathway_instance', $4::text,
          $8::text, NULL, $9::uuid, NULL,
          'user', $10::uuid, NULL,
          NULL, NULL, 'requested', $11::bigint,
          $12::text, $13::text, $14::char(64), $15::jsonb)
       RETURNING ${HANDOFF_COLUMNS}`,
      handoffId,
      tid,
      runtime.instance.patient_uid,
      instanceId,
      runtime.run.id,
      step.step_key,
      TRANSFER_HANDOFF_TYPE,
      TRANSFER_URGENCY_SENTINEL,
      currentActor.uid,
      targetUid,
      task.id,
      key,
      requestReason,
      commandFingerprint,
      JSON.stringify({
        requested_by_uid: currentActor.uid,
        requested_by_role: currentActor.role,
      }),
    );
    const handoff = handoffRows[0];
    if (!handoff) throw AppError.internal('Transfer request insert failed');
    const appended = await appendPathwayTransitionEventTx({
      tx: db,
      tenantId: tid,
      pathwayInstanceId: instanceId,
      pathwayInstance: runtime.instance,
      workflowRunId: runtime.run.id,
      workflowStepId: step.id,
      idempotencyKey: key,
      commandFingerprint,
      transitionScope: 'handoff',
      transitionKey: 'pathway_owner_transfer_requested',
      stageKey: step.step_key,
      previousState: { owning_clinician_uid: currentActor.uid, transfer_status: null },
      newState: { owning_clinician_uid: currentActor.uid, transfer_status: 'requested' },
      sourceResourceType: 'care_handoff_instance',
      sourceResourceId: handoffId,
      actor: currentActor.actor,
      eventPayload: {
        handoff_id: handoffId,
        prior_owner_uid: currentActor.uid,
        intended_recipient_uid: targetUid,
        request_reason: requestReason,
        request_fingerprint: commandFingerprint,
        review_task_id: task.id,
      },
      metadata: transitionMetadata(runtime),
    });
    return ownershipResultTx({
      tx: db,
      tenantId: tid,
      instanceId,
      handoff,
      task,
      events: [appended.event],
      replayed: false,
    });
  });
}

async function loadTransferPointerTx(db, tenantId, handoffId) {
  const pointers = await db.$queryRawUnsafe(
    `SELECT sending_pathway_instance_id, sender_uid, intended_recipient_uid
       FROM care_handoff_instances
      WHERE tenant_id = $1::uuid
        AND id = $2::uuid
        AND handoff_type = 'covering_clinician_reassignment'
      LIMIT 1`,
    tenantId,
    handoffId,
  );
  const instanceId = pointers[0]?.sending_pathway_instance_id;
  if (!instanceId || !pointers[0]?.sender_uid || !pointers[0]?.intended_recipient_uid) {
    throw AppError.notFound('Care pathway handoff not found', 'CARE_PATHWAY_HANDOFF_NOT_FOUND');
  }
  return pointers[0];
}

async function resolveLockedTransferRuntimeTx(db, tenantId, handoffId, pointer) {
  const instanceId = pointer.sending_pathway_instance_id;
  const runtime = await lockPathwayRuntimeTx({
    tx: db,
    tenantId,
    pathwayInstanceId: instanceId,
  });
  const handoff = runtime.handoffs.find(
    (candidate) => String(candidate.id).toLowerCase() === String(handoffId).toLowerCase(),
  ) || await loadHandoffByIdTx(db, tenantId, handoffId);
  if (!handoff) {
    throw AppError.notFound('Care pathway handoff not found', 'CARE_PATHWAY_HANDOFF_NOT_FOUND');
  }
  return { runtime, handoff, instanceId: String(instanceId).toLowerCase() };
}

function assertTransferBinding(runtime, handoff, { requireCurrentStep = false } = {}) {
  const step = runtime.steps.find((candidate) => candidate.step_key === handoff.sending_step_key)
    || null;
  const activeStep = currentStep(runtime);
  if (
    handoff.handoff_type !== TRANSFER_HANDOFF_TYPE
    || String(handoff.sending_pathway_instance_id).toLowerCase()
      !== String(runtime.instance.id).toLowerCase()
    || Number(handoff.sending_workflow_run_id) !== Number(runtime.run.id)
    || String(handoff.receiving_pathway_instance_id).toLowerCase()
      !== String(runtime.instance.id).toLowerCase()
    || Number(handoff.receiving_workflow_run_id) !== Number(runtime.run.id)
    || handoff.receiving_step_key !== handoff.sending_step_key
    || handoff.source_resource_type !== 'care_pathway_instance'
    || String(handoff.source_resource_id).toLowerCase() !== String(runtime.instance.id).toLowerCase()
    || !step
    || (requireCurrentStep && activeStep?.step_key !== step.step_key)
    || !handoff.task_id
    || !handoff.request_reason
    || !handoff.request_fingerprint
  ) {
    throw AppError.conflict(
      'Covering-transfer binding is invalid',
      'PATHWAY_TRANSFER_BINDING_INVALID',
    );
  }
  return step;
}

async function transitionTransfer({
  tenantId,
  handoffId,
  idempotencyKey,
  actor,
  operation,
  transitionKey,
  outcome,
  reason = null,
  tx = null,
}) {
  const tid = requireUuid(requireTenantId(tenantId), 'tenant_id');
  const id = requireUuid(handoffId, 'handoff_id');
  const normalizedActor = normalizeActor(actor);
  const rawKey = requireIdempotencyKey(idempotencyKey);
  const cleanReason = outcome === 'accepted' ? null : requireText(reason, 'reason');
  const key = namespaceKey(normalizedActor.uid, operation, rawKey);
  return inTenantTx(tid, tx, async (db) => {
    const pointer = await loadTransferPointerTx(db, tid, id);
    const currentActor = await lockClinicalActorsTx(db, tid, normalizedActor, [
      pointer.sender_uid,
      pointer.intended_recipient_uid,
    ]);
    const locked = await resolveLockedTransferRuntimeTx(db, tid, id, pointer);
    const { runtime, handoff, instanceId } = locked;
    if (
      String(handoff.sender_uid || '').toLowerCase()
        !== String(pointer.sender_uid).toLowerCase()
      || String(handoff.intended_recipient_uid || '').toLowerCase()
        !== String(pointer.intended_recipient_uid).toLowerCase()
      || String(handoff.sending_pathway_instance_id || '').toLowerCase()
        !== String(pointer.sending_pathway_instance_id).toLowerCase()
    ) {
      throw AppError.conflict(
        'Covering transfer changed while ownership locks were acquired',
        'PATHWAY_TRANSFER_CAS_CONFLICT',
      );
    }
    const commandFingerprint = fingerprint({
      operation,
      tenantId: tid,
      handoffId: id,
      reason: cleanReason,
      actorUid: currentActor.uid,
      actorRole: currentActor.role,
    });
    const replayEvents = await replayForOperationTx({
      tx: db,
      tenantId: tid,
      runtime,
      idempotencyKey: key,
      commandFingerprint,
      transitionKey,
    });
    const recipientUid = String(handoff.intended_recipient_uid || '').toLowerCase();
    const senderUid = String(handoff.sender_uid || '').toLowerCase();
    const isRecipientOperation = outcome === 'accepted' || outcome === 'declined';
    if (
      (isRecipientOperation && currentActor.uid !== recipientUid)
      || (!isRecipientOperation && currentActor.uid !== senderUid)
    ) {
      throw AppError.forbidden('Not authorized for this covering transfer');
    }
    if (replayEvents) {
      const expectedStatus = outcome;
      const expectedCurrentOwner = outcome === 'accepted' ? recipientUid : senderUid;
      if (
        handoff.status !== expectedStatus
        || String(runtime.instance.owning_clinician_uid || '').toLowerCase()
          !== expectedCurrentOwner
        || (outcome === 'accepted'
          && String(handoff.accepted_by_uid || '').toLowerCase() !== currentActor.uid)
      ) {
        throw AppError.conflict(
          'Covering transfer replay state is invalid',
          'PATHWAY_TRANSFER_REPLAY_INVALID',
        );
      }
      const task = await loadTransferTaskTx(db, tid, handoff.task_id);
      return ownershipResultTx({
        tx: db,
        tenantId: tid,
        instanceId,
        handoff,
        task,
        events: replayEvents,
        replayed: true,
      });
    }

    await assertInpatientPendingResultOwnerTransferAllowedTx({
      tx: db,
      tenantId: tid,
      pathwayInstance: runtime.instance,
      outcome,
    });
    const step = assertTransferBinding(runtime, handoff, {
      requireCurrentStep: outcome === 'accepted',
    });
    if (handoff.status !== 'requested') {
      throw AppError.conflict('Covering transfer is no longer pending', 'PATHWAY_TRANSFER_NOT_PENDING');
    }
    if (String(runtime.instance.owning_clinician_uid || '').toLowerCase() !== senderUid) {
      throw AppError.conflict(
        'Care pathway owner changed after the transfer request',
        'PATHWAY_TRANSFER_OWNER_CHANGED',
      );
    }
    const reviewTask = await loadTransferTaskTx(db, tid, handoff.task_id);
    if (
      !reviewTask
      || !ACTIONABLE_TASK_STATUSES.has(reviewTask.status)
      || reviewTask.task_kind !== 'pathway_owner_transfer_review'
      || reviewTask.workflow_run_id !== null
      || reviewTask.workflow_step_id !== null
      || String(reviewTask.assigned_to_uid || '').toLowerCase() !== recipientUid
      || reviewTask.assigned_to_role
      || reviewTask.workflow_sla_instance_id !== null
      || reviewTask.sla_completion_semantics !== 'none'
      || reviewTask.related_resource_type !== 'care_handoff_instance'
      || String(reviewTask.related_resource_id || '').toLowerCase() !== id
      || reviewTask.metadata?.task_contract !== TRANSFER_TASK_CONTRACT
      || String(reviewTask.metadata?.canonical_encounter_id || '').toLowerCase()
        !== String(runtime.instance.encounter_id || '').toLowerCase()
      || String(reviewTask.metadata?.request_fingerprint || '') !== String(handoff.request_fingerprint)
    ) {
      throw AppError.conflict(
        'Covering-transfer review task binding is invalid',
        'PATHWAY_TRANSFER_BINDING_INVALID',
      );
    }

    let affected = Object.freeze({ taskIds: Object.freeze([]), slaIds: Object.freeze([]) });
    if (outcome === 'accepted') {
      await assignPathwayOwnerCasTx({
        tx: db,
        tenantId: tid,
        instanceId,
        expectedOwnerUid: senderUid,
        nextOwnerUid: recipientUid,
        actorUid: currentActor.uid,
      });
      affected = await moveActionableWorkTx({
        tx: db,
        tenantId: tid,
        runtime,
        expectedOwnerUid: senderUid,
        nextOwnerUid: recipientUid,
      });
    }
    const task = await settleCoveringTransferReviewTaskTx({
      tenantId: tid,
      id: handoff.task_id,
      handoffId: id,
      recipientUid,
      actorUid: currentActor.uid,
      outcome,
      reason: cleanReason,
      tx: db,
    });
    const handoffRows = await db.$queryRawUnsafe(
      `UPDATE care_handoff_instances
          SET status = $3::text,
              accepted_at = CASE WHEN $3::text = 'accepted' THEN NOW() ELSE NULL END,
              accepted_by_uid = CASE WHEN $3::text = 'accepted' THEN $4::uuid ELSE NULL END,
              declined_at = CASE WHEN $3::text = 'declined' THEN NOW() ELSE NULL END,
              decline_reason = CASE WHEN $3::text = 'declined' THEN $5::text ELSE NULL END,
              cancelled_at = CASE WHEN $3::text = 'cancelled' THEN NOW() ELSE NULL END,
              cancellation_reason = CASE WHEN $3::text = 'cancelled' THEN $5::text ELSE NULL END,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND id = $2::uuid
          AND status = 'requested'
          AND sender_uid = $6::uuid
          AND intended_recipient_uid = $7::uuid
        RETURNING ${HANDOFF_COLUMNS}`,
      tid,
      id,
      outcome,
      currentActor.uid,
      cleanReason,
      senderUid,
      recipientUid,
    );
    const updatedHandoff = handoffRows[0];
    if (!updatedHandoff) {
      throw AppError.conflict(
        'Covering transfer changed before completion',
        'PATHWAY_TRANSFER_CAS_CONFLICT',
      );
    }
    const nextOwnerUid = outcome === 'accepted' ? recipientUid : senderUid;
    const appended = await appendPathwayTransitionEventTx({
      tx: db,
      tenantId: tid,
      pathwayInstanceId: instanceId,
      workflowRunId: runtime.run.id,
      workflowStepId: step.id,
      idempotencyKey: key,
      commandFingerprint,
      transitionScope: 'handoff',
      transitionKey,
      stageKey: step.step_key,
      previousState: { owning_clinician_uid: senderUid, transfer_status: 'requested' },
      newState: { owning_clinician_uid: nextOwnerUid, transfer_status: outcome },
      sourceResourceType: 'care_handoff_instance',
      sourceResourceId: id,
      actor: currentActor.actor,
      eventPayload: {
        handoff_id: id,
        prior_owner_uid: senderUid,
        new_owner_uid: nextOwnerUid,
        intended_recipient_uid: recipientUid,
        request_reason: handoff.request_reason,
        request_fingerprint: handoff.request_fingerprint,
        request_actor_uid: senderUid,
        acting_uid: currentActor.uid,
        current_database_role: currentActor.role,
        affected_task_ids: affected.taskIds,
        affected_sla_ids: affected.slaIds,
        review_task_id: task.id,
        ...(cleanReason ? { outcome_reason: cleanReason } : {}),
      },
      metadata: transitionMetadata(runtime),
    });
    return ownershipResultTx({
      tx: db,
      tenantId: tid,
      instanceId,
      handoff: updatedHandoff,
      task,
      events: [appended.event],
      replayed: false,
    });
  });
}

export function acceptCarePathwayOwnerTransfer(input = {}) {
  return transitionTransfer({
    ...input,
    operation: 'accept_care_pathway_owner_transfer',
    transitionKey: 'pathway_owner_transfer_accepted',
    outcome: 'accepted',
  });
}

export function declineCarePathwayOwnerTransfer(input = {}) {
  return transitionTransfer({
    ...input,
    operation: 'decline_care_pathway_owner_transfer',
    transitionKey: 'pathway_owner_transfer_declined',
    outcome: 'declined',
  });
}

export function cancelCarePathwayOwnerTransfer(input = {}) {
  return transitionTransfer({
    ...input,
    operation: 'cancel_care_pathway_owner_transfer',
    transitionKey: 'pathway_owner_transfer_cancelled',
    outcome: 'cancelled',
  });
}

export default {
  resolvePathwayInstanceIdForHandoff,
  getCarePathwayOwnerTransferForRecipient,
  claimCarePathwayOwner,
  requestCarePathwayOwnerTransfer,
  acceptCarePathwayOwnerTransfer,
  declineCarePathwayOwnerTransfer,
  cancelCarePathwayOwnerTransfer,
};
