import { createHash, randomUUID } from 'node:crypto';

import { ED_ROUTE_ROLES } from '../../config/routeRolePolicy.js';
import { isTenantTransactionClient, setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { canonicalizeRequestRole } from '../../utils/roles.js';
import { requireTenantId } from '../tenant/tenantService.js';
import {
  createEdDestinationHandoffReviewTaskTx,
  settleEdDestinationHandoffReviewTaskTx,
} from '../workflow/taskService.js';
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

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_RE = /^[A-Za-z0-9_.:-]+$/;
const ROLE_RE = /^[A-Z][A-Z0-9_]{1,79}$/;
const RECORD_SEPARATOR = '\u001e';
const LIVE_PATHWAY_STATUSES = new Set(['planned', 'active', 'on_hold']);
const LIVE_RUN_STATUSES = new Set(['started', 'running', 'blocked']);
const LIVE_STEP_STATUSES = new Set(['pending', 'in_progress', 'blocked']);
const ACTIONABLE_TASK_STATUSES = new Set(['open', 'in_progress', 'blocked', 'overdue']);
const DECISION_STEP_KEY = 'await_destination_acceptance';
const HANDOFF_TYPE = 'ed_destination_handoff';
const TASK_KIND = 'ed_destination_handoff_review';
const TASK_CONTRACT = 'ed_destination_handoff_review_v1';
const ED_HANDOFF_RECIPIENT_ROLES = new Set(ED_ROUTE_ROLES);

export const ED_HANDOFF_DESTINATIONS = Object.freeze([
  'ward',
  'icu',
  'hdu',
  'surgery',
  'external_transfer',
]);

const HANDOFF_COLUMNS = `id, tenant_id, patient_uid, sending_pathway_instance_id,
  sending_workflow_run_id, sending_step_key, receiving_pathway_instance_id,
  receiving_workflow_run_id, receiving_step_key, handoff_type, source_resource_type,
  source_resource_id, urgency_code, policy_due_at, sender_uid, sender_system_key,
  recipient_kind, intended_recipient_uid, intended_recipient_role, intended_team_id,
  external_recipient_ref, status, decline_reason, reroute_reason, cancellation_reason,
  requested_at, acknowledged_at, accepted_at, accepted_by_uid, declined_at,
  completed_at, originator_closed_at, cancelled_at, task_id, idempotency_key,
  request_reason, request_fingerprint, metadata, created_at, updated_at`;
const TASK_COLUMNS = `id, tenant_id, workflow_run_id, workflow_step_id, task_kind,
  title, description, patient_uid, encounter_id, related_resource_type,
  related_resource_id, priority, status, assigned_to_uid, assigned_to_role,
  created_by, due_at, completed_at, cancelled_at, cancellation_reason,
  workflow_sla_instance_id, sla_completion_semantics, metadata, created_at, updated_at`;

function requireUuid(value, label, code = 'ED_DESTINATION_HANDOFF_INPUT_INVALID') {
  const text = String(value || '').trim().toLowerCase();
  if (!UUID_RE.test(text)) {
    throw AppError.badRequest(`${label} must be a UUID`, code);
  }
  return text;
}

function isUuid(value) {
  return UUID_RE.test(String(value || '').trim());
}

function requireVisitId(value) {
  const text = String(value ?? '').trim();
  const id = Number.parseInt(text, 10);
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(id)) {
    throw AppError.badRequest(
      'emergency_visit_id must be a positive integer',
      'ED_DESTINATION_HANDOFF_INPUT_INVALID',
    );
  }
  return id;
}

function hasControlCharacters(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return true;
  }
  return false;
}

function requireReason(value, label = 'reason') {
  const reason = typeof value === 'string' ? value.trim() : '';
  if (!reason || reason.length > 2000 || hasControlCharacters(reason)) {
    throw AppError.badRequest(
      `${label} must be nonblank, at most 2000 characters, and contain no control characters`,
      'ED_DESTINATION_HANDOFF_INPUT_INVALID',
    );
  }
  return reason;
}

function optionalReason(value, label = 'reason') {
  if (value === null || value === undefined || value === '') return null;
  return requireReason(value, label);
}

function requireDestination(value) {
  const destination = String(value || '').trim().toLowerCase();
  if (!ED_HANDOFF_DESTINATIONS.includes(destination)) {
    throw AppError.badRequest(
      `destination must be one of: ${ED_HANDOFF_DESTINATIONS.join(', ')}`,
      'ED_DESTINATION_HANDOFF_INPUT_INVALID',
    );
  }
  return destination;
}

function requireRole(value) {
  const role = String(value || '').trim().toUpperCase();
  if (!ROLE_RE.test(role) || !ED_HANDOFF_RECIPIENT_ROLES.has(role)) {
    throw AppError.badRequest(
      'intended_recipient_role must be a role with access to the ED destination queue',
      'ED_DESTINATION_HANDOFF_RECIPIENT_ROLE_INVALID',
    );
  }
  return role;
}

