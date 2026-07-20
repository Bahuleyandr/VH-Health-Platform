import { randomUUID } from 'crypto';

import { isTenantTransactionClient } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { recordCanonicalClinicalEvent } from '../clinical/canonicalClinicalPlatformService.js';
import { requireTenantId } from '../tenant/tenantService.js';
import {
  isRegisteredWorkflowSystemActor,
  isWorkflowRuntimeRegistry,
  workflowRuntimeRegistry
} from '../workflow/workflowRuntimeRegistry.js';
import { assertWorkflowJsonBudget } from '../workflow/workflowJsonGuard.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_.:-]+$/;
const SHA256_RE = /^[0-9a-f]{64}$/i;
const ROLE_RE = /^[A-Z][A-Z0-9_]{0,79}$/;
const PG_INT_MAX = 2_147_483_647;
const PG_BIGINT_MAX = 9_223_372_036_854_775_807n;
const TRANSITION_SCOPES = new Set(['pathway', 'run', 'step', 'task', 'approval', 'handoff']);
const transitionAppendSessions = new WeakSet();

const INSTANCE_COLUMNS = `id, tenant_id, workflow_run_id, patient_uid, encounter_id,
  pathway_key, pathway_version, source_episode_type, source_episode_id,
  patient_visibility_status, clinical_status, metadata`;

const EVENT_COLUMNS = `id, tenant_id, pathway_instance_id, patient_uid, workflow_run_id,
  sequence_number, transition_scope, transition_key, stage_key, workflow_step_id,
  previous_state, new_state, source_resource_type, source_resource_id,
  workflow_sla_instance_id, actor_uid, system_actor_key, actor_role,
  occurred_at, recorded_at, idempotency_key, command_fingerprint, effect_ordinal,
  canonical_timeline_event_id, canonical_audit_event_id, event_payload, metadata`;

function requireTx(tx) {
  if (!tx || typeof tx.$queryRawUnsafe !== 'function' || !isTenantTransactionClient(tx)) {
    throw AppError.internal(
      'Pathway transition evidence requires an existing transaction',
      'PATHWAY_TRANSITION_TX_REQUIRED'
    );
  }
  return tx;
}

function requireUuid(value, label) {
  const text = String(value ?? '').trim();
  if (!UUID_RE.test(text)) {
    throw AppError.badRequest(`${label} must be a UUID`, 'PATHWAY_TRANSITION_BAD_UUID');
  }
  return text.toLowerCase();
}

function normalizeTenantId(value) {
  return requireUuid(requireTenantId(value), 'tenant_id');
}

function requireText(value, label, max) {
  const text = String(value ?? '').trim();
  if (!text) {
    throw AppError.badRequest(`${label} is required`, 'PATHWAY_TRANSITION_FIELD_REQUIRED');
  }
  if (text.length > max) {
    throw AppError.badRequest(
      `${label} must be at most ${max} characters`,
      'PATHWAY_TRANSITION_FIELD_TOO_LONG'
    );
  }
  return text;
}

function optionalText(value, label, max) {
  if (value === null || value === undefined || value === '') return null;
  return requireText(value, label, max);
}

function requirePositiveInteger(value, label) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed <= 0 ||
    parsed > PG_INT_MAX ||
    String(parsed) !== String(value).trim()
  ) {
    throw AppError.badRequest(
      `${label} must be a positive integer`,
      'PATHWAY_TRANSITION_BAD_INTEGER'
    );
  }
  return parsed;
}

function optionalPositiveInteger(value, label) {
  if (value === null || value === undefined || value === '') return null;
  return requirePositiveInteger(value, label);
}

function requireEffectOrdinal(value) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 0 ||
    parsed > PG_INT_MAX ||
    String(parsed) !== String(value).trim()
  ) {
    throw AppError.badRequest(
      'effect_ordinal must be a non-negative integer',
      'PATHWAY_TRANSITION_BAD_EFFECT_ORDINAL'
    );
  }
  return parsed;
}