function requireIdempotencyKey(value) {
  const key = typeof value === 'string' ? value.trim() : '';
  if (!key || key.length > 200 || !IDEMPOTENCY_RE.test(key)) {
    throw AppError.badRequest(
      'Idempotency-Key must be 1-200 chars [A-Za-z0-9_-:.]',
      'ED_DESTINATION_HANDOFF_IDEMPOTENCY_INVALID',
    );
  }
  return key;
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function requestFingerprint({
  tenantId,
  emergencyVisitId,
  pathwayInstanceId,
  senderUid,
  recipientRole,
  destination,
  reason,
  supersedesHandoffId = null,
}) {
  return sha256([
    'ed_destination_handoff_request_v1',
    `tenant_id=${tenantId}`,
    `emergency_visit_id=${emergencyVisitId}`,
    `pathway_instance_id=${pathwayInstanceId}`,
    `sender_uid=${senderUid}`,
    `recipient_role=${recipientRole}`,
    `destination=${destination}`,
    `reason=${reason}`,
    `supersedes_handoff_id=${supersedesHandoffId || 'none'}`,
  ].join(RECORD_SEPARATOR));
}

function decisionFingerprint({
  tenantId,
  emergencyVisitId,
  pathwayInstanceId,
  handoffId,
  recipientRole,
  actorUid,
  decision,
  reason,
}) {
  return sha256([
    'ed_destination_handoff_decision_v1',
    `tenant_id=${tenantId}`,
    `emergency_visit_id=${emergencyVisitId}`,
    `pathway_instance_id=${pathwayInstanceId}`,
    `handoff_id=${handoffId}`,
    `recipient_role=${recipientRole}`,
    `actor_uid=${actorUid}`,
    `decision=${decision}`,
    `reason=${reason || 'none'}`,
  ].join(RECORD_SEPARATOR));
}

function namespaceIdempotencyKey(actorUid, operation, rawKey) {
  return `u:${actorUid}:${sha256(
    [operation, `raw_key=${rawKey}`].join(RECORD_SEPARATOR),
  )}`;
}

function normalizeActor(actor) {
  if (!actor || actor.kind !== 'user') {
    throw AppError.unauthorized('Authenticated ED handoff actor is required');
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
    actor.authorizationMode || 'authenticated_ed_handoff_route',
  ).trim();
  if (
    roles.length === 0
    || !primaryRole
    || !roles.includes(primaryRole)
    || !rawRole
    || !authorizationMode
  ) {
    throw AppError.unauthorized('Authenticated ED handoff actor role is required');
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

async function inTenantTx(tenantId, suppliedTx, fn) {
  if (suppliedTx) {
    if (!isTenantTransactionClient(suppliedTx)) {
      throw AppError.internal(
        'ED destination handoff requires a tenant transaction',
        'ED_DESTINATION_HANDOFF_TX_REQUIRED',
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

async function lockActorTx(tx, tenantId, actor) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT uid, role, is_active, status, is_deleted, deleted_at
       FROM users
      WHERE tenant_id = $1::uuid
        AND uid = $2::uuid
      LIMIT 1
      FOR SHARE`,
    tenantId,
    actor.uid,
  );
  const row = rows[0];
  const rawRole = String(row?.role || '').trim().toUpperCase();
  const currentRole = canonicalizeRequestRole(rawRole);
  if (
    !activeUserRow(row)
    || rawRole !== actor.rawRole
    || currentRole !== actor.primaryRole
    || !actor.roles.includes(currentRole)
  ) {
    throw AppError.forbidden(
      'Not authorized for this ED destination handoff',
      'ED_DESTINATION_HANDOFF_FORBIDDEN',
    );
  }
  return Object.freeze({
    uid: actor.uid,
    rawRole,
    currentRole,
    actor: transitionActor(actor, currentRole),
  });
}

async function lockVisitTx(tx, tenantId, emergencyVisitId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT visit.id,
            visit.patient_uid,
            visit.encounter_id,
            visit.attending_doctor_uid,
            visit.status,
            visit.disposition,
            visit.departure_at
       FROM emergency_visits AS visit
      WHERE visit.tenant_id = $1::uuid
        AND visit.id = $2::integer
      LIMIT 1
      FOR UPDATE`,
    tenantId,
    emergencyVisitId,
  );
  if (!rows[0]) throw AppError.notFound('Emergency visit not found');
  return rows[0];
}

async function loadExactEmergencyInstanceTx(tx, tenantId, visit) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT id
       FROM care_pathway_instances
      WHERE tenant_id = $1::uuid
        AND patient_uid = $2::uuid
        AND pathway_key = $3::text
        AND source_episode_type = 'emergency_visit'
        AND source_episode_id = $4::integer::text
      ORDER BY created_at DESC, id DESC
      LIMIT 2
      FOR UPDATE`,
    tenantId,
    visit.patient_uid,
    CARE_PATHWAY_KEYS.EMERGENCY,
    visit.id,
  );
  if (rows.length !== 1) {
    throw AppError.conflict(
      rows.length === 0
        ? 'The exact ED pathway has not been projected'
        : 'More than one ED pathway is bound to this emergency visit',
      rows.length === 0
        ? 'ED_DESTINATION_HANDOFF_PATHWAY_PENDING'
        : 'ED_DESTINATION_HANDOFF_PATHWAY_AMBIGUOUS',
    );
  }
  return String(rows[0].id).toLowerCase();
}

function currentRuntimeStep(runtime) {
  const key = String(runtime.run.current_step_key || '').trim();
  if (!key) return null;
  return runtime.steps.find(step => step.step_key === key) || null;
}

async function assertEmergencyRuntimeTx({ tx, tenantId, visit, runtime }) {
  const registryVersion = await resolvePathwayRuntimeRegistryVersionTx({
    tx,
    tenantId,
    pathwayInstanceId: runtime.instance.id,
  });
  const definitionModule = await import('../pathways/emergencyPathwayDefinition.js');
  const registryModule = await import('../workflow/workflowRuntimeRegistry.js');
  const compiled = definitionModule.compileEmergencyArrivalToAftercareDefinition({
    registry: registryModule.workflowRuntimeRegistryV5,
  });
  const exact = (
    String(runtime.instance.patient_uid).toLowerCase()
      === String(visit.patient_uid).toLowerCase()
    && runtime.instance.pathway_key === CARE_PATHWAY_KEYS.EMERGENCY
    && Number(runtime.instance.pathway_version) === 1
    && runtime.instance.source_episode_type === 'emergency_visit'
    && String(runtime.instance.source_episode_id) === String(visit.id)
    && runtime.run.workflow_key === CARE_PATHWAY_KEYS.EMERGENCY
    && Number(runtime.run.workflow_version) === 1
    && Number(runtime.instance.workflow_run_id) === Number(runtime.run.id)
    && String(runtime.instance.definition_checksum || '') === compiled.checksum
    && String(runtime.run.pathway_definition_checksum || '') === compiled.checksum
    && registryVersion === 5
    && String(runtime.instance.owning_clinician_uid || '').toLowerCase()
      === String(visit.attending_doctor_uid || '').toLowerCase()
  );
  if (!exact) {
    throw AppError.conflict(
      'The ED handoff source binding or V5 definition pin is invalid',
      'ED_DESTINATION_HANDOFF_SOURCE_INVALID',
    );
  }
}

async function assertRequestStageTx({ tx, tenantId, visit, runtime, step, actorUid }) {
  const mode = await resolvePathwayModeTx({
    tx,
    tenantId,
    pathwayKey: CARE_PATHWAY_KEYS.EMERGENCY,
  });
  if (
    mode !== PATHWAY_MODES.ACTIVE
    || !visit.patient_uid
    || !visit.attending_doctor_uid
    || String(visit.attending_doctor_uid).toLowerCase() !== actorUid
    || visit.status !== 'awaiting_disposition'
    || visit.disposition !== null
    || visit.departure_at !== null
    || !LIVE_PATHWAY_STATUSES.has(String(runtime.instance.clinical_status || ''))
    || runtime.instance.closed_at
    || !LIVE_RUN_STATUSES.has(String(runtime.run.status || ''))
    || !step
    || step.step_key !== DECISION_STEP_KEY
    || step.step_key !== runtime.run.current_step_key
    || !LIVE_STEP_STATUSES.has(String(step.status || ''))
  ) {
    throw AppError.conflict(
      'The visit does not have a live active-mode ED destination handoff stage owned by this clinician',
      'ED_DESTINATION_HANDOFF_STAGE_UNAVAILABLE',
    );
  }
}

async function loadTaskTx(tx, tenantId, taskId) {
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

function assertBinding({
  handoff,
  task,
  tenantId,
  visit,
  runtime,
  senderUid,
  recipientRole,
  requestKey = null,
  expectedFingerprint = null,
}) {
  const sendingStep = runtime.steps.find(
    step => step.step_key === handoff?.sending_step_key,
  ) || null;
  const terminalTaskValid = handoff?.status === 'accepted'
    ? task?.status === 'completed'
    : handoff?.status === 'declined'
      ? task?.status === 'cancelled'
      : ACTIONABLE_TASK_STATUSES.has(String(task?.status || ''));
  if (
    !handoff
    || String(handoff.tenant_id).toLowerCase() !== tenantId
    || String(handoff.patient_uid).toLowerCase() !== String(visit.patient_uid).toLowerCase()
    || String(handoff.sending_pathway_instance_id).toLowerCase()
      !== String(runtime.instance.id).toLowerCase()
    || Number(handoff.sending_workflow_run_id) !== Number(runtime.run.id)
    || !sendingStep
    || sendingStep.step_key !== DECISION_STEP_KEY
    || handoff.receiving_pathway_instance_id !== null
    || handoff.receiving_workflow_run_id !== null
    || handoff.receiving_step_key !== null
    || handoff.handoff_type !== HANDOFF_TYPE
    || handoff.source_resource_type !== 'emergency_visit'
    || String(handoff.source_resource_id) !== String(visit.id)
    || handoff.urgency_code !== 'not_applicable'
    || handoff.policy_due_at !== null
    || String(handoff.sender_uid || '').toLowerCase() !== senderUid
    || handoff.sender_system_key !== null
    || handoff.recipient_kind !== 'role'
    || handoff.intended_recipient_uid !== null
    || handoff.intended_recipient_role !== recipientRole
    || handoff.intended_team_id !== null
    || handoff.external_recipient_ref !== null
    || !handoff.task_id
    || !handoff.request_reason
    || !ED_HANDOFF_DESTINATIONS.includes(handoff.metadata?.destination)
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
    || task.task_kind !== TASK_KIND
    || String(task.patient_uid || '').toLowerCase()
      !== String(visit.patient_uid).toLowerCase()
    || task.encounter_id !== null
    || task.related_resource_type !== 'care_handoff_instance'
    || String(task.related_resource_id || '').toLowerCase()
      !== String(handoff.id).toLowerCase()
    || task.priority !== 'high'
    || !terminalTaskValid
    || task.assigned_to_uid !== null
    || task.assigned_to_role !== recipientRole
    || task.due_at !== null
    || task.workflow_sla_instance_id !== null
    || task.sla_completion_semantics !== 'none'
    || task.metadata?.task_contract !== TASK_CONTRACT
    || String(task.metadata?.care_pathway_instance_id || '').toLowerCase()
      !== String(runtime.instance.id).toLowerCase()
    || String(task.metadata?.emergency_visit_id || '') !== String(visit.id)
    || String(task.metadata?.canonical_encounter_id || '').toLowerCase()
      !== String(visit.encounter_id).toLowerCase()
    || String(task.metadata?.destination || '') !== handoff.metadata?.destination
    || String(task.metadata?.request_fingerprint || '')
      !== String(handoff.request_fingerprint)
  ) {
    throw AppError.conflict(
      'ED destination handoff or review task binding is invalid',
      'ED_DESTINATION_HANDOFF_BINDING_INVALID',
    );
  }
  return sendingStep;
}

function assertReplay(events, transitionKey) {
  if (
    events.length !== 1
    || events[0].transition_key !== transitionKey
    || events[0].transition_scope !== 'handoff'
  ) {
    throw AppError.conflict(
      'ED destination handoff idempotency evidence is invalid',
      'ED_DESTINATION_HANDOFF_REPLAY_INVALID',
    );
  }
}

function handoffResult({ handoff, task, transition, visit, runtime, replayed }) {
  const result = {
    handoff: Object.freeze({
      id: String(handoff.id).toLowerCase(),
      status: handoff.status,
      destination: handoff.metadata?.destination || null,
      intended_recipient_role: handoff.intended_recipient_role,
      requested_at: handoff.requested_at || null,
      accepted_at: handoff.accepted_at || null,
      declined_at: handoff.declined_at || null,
      accepted_by_uid: handoff.accepted_by_uid
        ? String(handoff.accepted_by_uid).toLowerCase()
        : null,
      decline_reason: handoff.decline_reason || null,
      reroute_reason: handoff.reroute_reason || null,
    }),
    task: Object.freeze({
      id: Number(task.id),
      task_kind: task.task_kind,
      priority: task.priority,
      status: task.status,
      assigned_to_role: task.assigned_to_role,
    }),
    transition: Object.freeze({
      transition_key: transition.transition_key,
      occurred_at: transition.occurred_at || null,
    }),
    destination_source: Object.freeze({
      emergency_visit_id: Number(visit.id),
      source_pathway_instance_id: String(runtime.instance.id).toLowerCase(),
      source_handoff_id: String(handoff.id).toLowerCase(),
    }),
    replayed,
  };
  Object.defineProperty(result, '__patient_uid', {
    value: String(visit.patient_uid).toLowerCase(),
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return Object.freeze(result);
}

async function insertRequestTx({
  tx,
  tenantId,
  visit,
  runtime,
  step,
  actor,
  recipientRole,
  destination,
  reason,
  idempotencyKey,
  fingerprint,
  supersedesHandoffId = null,
}) {
  const handoffId = randomUUID();
  const task = await createEdDestinationHandoffReviewTaskTx({
    tenantId,
    handoffId,
    pathwayInstanceId: runtime.instance.id,
    emergencyVisitId: visit.id,
    patientUid: visit.patient_uid,
    encounterId: visit.encounter_id,
    recipientRole,
    senderUid: actor.uid,
    destination,
    requestFingerprint: fingerprint,
    tx,
  });
  if (!task) {
    throw AppError.internal(
      'ED destination review task was not created',
      'ED_DESTINATION_HANDOFF_TASK_CREATE_FAILED',
    );
  }
  const rows = await tx.$queryRawUnsafe(
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
        'ed_destination_handoff', 'emergency_visit', $7::integer::text,
        'not_applicable', NULL, $8::uuid, NULL,
        'role', NULL, $9::text,
        NULL, NULL, 'requested', $10::bigint,
        $11::text, $12::text, $13::char(64), $14::jsonb)
     RETURNING ${HANDOFF_COLUMNS}`,
    handoffId,
    tenantId,
    visit.patient_uid,
    runtime.instance.id,
    runtime.run.id,
    step.step_key,
    visit.id,
    actor.uid,
    recipientRole,
    task.id,
    idempotencyKey,
    reason,
    fingerprint,
    JSON.stringify({
      destination,
      requested_by_uid: actor.uid,
      requested_by_role: actor.rawRole,
      registry_version: 5,
      ...(supersedesHandoffId
        ? { supersedes_handoff_id: supersedesHandoffId }
        : {}),
    }),
  );
  const handoff = rows[0];
  if (!handoff) {
    throw AppError.internal(
      'ED destination handoff was not created',
      'ED_DESTINATION_HANDOFF_CREATE_FAILED',
    );
  }
  return { handoff, task };
}

export async function requestEdDestinationHandoff({
  tenantId = null,
  emergencyVisitId: rawEmergencyVisitId,
  destination,
  intendedRecipientRole,
  reason,
  idempotencyKey,
  actor,
  tx = null,
} = {}) {
  const tid = requireUuid(requireTenantId(tenantId), 'tenant_id');
  const emergencyVisitId = requireVisitId(rawEmergencyVisitId);
  const cleanDestination = requireDestination(destination);
  const recipientRole = requireRole(intendedRecipientRole);
  const requestReason = requireReason(reason);
  const normalizedActor = normalizeActor(actor);
  const rawKey = requireIdempotencyKey(idempotencyKey);

  return inTenantTx(tid, tx, async db => {
    const currentActor = await lockActorTx(db, tid, normalizedActor);
    const visit = await lockVisitTx(db, tid, emergencyVisitId);
    if (!visit.patient_uid || !visit.encounter_id) {
      throw AppError.conflict(
        'The ED visit requires an identified patient and canonical encounter',
        'ED_DESTINATION_HANDOFF_VISIT_IDENTITY_REQUIRED',
      );
    }
    const pathwayInstanceId = await loadExactEmergencyInstanceTx(db, tid, visit);
    const runtime = await lockPathwayRuntimeTx({
      tx: db,
      tenantId: tid,
      pathwayInstanceId,
    });
    await assertEmergencyRuntimeTx({ tx: db, tenantId: tid, visit, runtime });
    const step = currentRuntimeStep(runtime);
    await assertRequestStageTx({
      tx: db,
      tenantId: tid,
      visit,
      runtime,
      step,
      actorUid: currentActor.uid,
    });

    const fingerprint = requestFingerprint({
      tenantId: tid,
      emergencyVisitId,
      pathwayInstanceId,
      senderUid: currentActor.uid,
      recipientRole,
      destination: cleanDestination,
      reason: requestReason,
    });
    const key = namespaceIdempotencyKey(
      currentActor.uid,
      'request_ed_destination_handoff',
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
      assertReplay(replay.events, 'ed_destination_handoff_requested');
      const handoff = runtime.handoffs.find(item => item.idempotency_key === key) || null;
      const task = await loadTaskTx(db, tid, handoff?.task_id);
      assertBinding({
        handoff,
        task,
        tenantId: tid,
        visit,
        runtime,
        senderUid: currentActor.uid,
        recipientRole,
        requestKey: key,
        expectedFingerprint: fingerprint,
      });
      return handoffResult({
        handoff,
        task,
        transition: replay.events[0],
        visit,
        runtime,
        replayed: true,
      });
    }
    if (runtime.handoffs.some(item => (
      item.handoff_type === HANDOFF_TYPE
      && item.source_resource_type === 'emergency_visit'
      && String(item.source_resource_id) === String(emergencyVisitId)
      && ['requested', 'accepted'].includes(item.status)
    ))) {
      throw AppError.conflict(
        'An ED destination handoff is already pending or accepted',
        'ED_DESTINATION_HANDOFF_ALREADY_EXISTS',
      );
    }
    const created = await insertRequestTx({
      tx: db,
      tenantId: tid,
      visit,
      runtime,
      step,
      actor: currentActor,
      recipientRole,
      destination: cleanDestination,
      reason: requestReason,
      idempotencyKey: key,
      fingerprint,
    });
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
      transitionKey: 'ed_destination_handoff_requested',
      stageKey: step.step_key,
      previousState: { destination_handoff_status: null },
      newState: { destination_handoff_status: 'requested' },
      sourceResourceType: 'care_handoff_instance',
      sourceResourceId: created.handoff.id,
      actor: currentActor.actor,
      eventPayload: {
        handoff_id: created.handoff.id,
        emergency_visit_id: emergencyVisitId,
        pathway_instance_id: pathwayInstanceId,
        sender_uid: currentActor.uid,
        intended_recipient_role: recipientRole,
        destination: cleanDestination,
        review_task_id: created.task.id,
        request_fingerprint: fingerprint,
      },
      metadata: {
        pathway_runtime: {
          definition_checksum: runtime.instance.definition_checksum,
          registry_version: 5,
        },
      },
    });
    return handoffResult({
      ...created,
      transition: appended.event,
      visit,
      runtime,
      replayed: false,
    });
  });
}

async function loadDecisionPointerTx(tx, tenantId, handoffId, emergencyVisitId, actorRole) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT sending_pathway_instance_id, sending_workflow_run_id,
            sending_step_key, source_resource_id, sender_uid,
            intended_recipient_role, task_id
       FROM care_handoff_instances
      WHERE tenant_id = $1::uuid
        AND id = $2::uuid
        AND handoff_type = 'ed_destination_handoff'
        AND source_resource_type = 'emergency_visit'
        AND source_resource_id = $3::integer::text
        AND recipient_kind = 'role'
        AND intended_recipient_role = $4::text
      LIMIT 1`,
    tenantId,
    handoffId,
    emergencyVisitId,
    actorRole,
  );
  if (!rows[0]) {
    throw AppError.forbidden(
      'Not authorized for this ED destination handoff',
      'ED_DESTINATION_HANDOFF_FORBIDDEN',
    );
  }
  return rows[0];
}

export async function decideEdDestinationHandoff({
  tenantId = null,
  emergencyVisitId: rawEmergencyVisitId,
  handoffId: rawHandoffId,
  decision,
  reason = null,
  idempotencyKey,
  actor,
  tx = null,
} = {}) {
  const tid = requireUuid(requireTenantId(tenantId), 'tenant_id');
  const emergencyVisitId = requireVisitId(rawEmergencyVisitId);
  const normalizedActor = normalizeActor(actor);
  const cleanDecision = String(decision || '').trim().toLowerCase();
  if (!['accept', 'decline'].includes(cleanDecision)) {
    throw AppError.badRequest(
      'decision must be accept or decline',
      'ED_DESTINATION_HANDOFF_INPUT_INVALID',
    );
  }
  const cleanReason = cleanDecision === 'decline'
    ? requireReason(reason, 'decline reason')
    : optionalReason(reason);
  const rawKey = requireIdempotencyKey(idempotencyKey);

  return inTenantTx(tid, tx, async db => {
    const currentActor = await lockActorTx(db, tid, normalizedActor);
    if (!isUuid(rawHandoffId)) {
      throw AppError.forbidden(
        'Not authorized for this ED destination handoff',
        'ED_DESTINATION_HANDOFF_FORBIDDEN',
      );
    }
    const handoffId = String(rawHandoffId).trim().toLowerCase();
    const pointer = await loadDecisionPointerTx(
      db,
      tid,
      handoffId,
      emergencyVisitId,
      currentActor.rawRole,
    );
    const visit = await lockVisitTx(db, tid, emergencyVisitId);
    const runtime = await lockPathwayRuntimeTx({
      tx: db,
      tenantId: tid,
      pathwayInstanceId: pointer.sending_pathway_instance_id,
    });
    await assertEmergencyRuntimeTx({ tx: db, tenantId: tid, visit, runtime });
    const mode = await resolvePathwayModeTx({
      tx: db,
      tenantId: tid,
      pathwayKey: CARE_PATHWAY_KEYS.EMERGENCY,
    });
    if (mode !== PATHWAY_MODES.ACTIVE) {
      throw AppError.conflict(
        'ED destination decisions require active pathway mode',
        'ED_DESTINATION_HANDOFF_STAGE_UNAVAILABLE',
      );
    }
    const outcome = cleanDecision === 'accept' ? 'accepted' : 'declined';
    const fingerprint = decisionFingerprint({
      tenantId: tid,
      emergencyVisitId,
      pathwayInstanceId: runtime.instance.id,
      handoffId,
      recipientRole: currentActor.rawRole,
      actorUid: currentActor.uid,
      decision: cleanDecision,
      reason: cleanReason,
    });
    const key = namespaceIdempotencyKey(
      currentActor.uid,
      `${cleanDecision}_ed_destination_handoff`,
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
    const task = await loadTaskTx(db, tid, handoff?.task_id);
    const sendingStep = assertBinding({
      handoff,
      task,
      tenantId: tid,
      visit,
      runtime,
      senderUid: String(pointer.sender_uid).toLowerCase(),
      recipientRole: currentActor.rawRole,
    });
    if (replay.replayed) {
      assertReplay(replay.events, `ed_destination_handoff_${outcome}`);
      const replayValid = outcome === 'accepted'
        ? handoff.status === 'accepted'
          && handoff.accepted_at
          && String(handoff.accepted_by_uid || '').toLowerCase() === currentActor.uid
          && task.status === 'completed'
        : handoff.status === 'declined'
          && handoff.declined_at
          && handoff.decline_reason === cleanReason
          && task.status === 'cancelled';
      if (!replayValid) {
        throw AppError.conflict(
          'ED destination decision replay state is invalid',
          'ED_DESTINATION_HANDOFF_REPLAY_INVALID',
        );
      }
      return handoffResult({
        handoff,
        task,
        transition: replay.events[0],
        visit,
        runtime,
        replayed: true,
      });
    }
    if (
      sendingStep.step_key !== DECISION_STEP_KEY
      || Number(pointer.sending_workflow_run_id) !== Number(runtime.run.id)
      || pointer.sending_step_key !== sendingStep.step_key
      || String(pointer.source_resource_id) !== String(emergencyVisitId)
      || Number(pointer.task_id) !== Number(handoff.task_id)
      || handoff.status !== 'requested'
      || handoff.accepted_at !== null
      || handoff.accepted_by_uid !== null
      || handoff.declined_at !== null
    ) {
      throw AppError.conflict(
        'The ED destination handoff is no longer pending at its exact source stage',
        'ED_DESTINATION_HANDOFF_NOT_PENDING',
      );
    }
    const settledTask = await settleEdDestinationHandoffReviewTaskTx({
      tenantId: tid,
      id: task.id,
      handoffId,
      pathwayInstanceId: runtime.instance.id,
      emergencyVisitId,
      patientUid: visit.patient_uid,
      encounterId: visit.encounter_id,
      requestFingerprint: handoff.request_fingerprint,
      recipientRole: currentActor.rawRole,
      actorUid: currentActor.uid,
      outcome,
      reason: cleanReason,
      tx: db,
    });
    const rows = await db.$queryRawUnsafe(
      `UPDATE care_handoff_instances
          SET status = $3::text,
              accepted_at = CASE
                WHEN $3::text = 'accepted' THEN NOW()
                ELSE NULL
              END,
              accepted_by_uid = CASE
                WHEN $3::text = 'accepted' THEN $4::uuid
                ELSE NULL
              END,
              declined_at = CASE
                WHEN $3::text = 'declined' THEN NOW()
                ELSE NULL
              END,
              decline_reason = CASE
                WHEN $3::text = 'declined' THEN $5::text
                ELSE NULL
              END,
              metadata = COALESCE(metadata, '{}'::jsonb)
                || jsonb_build_object(
                     'decision_actor_uid', $4::text,
                     'decision_actor_role', $6::text
                   ),
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND id = $2::uuid
          AND status = 'requested'
          AND accepted_at IS NULL
          AND accepted_by_uid IS NULL
          AND declined_at IS NULL
          AND sending_pathway_instance_id = $7::uuid
          AND sending_workflow_run_id = $8::integer
          AND sending_step_key = $9::text
          AND handoff_type = 'ed_destination_handoff'
          AND source_resource_type = 'emergency_visit'
          AND source_resource_id = $10::integer::text
          AND sender_uid = $11::uuid
          AND recipient_kind = 'role'
          AND intended_recipient_uid IS NULL
          AND intended_recipient_role = $6::text
          AND task_id = $12::bigint
          AND request_fingerprint = $13::char(64)
        RETURNING ${HANDOFF_COLUMNS}`,
      tid,
      handoffId,
      outcome,
      currentActor.uid,
      cleanReason,
      currentActor.rawRole,
      runtime.instance.id,
      runtime.run.id,
      sendingStep.step_key,
      emergencyVisitId,
      pointer.sender_uid,
      task.id,
      handoff.request_fingerprint,
    );
    const decidedHandoff = rows[0];
    if (!decidedHandoff) {
      throw AppError.conflict(
        'The ED destination handoff changed before decision',
        'ED_DESTINATION_HANDOFF_CAS_CONFLICT',
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
      transitionKey: `ed_destination_handoff_${outcome}`,
      stageKey: sendingStep.step_key,
      previousState: { destination_handoff_status: 'requested' },
      newState: { destination_handoff_status: outcome },
      sourceResourceType: 'care_handoff_instance',
      sourceResourceId: handoffId,
      actor: currentActor.actor,
      eventPayload: {
        handoff_id: handoffId,
        emergency_visit_id: emergencyVisitId,
        pathway_instance_id: runtime.instance.id,
        sender_uid: pointer.sender_uid,
        intended_recipient_role: currentActor.rawRole,
        decision_actor_uid: currentActor.uid,
        destination: decidedHandoff.metadata?.destination,
        review_task_id: task.id,
        request_fingerprint: handoff.request_fingerprint,
        ...(cleanReason ? { reason: cleanReason } : {}),
      },
      metadata: {
        pathway_runtime: {
          definition_checksum: runtime.instance.definition_checksum,
          registry_version: 5,
        },
      },
    });
    return handoffResult({
      handoff: decidedHandoff,
      task: settledTask,
      transition: appended.event,
      visit,
      runtime,
      replayed: false,
    });
  });
}

export async function rerouteEdDestinationHandoff({
  tenantId = null,
  emergencyVisitId: rawEmergencyVisitId,
  handoffId: rawHandoffId,
  destination,
  intendedRecipientRole,
  reason,
  idempotencyKey,
  actor,
  tx = null,
} = {}) {
  const tid = requireUuid(requireTenantId(tenantId), 'tenant_id');
  const emergencyVisitId = requireVisitId(rawEmergencyVisitId);
  const predecessorId = requireUuid(rawHandoffId, 'handoff_id');
  const cleanDestination = requireDestination(destination);
  const recipientRole = requireRole(intendedRecipientRole);
  const rerouteReason = requireReason(reason, 'reroute reason');
  const normalizedActor = normalizeActor(actor);
  const rawKey = requireIdempotencyKey(idempotencyKey);

  return inTenantTx(tid, tx, async db => {
    const currentActor = await lockActorTx(db, tid, normalizedActor);
    const visit = await lockVisitTx(db, tid, emergencyVisitId);
    const predecessorRows = await db.$queryRawUnsafe(
      `SELECT ${HANDOFF_COLUMNS}
         FROM care_handoff_instances
        WHERE tenant_id = $1::uuid
          AND id = $2::uuid
          AND handoff_type = 'ed_destination_handoff'
          AND source_resource_type = 'emergency_visit'
          AND source_resource_id = $3::integer::text
          AND sender_uid = $4::uuid
        LIMIT 1
        FOR UPDATE`,
      tid,
      predecessorId,
      emergencyVisitId,
      currentActor.uid,
    );
    const predecessor = predecessorRows[0];
    if (!predecessor) {
      throw AppError.forbidden(
        'Not authorized to reroute this ED destination handoff',
        'ED_DESTINATION_HANDOFF_FORBIDDEN',
      );
    }
    const runtime = await lockPathwayRuntimeTx({
      tx: db,
      tenantId: tid,
      pathwayInstanceId: predecessor.sending_pathway_instance_id,
    });
    await assertEmergencyRuntimeTx({ tx: db, tenantId: tid, visit, runtime });
    const step = currentRuntimeStep(runtime);
    await assertRequestStageTx({
      tx: db,
      tenantId: tid,
      visit,
      runtime,
      step,
      actorUid: currentActor.uid,
    });
    const predecessorTask = await loadTaskTx(db, tid, predecessor.task_id);
    assertBinding({
      handoff: predecessor,
      task: predecessorTask,
      tenantId: tid,
      visit,
      runtime,
      senderUid: currentActor.uid,
      recipientRole: predecessor.intended_recipient_role,
    });
    if (
      predecessor.status !== 'declined'
      || !predecessor.declined_at
      || !predecessor.decline_reason
      || predecessor.reroute_reason
      || predecessor.metadata?.rerouted_to_handoff_id
    ) {
      throw AppError.conflict(
        'Only an unrouted declined ED handoff can be rerouted',
        'ED_DESTINATION_HANDOFF_REROUTE_UNAVAILABLE',
      );
    }
    const fingerprint = requestFingerprint({
      tenantId: tid,
      emergencyVisitId,
      pathwayInstanceId: runtime.instance.id,
      senderUid: currentActor.uid,
      recipientRole,
      destination: cleanDestination,
      reason: rerouteReason,
      supersedesHandoffId: predecessorId,
    });
    const key = namespaceIdempotencyKey(
      currentActor.uid,
      'reroute_ed_destination_handoff',
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
    if (replay.replayed) {
      assertReplay(replay.events, 'ed_destination_handoff_rerouted');
      const successorId = predecessor.metadata?.rerouted_to_handoff_id;
      const successor = runtime.handoffs.find(
        item => String(item.id).toLowerCase() === String(successorId).toLowerCase(),
      ) || null;
      const successorTask = await loadTaskTx(db, tid, successor?.task_id);
      assertBinding({
        handoff: successor,
        task: successorTask,
        tenantId: tid,
        visit,
        runtime,
        senderUid: currentActor.uid,
        recipientRole,
        requestKey: key,
        expectedFingerprint: fingerprint,
      });
      return handoffResult({
        handoff: successor,
        task: successorTask,
        transition: replay.events[0],
        visit,
        runtime,
        replayed: true,
      });
    }
    const created = await insertRequestTx({
      tx: db,
      tenantId: tid,
      visit,
      runtime,
      step,
      actor: currentActor,
      recipientRole,
      destination: cleanDestination,
      reason: rerouteReason,
      idempotencyKey: key,
      fingerprint,
      supersedesHandoffId: predecessorId,
    });
    const reroutedRows = await db.$queryRawUnsafe(
      `UPDATE care_handoff_instances
          SET reroute_reason = $3::text,
              metadata = COALESCE(metadata, '{}'::jsonb)
                || jsonb_build_object('rerouted_to_handoff_id', $4::text),
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND id = $2::uuid
          AND status = 'declined'
          AND declined_at IS NOT NULL
          AND NULLIF(BTRIM(decline_reason), '') IS NOT NULL
          AND reroute_reason IS NULL
          AND NOT (COALESCE(metadata, '{}'::jsonb) ? 'rerouted_to_handoff_id')
        RETURNING id`,
      tid,
      predecessorId,
      rerouteReason,
      created.handoff.id,
    );
    if (!reroutedRows[0]) {
      throw AppError.conflict(
        'The declined ED handoff changed before reroute',
        'ED_DESTINATION_HANDOFF_CAS_CONFLICT',
      );
    }
    const appended = await appendPathwayTransitionEventTx({
      tx: db,
      tenantId: tid,
      pathwayInstanceId: runtime.instance.id,
      pathwayInstance: runtime.instance,
      workflowRunId: runtime.run.id,
      workflowStepId: step.id,
      idempotencyKey: key,
      commandFingerprint: fingerprint,
      transitionScope: 'handoff',
      transitionKey: 'ed_destination_handoff_rerouted',
      stageKey: step.step_key,
      previousState: {
        destination_handoff_status: 'declined',
        handoff_id: predecessorId,
      },
      newState: {
        destination_handoff_status: 'requested',
        handoff_id: created.handoff.id,
      },
      sourceResourceType: 'care_handoff_instance',
      sourceResourceId: created.handoff.id,
      actor: currentActor.actor,
      eventPayload: {
        handoff_id: created.handoff.id,
        supersedes_handoff_id: predecessorId,
        emergency_visit_id: emergencyVisitId,
        pathway_instance_id: runtime.instance.id,
        sender_uid: currentActor.uid,
        intended_recipient_role: recipientRole,
        destination: cleanDestination,
        review_task_id: created.task.id,
        request_fingerprint: fingerprint,
      },
      metadata: {
        pathway_runtime: {
          definition_checksum: runtime.instance.definition_checksum,
          registry_version: 5,
        },
      },
    });
    return handoffResult({
      ...created,
      transition: appended.event,
      visit,
      runtime,
      replayed: false,
    });
  });
}

export async function listEdDestinationHandoffs({
  tenantId = null,
  actor,
  status = null,
  limit = 50,
  tx = null,
} = {}) {
  const tid = requireUuid(requireTenantId(tenantId), 'tenant_id');
  const normalizedActor = normalizeActor(actor);
  const cleanStatus = status == null || status === ''
    ? null
    : String(status).trim().toLowerCase();
  if (cleanStatus && !['requested', 'accepted', 'declined'].includes(cleanStatus)) {
    throw AppError.badRequest(
      'status must be requested, accepted, or declined',
      'ED_DESTINATION_HANDOFF_INPUT_INVALID',
    );
  }
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  return inTenantTx(tid, tx, async db => {
    const currentActor = await lockActorTx(db, tid, normalizedActor);
    const rows = await db.$queryRawUnsafe(
      `SELECT handoff.id,
              handoff.source_resource_id::integer AS emergency_visit_id,
              handoff.status,
              handoff.request_reason,
              handoff.decline_reason,
              handoff.reroute_reason,
              handoff.requested_at,
              handoff.accepted_at,
              handoff.declined_at,
              handoff.sender_uid,
              handoff.intended_recipient_role,
              handoff.accepted_by_uid,
              handoff.metadata ->> 'destination' AS destination,
              handoff.metadata ->> 'supersedes_handoff_id' AS supersedes_handoff_id,
              handoff.metadata ->> 'rerouted_to_handoff_id' AS rerouted_to_handoff_id,
              task.id AS task_id,
              task.status AS task_status,
              visit.visit_number,
              visit.patient_uid,
              visit.status AS visit_status,
              visit.disposition,
              visit.attending_doctor_uid,
              visit.arrival_at
         FROM care_handoff_instances AS handoff
         JOIN tasks AS task
           ON task.tenant_id = handoff.tenant_id
          AND task.id = handoff.task_id
         JOIN emergency_visits AS visit
           ON visit.tenant_id = handoff.tenant_id
          AND visit.id::text = handoff.source_resource_id
          AND visit.patient_uid = handoff.patient_uid
        WHERE handoff.tenant_id = $1::uuid
          AND handoff.handoff_type = 'ed_destination_handoff'
          AND handoff.source_resource_type = 'emergency_visit'
          AND (
            handoff.sender_uid = $2::uuid
            OR handoff.intended_recipient_role = $3::text
          )
          AND ($4::text IS NULL OR handoff.status = $4::text)
        ORDER BY
          CASE WHEN handoff.status = 'requested' THEN 0 ELSE 1 END,
          handoff.requested_at ASC,
          handoff.id ASC
        LIMIT $5::integer`,
      tid,
      currentActor.uid,
      currentActor.rawRole,
      cleanStatus,
      safeLimit,
    );
    return Object.freeze({
      handoffs: Object.freeze(rows.map(row => Object.freeze({
        ...row,
        emergency_visit_id: Number(row.emergency_visit_id),
        task_id: Number(row.task_id),
        can_decide: row.status === 'requested'
          && row.intended_recipient_role === currentActor.rawRole,
        can_reroute: row.status === 'declined'
          && String(row.sender_uid).toLowerCase() === currentActor.uid
          && !row.rerouted_to_handoff_id,
      }))),
      count: rows.length,
      actor_role: currentActor.rawRole,
    });
  });
}

export const __testing__ = Object.freeze({
  DECISION_STEP_KEY,
  ED_HANDOFF_DESTINATIONS,
  decisionFingerprint,
  namespaceIdempotencyKey,
  requestFingerprint,
});

export default {
  decideEdDestinationHandoff,
  listEdDestinationHandoffs,
  requestEdDestinationHandoff,
  rerouteEdDestinationHandoff,
};