function normalizeJsonObject(value, label) {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw AppError.badRequest(`${label} must be a JSON object`, 'PATHWAY_TRANSITION_BAD_JSON');
  }
  try {
    assertWorkflowJsonBudget(value, {
      label,
      onViolation: ({ kind, message }) => {
        throw AppError.badRequest(
          message,
          ['depth', 'nodes', 'bytes'].includes(kind)
            ? 'PATHWAY_TRANSITION_JSON_LIMIT_EXCEEDED'
            : 'PATHWAY_TRANSITION_BAD_JSON',
          { field: label, violation: kind }
        );
      }
    });
    const normalized = JSON.parse(JSON.stringify(value));
    if (normalized === null || typeof normalized !== 'object' || Array.isArray(normalized)) {
      throw new TypeError('not an object');
    }
    return normalized;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw AppError.badRequest(
      `${label} must be a JSON-serializable object`,
      'PATHWAY_TRANSITION_BAD_JSON'
    );
  }
}

function normalizeIdempotencyKey(value) {
  const key = requireText(value, 'idempotency_key', 200);
  if (!IDEMPOTENCY_KEY_RE.test(key)) {
    throw AppError.badRequest(
      'idempotency_key contains unsupported characters',
      'PATHWAY_TRANSITION_BAD_IDEMPOTENCY_KEY'
    );
  }
  return key;
}

function normalizeFingerprint(value) {
  const fingerprint = String(value ?? '')
    .trim()
    .toLowerCase();
  if (!SHA256_RE.test(fingerprint)) {
    throw AppError.badRequest(
      'command_fingerprint must be a SHA-256 hex digest',
      'PATHWAY_TRANSITION_BAD_FINGERPRINT'
    );
  }
  return fingerprint;
}

function normalizeOccurredAt(value) {
  const occurredAt = value === null || value === undefined ? new Date() : new Date(value);
  if (Number.isNaN(occurredAt.getTime())) {
    throw AppError.badRequest(
      'occurred_at must be a valid timestamp',
      'PATHWAY_TRANSITION_BAD_OCCURRED_AT'
    );
  }
  return occurredAt.toISOString();
}

function normalizeBigintText(value, label) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) {
    throw AppError.badRequest(`${label} must be a safe non-negative integer`);
  }
  const text = typeof value === 'bigint' ? value.toString() : String(value).trim();
  if (!/^\d+$/.test(text)) {
    throw AppError.badRequest(`${label} must be a non-negative integer`);
  }
  const normalized = text.replace(/^0+(?=\d)/, '');
  if (normalized.length > 19 || BigInt(normalized) > PG_BIGINT_MAX) {
    throw AppError.badRequest(`${label} exceeds the PostgreSQL BIGINT range`);
  }
  return normalized;
}

function normalizeActor(actor, registry) {
  if (!actor || typeof actor !== 'object' || Array.isArray(actor)) {
    throw AppError.unauthorized('Pathway transition actor is required');
  }

  if (actor.kind === 'user') {
    const uid = requireUuid(actor.uid, 'actor.uid');
    const suppliedRoles = Array.isArray(actor.roles) ? actor.roles : actor.role ? [actor.role] : [];
    const roles = [
      ...new Set(suppliedRoles.map(role => requireText(role, 'actor role', 80).toUpperCase()))
    ];
    if (roles.length === 0) {
      throw AppError.unauthorized('Authenticated pathway actor role is required');
    }
    if (roles.some(role => !ROLE_RE.test(role))) {
      throw AppError.badRequest(
        'Pathway actor roles must be canonical uppercase role codes',
        'PATHWAY_TRANSITION_BAD_ACTOR_ROLE'
      );
    }
    const suppliedPrimaryRole = optionalText(actor.primaryRole, 'primary_role', 80);
    const primaryRole = suppliedPrimaryRole || roles[0];
    if (!ROLE_RE.test(primaryRole) || !roles.includes(primaryRole)) {
      throw AppError.badRequest(
        'primary_role must be a canonical member of actor roles',
        'PATHWAY_TRANSITION_BAD_PRIMARY_ROLE'
      );
    }
    const authorizationMode = requireText(actor.authorizationMode, 'authorization_mode', 80);
    const overrideReason = optionalText(actor.overrideReason, 'override_reason', 2000);
    const breakGlassId = optionalPositiveInteger(actor.breakGlassId, 'break_glass_id');
    if (authorizationMode.toLowerCase().includes('override') && !overrideReason) {
      throw AppError.badRequest(
        'override_reason is required for override authorization',
        'PATHWAY_TRANSITION_OVERRIDE_REASON_REQUIRED'
      );
    }
    if (
      authorizationMode.toLowerCase() === 'patient_access_break_glass' &&
      (!breakGlassId || !overrideReason)
    ) {
      throw AppError.badRequest(
        'Patient-access break-glass authorization requires its audit id and reason',
        'PATHWAY_TRANSITION_BREAK_GLASS_CONTEXT_REQUIRED'
      );
    }
    return {
      actorUid: uid,
      actorRole: primaryRole,
      systemActorKey: null,
      provenance: {
        kind: 'user',
        roles,
        primary_role: primaryRole,
        authorization_mode: authorizationMode,
        override_reason: overrideReason,
        break_glass_id: breakGlassId
      }
    };
  }

  if (actor.kind === 'system') {
    if (
      !isWorkflowRuntimeRegistry(registry) ||
      !isRegisteredWorkflowSystemActor(actor, { registry })
    ) {
      throw AppError.forbidden(
        'Pathway system actor is not registered',
        'PATHWAY_SYSTEM_ACTOR_NOT_REGISTERED'
      );
    }
    if (actor.breakGlassId !== null && actor.breakGlassId !== undefined) {
      throw AppError.badRequest(
        'System pathway actors cannot carry break-glass authorization',
        'PATHWAY_SYSTEM_ACTOR_BREAK_GLASS_FORBIDDEN'
      );
    }
    const systemKey = requireText(actor.systemKey, 'actor.systemKey', 120);
    return {
      actorUid: null,
      actorRole: null,
      systemActorKey: systemKey,
      provenance: {
        kind: 'system',
        system_key: systemKey,
        source_event_id: normalizeBigintText(actor.sourceEventId, 'source_event_id'),
        causation_id: optionalText(actor.causationId, 'causation_id', 160)
      }
    };
  }

  throw AppError.badRequest(
    'Pathway transition actor kind must be user or system',
    'PATHWAY_TRANSITION_BAD_ACTOR_KIND'
  );
}

function resolveInstanceId(pathwayInstanceId, pathwayInstance) {
  return requireUuid(pathwayInstanceId ?? pathwayInstance?.id, 'pathway_instance_id');
}

async function lockPathwayInstanceTx(tx, tenantId, pathwayInstanceId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT ${INSTANCE_COLUMNS}
       FROM care_pathway_instances
      WHERE tenant_id = $1::uuid
        AND id = $2::uuid
      FOR UPDATE`,
    tenantId,
    pathwayInstanceId
  );
  if (!rows[0]) {
    throw AppError.notFound('Care pathway instance not found', 'CARE_PATHWAY_INSTANCE_NOT_FOUND');
  }
  return rows[0];
}

async function acquireCommandLockTx(tx, tenantId, idempotencyKey) {
  await tx.$queryRawUnsafe(
    `SELECT COUNT(*)::integer AS command_locked
       FROM (
         SELECT pg_advisory_xact_lock(
           hashtextextended($1::text, 0)
         )
       ) AS acquired`,
    `${tenantId}:${idempotencyKey}`
  );
}

async function loadCommandEventsTx(tx, tenantId, idempotencyKey) {
  return tx.$queryRawUnsafe(
    `SELECT ${EVENT_COLUMNS}
       FROM care_pathway_transition_events
      WHERE tenant_id = $1::uuid
        AND idempotency_key = $2::text
      ORDER BY effect_ordinal ASC`,
    tenantId,
    idempotencyKey
  );
}

function assertReplayGroup(rows, pathwayInstanceId, commandFingerprint) {
  for (const [index, row] of rows.entries()) {
    if (String(row.pathway_instance_id) !== pathwayInstanceId) {
      throw AppError.conflict(
        'Pathway idempotency key is already bound to another instance',
        'PATHWAY_IDEMPOTENCY_KEY_REUSED'
      );
    }
    if (
      String(row.command_fingerprint || '')
        .trim()
        .toLowerCase() !== commandFingerprint
    ) {
      throw AppError.conflict(
        'Pathway idempotency key was reused with a different command',
        'PATHWAY_IDEMPOTENCY_KEY_REUSED'
      );
    }
    if (Number(row.effect_ordinal) !== index) {
      throw AppError.conflict(
        'Pathway command evidence has a non-contiguous effect sequence',
        'PATHWAY_EFFECT_SEQUENCE_INVALID'
      );
    }
  }
}

export async function findPathwayTransitionReplayTx({
  tx,
  tenantId,
  pathwayInstanceId,
  pathwayInstance = null,
  idempotencyKey,
  commandFingerprint,
  effectOrdinal = null,
  lockInstance = true
} = {}) {
  const db = requireTx(tx);
  if (lockInstance !== true) {
    throw AppError.internal(
      'Pathway replay checks require the instance lock',
      'PATHWAY_INSTANCE_LOCK_REQUIRED'
    );
  }
  const tid = normalizeTenantId(tenantId);
  const instanceId = resolveInstanceId(pathwayInstanceId, pathwayInstance);
  const key = normalizeIdempotencyKey(idempotencyKey);
  const fingerprint = normalizeFingerprint(commandFingerprint);
  const ordinal =
    effectOrdinal === null || effectOrdinal === undefined
      ? null
      : requireEffectOrdinal(effectOrdinal);

  const lockedInstance = await lockPathwayInstanceTx(db, tid, instanceId);
  await acquireCommandLockTx(db, tid, key);
  const events = await loadCommandEventsTx(db, tid, key);
  assertReplayGroup(events, instanceId, fingerprint);
  const event =
    ordinal === null ? null : events.find(row => Number(row.effect_ordinal) === ordinal) || null;

  return {
    pathwayInstance: lockedInstance,
    events,
    event,
    replayed: ordinal === null ? events.length > 0 : event !== null
  };
}

function normalizeAppendContext({
  tx,
  tenantId,
  pathwayInstanceId,
  pathwayInstance = null,
  workflowRunId,
  idempotencyKey,
  commandFingerprint,
  actor,
  registry = workflowRuntimeRegistry
} = {}) {
  return {
    db: requireTx(tx),
    tenantId: normalizeTenantId(tenantId),
    pathwayInstanceId: resolveInstanceId(pathwayInstanceId, pathwayInstance),
    workflowRunId: requirePositiveInteger(workflowRunId, 'workflow_run_id'),
    idempotencyKey: normalizeIdempotencyKey(idempotencyKey),
    commandFingerprint: normalizeFingerprint(commandFingerprint),
    provenance: normalizeActor(actor, registry)
  };
}

function normalizeTransitionIntent(
  {
    workflowStepId = null,
    transitionScope,
    transitionKey,
    stageKey = null,
    previousState = {},
    newState = {},
    sourceResourceType = null,
    sourceResourceId = null,
    workflowSlaInstanceId = null,
    occurredAt = null,
    eventPayload = {},
    metadata = {}
  } = {},
  effectOrdinal
) {
  const stepId = optionalPositiveInteger(workflowStepId, 'workflow_step_id');
  const ordinal = requireEffectOrdinal(effectOrdinal);
  const scope = requireText(transitionScope, 'transition_scope', 30);
  if (!TRANSITION_SCOPES.has(scope)) {
    throw AppError.badRequest('transition_scope is not supported', 'PATHWAY_TRANSITION_BAD_SCOPE');
  }
  const transition = requireText(transitionKey, 'transition_key', 120);
  const stage = optionalText(stageKey, 'stage_key', 120);
  const sourceType = optionalText(sourceResourceType, 'source_resource_type', 80);
  const sourceId = optionalText(sourceResourceId, 'source_resource_id', 160);
  if ((sourceType === null) !== (sourceId === null)) {
    throw AppError.badRequest(
      'source_resource_type and source_resource_id must be supplied together',
      'PATHWAY_TRANSITION_SOURCE_PAIR_REQUIRED'
    );
  }
  const slaId =
    workflowSlaInstanceId === null || workflowSlaInstanceId === undefined
      ? null
      : requireUuid(workflowSlaInstanceId, 'workflow_sla_instance_id');
  const before = normalizeJsonObject(previousState, 'previous_state');
  const after = normalizeJsonObject(newState, 'new_state');
  const payload = normalizeJsonObject(eventPayload, 'event_payload');
  const callerMetadata = normalizeJsonObject(metadata, 'metadata');
  const eventOccurredAt = normalizeOccurredAt(occurredAt);

  return {
    workflowStepId: stepId,
    effectOrdinal: ordinal,
    transitionScope: scope,
    transitionKey: transition,
    stageKey: stage,
    previousState: before,
    newState: after,
    sourceResourceType: sourceType,
    sourceResourceId: sourceId,
    workflowSlaInstanceId: slaId,
    occurredAt: eventOccurredAt,
    eventPayload: payload,
    metadata: callerMetadata
  };
}

async function beginTransitionAppendSessionTx(context) {
  const lockedInstance = await lockPathwayInstanceTx(
    context.db,
    context.tenantId,
    context.pathwayInstanceId
  );
  await acquireCommandLockTx(context.db, context.tenantId, context.idempotencyKey);
  const replayEvents = await loadCommandEventsTx(
    context.db,
    context.tenantId,
    context.idempotencyKey
  );
  assertReplayGroup(replayEvents, context.pathwayInstanceId, context.commandFingerprint);
  if (Number(lockedInstance.workflow_run_id) !== context.workflowRunId) {
    throw AppError.conflict(
      'Pathway transition workflow run does not match its instance',
      'PATHWAY_RUN_CONTEXT_MISMATCH'
    );
  }

  const session = Object.seal({
    ...context,
    pathwayInstance: lockedInstance,
    replayEvents: Object.freeze([...replayEvents]),
    expectedOrdinal: replayEvents.length,
    nextSequence: null
  });
  transitionAppendSessions.add(session);
  return session;
}

function requireTransitionAppendSession(session) {
  if (!session || !transitionAppendSessions.has(session)) {
    throw AppError.internal(
      'Pathway transition append session is invalid',
      'PATHWAY_TRANSITION_APPEND_SESSION_INVALID'
    );
  }
  return session;
}

async function captureNextSequenceTx(session) {
  const sealedSession = requireTransitionAppendSession(session);
  if (sealedSession.nextSequence !== null) return sealedSession.nextSequence;
  const sequenceRows = await sealedSession.db.$queryRawUnsafe(
    `SELECT COALESCE(MAX(sequence_number), 0) + 1 AS next_sequence
       FROM care_pathway_transition_events
      WHERE tenant_id = $1::uuid
        AND pathway_instance_id = $2::uuid`,
    sealedSession.tenantId,
    sealedSession.pathwayInstanceId
  );
  const sequenceNumber = Number(sequenceRows[0]?.next_sequence || 1);
  if (!Number.isSafeInteger(sequenceNumber) || sequenceNumber <= 0 || sequenceNumber > PG_INT_MAX) {
    throw AppError.internal(
      'Pathway transition sequence allocation failed',
      'PATHWAY_TRANSITION_SEQUENCE_FAILED'
    );
  }
  sealedSession.nextSequence = sequenceNumber;
  return sequenceNumber;
}

async function appendNormalizedTransitionInSessionTx(session, intent) {
  const sealedSession = requireTransitionAppendSession(session);
  const ordinal = intent.effectOrdinal;
  if (ordinal < sealedSession.replayEvents.length) {
    return {
      event: sealedSession.replayEvents[ordinal],
      replayed: true,
      pathwayInstance: sealedSession.pathwayInstance
    };
  }
  if (ordinal !== sealedSession.expectedOrdinal) {
    throw AppError.conflict(
      'Pathway transition effect ordinal is not the next command effect',
      'PATHWAY_EFFECT_ORDINAL_GAP'
    );
  }

  const sequenceNumber = await captureNextSequenceTx(sealedSession);
  if (sequenceNumber > PG_INT_MAX) {
    throw AppError.internal(
      'Pathway transition sequence allocation failed',
      'PATHWAY_TRANSITION_SEQUENCE_FAILED'
    );
  }
  const {
    db,
    tenantId: tid,
    pathwayInstanceId: instanceId,
    workflowRunId: runId,
    idempotencyKey: key,
    commandFingerprint: fingerprint,
    provenance,
    pathwayInstance: lockedInstance
  } = sealedSession;
  const {
    workflowStepId: stepId,
    transitionScope: scope,
    transitionKey: transition,
    stageKey: stage,
    previousState: before,
    newState: after,
    sourceResourceType: sourceType,
    sourceResourceId: sourceId,
    workflowSlaInstanceId: slaId,
    occurredAt: eventOccurredAt,
    eventPayload: payload,
    metadata: callerMetadata
  } = intent;

  const eventId = randomUUID();
  const trustedPayload = {
    ...payload,
    event_id: eventId,
    tenant_id: tid,
    pathway_instance_id: instanceId,
    patient_uid: lockedInstance.patient_uid,
    encounter_id: lockedInstance.encounter_id,
    workflow_run_id: runId,
    workflow_step_id: stepId,
    sequence_number: sequenceNumber,
    transition_scope: scope,
    transition_key: transition,
    stage_key: stage,
    source_resource_type: sourceType,
    source_resource_id: sourceId,
    workflow_sla_instance_id: slaId,
    actor_uid: provenance.actorUid,
    system_actor_key: provenance.systemActorKey,
    actor_role: provenance.actorRole,
    occurred_at: eventOccurredAt,
    idempotency_key: key,
    command_fingerprint: fingerprint,
    effect_ordinal: ordinal
  };
  delete trustedPayload.canonical_timeline_event_id;
  delete trustedPayload.canonical_audit_event_id;
  delete trustedPayload.recorded_at;
  const trustedMetadata = normalizeJsonObject({
    ...callerMetadata,
    command_fingerprint: fingerprint,
    effect_ordinal: ordinal,
    provenance: provenance.provenance
  }, 'trusted_metadata');
  const durablePayload = normalizeJsonObject(trustedPayload, 'trusted_event_payload');
  const timelineIdempotencyKey = `care_pathway_transition_events:${eventId}:timeline`;
  const auditIdempotencyKey = `care_pathway_transition_events:${eventId}:audit`;
  const canonical = await recordCanonicalClinicalEvent(
    {
      tenantId: tid,
      patientUid: lockedInstance.patient_uid,
      encounterId: lockedInstance.encounter_id,
      eventType: 'care_pathway.transition',
      eventStatus: scope,
      sourceTable: 'care_pathway_transition_events',
      sourceId: eventId,
      sourceUid: eventId,
      resourceType: 'care_pathway_transition_event',
      resourceId: eventId,
      actorUid: provenance.actorUid,
      actorRole: provenance.actorRole,
      occurredAt: eventOccurredAt,
      visibleToPatient: false,
      summary: 'Care pathway transition recorded',
      payload: durablePayload,
      tags: ['care_pathway', lockedInstance.pathway_key, scope],
      action: 'care_pathway.transition',
      beforeState: before,
      afterState: after,
      metadata: trustedMetadata,
      timelineIdempotencyKey,
      auditIdempotencyKey
    },
    { db, strict: true }
  );
  if (!canonical?.timeline?.id || !canonical?.audit?.id) {
    throw AppError.internal(
      'Canonical pathway transition evidence was not recorded',
      'PATHWAY_CANONICAL_WRITE_FAILED'
    );
  }

  const inserted = await db.$queryRawUnsafe(
    `INSERT INTO care_pathway_transition_events
       (id, tenant_id, pathway_instance_id, patient_uid, workflow_run_id,
        sequence_number, transition_scope, transition_key, stage_key, workflow_step_id,
        previous_state, new_state, source_resource_type, source_resource_id,
        workflow_sla_instance_id, actor_uid, system_actor_key, actor_role,
        occurred_at, idempotency_key, command_fingerprint, effect_ordinal,
        canonical_timeline_event_id, canonical_audit_event_id, event_payload, metadata)
     VALUES
       ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::integer,
        $6::integer, $7::text, $8::text, $9::text, $10::integer,
        $11::jsonb, $12::jsonb, $13::text, $14::text,
        $15::uuid, $16::uuid, $17::text, $18::text,
        $19::timestamptz, $20::text, $21::char(64), $22::integer,
        $23::uuid, $24::uuid, $25::jsonb, $26::jsonb)
     RETURNING ${EVENT_COLUMNS}`,
    eventId,
    tid,
    instanceId,
    lockedInstance.patient_uid,
    runId,
    sequenceNumber,
    scope,
    transition,
    stage,
    stepId,
    JSON.stringify(before),
    JSON.stringify(after),
    sourceType,
    sourceId,
    slaId,
    provenance.actorUid,
    provenance.systemActorKey,
    provenance.actorRole,
    eventOccurredAt,
    key,
    fingerprint,
    ordinal,
    canonical.timeline.id,
    canonical.audit.id,
    JSON.stringify(durablePayload),
    JSON.stringify(trustedMetadata)
  );
  if (!inserted[0]) {
    throw AppError.internal(
      'Pathway transition evidence insert failed',
      'PATHWAY_TRANSITION_INSERT_FAILED'
    );
  }
  sealedSession.expectedOrdinal += 1;
  sealedSession.nextSequence += 1;
  return {
    event: inserted[0],
    replayed: false,
    pathwayInstance: lockedInstance
  };
}

export async function appendPathwayTransitionEventTx({
  tx,
  tenantId,
  pathwayInstanceId,
  pathwayInstance = null,
  workflowRunId,
  workflowStepId = null,
  idempotencyKey,
  commandFingerprint,
  effectOrdinal = 0,
  transitionScope,
  transitionKey,
  stageKey = null,
  previousState = {},
  newState = {},
  sourceResourceType = null,
  sourceResourceId = null,
  workflowSlaInstanceId = null,
  occurredAt = null,
  actor,
  registry = workflowRuntimeRegistry,
  eventPayload = {},
  metadata = {}
} = {}) {
  const context = normalizeAppendContext({
    tx,
    tenantId,
    pathwayInstanceId,
    pathwayInstance,
    workflowRunId,
    idempotencyKey,
    commandFingerprint,
    actor,
    registry
  });
  const intent = normalizeTransitionIntent(
    {
      workflowStepId,
      transitionScope,
      transitionKey,
      stageKey,
      previousState,
      newState,
      sourceResourceType,
      sourceResourceId,
      workflowSlaInstanceId,
      occurredAt,
      eventPayload,
      metadata
    },
    effectOrdinal
  );
  const session = await beginTransitionAppendSessionTx(context);
  return appendNormalizedTransitionInSessionTx(session, intent);
}

export async function appendPathwayTransitionEventsBatchTx({
  tx,
  tenantId,
  pathwayInstanceId,
  pathwayInstance = null,
  workflowRunId,
  idempotencyKey,
  commandFingerprint,
  occurredAt = null,
  actor,
  registry = workflowRuntimeRegistry,
  intents
} = {}) {
  const context = normalizeAppendContext({
    tx,
    tenantId,
    pathwayInstanceId,
    pathwayInstance,
    workflowRunId,
    idempotencyKey,
    commandFingerprint,
    actor,
    registry
  });
  if (!Array.isArray(intents) || intents.length === 0) {
    throw AppError.badRequest(
      'Pathway transition batch requires at least one intent',
      'PATHWAY_TRANSITION_BATCH_REQUIRED'
    );
  }
  if (intents.length > PG_INT_MAX) {
    throw AppError.badRequest(
      'Pathway transition batch exceeds the supported effect range',
      'PATHWAY_TRANSITION_BATCH_TOO_LARGE'
    );
  }
  const batchOccurredAt = normalizeOccurredAt(occurredAt);
  const normalizedIntents = intents.map((intent, ordinal) => {
    if (!intent || typeof intent !== 'object' || Array.isArray(intent)) {
      throw AppError.badRequest(
        'Pathway transition intent must be an object',
        'PATHWAY_TRANSITION_BAD_INTENT'
      );
    }
    if (Object.hasOwn(intent, 'effectOrdinal')) {
      throw AppError.badRequest(
        'Batch transition ordinals are assigned by array order',
        'PATHWAY_TRANSITION_BATCH_ORDINAL_FORBIDDEN'
      );
    }
    return normalizeTransitionIntent(
      {
        ...intent,
        occurredAt: intent.occurredAt ?? batchOccurredAt
      },
      ordinal
    );
  });
  const session = await beginTransitionAppendSessionTx(context);
  if (session.replayEvents.length > 0) {
    if (session.replayEvents.length !== normalizedIntents.length) {
      throw AppError.conflict(
        'Pathway command evidence is only a partial match for this transition batch',
        'PATHWAY_TRANSITION_BATCH_REPLAY_INCOMPLETE'
      );
    }
    return {
      events: [...session.replayEvents],
      replayed: true,
      pathwayInstance: session.pathwayInstance
    };
  }

  await captureNextSequenceTx(session);
  const events = [];
  for (const intent of normalizedIntents) {
    const result = await appendNormalizedTransitionInSessionTx(session, intent);
    events.push(result.event);
  }
  return {
    events,
    replayed: false,
    pathwayInstance: session.pathwayInstance
  };
}

export default {
  appendPathwayTransitionEventTx,
  appendPathwayTransitionEventsBatchTx,
  findPathwayTransitionReplayTx
};
