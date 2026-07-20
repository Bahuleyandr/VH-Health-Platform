import { createHash } from 'node:crypto';

import { isTenantTransactionClient, setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { startWorkflowSla } from '../clinical/canonicalClinicalPlatformService.js';
import { requireTenantId } from '../tenant/tenantService.js';
import {
  completePathwayTaskFromRegisteredEvidence,
  createApproval,
  createTask,
} from '../workflow/taskService.js';
import {
  compileWorkflowDefinition,
  WORKFLOW_RUNTIME_LIMITS,
} from '../workflow/workflowDefinitionCompiler.js';
import { assertWorkflowJsonBudget } from '../workflow/workflowJsonGuard.js';
import {
  isPathwayHumanOwnerRole,
  resolvePathwayTaskOwnerTx,
} from '../workflow/workflowHumanOwnerService.js';
import {
  isRegisteredWorkflowSystemActor,
  isWorkflowRuntimeRegistry,
  workflowRuntimeRegistry,
} from '../workflow/workflowRuntimeRegistry.js';
import {
  acquirePathwayStartLocksTx,
  activatePathwayInstanceCasTx,
  assertPathwayReplayDefinitionPinTx,
  assertPathwayPatientContextTx,
  assertPathwayTenantScopeTx,
  closePathwayInstanceCasTx,
  findActivePathwayEpisodeTx,
  findPathwayInstanceByIdempotencyTx,
  getCarePathwayInstanceTx,
  getPathwayTransitionLedgerStateTx,
  insertPathwayRuntimeTx,
  loadGovernedPathwayDefinitionTx,
  lockPathwayRuntimeTx,
  preflightPathwaySlaRulesTx,
  resolvePathwayModeTx,
  transitionPathwayRunCasTx,
  transitionPathwayStepCasTx,
} from './pathwayRuntimePersistence.js';
import {
  appendPathwayTransitionEventTx,
  appendPathwayTransitionEventsBatchTx,
  findPathwayTransitionReplayTx,
} from './pathwayTransitionEventService.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CANONICAL_KEY_RE = /^[a-z][a-z0-9_]{0,119}$/;
const SOURCE_TYPE_RE = /^[a-z][a-z0-9_]{0,79}$/;
const ROLE_RE = /^[A-Z][A-Z0-9_]{0,79}$/;
const IDEMPOTENCY_RE = /^[A-Za-z0-9_.:-]+$/;
const HANDLER_ID_RE = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*\.v[1-9][0-9]*$/;
const ISO_TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const TRIGGER_KINDS = new Set(['manual', 'event', 'schedule', 'api', 'subgraph']);
const ADMIN_ROLES = new Set(['ADMIN', 'SUPER_ADMIN']);
const TERMINAL_RUN_STATUSES = new Set(['completed', 'cancelled', 'failed']);
const TERMINAL_TASK_STATUSES = new Set(['completed', 'cancelled']);
const TERMINAL_APPROVAL_STATUSES = new Set(['approved', 'rejected', 'cancelled', 'expired']);
const MAX_CHILDREN_PER_RULE = WORKFLOW_RUNTIME_LIMITS.maxChildrenPerRule;
const MAX_CHILDREN_PER_STAGE = WORKFLOW_RUNTIME_LIMITS.maxChildrenPerStage;
const MAX_CHILDREN_PER_COMMAND = WORKFLOW_RUNTIME_LIMITS.maxChildrenPerCommand;
const MAX_CHILD_WORKFLOW_STEPS_PER_COMMAND = WORKFLOW_RUNTIME_LIMITS
  .maxChildWorkflowStepsPerCommand;
const MAX_TRANSITION_INTENTS_PER_COMMAND = WORKFLOW_RUNTIME_LIMITS
  .maxTransitionIntentsPerCommand;
const MAX_APPLIED_PLANS_PER_COMMAND = WORKFLOW_RUNTIME_LIMITS.maxAppliedPlansPerCommand;
const CONDITION_EVIDENCE_SAVEPOINT = 'care_pathway_condition_evidence';
const TASK_MATERIALIZATION_CONTRACT = 'application_atomic_v1';
const SIGNAL_FIELDS = new Set([
  'kind', 'payload', 'source_resource_type', 'source_resource_id', 'occurred_at',
]);
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const activationEvidenceCapabilities = new WeakSet();
const childStartCapabilities = new WeakMap();
const pathwayExecutorCapabilities = new WeakSet();

function mintPathwayExecutorCapability() {
  const capability = Object.freeze({ kind: 'pathway_executor_mutation_capability' });
  pathwayExecutorCapabilities.add(capability);
  return capability;
}

export function isPathwayExecutorCapability(value) {
  return Boolean(value && typeof value === 'object' && pathwayExecutorCapabilities.has(value));
}

export function mintPathwayExecutorCapabilityForTest() {
  if (process.env.NODE_ENV !== 'test') {
    throw AppError.forbidden(
      'Pathway executor mutation capability is available only to conformance tests',
      'PATHWAY_TEST_CAPABILITY_FORBIDDEN',
    );
  }
  return mintPathwayExecutorCapability();
}

function badRequest(message, code = 'PATHWAY_COMMAND_INVALID') {
  throw AppError.badRequest(message, code);
}

function requireUuid(value, label) {
  const text = String(value ?? '').trim();
  if (!UUID_RE.test(text)) badRequest(`${label} must be a UUID`, 'PATHWAY_BAD_UUID');
  return text.toLowerCase();
}

function optionalUuid(value, label) {
  if (value === null || value === undefined || value === '') return null;
  return requireUuid(value, label);
}

function normalizeNamedPathwayOwnerUid(input) {
  if (!Object.prototype.hasOwnProperty.call(input, 'owningClinicianUid')) return null;
  if (input.owningClinicianUid === null || input.owningClinicianUid === undefined) return null;
  const value = typeof input.owningClinicianUid === 'string'
    ? input.owningClinicianUid.trim()
    : '';
  if (!UUID_RE.test(value)) {
    throw AppError.conflict(
      'Named pathway owner is unavailable or not route-capable',
      'PATHWAY_NAMED_OWNER_UNAVAILABLE',
    );
  }
  return value.toLowerCase();
}

function requirePositiveInteger(value, label) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || String(parsed) !== String(value).trim()) {
    badRequest(`${label} must be a positive integer`, 'PATHWAY_BAD_INTEGER');
  }
  return parsed;
}

function optionalPositiveInteger(value, label) {
  if (value === null || value === undefined || value === '') return null;
  return requirePositiveInteger(value, label);
}

function normalizeIsoTimestamp(value, label) {
  if (typeof value !== 'string' || value.trim() !== value) {
    badRequest(`${label} must be an ISO timestamp`);
  }
  const parts = ISO_TIMESTAMP_RE.exec(value);
  if (!parts) badRequest(`${label} must be an ISO timestamp`);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetText] = parts;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [0, 31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const offsetHours = offsetText === 'Z' ? 0 : Number(offsetText.slice(1, 3));
  const offsetMinutes = offsetText === 'Z' ? 0 : Number(offsetText.slice(4, 6));
  if (
    year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth[month]
    || hour > 23 || minute > 59 || second > 59 || offsetHours > 23 || offsetMinutes > 59
  ) badRequest(`${label} must be an ISO timestamp`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) badRequest(`${label} must be an ISO timestamp`);
  return parsed.toISOString();
}

function requireText(value, label, max, pattern = null) {
  if (typeof value !== 'string') badRequest(`${label} must be a string`);
  const text = value.trim();
  if (!text) badRequest(`${label} is required`);
  if (text.length > max) badRequest(`${label} must be at most ${max} characters`);
  if (pattern && !pattern.test(text)) badRequest(`${label} is not canonical`);
  return text;
}

function optionalText(value, label, max, pattern = null) {
  if (value === null || value === undefined || value === '') return null;
  return requireText(value, label, max, pattern);
}

function requireIdempotencyKey(value) {
  const key = requireText(value, 'idempotency_key', 200);
  if (!IDEMPOTENCY_RE.test(key)) {
    badRequest(
      'idempotency_key contains unsupported characters',
      'PATHWAY_IDEMPOTENCY_KEY_INVALID',
    );
  }
  return key;
}

function assertPlainDataObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    badRequest(`${label} must be a plain JSON object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    badRequest(`${label} must be a plain JSON object`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || UNSAFE_KEYS.has(key)) {
      badRequest(`${label} contains an unsafe key`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || descriptor.get || descriptor.set) {
      badRequest(`${label}.${key} must be an enumerable data property`);
    }
  }
}

function assertCommandJsonBudget(value, label, options = {}) {
  assertWorkflowJsonBudget(value, {
    label,
    ...options,
    onViolation: ({ kind, message }) => {
      badRequest(
        message,
        ['depth', 'nodes', 'bytes'].includes(kind)
          ? 'PATHWAY_JSON_LIMIT_EXCEEDED'
          : 'PATHWAY_JSON_INVALID',
      );
    },
  });
}

function cloneJson(value, label, ancestors = null) {
  if (ancestors === null) {
    assertCommandJsonBudget(value, label);
    ancestors = new WeakSet();
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) badRequest(`${label} must contain only finite numbers`);
    return value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) badRequest(`${label} must not be circular`);
    ancestors.add(value);
    const copy = value.map((item, index) => cloneJson(item, `${label}[${index}]`, ancestors));
    ancestors.delete(value);
    return Object.freeze(copy);
  }
  assertPlainDataObject(value, label);
  if (ancestors.has(value)) badRequest(`${label} must not be circular`);
  ancestors.add(value);
  const copy = {};
  for (const [key, item] of Object.entries(value)) {
    copy[key] = cloneJson(item, `${label}.${key}`, ancestors);
  }
  ancestors.delete(value);
  return Object.freeze(copy);
}

function normalizeJsonObject(value, label) {
  if (value === null || value === undefined) return Object.freeze({});
  const normalized = cloneJson(value, label);
  if (Array.isArray(normalized) || normalized === null || typeof normalized !== 'object') {
    badRequest(`${label} must be a plain JSON object`);
  }
  return normalized;
}

function freezeHandlerValue(value, ancestors = null) {
  if (ancestors === null) {
    assertWorkflowJsonBudget(value, {
      label: 'pathway runtime value',
      allowBigInt: true,
      allowDate: true,
      onViolation: ({ kind, message }) => {
        throw AppError.conflict(
          message,
          ['depth', 'nodes', 'bytes'].includes(kind)
            ? 'PATHWAY_JSON_LIMIT_EXCEEDED'
            : 'PATHWAY_GRAPH_INVALID',
        );
      },
    });
    ancestors = new WeakSet();
  }
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
  ) return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw AppError.conflict('Pathway runtime snapshot is circular', 'PATHWAY_GRAPH_INVALID');
    }
    ancestors.add(value);
    const copy = value.map((item) => freezeHandlerValue(item, ancestors));
    ancestors.delete(value);
    return Object.freeze(copy);
  }
  if (typeof value !== 'object' || ancestors.has(value)) {
    throw AppError.conflict('Pathway runtime snapshot is invalid', 'PATHWAY_GRAPH_INVALID');
  }
  ancestors.add(value);
  const copy = {};
  for (const [key, item] of Object.entries(value)) {
    copy[key] = freezeHandlerValue(item, ancestors);
  }
  ancestors.delete(value);
  return Object.freeze(copy);
}

function parseStoredJson(value, label, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    throw AppError.conflict(`${label} is malformed`, 'PATHWAY_DEFINITION_INVALID');
  }
}

function replayResult(events) {
  const first = Array.isArray(events) ? events[0] : null;
  const metadata = parseStoredJson(first?.metadata, 'Pathway replay metadata', {});
  const runtimeMetadata = parseStoredJson(
    metadata?.pathway_runtime,
    'Pathway replay runtime metadata',
    {},
  );
  if (!runtimeMetadata?.result_snapshot || typeof runtimeMetadata.result_snapshot !== 'object') {
    throw AppError.conflict(
      'Pathway replay result snapshot is missing',
      'PATHWAY_REPLAY_RESULT_MISSING',
    );
  }
  return Object.freeze({
    resultSnapshot: freezeHandlerValue(runtimeMetadata.result_snapshot),
    mode: typeof runtimeMetadata.mode === 'string' ? runtimeMetadata.mode : 'shadow',
  });
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

function actionRuntimeSnapshot(runtime, ledgerState) {
  return fingerprint(freezeHandlerValue({
    instance: runtime.instance,
    run: runtime.run,
    steps: runtime.steps,
    children: runtime.children,
    tasks: runtime.tasks,
    approvals: runtime.approvals,
    handoffs: runtime.handoffs,
    slas: runtime.slas,
    definition: runtime.definition,
    child_runtime_graphs: runtime.childRuntimeGraphs || [],
    transition_ledger: ledgerState,
  }));
}

async function executeRegisteredActionGuarded(ctx, handler, step) {
  const preHandlerRuntime = await lockPathwayRuntimeTx({
    tx: ctx.tx,
    tenantId: ctx.tenantId,
    pathwayInstanceId: ctx.runtime.instance.id,
  });
  const preHandlerStep = preHandlerRuntime.steps.find(
    (candidate) => Number(candidate.id) === Number(step.id),
  );
  if (!preHandlerStep || preHandlerStep.step_key !== step.step_key) {
    throw AppError.conflict('Care pathway action step changed before execution', 'PATHWAY_GRAPH_INVALID');
  }
  ctx.runtime = preHandlerRuntime;
  const beforeLedger = await getPathwayTransitionLedgerStateTx({
    tx: ctx.tx,
    tenantId: ctx.tenantId,
    pathwayInstanceId: ctx.runtime.instance.id,
  });
  const beforeSnapshot = actionRuntimeSnapshot(ctx.runtime, beforeLedger);
  const handlerResult = await handler.execute(Object.freeze({
    tenantId: ctx.tenantId,
    instance: freezeHandlerValue(ctx.runtime.instance),
    run: freezeHandlerValue(ctx.runtime.run),
    step: freezeHandlerValue(preHandlerStep),
    signal: ctx.signal,
    actor: ctx.actor,
  }));
  let reloadedRuntime;
  let afterLedger;
  try {
    reloadedRuntime = await lockPathwayRuntimeTx({
      tx: ctx.tx,
      tenantId: ctx.tenantId,
      pathwayInstanceId: ctx.runtime.instance.id,
    });
    afterLedger = await getPathwayTransitionLedgerStateTx({
      tx: ctx.tx,
      tenantId: ctx.tenantId,
      pathwayInstanceId: ctx.runtime.instance.id,
    });
  } catch {
    throw AppError.conflict(
      'Registered action invalidated pathway runtime state outside the executor',
      'PATHWAY_ACTION_RUNTIME_MUTATION_FORBIDDEN',
    );
  }
  if (actionRuntimeSnapshot(reloadedRuntime, afterLedger) !== beforeSnapshot) {
    throw AppError.conflict(
      'Registered action mutated pathway runtime state outside the executor',
      'PATHWAY_ACTION_RUNTIME_MUTATION_FORBIDDEN',
    );
  }
  ctx.runtime = reloadedRuntime;
  return handlerResult;
}

function fingerprint(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function actorFingerprintIdentity(actor) {
  if (actor.kind === 'user') return actor;
  return Object.freeze({
    kind: 'system',
    systemKey: actor.systemKey,
    sourceEventId: actor.sourceEventId,
    causationId: actor.causationId,
    signalContext: actor.signalContext,
  });
}

function namespaceUserIdempotencyKey(actor, operation, rawKey) {
  return `u:${actor.uid}:${fingerprint({ operation, rawKey })}`;
}

function namespaceSystemIdempotencyKey(actor, operation, targetIdentity) {
  return `s:${fingerprint({
    systemKey: actor.systemKey,
    sourceEventId: actor.sourceEventId,
    operation,
    targetIdentity,
  })}`;
}

function normalizeActor(actor, registry) {
  if (!actor || typeof actor !== 'object' || Array.isArray(actor)) {
    throw AppError.unauthorized('Pathway actor is required');
  }
  if (actor.kind === 'system') {
    if (!isRegisteredWorkflowSystemActor(actor, { registry })) {
      throw AppError.forbidden(
        'Pathway system actor is not registered for this runtime',
        'PATHWAY_SYSTEM_ACTOR_NOT_REGISTERED',
      );
    }
    return actor;
  }
  if (actor.kind !== 'user') {
    badRequest('Pathway actor kind must be user or system', 'PATHWAY_ACTOR_INVALID');
  }
  const uid = requireUuid(actor.uid, 'actor.uid');
  const suppliedRoles = Array.isArray(actor.roles) ? actor.roles : [];
  const roles = [...new Set(suppliedRoles.map((role) => (
    requireText(role, 'actor role', 80).toUpperCase()
  )))];
  if (roles.length === 0 || roles.some((role) => !ROLE_RE.test(role))) {
    throw AppError.unauthorized('Authenticated pathway actor role is required');
  }
  const primaryRole = actor.primaryRole === null || actor.primaryRole === undefined
    ? roles[0]
    : requireText(actor.primaryRole, 'actor.primaryRole', 80).toUpperCase();
  if (!ROLE_RE.test(primaryRole) || !roles.includes(primaryRole)) {
    badRequest(
      'actor.primaryRole must be one of actor.roles',
      'PATHWAY_ACTOR_PRIMARY_ROLE_INVALID',
    );
  }
  const authorizationMode = requireText(
    actor.authorizationMode,
    'actor.authorizationMode',
    80,
  );
  const overrideReason = optionalText(actor.overrideReason, 'actor.overrideReason', 2000);
  const breakGlassId = optionalPositiveInteger(actor.breakGlassId, 'actor.breakGlassId');
  if (authorizationMode.toLowerCase().includes('override') && !overrideReason) {
    badRequest(
      'actor.overrideReason is required for override authorization',
      'PATHWAY_OVERRIDE_REASON_REQUIRED',
    );
  }
  if (
    authorizationMode.toLowerCase() === 'patient_access_break_glass'
    && (!breakGlassId || !overrideReason)
  ) {
    badRequest(
      'Patient-access break-glass authorization requires its audit id and reason',
      'PATHWAY_BREAK_GLASS_CONTEXT_REQUIRED',
    );
  }
  return Object.freeze({
    kind: 'user',
    uid,
    roles: Object.freeze(roles),
    primaryRole,
    authorizationMode,
    ...(overrideReason ? { overrideReason } : {}),
    ...(breakGlassId ? { breakGlassId } : {}),
  });
}

function normalizeSignal(signal) {
  assertPlainDataObject(signal, 'signal');
  for (const key of Object.keys(signal)) {
    if (!SIGNAL_FIELDS.has(key)) badRequest(`signal.${key} is not supported`);
  }
  const kind = requireText(signal.kind, 'signal.kind', 120, CANONICAL_KEY_RE);
  const sourceResourceType = optionalText(
    signal.source_resource_type,
    'signal.source_resource_type',
    80,
    SOURCE_TYPE_RE,
  );
  const sourceResourceId = optionalText(
    signal.source_resource_id,
    'signal.source_resource_id',
    160,
  );
  if (Boolean(sourceResourceType) !== Boolean(sourceResourceId)) {
    badRequest(
      'signal source_resource_type and source_resource_id must be supplied together',
      'PATHWAY_SIGNAL_SOURCE_PAIR_REQUIRED',
    );
  }
  let occurredAt = null;
  if (signal.occurred_at !== null && signal.occurred_at !== undefined) {
    if (typeof signal.occurred_at !== 'string' || !signal.occurred_at.trim()) {
      badRequest('signal.occurred_at must be an ISO timestamp');
    }
    occurredAt = normalizeIsoTimestamp(signal.occurred_at, 'signal.occurred_at');
  }
  return Object.freeze({
    kind,
    payload: normalizeJsonObject(signal.payload, 'signal.payload'),
    source_resource_type: sourceResourceType,
    source_resource_id: sourceResourceId,
    occurred_at: occurredAt,
  });
}

function normalizeRegistry(registry) {
  if (!isWorkflowRuntimeRegistry(registry)) {
    badRequest('registry is not a workflow runtime registry', 'PATHWAY_REGISTRY_INVALID');
  }
  return registry;
}

async function inTenantTx(tenantId, suppliedTx, fn) {
  if (suppliedTx !== null && suppliedTx !== undefined) {
    if (!isTenantTransactionClient(suppliedTx)) {
      throw AppError.internal(
        'Pathway executor requires a branded tenant transaction',
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

function assertModeAvailable(mode, activationEvidenceCapability = null) {
  if (mode === 'off') {
    throw AppError.conflict('Care pathway mode is off', 'PATHWAY_MODE_OFF');
  }
  if (mode === 'active') {
    if (activationEvidenceCapabilities.has(activationEvidenceCapability)) {
      return Object.freeze({ mode, suppressEffects: false });
    }
    throw AppError.conflict(
      'Care pathway active execution evidence is not available',
      'PATHWAY_ACTIVE_EXECUTION_UNAVAILABLE',
    );
  }
  if (mode !== 'shadow') {
    throw AppError.conflict('Care pathway mode is unavailable', 'PATHWAY_MODE_OFF');
  }
  return Object.freeze({ mode, suppressEffects: true });
}

function compilePinnedDefinition(definition, registry) {
  const compiled = compileWorkflowDefinition({
    workflow_key: definition.workflow_key,
    version: Number(definition.version),
    steps: parseStoredJson(definition.steps, 'Pathway definition steps', []),
    triggers: parseStoredJson(definition.triggers, 'Pathway definition triggers', []),
    defaults: parseStoredJson(definition.defaults, 'Pathway definition defaults', {}),
  }, { registry });
  const expectedChecksum = String(definition.definition_checksum || '').trim().toLowerCase();
  if (!expectedChecksum || compiled.checksum !== expectedChecksum) {
    throw AppError.conflict(
      'Pathway definition checksum does not match its governance evidence',
      'PATHWAY_DEFINITION_CHECKSUM_MISMATCH',
    );
  }
  return compiled;
}

function actorUid(actor) {
  return actor.kind === 'user' ? actor.uid : null;
}

function hasAnyRole(actor, roles) {
  if (actor.kind !== 'user') return false;
  const allowed = new Set(roles.filter(Boolean).map((role) => String(role).toUpperCase()));
  return actor.roles.some((role) => ADMIN_ROLES.has(role) || allowed.has(role));
}

function assertStartOwnership(input, actor) {
  if (actor.kind === 'system') return;
  if (
    actor.uid === input.owningClinicianUid
    || hasAnyRole(actor, [input.accountableRole])
  ) return;
  throw AppError.forbidden(
    'Actor is not authorized to start this care pathway',
    'PATHWAY_SIGNAL_NOT_OWNED',
  );
}

async function assertCurrentInstanceOwnerTx(tx, tenantId, instance, actor) {
  const namedOwnerUid = String(instance?.owning_clinician_uid || '').toLowerCase();
  if (!namedOwnerUid) return false;
  const owner = await resolvePathwayTaskOwnerTx({
    tx,
    tenantId,
    requestedUid: namedOwnerUid,
  });
  if (actor.kind === 'system' || actor.uid === owner.assignedToUid) return true;
  throw AppError.forbidden(
    'Actor is not authorized for the current pathway stage',
    'PATHWAY_SIGNAL_NOT_OWNED',
  );
}

async function assertCommandOwnership(tx, tenantId, runtime, compiled, actor) {
  const namedOwner = await assertCurrentInstanceOwnerTx(
    tx,
    tenantId,
    runtime.instance,
    actor,
  );
  if (namedOwner || actor.kind === 'system') return;
  const current = runtime.steps.find((step) => step.step_key === runtime.run.current_step_key)
    || runtime.steps[0]
    || null;
  const currentTasks = current
    ? runtime.tasks.filter((task) => Number(task.workflow_step_id) === Number(current.id))
    : [];
  const currentApprovals = current
    ? runtime.approvals.filter((approval) => Number(approval.workflow_step_id) === Number(current.id))
    : [];
  const roles = [
    runtime.instance.accountable_role,
    current?.assigned_role,
    compiled.steps.find((step) => step.step_key === current?.step_key)?.assigned_role,
    ...currentTasks.map((task) => task.assigned_to_role),
    ...currentApprovals.map((approval) => approval.required_role),
  ];
  if (
    currentTasks.some((task) => String(task.assigned_to_uid || '').toLowerCase() === actor.uid)
    || hasAnyRole(actor, roles)
  ) return;
  throw AppError.forbidden(
    'Actor is not authorized for the current pathway stage',
    'PATHWAY_SIGNAL_NOT_OWNED',
  );
}

function assertRuntimeGraph(runtime, compiled) {
  const { instance, run, steps, definition } = runtime;
  const instanceChecksum = String(instance.definition_checksum || '');
  const runChecksum = String(run.pathway_definition_checksum || '');
  if (
    Number(instance.workflow_run_id) !== Number(run.id)
    || Number(instance.workflow_definition_id) !== Number(run.workflow_definition_id)
    || String(instance.definition_governance_id || '').toLowerCase()
      !== String(run.pathway_governance_id || '').toLowerCase()
    || instanceChecksum !== runChecksum
    || instance.pathway_key !== run.workflow_key
    || Number(instance.pathway_version) !== Number(run.workflow_version)
    || Number(definition?.id) !== Number(run.workflow_definition_id)
    || String(definition?.governance_id || '').toLowerCase()
      !== String(run.pathway_governance_id || '').toLowerCase()
    || String(definition?.definition_checksum || '') !== runChecksum
    || compiled.checksum !== runChecksum
    || run.workflow_key !== compiled.workflow_key
    || Number(run.workflow_version) !== compiled.version
    || steps.length !== compiled.steps.length
  ) {
    throw AppError.conflict('Care pathway runtime graph is inconsistent', 'PATHWAY_GRAPH_INVALID');
  }
  for (const [index, step] of steps.entries()) {
    const expected = compiled.steps[index];
    if (
      Number(step.ordering) !== index
      || step.step_key !== expected.step_key
      || step.step_kind !== expected.step_kind
      || Number(step.workflow_run_id) !== Number(run.id)
    ) {
      throw AppError.conflict('Care pathway step graph is inconsistent', 'PATHWAY_GRAPH_INVALID');
    }
  }
  const activeSteps = steps.filter((step) => ['in_progress', 'blocked'].includes(step.status));
  if (run.status === 'started') {
    if (
      run.current_step_key !== null
      || activeSteps.length !== 0
      || instance.clinical_status !== 'planned'
      || steps.some((step) => step.status !== 'pending')
    ) {
      throw AppError.conflict('Care pathway start state is inconsistent', 'PATHWAY_GRAPH_INVALID');
    }
    return;
  }
  if (run.status === 'running' || run.status === 'blocked') {
    const currentIndex = steps.findIndex((step) => step.step_key === run.current_step_key);
    const priorStepsValid = currentIndex > 0
      ? steps.slice(0, currentIndex).every((step) => ['completed', 'skipped'].includes(step.status))
      : currentIndex === 0;
    const laterStepsValid = currentIndex >= 0
      && steps.slice(currentIndex + 1).every((step) => step.status === 'pending');
    if (
      !run.current_step_key
      || currentIndex < 0
      || activeSteps.length !== 1
      || activeSteps[0].step_key !== run.current_step_key
      || activeSteps[0].status !== (run.status === 'blocked' ? 'blocked' : 'in_progress')
      || !['active', 'on_hold'].includes(instance.clinical_status)
      || !priorStepsValid
      || !laterStepsValid
    ) {
      throw AppError.conflict('Care pathway current step is inconsistent', 'PATHWAY_GRAPH_INVALID');
    }
    return;
  }
  if (run.status === 'completed') {
    if (
      run.current_step_key
      || activeSteps.length > 0
      || instance.clinical_status !== 'completed'
      || !instance.closed_at
      || steps.some((step) => !['completed', 'skipped'].includes(step.status))
    ) {
      throw AppError.conflict('Care pathway completed state is inconsistent', 'PATHWAY_GRAPH_INVALID');
    }
    return;
  }
  if (run.status === 'cancelled' || run.status === 'failed') {
    const expectedClinicalStatus = run.status === 'cancelled' ? 'cancelled' : 'entered_in_error';
    if (
      run.current_step_key
      || activeSteps.length > 0
      || instance.clinical_status !== expectedClinicalStatus
      || !instance.closed_at
      || (run.status === 'failed' && !steps.some((step) => step.status === 'failed'))
    ) {
      throw AppError.conflict('Care pathway terminal state is inconsistent', 'PATHWAY_GRAPH_INVALID');
    }
    return;
  }
  throw AppError.conflict('Care pathway run status is invalid', 'PATHWAY_GRAPH_INVALID');
}

function normalizeStartInput(input, registry) {
  const tenantId = requireUuid(requireTenantId(input.tenantId), 'tenant_id');
  const actor = normalizeActor(input.actor, registry);
  const triggerKind = input.triggerKind ?? 'manual';
  if (!TRIGGER_KINDS.has(triggerKind)) badRequest('trigger_kind is unsupported');
  const patientUid = requireUuid(input.patientUid, 'patient_uid');
  const encounterId = optionalUuid(input.encounterId, 'encounter_id');
  const parentInstanceId = optionalUuid(input.parentInstanceId, 'parent_instance_id');
  const trustedChildStart = Boolean(
    parentInstanceId && childStartCapabilities.has(input.childStartCapability),
  );
  const childStartBinding = trustedChildStart
    ? childStartCapabilities.get(input.childStartCapability)
    : null;
  if (parentInstanceId && !trustedChildStart) {
    throw AppError.forbidden(
      'Parent pathway links may be created only by registered child fan-out',
      'PATHWAY_PARENT_LINK_NOT_REGISTERED',
    );
  }
  const triggerPayload = normalizeJsonObject(input.triggerPayload, 'trigger_payload');
  if (actor.kind === 'system' && !trustedChildStart) {
    if (triggerKind !== 'event') {
      badRequest(
        'Registered system pathway starts require an event trigger',
        'PATHWAY_SYSTEM_START_TRIGGER_INVALID',
      );
    }
    if (
      Object.prototype.hasOwnProperty.call(triggerPayload, 'source_resource_type')
      || Object.prototype.hasOwnProperty.call(triggerPayload, 'source_resource_id')
      || Object.prototype.hasOwnProperty.call(triggerPayload, 'occurred_at')
    ) {
      badRequest(
        'System pathway start lineage comes only from its sealed signal context',
        'PATHWAY_SYSTEM_SIGNAL_CONTEXT_SPOOFED',
      );
    }
  }
  let owningClinicianUid = normalizeNamedPathwayOwnerUid(input);
  let owningTeamId = optionalPositiveInteger(input.owningTeamId, 'owning_team_id');
  let accountableRole = optionalText(input.accountableRole, 'accountable_role', 80)?.toUpperCase()
    || null;
  if (actor.kind === 'user' && !trustedChildStart) {
    if (owningClinicianUid && owningClinicianUid !== actor.uid) {
      throw AppError.forbidden(
        'Manual pathway ownership must remain with the authenticated caller',
        'PATHWAY_MANUAL_OWNER_FORBIDDEN',
      );
    }
    if (owningTeamId) {
      throw AppError.forbidden(
        'Manual team pathway assignment is not available',
        'PATHWAY_MANUAL_TEAM_FORBIDDEN',
      );
    }
    if (accountableRole && accountableRole !== actor.primaryRole) {
      throw AppError.forbidden(
        'Manual pathway accountable role must come from authenticated context',
        'PATHWAY_MANUAL_ACCOUNTABLE_ROLE_FORBIDDEN',
      );
    }
    owningClinicianUid = actor.uid;
    owningTeamId = null;
    accountableRole = actor.primaryRole;
  } else if (!accountableRole) {
    badRequest('accountable_role is required');
  }
  const workflowDefinitionId = requirePositiveInteger(
    input.workflowDefinitionId,
    'workflow_definition_id',
  );
  const pathwayKey = requireText(input.pathwayKey, 'pathway_key', 120, CANONICAL_KEY_RE);
  const sourceEpisodeType = requireText(
    input.sourceEpisodeType,
    'source_episode_type',
    80,
    SOURCE_TYPE_RE,
  );
  const sourceEpisodeId = requireText(input.sourceEpisodeId, 'source_episode_id', 160);
  const rawIdempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const startTargetIdentity = Object.freeze({
    tenantId,
    workflowDefinitionId,
    patientUid,
    encounterId,
    pathwayKey,
    sourceEpisodeType,
    sourceEpisodeId,
  });
  const idempotencyKey = trustedChildStart
    ? childStartBinding.idempotencyKey
    : actor.kind === 'user'
      ? namespaceUserIdempotencyKey(
        actor,
        'start_care_pathway_instance',
        rawIdempotencyKey,
      )
      : namespaceSystemIdempotencyKey(
        actor,
        'start_care_pathway_instance',
        startTargetIdentity,
      );
  const normalized = Object.freeze({
    tenantId,
    workflowDefinitionId,
    patientUid,
    encounterId,
    pathwayKey,
    sourceEpisodeType,
    sourceEpisodeId,
    parentInstanceId,
    owningClinicianUid,
    owningTeamId,
    accountableRole,
    triggerKind,
    triggerPayload,
    context: normalizeJsonObject(input.context, 'context'),
    metadata: normalizeJsonObject(input.metadata, 'metadata'),
    idempotencyKey,
    actor,
    activationEvidenceCapability: input.activationEvidenceCapability ?? null,
    childWorkflowStepBudget: childStartBinding?.childWorkflowStepBudget || null,
  });
  if (!ROLE_RE.test(normalized.accountableRole)) badRequest('accountable_role is not canonical');
  if (!isPathwayHumanOwnerRole(normalized.accountableRole)) {
    badRequest(
      'accountable_role must be a route-capable human clinical role',
      'PATHWAY_ACCOUNTABLE_ROLE_UNREACHABLE',
    );
  }
  if (actor.kind === 'user' && !trustedChildStart) {
    const expectedSourceType = encounterId ? 'patient_encounter' : 'patient';
    const expectedSourceId = encounterId || patientUid;
    if (
      normalized.sourceEpisodeType !== expectedSourceType
      || normalized.sourceEpisodeId.toLowerCase() !== expectedSourceId
    ) {
      throw AppError.badRequest(
        'User pathway source must match the guarded patient context',
        'PATHWAY_SOURCE_CONTEXT_MISMATCH',
      );
    }
  }
  if (!trustedChildStart) assertStartOwnership(normalized, actor);
  return normalized;
}

function normalizeCommandInput(input, registry) {
  const actor = normalizeActor(input.actor, registry);
  let signal = normalizeSignal(input.signal);
  if (actor.kind === 'system') {
    if (
      Object.prototype.hasOwnProperty.call(input.signal, 'source_resource_type')
      || Object.prototype.hasOwnProperty.call(input.signal, 'source_resource_id')
      || Object.prototype.hasOwnProperty.call(input.signal, 'occurred_at')
    ) {
      badRequest(
        'System pathway command lineage comes only from its sealed signal context',
        'PATHWAY_SYSTEM_SIGNAL_CONTEXT_SPOOFED',
      );
    }
    signal = Object.freeze({
      kind: signal.kind,
      payload: signal.payload,
      source_resource_type: actor.signalContext.sourceResourceType,
      source_resource_id: actor.signalContext.sourceResourceId,
      occurred_at: actor.signalContext.occurredAt,
    });
  }
  if (actor.kind === 'user' && signal.occurred_at !== null) {
    badRequest(
      'User pathway commands cannot supply occurred_at',
      'PATHWAY_USER_OCCURRED_AT_FORBIDDEN',
    );
  }
  if (
    actor.kind === 'user'
    && (signal.source_resource_type !== null || signal.source_resource_id !== null)
  ) {
    badRequest(
      'User pathway commands cannot supply source resource lineage',
      'PATHWAY_USER_SOURCE_LINEAGE_FORBIDDEN',
    );
  }
  const tenantId = requireUuid(requireTenantId(input.tenantId), 'tenant_id');
  const pathwayInstanceId = requireUuid(input.pathwayInstanceId, 'pathway_instance_id');
  const rawIdempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const commandTargetIdentity = Object.freeze({ tenantId, pathwayInstanceId });
  const idempotencyKey = actor.kind === 'user'
    ? namespaceUserIdempotencyKey(
      actor,
      'execute_pathway_command',
      rawIdempotencyKey,
    )
    : namespaceSystemIdempotencyKey(
      actor,
      'execute_pathway_command',
      commandTargetIdentity,
    );
  return Object.freeze({
    tenantId,
    pathwayInstanceId,
    idempotencyKey,
    signal,
    actor,
    tx: input.tx ?? null,
    activationEvidenceCapability: input.activationEvidenceCapability ?? null,
  });
}

export function createPathwayActivationEvidenceCapabilityForTests() {
  if (process.env.NODE_ENV !== 'test') {
    throw AppError.forbidden(
      'Pathway activation capability is available only to conformance tests',
      'PATHWAY_TEST_CAPABILITY_FORBIDDEN',
    );
  }
  const capability = Object.freeze({ kind: 'pathway_activation_evidence_test_capability' });
  activationEvidenceCapabilities.add(capability);
  return capability;
}

function createChildWorkflowStepBudget() {
  return { consumedSteps: 0 };
}

function createChildStartCapability(childWorkflowStepBudget, idempotencyKey) {
  const capability = Object.freeze({ kind: 'registered_pathway_child_start' });
  childStartCapabilities.set(capability, Object.freeze({
    childWorkflowStepBudget,
    idempotencyKey,
  }));
  return capability;
}

function debitChildWorkflowStepBudget(childWorkflowStepBudget, stepCount) {
  if (!childWorkflowStepBudget) return;
  const nextCount = childWorkflowStepBudget.consumedSteps + stepCount;
  if (nextCount > MAX_CHILD_WORKFLOW_STEPS_PER_COMMAND) {
    throw AppError.conflict(
      'Pathway command exceeded its child workflow-step limit',
      'PATHWAY_CHILD_WORKFLOW_STEP_LIMIT_EXCEEDED',
    );
  }
  childWorkflowStepBudget.consumedSteps = nextCount;
}

function createRecorder({
  tx,
  tenantId,
  instance,
  run,
  idempotencyKey,
  commandFingerprint,
  signal,
  actor,
  registry,
  runtimeMode,
  definitionChecksum,
  commandOperation = null,
}) {
  const events = [];
  const intents = [];
  return Object.freeze({
    events,
    get effectCount() {
      return intents.length;
    },
    async append({
      transitionScope,
      transitionKey,
      stageKey = null,
      workflowStepId = null,
      previousState = {},
      newState = {},
      sourceResourceType = signal.source_resource_type,
      sourceResourceId = signal.source_resource_id,
      workflowSlaInstanceId = null,
      eventPayload = {},
    }) {
      if (intents.length >= MAX_TRANSITION_INTENTS_PER_COMMAND) {
        throw AppError.conflict(
          'Pathway command exceeded its transition-effect limit',
          'PATHWAY_TRANSITION_INTENT_LIMIT_EXCEEDED',
        );
      }
      const intent = freezeHandlerValue({
        transitionScope,
        transitionKey,
        stageKey,
        workflowStepId,
        previousState,
        newState,
        sourceResourceType,
        sourceResourceId,
        workflowSlaInstanceId,
        eventPayload: {
          signal_kind: signal.kind,
          ...eventPayload,
        },
      });
      intents.push(intent);
      return intent;
    },
    async flush(resultSnapshot) {
      const result = await appendPathwayTransitionEventsBatchTx({
        tx,
        tenantId,
        pathwayInstanceId: instance.id,
        workflowRunId: run.id,
        idempotencyKey,
        commandFingerprint,
        occurredAt: signal.occurred_at,
        actor,
        registry,
        intents: intents.map((intent, ordinal) => ({
          ...intent,
          metadata: {
            pathway_runtime: {
            mode: runtimeMode.mode,
            registry_version: registry.version,
            definition_checksum: definitionChecksum,
            ...(commandOperation ? { command_operation: commandOperation } : {}),
            ...(ordinal === 0 ? { result_snapshot: resultSnapshot } : {}),
            },
          },
        })),
      });
      events.push(...result.events);
      return events;
    },
  });
}

function linkedForStep(rows, step) {
  return rows.filter((row) => Number(row.workflow_step_id) === Number(step.id));
}

function childrenForStep(runtime, step) {
  return runtime.children.filter((child) => {
    const metadata = parseStoredJson(child.metadata, 'Child pathway metadata', {});
    return metadata?.parent_stage_key === step.step_key;
  });
}

async function startStageSla({ tx, tenantId, runtime, step, semantics, owner }) {
  if (semantics.sla_completion_semantics === 'none') return null;
  const sla = await startWorkflowSla({
    tenantId,
    ruleCode: semantics.sla_rule_code,
    patientUid: runtime.instance.patient_uid,
    encounterId: runtime.instance.encounter_id,
    sourceTable: 'workflow_steps',
    sourceId: String(step.id),
    priority: semantics.priority,
    assignedRoleCodes: owner.assignedToRole ? [owner.assignedToRole] : [],
    assignedUserUid: owner.assignedToUid,
    metadata: {
      care_pathway_instance_id: runtime.instance.id,
      workflow_run_id: runtime.run.id,
      workflow_step_id: step.id,
      stage_key: step.step_key,
      task_materialization_contract: TASK_MATERIALIZATION_CONTRACT,
    },
  }, { db: tx });
  const dueAt = sla?.due_at ? new Date(sla.due_at) : null;
  if (!sla?.id || !dueAt || Number.isNaN(dueAt.getTime())) {
    throw AppError.conflict(
      'Registered pathway SLA rule could not be started',
      'PATHWAY_SLA_START_FAILED',
    );
  }
  return Object.freeze({ ...sla, due_at: dueAt.toISOString() });
}

async function materializeTask({ ctx, step, compiledStep, semantics, materializationSuffix = 'task' }) {
  const stageOccurrenceKey = `${ctx.runtime.instance.id}:${step.step_key}:${materializationSuffix}`;
  const owner = await resolvePathwayTaskOwnerTx({
    tx: ctx.tx,
    tenantId: ctx.tenantId,
    requestedUid: ctx.runtime.instance.owning_clinician_uid,
    fallbackRole: step.assigned_role || ctx.runtime.instance.accountable_role,
  });
  const sla = await startStageSla({
    tx: ctx.tx,
    tenantId: ctx.tenantId,
    runtime: ctx.runtime,
    step,
    semantics,
    owner,
  });
  if (sla && !ctx.runtime.slas.some((candidate) => String(candidate.id) === String(sla.id))) {
    ctx.runtime.slas.push(sla);
  }
  const task = await createTask({
    tenantId: ctx.tenantId,
    workflowRunId: ctx.runtime.run.id,
    workflowStepId: step.id,
    taskKind: semantics.task_kind,
    title: semantics.title || compiledStep.display_name || step.step_key,
    description: semantics.description,
    patientUid: ctx.runtime.instance.patient_uid,
    relatedResourceType: 'care_pathway_instance',
    relatedResourceId: ctx.runtime.instance.id,
    priority: semantics.priority,
    assignedToUid: owner.assignedToUid,
    assignedToRole: owner.assignedToRole,
    createdBy: actorUid(ctx.actor),
    workflowSlaInstanceId: sla?.id || null,
    slaCompletionSemantics: semantics.sla_completion_semantics,
    stageOccurrenceKey,
    metadata: {
      care_pathway_instance_id: ctx.runtime.instance.id,
      canonical_encounter_id: ctx.runtime.instance.encounter_id || null,
      stage_key: step.step_key,
      materialization_kind: materializationSuffix,
    },
    executorAuthority: ctx.executorCapability,
    tx: ctx.tx,
  });
  if (!task) {
    throw AppError.conflict(
      'Pathway task materialization did not return a task',
      'PATHWAY_TASK_MATERIALIZATION_FAILED',
    );
  }
  const taskDueAt = task.due_at ? new Date(task.due_at) : null;
  if (
    (sla && (!taskDueAt || Number.isNaN(taskDueAt.getTime())))
    || (!sla && taskDueAt)
    || (sla && taskDueAt.toISOString() !== sla.due_at)
  ) {
    throw AppError.conflict(
      'Pathway task deadline does not match its linked SLA',
      'PATHWAY_TASK_SLA_DUE_AT_MISMATCH',
    );
  }
  ctx.runtime.tasks.push(task);
  await ctx.recorder.append({
    transitionScope: 'task',
    transitionKey: 'task_materialized',
    stageKey: step.step_key,
    workflowStepId: step.id,
    previousState: {},
    newState: { task_id: task.id, status: task.status },
    sourceResourceType: 'tasks',
    sourceResourceId: String(task.id),
    workflowSlaInstanceId: sla?.id || null,
    eventPayload: { stage_occurrence_key: stageOccurrenceKey },
  });
  return task;
}

async function materializeStageEffects(ctx, stepIndex) {
  const step = ctx.runtime.steps[stepIndex];
  const compiledStep = ctx.compiled.steps[stepIndex];
  const effects = [];
  if (compiledStep.step_kind === 'task') effects.push('task');
  if (compiledStep.step_kind === 'approval') effects.push('task', 'approval');
  if (compiledStep.action_handler) effects.push('action');
  for (const rule of compiledStep.child_rules) effects.push(`child:${rule.rule_key}`);

  if (ctx.runtimeMode.suppressEffects) {
    for (const effect of effects) {
      const scope = effect === 'approval' ? 'approval' : effect.startsWith('child:') ? 'handoff' : 'task';
      await ctx.recorder.append({
        transitionScope: scope,
        transitionKey: `${effect.split(':')[0]}_materialization_suppressed`,
        stageKey: step.step_key,
        workflowStepId: step.id,
        previousState: {},
        newState: { suppressed: true, mode: 'shadow' },
        eventPayload: { effect },
      });
    }
    return Object.freeze({ autoComplete: false });
  }

  let approvalTask = null;
  let actionExecuted = false;
  let hasBlockingChild = false;
  if (compiledStep.step_kind === 'task') {
    await materializeTask({
      ctx,
      step,
      compiledStep,
      semantics: compiledStep.work_semantics,
    });
  } else if (compiledStep.step_kind === 'approval') {
    approvalTask = await materializeTask({
      ctx,
      step,
      compiledStep,
      semantics: compiledStep.work_semantics,
      materializationSuffix: 'approval_task',
    });
    const semantics = compiledStep.work_semantics;
    const materializationKey = `${ctx.runtime.instance.id}:${step.step_key}:approval`;
    const approval = await createApproval({
      tenantId: ctx.tenantId,
      workflowRunId: ctx.runtime.run.id,
      workflowStepId: step.id,
      taskId: approvalTask.id,
      approvalKind: semantics.approval_kind,
      subjectResourceType: semantics.subject_resource_type || 'care_pathway_instance',
      subjectResourceId: ctx.runtime.instance.id,
      requiredApprovers: semantics.required_approvers,
      requiredRole: semantics.required_role
        || step.assigned_role
        || ctx.runtime.instance.accountable_role,
      createdBy: actorUid(ctx.actor),
      materializationKey,
      metadata: {
        care_pathway_instance_id: ctx.runtime.instance.id,
        stage_key: step.step_key,
      },
      executorAuthority: ctx.executorCapability,
      tx: ctx.tx,
    });
    ctx.runtime.approvals.push(approval);
    await ctx.recorder.append({
      transitionScope: 'approval',
      transitionKey: 'approval_materialized',
      stageKey: step.step_key,
      workflowStepId: step.id,
      previousState: {},
      newState: { approval_id: approval.id, task_id: approvalTask.id, status: approval.status },
      sourceResourceType: 'approvals',
      sourceResourceId: String(approval.id),
      eventPayload: { materialization_key: materializationKey },
    });
  }

  if (compiledStep.action_handler) {
    const handler = ctx.registry.resolveAction(compiledStep.action_handler);
    const result = normalizeJsonObject(
      await executeRegisteredActionGuarded(ctx, handler, step),
      'action result',
    );
    await ctx.recorder.append({
      transitionScope: 'step',
      transitionKey: 'registered_action_executed',
      stageKey: step.step_key,
      workflowStepId: step.id,
      previousState: {},
      newState: result,
      eventPayload: { handler_id: compiledStep.action_handler },
    });
    actionExecuted = true;
  }

  const resolvedChildRules = [];
  let resolvedChildCount = 0;
  for (const rule of compiledStep.child_rules) {
    if (rule.relationship === 'blocking') {
      hasBlockingChild = true;
    }
    if (rule.relationship === 'ownership_transferring') {
      throw AppError.conflict(
        'Ownership transfer requires persisted destination-acceptance evidence',
        'PATHWAY_OWNERSHIP_TRANSFER_EVIDENCE_UNAVAILABLE',
      );
    }
    const handler = ctx.registry.resolveChildFanout(rule.fanout_handler);
    const resolved = await handler.resolve(Object.freeze({
      tenantId: ctx.tenantId,
      instance: freezeHandlerValue(ctx.runtime.instance),
      run: freezeHandlerValue(ctx.runtime.run),
      step: freezeHandlerValue(step),
      signal: ctx.signal,
      actor: ctx.actor,
      rule: freezeHandlerValue(rule),
    }));
    if (!Array.isArray(resolved)) {
      throw AppError.conflict(
        'Registered child fan-out handler must return an array',
        'PATHWAY_HANDLER_CONTRACT_INVALID',
      );
    }
    if (resolved.length > MAX_CHILDREN_PER_RULE) {
      throw AppError.conflict(
        'Registered child fan-out exceeded the per-rule limit',
        'PATHWAY_CHILD_FANOUT_LIMIT_EXCEEDED',
      );
    }
    resolvedChildCount += resolved.length;
    if (resolvedChildCount > MAX_CHILDREN_PER_STAGE) {
      throw AppError.conflict(
        'Registered child fan-out exceeded the per-stage limit',
        'PATHWAY_CHILD_FANOUT_LIMIT_EXCEEDED',
      );
    }
    if (
      rule.relationship === 'blocking'
      && resolved.length === 0
    ) {
      throw AppError.conflict(
        'Blocking child fan-out must resolve at least one child',
        'PATHWAY_BLOCKING_CHILD_REQUIRED',
      );
    }
    const normalizedChildren = resolved.map((childInput) => {
      assertPlainDataObject(childInput, 'child fan-out input');
      if (childInput.pathwayKey !== rule.child_pathway_key) {
        throw AppError.conflict(
          'Registered child fan-out returned the wrong pathway key',
          'PATHWAY_HANDLER_CONTRACT_INVALID',
        );
      }
      if (
        rule.relationship === 'nonblocking_with_named_owner'
        && !childInput.owningClinicianUid
        && !childInput.owningTeamId
      ) {
        throw AppError.conflict(
          'Non-blocking child pathway requires a concrete owner',
          'PATHWAY_CHILD_OWNER_REQUIRED',
        );
      }
      return freezeHandlerValue(childInput);
    });
    resolvedChildRules.push(Object.freeze({
      rule,
      children: Object.freeze(normalizedChildren),
    }));
  }

  if (ctx.startedChildCount + resolvedChildCount > MAX_CHILDREN_PER_COMMAND) {
    throw AppError.conflict(
      'Pathway command exceeded its child-start limit',
      'PATHWAY_CHILD_COMMAND_LIMIT_EXCEEDED',
    );
  }
  ctx.startedChildCount += resolvedChildCount;

  for (const { rule, children } of resolvedChildRules) {
    for (const [childIndex, childInput] of children.entries()) {
      const childKey = `c:${fingerprint({
        parent: ctx.runtime.instance.id,
        workflowRunId: ctx.runtime.run.id,
        workflowStepId: step.id,
        stage: step.step_key,
        rule: rule.rule_key,
        index: childIndex,
        pathwayKey: rule.child_pathway_key,
        workflowDefinitionId: childInput.workflowDefinitionId,
        sourceEpisodeType: childInput.sourceEpisodeType,
        sourceEpisodeId: childInput.sourceEpisodeId,
      })}`;
      const child = await startCarePathwayInstance({
        ...childInput,
        tenantId: ctx.tenantId,
        patientUid: ctx.runtime.instance.patient_uid,
        encounterId: ctx.runtime.instance.encounter_id,
        pathwayKey: rule.child_pathway_key,
        parentInstanceId: ctx.runtime.instance.id,
        triggerKind: 'subgraph',
        triggerPayload: {
          parent_pathway_instance_id: ctx.runtime.instance.id,
          parent_workflow_run_id: ctx.runtime.run.id,
          parent_step_key: step.step_key,
          child_rule_key: rule.rule_key,
        },
        metadata: {
          ...(childInput.metadata || {}),
          parent_stage_key: step.step_key,
          child_rule_key: rule.rule_key,
          child_relationship: rule.relationship,
        },
        idempotencyKey: childKey,
        actor: ctx.actor,
        tx: ctx.tx,
        registry: ctx.registry,
        childStartCapability: createChildStartCapability(ctx.childWorkflowStepBudget, childKey),
        activationEvidenceCapability: ctx.activationEvidenceCapability,
      });
      ctx.runtime.children.push(child);
      await ctx.recorder.append({
        transitionScope: 'handoff',
        transitionKey: 'child_pathway_materialized',
        stageKey: step.step_key,
        workflowStepId: step.id,
        previousState: {},
        newState: {
          child_pathway_instance_id: child.id,
          relationship: rule.relationship,
        },
        sourceResourceType: 'care_pathway_instances',
        sourceResourceId: child.id,
        eventPayload: { rule_key: rule.rule_key, child_index: childIndex },
      });
    }
  }
  const autoComplete = (
    ['automation', 'ai_call'].includes(compiledStep.step_kind) && actionExecuted && !hasBlockingChild
  ) || (compiledStep.step_kind === 'subworkflow' && !hasBlockingChild);
  return Object.freeze({ autoComplete });
}

async function recordRunTransition(ctx, previous, next, transitionKey) {
  await ctx.recorder.append({
    transitionScope: 'run',
    transitionKey,
    stageKey: next.current_step_key || previous.current_step_key,
    previousState: { status: previous.status, current_step_key: previous.current_step_key },
    newState: { status: next.status, current_step_key: next.current_step_key },
  });
}

async function recordStepTransition(ctx, previous, next, transitionKey, eventPayload = {}) {
  await ctx.recorder.append({
    transitionScope: 'step',
    transitionKey,
    stageKey: next.step_key,
    workflowStepId: next.id,
    previousState: { status: previous.status },
    newState: { status: next.status, outcome: next.outcome },
    eventPayload,
  });
}

async function activateInitialStage(ctx) {
  const step = ctx.runtime.steps[0];
  const previousRun = ctx.runtime.run;
  ctx.runtime.run = await transitionPathwayRunCasTx({
    tx: ctx.tx,
    tenantId: ctx.tenantId,
    runId: previousRun.id,
    expectedStatus: 'started',
    expectedCurrentStepKey: null,
    nextStatus: 'running',
    nextCurrentStepKey: step.step_key,
  });
  await recordRunTransition(ctx, previousRun, ctx.runtime.run, 'run_started');

  const previousInstance = ctx.runtime.instance;
  ctx.runtime.instance = await activatePathwayInstanceCasTx({
    tx: ctx.tx,
    tenantId: ctx.tenantId,
    instanceId: previousInstance.id,
    actorUid: actorUid(ctx.actor),
  });
  await ctx.recorder.append({
    transitionScope: 'pathway',
    transitionKey: 'pathway_activated',
    previousState: { clinical_status: previousInstance.clinical_status },
    newState: { clinical_status: ctx.runtime.instance.clinical_status },
  });

  const previousStep = step;
  ctx.runtime.steps[0] = await transitionPathwayStepCasTx({
    tx: ctx.tx,
    tenantId: ctx.tenantId,
    workflowRunId: ctx.runtime.run.id,
    stepId: step.id,
    expectedStatus: 'pending',
    nextStatus: 'in_progress',
  });
  await recordStepTransition(ctx, previousStep, ctx.runtime.steps[0], 'step_activated');
}

async function blockCurrentStage(ctx, stepIndex, reason, evidence = {}) {
  let step = ctx.runtime.steps[stepIndex];
  if (step.status === 'in_progress') {
    const previousStep = step;
    step = await transitionPathwayStepCasTx({
      tx: ctx.tx,
      tenantId: ctx.tenantId,
      workflowRunId: ctx.runtime.run.id,
      stepId: step.id,
      expectedStatus: 'in_progress',
      nextStatus: 'blocked',
      outcome: reason,
      outcomePayload: evidence,
    });
    ctx.runtime.steps[stepIndex] = step;
    await recordStepTransition(ctx, previousStep, step, 'step_blocked', { reason, evidence });
  }
  if (ctx.runtime.run.status === 'running') {
    const previousRun = ctx.runtime.run;
    ctx.runtime.run = await transitionPathwayRunCasTx({
      tx: ctx.tx,
      tenantId: ctx.tenantId,
      runId: previousRun.id,
      expectedStatus: 'running',
      expectedCurrentStepKey: step.step_key,
      nextStatus: 'blocked',
      nextCurrentStepKey: step.step_key,
    });
    await recordRunTransition(ctx, previousRun, ctx.runtime.run, 'run_blocked');
  }
  if (ctx.runtime.run.status === 'blocked' && ctx.runtime.steps[stepIndex].status === 'blocked') {
    if (ctx.recorder.effectCount === 0) {
      await ctx.recorder.append({
        transitionScope: 'step',
        transitionKey: 'step_still_blocked',
        stageKey: step.step_key,
        workflowStepId: step.id,
        previousState: { status: 'blocked' },
        newState: { status: 'blocked' },
        eventPayload: { reason, evidence },
      });
    }
  }
}

async function advanceCurrentStage(ctx, stepIndex, { targetIndex = stepIndex + 1, decision = 'satisfied', evidence = {} } = {}) {
  let step = ctx.runtime.steps[stepIndex];
  if (step.status === 'blocked') {
    const previousStep = step;
    step = await transitionPathwayStepCasTx({
      tx: ctx.tx,
      tenantId: ctx.tenantId,
      workflowRunId: ctx.runtime.run.id,
      stepId: step.id,
      expectedStatus: 'blocked',
      nextStatus: 'in_progress',
    });
    ctx.runtime.steps[stepIndex] = step;
    await recordStepTransition(ctx, previousStep, step, 'step_unblocked');
    const previousRun = ctx.runtime.run;
    ctx.runtime.run = await transitionPathwayRunCasTx({
      tx: ctx.tx,
      tenantId: ctx.tenantId,
      runId: previousRun.id,
      expectedStatus: 'blocked',
      expectedCurrentStepKey: step.step_key,
      nextStatus: 'running',
      nextCurrentStepKey: step.step_key,
    });
    await recordRunTransition(ctx, previousRun, ctx.runtime.run, 'run_resumed');
  }

  const previousStep = step;
  step = await transitionPathwayStepCasTx({
    tx: ctx.tx,
    tenantId: ctx.tenantId,
    workflowRunId: ctx.runtime.run.id,
    stepId: step.id,
    expectedStatus: 'in_progress',
    nextStatus: 'completed',
    outcome: decision,
    outcomePayload: evidence,
  });
  ctx.runtime.steps[stepIndex] = step;
  await recordStepTransition(ctx, previousStep, step, 'step_completed', { decision, evidence });

  if (targetIndex >= ctx.runtime.steps.length) {
    const previousRun = ctx.runtime.run;
    ctx.runtime.run = await transitionPathwayRunCasTx({
      tx: ctx.tx,
      tenantId: ctx.tenantId,
      runId: previousRun.id,
      expectedStatus: 'running',
      expectedCurrentStepKey: step.step_key,
      nextStatus: 'completed',
      nextCurrentStepKey: null,
    });
    await recordRunTransition(ctx, previousRun, ctx.runtime.run, 'run_completed');
    const previousInstance = ctx.runtime.instance;
    ctx.runtime.instance = await closePathwayInstanceCasTx({
      tx: ctx.tx,
      tenantId: ctx.tenantId,
      instanceId: previousInstance.id,
      expectedClinicalStatus: previousInstance.clinical_status,
      nextClinicalStatus: 'completed',
      completionOutcome: 'workflow_completed',
      actorUid: actorUid(ctx.actor),
    });
    await ctx.recorder.append({
      transitionScope: 'pathway',
      transitionKey: 'pathway_completed',
      previousState: { clinical_status: previousInstance.clinical_status },
      newState: {
        clinical_status: ctx.runtime.instance.clinical_status,
        completion_outcome: ctx.runtime.instance.completion_outcome,
      },
    });
    return;
  }

  const nextStep = ctx.runtime.steps[targetIndex];
  if (nextStep.status !== 'pending' || targetIndex <= stepIndex) {
    throw AppError.conflict('Pathway next step is invalid', 'PATHWAY_GRAPH_INVALID');
  }
  for (let bypassedIndex = stepIndex + 1; bypassedIndex < targetIndex; bypassedIndex += 1) {
    const bypassedStep = ctx.runtime.steps[bypassedIndex];
    if (bypassedStep.status !== 'pending') {
      throw AppError.conflict('Pathway bypassed step is invalid', 'PATHWAY_GRAPH_INVALID');
    }
    ctx.runtime.steps[bypassedIndex] = await transitionPathwayStepCasTx({
      tx: ctx.tx,
      tenantId: ctx.tenantId,
      workflowRunId: ctx.runtime.run.id,
      stepId: bypassedStep.id,
      expectedStatus: 'pending',
      nextStatus: 'skipped',
      outcome: 'forward_exception_bypassed',
      outcomePayload: {
        source_step_key: step.step_key,
        target_step_key: nextStep.step_key,
        decision,
      },
    });
    await recordStepTransition(
      ctx,
      bypassedStep,
      ctx.runtime.steps[bypassedIndex],
      'step_skipped',
      {
        source_step_key: step.step_key,
        target_step_key: nextStep.step_key,
        decision,
      },
    );
  }
  const previousRun = ctx.runtime.run;
  ctx.runtime.run = await transitionPathwayRunCasTx({
    tx: ctx.tx,
    tenantId: ctx.tenantId,
    runId: previousRun.id,
    expectedStatus: 'running',
    expectedCurrentStepKey: step.step_key,
    nextStatus: 'running',
    nextCurrentStepKey: nextStep.step_key,
  });
  await recordRunTransition(ctx, previousRun, ctx.runtime.run, 'run_advanced');
  const previousNextStep = nextStep;
  ctx.runtime.steps[targetIndex] = await transitionPathwayStepCasTx({
    tx: ctx.tx,
    tenantId: ctx.tenantId,
    workflowRunId: ctx.runtime.run.id,
    stepId: nextStep.id,
    expectedStatus: 'pending',
    nextStatus: 'in_progress',
  });
  await recordStepTransition(ctx, previousNextStep, ctx.runtime.steps[targetIndex], 'step_activated');
}

function normalizeConditionResult(result, handler) {
  assertPlainDataObject(result, 'condition result');
  for (const key of Object.keys(result)) {
    if (!['decision', 'evidence'].includes(key)) badRequest(`condition result.${key} is not supported`);
  }
  const decision = requireText(result.decision, 'condition result.decision', 80, CANONICAL_KEY_RE);
  if (!handler.decisionCodes.includes(decision)) {
    throw AppError.conflict(
      'Registered condition returned an undeclared decision',
      'PATHWAY_HANDLER_CONTRACT_INVALID',
    );
  }
  const evidence = result.evidence === undefined
    ? Object.freeze({})
    : Array.isArray(result.evidence)
      ? Object.freeze({ items: cloneJson(result.evidence, 'condition result.evidence') })
      : normalizeJsonObject(result.evidence, 'condition result.evidence');
  return Object.freeze({ decision, evidence });
}

async function evaluateCondition(ctx, stepIndex) {
  const compiledStep = ctx.compiled.steps[stepIndex];
  if (!compiledStep.condition_handler) return null;
  const handler = ctx.registry.resolveCondition(compiledStep.condition_handler);
  if (!handler) {
    throw AppError.conflict('Pathway condition handler is missing', 'PATHWAY_HANDLER_NOT_REGISTERED');
  }
  const step = ctx.runtime.steps[stepIndex];
  const readContext = Object.freeze({
    tenantId: ctx.tenantId,
    instance: freezeHandlerValue(ctx.runtime.instance),
    run: freezeHandlerValue(ctx.runtime.run),
    step: freezeHandlerValue(step),
    tasks: freezeHandlerValue(linkedForStep(ctx.runtime.tasks, step)),
    approvals: freezeHandlerValue(linkedForStep(ctx.runtime.approvals, step)),
    handoffs: freezeHandlerValue(ctx.runtime.handoffs),
    slas: freezeHandlerValue(ctx.runtime.slas),
    signal: ctx.signal,
    actor: ctx.actor,
  });
  let loadedEvidence = Object.freeze({});
  if (handler.loadEvidence) {
    if (typeof ctx.tx.$executeRawUnsafe !== 'function') {
      throw AppError.internal(
        'Pathway condition evidence isolation is unavailable',
        'PATHWAY_CONDITION_EVIDENCE_ISOLATION_FAILED',
      );
    }
    await ctx.tx.$executeRawUnsafe(`SAVEPOINT ${CONDITION_EVIDENCE_SAVEPOINT}`);
    let loaderResult;
    let loaderError = null;
    try {
      loaderResult = await handler.loadEvidence(Object.freeze({ tx: ctx.tx, ...readContext }));
    } catch (error) {
      loaderError = error;
    }
    try {
      await ctx.tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${CONDITION_EVIDENCE_SAVEPOINT}`);
      await ctx.tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${CONDITION_EVIDENCE_SAVEPOINT}`);
    } catch {
      throw AppError.internal(
        'Pathway condition evidence isolation cleanup failed',
        'PATHWAY_CONDITION_EVIDENCE_ISOLATION_FAILED',
      );
    }
    if (loaderError) throw loaderError;
    loadedEvidence = normalizeJsonObject(loaderResult, 'condition loaded evidence');
  }
  const result = await handler.evaluate(Object.freeze({ ...readContext, loadedEvidence }));
  return normalizeConditionResult(result, handler);
}

async function recordWaiting(ctx, step, transitionKey, state, eventPayload = {}) {
  await ctx.recorder.append({
    transitionScope: 'step',
    transitionKey,
    stageKey: step.step_key,
    workflowStepId: step.id,
    previousState: state,
    newState: state,
    eventPayload,
  });
}

function effectPlan(kind, fields = {}) {
  return Object.freeze({ kind, ...fields });
}

function buildMaterializationPlan(ctx, stepIndex) {
  const compiledStep = ctx.compiled.steps[stepIndex];
  if (
    !ctx.runtimeMode.suppressEffects
    && compiledStep.child_rules.some((rule) => rule.relationship === 'ownership_transferring')
  ) {
    throw AppError.conflict(
      'Ownership transfer requires persisted destination-acceptance evidence',
      'PATHWAY_OWNERSHIP_TRANSFER_EVIDENCE_UNAVAILABLE',
    );
  }
  const effects = [];
  if (compiledStep.step_kind === 'task') effects.push('task');
  if (compiledStep.step_kind === 'approval') effects.push('task', 'approval');
  if (compiledStep.action_handler) effects.push('action');
  for (const rule of compiledStep.child_rules) effects.push(`child:${rule.rule_key}`);
  return Object.freeze({ stepIndex, effects: Object.freeze(effects) });
}

function buildAdvancePlan(ctx, stepIndex, {
  targetIndex = stepIndex + 1,
  decision = 'satisfied',
  evidence = Object.freeze({}),
  activateFirst = false,
} = {}) {
  return effectPlan('advance', {
    stepIndex,
    targetIndex,
    decision,
    evidence,
    activateFirst,
  });
}

function assertExceptionWorkTerminal(ctx, step, compiledStep) {
  if (!['task', 'approval'].includes(compiledStep.step_kind)) return;
  const tasks = linkedForStep(ctx.runtime.tasks, step);
  const approvals = linkedForStep(ctx.runtime.approvals, step);
  if (tasks.length > 1 || approvals.length > 1) {
    throw AppError.conflict('Pathway human-work graph is ambiguous', 'PATHWAY_GRAPH_INVALID');
  }
  if (compiledStep.step_kind === 'approval') {
    if (tasks.length !== approvals.length) {
      throw AppError.conflict('Pathway approval work graph is incomplete', 'PATHWAY_GRAPH_INVALID');
    }
    if (
      tasks.length === 1
      && Number(approvals[0].task_id) !== Number(tasks[0].id)
    ) {
      throw AppError.conflict('Pathway approval task link is invalid', 'PATHWAY_GRAPH_INVALID');
    }
  }
  if (
    tasks.some((task) => !TERMINAL_TASK_STATUSES.has(task.status))
    || approvals.some((approval) => !TERMINAL_APPROVAL_STATUSES.has(approval.status))
  ) {
    throw AppError.conflict(
      'Pathway exception cannot abandon active human work',
      'PATHWAY_HUMAN_WORK_STILL_ACTIVE',
    );
  }
}

async function buildCurrentStagePlan(ctx) {
  const activateFirst = ctx.runtime.run.status === 'started';
  if (!activateFirst && TERMINAL_RUN_STATUSES.has(ctx.runtime.run.status)) {
    throw AppError.conflict(
      'Care pathway workflow run is already terminal',
      'PATHWAY_RUN_TERMINAL',
    );
  }
  const stepIndex = activateFirst
    ? 0
    : ctx.runtime.steps.findIndex(
      (step) => step.step_key === ctx.runtime.run.current_step_key,
    );
  if (stepIndex < 0) {
    throw AppError.conflict('Care pathway current step is missing', 'PATHWAY_GRAPH_INVALID');
  }
  const plan = (kind, fields = {}) => effectPlan(kind, { activateFirst, ...fields });
  const step = ctx.runtime.steps[stepIndex];
  const compiledStep = ctx.compiled.steps[stepIndex];
  const domainEvidenceWork = (
    ['task', 'approval'].includes(compiledStep.step_kind)
    && compiledStep.work_semantics?.sla_completion_semantics === 'domain_evidence'
  );
  const condition = await evaluateCondition(ctx, stepIndex);
  if (condition?.decision === 'blocked' && !domainEvidenceWork) {
    return plan('block', {
      stepIndex,
      reason: 'condition_blocked',
      evidence: condition.evidence,
    });
  }
  if (condition && !['blocked', 'satisfied'].includes(condition.decision)) {
    const exception = compiledStep.exception_transitions.find(
      (transition) => transition.decision_code === condition.decision,
    );
    if (!exception) {
      throw AppError.conflict(
        'Condition decision has no declared forward transition',
        'PATHWAY_HANDLER_CONTRACT_INVALID',
      );
    }
    const targetIndex = ctx.compiled.steps.findIndex(
      (candidate) => candidate.step_key === exception.target_step_key,
    );
    assertExceptionWorkTerminal(ctx, step, compiledStep);
    return buildAdvancePlan(ctx, stepIndex, {
      targetIndex,
      decision: condition.decision,
      evidence: condition.evidence,
      activateFirst,
    });
  }

  if (compiledStep.step_kind === 'wait') {
    return buildAdvancePlan(ctx, stepIndex, {
      decision: 'satisfied',
      evidence: condition?.evidence || Object.freeze({}),
      activateFirst,
    });
  }

  if (compiledStep.step_kind === 'task') {
    const tasks = linkedForStep(ctx.runtime.tasks, step);
    if (tasks.length > 1) {
      throw AppError.conflict('Pathway task graph is ambiguous', 'PATHWAY_GRAPH_INVALID');
    }
    if (tasks.length === 0) {
      return plan('materialize', {
        stepIndex,
        materialization: buildMaterializationPlan(ctx, stepIndex),
        waitingTransitionKey: 'task_waiting',
        waitingState: Object.freeze({ status: 'not_materialized' }),
        waitingEventPayload: Object.freeze({}),
      });
    }
    const task = tasks[0];
    if (task.status === 'completed') {
      if (domainEvidenceWork && condition?.decision !== 'satisfied') {
        return plan('wait', {
          stepIndex,
          transitionKey: 'domain_evidence_waiting',
          state: Object.freeze({ task_status: task.status, evidence_satisfied: false }),
          eventPayload: Object.freeze({ task_id: task.id }),
        });
      }
      return buildAdvancePlan(ctx, stepIndex, {
        decision: 'task_completed',
        evidence: Object.freeze({
          task_id: task.id,
          task_status: task.status,
          ...(domainEvidenceWork ? {
            domain_evidence_satisfied: true,
            condition_evidence: condition.evidence,
          } : {}),
        }),
        activateFirst,
      });
    }
    if (task.status === 'cancelled') {
      return plan('block', {
        stepIndex,
        reason: 'task_cancelled',
        evidence: Object.freeze({ task_id: task.id }),
      });
    }
    return plan('wait', {
      stepIndex,
      transitionKey: 'task_waiting',
      state: Object.freeze({ status: task.status }),
      eventPayload: Object.freeze({ task_id: task.id }),
    });
  }

  if (compiledStep.step_kind === 'approval') {
    const tasks = linkedForStep(ctx.runtime.tasks, step);
    const approvals = linkedForStep(ctx.runtime.approvals, step);
    if (tasks.length > 1 || approvals.length > 1) {
      throw AppError.conflict('Pathway approval graph is ambiguous', 'PATHWAY_GRAPH_INVALID');
    }
    if (tasks.length !== approvals.length) {
      throw AppError.conflict('Pathway approval work graph is incomplete', 'PATHWAY_GRAPH_INVALID');
    }
    if (tasks.length === 0) {
      return plan('materialize', {
        stepIndex,
        materialization: buildMaterializationPlan(ctx, stepIndex),
        waitingTransitionKey: 'approval_waiting',
        waitingState: Object.freeze({ status: 'not_materialized' }),
        waitingEventPayload: Object.freeze({}),
      });
    }
    const task = tasks[0];
    const approval = approvals[0];
    if (Number(approval.task_id) !== Number(task.id)) {
      throw AppError.conflict('Pathway approval task link is invalid', 'PATHWAY_GRAPH_INVALID');
    }
    if (
      approval.status === 'approved'
      && task.status === 'completed'
      && (!domainEvidenceWork || condition?.decision === 'satisfied')
    ) {
      return buildAdvancePlan(ctx, stepIndex, {
        decision: 'approval_completed',
        evidence: Object.freeze({
          task_id: task.id,
          approval_id: approval.id,
          ...(domainEvidenceWork ? {
            domain_evidence_satisfied: true,
            condition_evidence: condition.evidence,
          } : {}),
        }),
        activateFirst,
      });
    }
    if (['rejected', 'cancelled', 'expired'].includes(approval.status) || task.status === 'cancelled') {
      return plan('block', {
        stepIndex,
        reason: 'approval_not_granted',
        evidence: Object.freeze({
          task_id: task.id,
          task_status: task.status,
          approval_id: approval.id,
          approval_status: approval.status,
        }),
      });
    }
    return plan('wait', {
      stepIndex,
      transitionKey: 'approval_waiting',
      state: Object.freeze({
        task_status: task.status,
        approval_status: approval.status,
        ...(domainEvidenceWork ? {
          evidence_satisfied: condition?.decision === 'satisfied',
        } : {}),
      }),
      eventPayload: Object.freeze({
        task_id: task.id,
        approval_id: approval.id,
        ...(domainEvidenceWork ? {
          evidence_satisfied: condition?.decision === 'satisfied',
          condition_evidence: condition?.evidence || Object.freeze({}),
        } : {}),
      }),
    });
  }

  if (['automation', 'ai_call', 'subworkflow'].includes(compiledStep.step_kind)) {
    if (compiledStep.step_kind === 'subworkflow') {
      const materialization = buildMaterializationPlan(ctx, stepIndex);
      const children = childrenForStep(ctx.runtime, step);
      if (children.length > 0) {
        const blockingRules = new Set(compiledStep.child_rules
          .filter((rule) => rule.relationship === 'blocking')
          .map((rule) => rule.rule_key));
        const childRuleKeys = new Set(compiledStep.child_rules.map((rule) => rule.rule_key));
        const childrenByRule = children.map((child) => ({
          child,
          ruleKey: parseStoredJson(child.metadata, 'Child pathway metadata', {})?.child_rule_key,
        }));
        if (childrenByRule.some(({ ruleKey }) => !childRuleKeys.has(ruleKey))) {
          throw AppError.conflict(
            'Child pathway relationship evidence is invalid',
            'PATHWAY_GRAPH_INVALID',
          );
        }
        const blockingChildren = childrenByRule
          .filter(({ ruleKey }) => blockingRules.has(ruleKey))
          .map(({ child }) => child);
        const failedChild = blockingChildren.find((child) => (
          ['cancelled', 'entered_in_error'].includes(child.clinical_status)
        ));
        if (failedChild) {
          return plan('block', {
            stepIndex,
            reason: 'child_pathway_not_completed',
            evidence: Object.freeze({
              child_pathway_instance_id: failedChild.id,
              child_status: failedChild.clinical_status,
            }),
          });
        }
        const resolvedBlockingRules = new Set(childrenByRule
          .filter(({ ruleKey }) => blockingRules.has(ruleKey))
          .map(({ ruleKey }) => ruleKey));
        if ([...blockingRules].some((ruleKey) => !resolvedBlockingRules.has(ruleKey))) {
          throw AppError.conflict(
            'Blocking child fan-out evidence is incomplete',
            'PATHWAY_BLOCKING_CHILD_INCOMPLETE',
          );
        }
        if (
          blockingRules.size === 0
          || blockingChildren.every((child) => child.clinical_status === 'completed')
        ) {
          return buildAdvancePlan(ctx, stepIndex, {
            decision: blockingRules.size === 0
              ? 'child_pathways_dispatched'
              : 'child_pathways_completed',
            evidence: Object.freeze({
              child_pathway_instance_ids: children.map((child) => child.id),
            }),
            activateFirst,
          });
        }
        return plan('wait', {
          stepIndex,
          transitionKey: 'child_pathway_waiting',
          state: Object.freeze({
            active_child_count: blockingChildren.filter(
            (child) => !['completed', 'cancelled', 'entered_in_error'].includes(child.clinical_status),
            ).length,
          }),
          eventPayload: Object.freeze({}),
        });
      }
      return plan('materialize', {
        stepIndex,
        materialization,
        waitingTransitionKey: 'registered_effect_waiting',
        waitingState: Object.freeze({ status: step.status }),
        waitingEventPayload: Object.freeze({}),
      });
    }
    return plan('materialize', {
      stepIndex,
      materialization: buildMaterializationPlan(ctx, stepIndex),
      waitingTransitionKey: 'registered_effect_waiting',
      waitingState: Object.freeze({ status: step.status }),
      waitingEventPayload: Object.freeze({}),
    });
  }

  throw AppError.conflict('Pathway step kind is unsupported', 'PATHWAY_GRAPH_INVALID');
}

async function applyCurrentStagePlan(ctx, initialPlan) {
  let plan = initialPlan;
  for (let applied = 0; applied < MAX_APPLIED_PLANS_PER_COMMAND; applied += 1) {
    if (!plan || !Object.isFrozen(plan)) {
      throw AppError.internal('Pathway effect plan must be frozen', 'PATHWAY_EFFECT_PLAN_INVALID');
    }
    if (plan.activateFirst) {
      await activateInitialStage(ctx);
    }
    if (plan.kind === 'block') {
      await blockCurrentStage(ctx, plan.stepIndex, plan.reason, plan.evidence);
      return;
    }
    if (plan.kind === 'advance') {
      await advanceCurrentStage(ctx, plan.stepIndex, {
        targetIndex: plan.targetIndex,
        decision: plan.decision,
        evidence: plan.evidence,
      });
      if (TERMINAL_RUN_STATUSES.has(ctx.runtime.run.status)) return;
      plan = await buildCurrentStagePlan(ctx);
      continue;
    }
    if (plan.kind === 'wait') {
      await recordWaiting(
        ctx,
        ctx.runtime.steps[plan.stepIndex],
        plan.transitionKey,
        plan.state,
        plan.eventPayload,
      );
      return;
    }
    if (plan.kind === 'materialize') {
      const priorEventCount = ctx.recorder.effectCount;
      const materialized = await materializeStageEffects(ctx, plan.stepIndex);
      if (materialized.autoComplete) {
        await advanceCurrentStage(ctx, plan.stepIndex, {
          decision: 'registered_effect_completed',
        });
        if (TERMINAL_RUN_STATUSES.has(ctx.runtime.run.status)) return;
        plan = await buildCurrentStagePlan(ctx);
        continue;
      }
      if (ctx.recorder.effectCount === priorEventCount) {
        await recordWaiting(
          ctx,
          ctx.runtime.steps[plan.stepIndex],
          plan.waitingTransitionKey,
          plan.waitingState,
          plan.waitingEventPayload,
        );
      }
      return;
    }
    throw AppError.internal('Pathway effect plan kind is invalid', 'PATHWAY_EFFECT_PLAN_INVALID');
  }
  throw AppError.conflict(
    'Pathway command exceeded its applied-plan limit',
    'PATHWAY_PLAN_LIMIT_EXCEEDED',
  );
}

export async function startCarePathwayInstance(input = {}) {
  const registry = normalizeRegistry(input.registry ?? workflowRuntimeRegistry);
  const normalized = normalizeStartInput(input, registry);
  const commandFingerprint = fingerprint({
    operation: 'start_care_pathway_instance',
    registryVersion: registry.version,
    tenantId: normalized.tenantId,
    workflowDefinitionId: normalized.workflowDefinitionId,
    patientUid: normalized.patientUid,
    encounterId: normalized.encounterId,
    pathwayKey: normalized.pathwayKey,
    sourceEpisodeType: normalized.sourceEpisodeType,
    sourceEpisodeId: normalized.sourceEpisodeId,
    parentInstanceId: normalized.parentInstanceId,
    owningClinicianUid: normalized.owningClinicianUid,
    owningTeamId: normalized.owningTeamId,
    accountableRole: normalized.accountableRole,
    triggerKind: normalized.triggerKind,
    triggerPayload: normalized.triggerPayload,
    context: normalized.context,
    metadata: normalized.metadata,
    actor: actorFingerprintIdentity(normalized.actor),
  });

  return inTenantTx(normalized.tenantId, input.tx ?? null, async (tx) => {
    await acquirePathwayStartLocksTx({
      tx,
      ...normalized,
      waitForLocks: input.tx === null || input.tx === undefined,
    });
    const existing = await findPathwayInstanceByIdempotencyTx({
      tx,
      tenantId: normalized.tenantId,
      idempotencyKey: normalized.idempotencyKey,
    });
    if (existing) {
      const replay = await findPathwayTransitionReplayTx({
        tx,
        tenantId: normalized.tenantId,
        pathwayInstanceId: existing.id,
        idempotencyKey: normalized.idempotencyKey,
        commandFingerprint,
        lockInstance: true,
      });
      if (!replay.replayed) {
        throw AppError.conflict(
          'Pathway start exists without committed transition evidence',
          'PATHWAY_START_EVIDENCE_MISSING',
        );
      }
      await assertCurrentInstanceOwnerTx(
        tx,
        normalized.tenantId,
        existing,
        normalized.actor,
      );
      await assertPathwayReplayDefinitionPinTx({
        tx,
        tenantId: normalized.tenantId,
        pathwayInstanceId: existing.id,
        events: replay.events,
      });
      const prior = replayResult(replay.events);
      return {
        ...prior.resultSnapshot,
        events: replay.events,
        event: replay.events[0],
        replayed: true,
        mode: prior.mode,
      };
    }

    const runtimeMode = assertModeAvailable(
      await resolvePathwayModeTx({
        tx,
        tenantId: normalized.tenantId,
        pathwayKey: normalized.pathwayKey,
      }),
      normalized.activationEvidenceCapability,
    );
    await assertPathwayPatientContextTx({
      tx,
      tenantId: normalized.tenantId,
      patientUid: normalized.patientUid,
      encounterId: normalized.encounterId,
      owningClinicianUid: normalized.owningClinicianUid,
    });
    const activeEpisode = await findActivePathwayEpisodeTx({ tx, ...normalized });
    if (activeEpisode) {
      throw AppError.conflict(
        'An active care pathway already exists for this episode',
        'PATHWAY_EPISODE_ALREADY_ACTIVE',
      );
    }
    const definition = await loadGovernedPathwayDefinitionTx({
      tx,
      tenantId: normalized.tenantId,
      workflowDefinitionId: normalized.workflowDefinitionId,
    });
    const compiled = compilePinnedDefinition(definition, registry);
    if (compiled.workflow_key !== normalized.pathwayKey) {
      throw AppError.conflict(
        'Pathway key does not match the governed workflow definition',
        'PATHWAY_DEFINITION_KEY_MISMATCH',
      );
    }
    await preflightPathwaySlaRulesTx({
      tx,
      tenantId: normalized.tenantId,
      compiledDefinition: compiled,
    });
    debitChildWorkflowStepBudget(normalized.childWorkflowStepBudget, compiled.steps.length);
    const created = await insertPathwayRuntimeTx({
      tx,
      tenantId: normalized.tenantId,
      definition,
      compiledDefinition: compiled,
      patientUid: normalized.patientUid,
      encounterId: normalized.encounterId,
      sourceEpisodeType: normalized.sourceEpisodeType,
      sourceEpisodeId: normalized.sourceEpisodeId,
      parentInstanceId: normalized.parentInstanceId,
      owningClinicianUid: normalized.owningClinicianUid,
      owningTeamId: normalized.owningTeamId,
      accountableRole: normalized.accountableRole,
      triggerKind: normalized.triggerKind,
      triggerPayload: normalized.triggerPayload,
      context: normalized.context,
      metadata: normalized.metadata,
      idempotencyKey: normalized.idempotencyKey,
      actorUid: actorUid(normalized.actor),
    });
    const resultSnapshot = freezeHandlerValue({
      ...created.instance,
      run: created.run,
      steps: created.steps,
      tasks: [],
      approvals: [],
      handoffs: [],
    });
    const appended = await appendPathwayTransitionEventTx({
      tx,
      tenantId: normalized.tenantId,
      pathwayInstanceId: created.instance.id,
      workflowRunId: created.run.id,
      idempotencyKey: normalized.idempotencyKey,
      commandFingerprint,
      effectOrdinal: 0,
      transitionScope: 'pathway',
      transitionKey: 'pathway_instance_created',
      previousState: {},
      newState: {
        clinical_status: created.instance.clinical_status,
        run_status: created.run.status,
      },
      sourceResourceType: normalized.actor.kind === 'system'
        ? normalized.actor.signalContext.sourceResourceType
        : normalized.sourceEpisodeType,
      sourceResourceId: normalized.actor.kind === 'system'
        ? normalized.actor.signalContext.sourceResourceId
        : normalized.sourceEpisodeId,
      occurredAt: normalized.actor.kind === 'system'
        ? normalized.actor.signalContext.occurredAt
        : null,
      actor: normalized.actor,
      registry,
      eventPayload: {
        mode: runtimeMode.mode,
        workflow_definition_id: definition.id,
        governance_id: definition.governance_id,
        definition_checksum: compiled.checksum,
      },
      metadata: {
        pathway_runtime: {
          mode: runtimeMode.mode,
          registry_version: registry.version,
          definition_checksum: compiled.checksum,
          result_snapshot: resultSnapshot,
        },
      },
    });
    return {
      ...resultSnapshot,
      event: appended.event,
      events: [appended.event],
      replayed: false,
      mode: runtimeMode.mode,
    };
  });
}

function pathwayCommandFingerprint(normalized, registry, commandOperation = null) {
  return fingerprint({
    operation: 'execute_pathway_command',
    registryVersion: registry.version,
    tenantId: normalized.tenantId,
    pathwayInstanceId: normalized.pathwayInstanceId,
    signal: normalized.signal,
    actor: actorFingerprintIdentity(normalized.actor),
    ...(commandOperation ? { commandOperation } : {}),
  });
}

function canonicalDomainEvidenceReference(evidence) {
  assertPlainDataObject(evidence, 'registered domain evidence');
  return freezeHandlerValue({
    kind: evidence.kind ?? null,
    handler_id: evidence.handler_id ?? null,
    decision: evidence.decision ?? null,
    resource_type: evidence.resource_type ?? null,
    resource_id: evidence.resource_id ?? null,
    provenance: evidence.provenance ?? null,
    evidence_fingerprint: fingerprint(evidence),
  });
}

async function executePathwayCommandInternal(
  input = {},
  commandOperation = null,
  domainEvidenceCompletion = null,
  normalizedCommand = null,
) {
  const registry = normalizeRegistry(input.registry ?? workflowRuntimeRegistry);
  const normalized = normalizedCommand ?? normalizeCommandInput(input, registry);
  const commandFingerprint = pathwayCommandFingerprint(normalized, registry, commandOperation);
  return inTenantTx(normalized.tenantId, normalized.tx, async (tx) => {
    const replay = await findPathwayTransitionReplayTx({
      tx,
      tenantId: normalized.tenantId,
      pathwayInstanceId: normalized.pathwayInstanceId,
      idempotencyKey: normalized.idempotencyKey,
      commandFingerprint,
      lockInstance: true,
    });
    if (replay.replayed) {
      await assertCurrentInstanceOwnerTx(
        tx,
        normalized.tenantId,
        replay.pathwayInstance,
        normalized.actor,
      );
      await assertPathwayReplayDefinitionPinTx({
        tx,
        tenantId: normalized.tenantId,
        pathwayInstanceId: normalized.pathwayInstanceId,
        events: replay.events,
      });
      const prior = replayResult(replay.events);
      return {
        instance: prior.resultSnapshot,
        events: replay.events,
        replayed: true,
        mode: prior.mode,
      };
    }
    const runtimeMode = assertModeAvailable(
      await resolvePathwayModeTx({
        tx,
        tenantId: normalized.tenantId,
        pathwayKey: replay.pathwayInstance.pathway_key,
      }),
      normalized.activationEvidenceCapability,
    );
    const runtime = await lockPathwayRuntimeTx({
      tx,
      tenantId: normalized.tenantId,
      pathwayInstanceId: normalized.pathwayInstanceId,
    });
    if (!['approved', 'retired'].includes(runtime.definition.governance_status)) {
      throw AppError.conflict(
        'Pathway definition governance is no longer valid',
        'PATHWAY_DEFINITION_NOT_APPROVED',
      );
    }
    const compiled = compilePinnedDefinition(runtime.definition, registry);
    assertRuntimeGraph(runtime, compiled);
    await assertCommandOwnership(tx, normalized.tenantId, runtime, compiled, normalized.actor);
    const recorder = createRecorder({
      tx,
      tenantId: normalized.tenantId,
      instance: runtime.instance,
      run: runtime.run,
      idempotencyKey: normalized.idempotencyKey,
      commandFingerprint,
      signal: normalized.signal,
      actor: normalized.actor,
      registry,
      runtimeMode,
      definitionChecksum: compiled.checksum,
      commandOperation: commandOperation ? Object.freeze({
        kind: commandOperation.kind,
        task_id: commandOperation.task_id,
        workflow_run_id: commandOperation.workflow_run_id,
        workflow_step_id: commandOperation.workflow_step_id,
        condition_handler: commandOperation.condition_handler,
        evidence_fingerprint: commandOperation.evidence_fingerprint,
      }) : null,
    });
    const ctx = {
      tx,
      tenantId: normalized.tenantId,
      runtime,
      compiled,
      signal: normalized.signal,
      actor: normalized.actor,
      registry,
      runtimeMode,
      recorder,
      activationEvidenceCapability: normalized.activationEvidenceCapability,
      executorCapability: mintPathwayExecutorCapability(),
      startedChildCount: 0,
      childWorkflowStepBudget: createChildWorkflowStepBudget(),
    };
    if (domainEvidenceCompletion) {
      const evidenceStep = runtime.steps.find(
        (step) => Number(step.id) === commandOperation.workflow_step_id,
      );
      if (
        !evidenceStep
        || Number(domainEvidenceCompletion.task?.id) !== commandOperation.task_id
        || String(domainEvidenceCompletion.sla?.id || '') === ''
      ) {
        throw AppError.conflict(
          'Registered domain evidence completion does not match its pathway command',
          'PATHWAY_DOMAIN_EVIDENCE_POSTCONDITION_FAILED',
        );
      }
      await recorder.append({
        transitionScope: 'task',
        transitionKey: 'domain_evidence_task_completed',
        stageKey: evidenceStep.step_key,
        workflowStepId: evidenceStep.id,
        previousState: {
          task_status: domainEvidenceCompletion.previousTaskStatus,
          sla_status: domainEvidenceCompletion.previousSlaStatus,
        },
        newState: {
          task_status: domainEvidenceCompletion.task.status,
          sla_status: domainEvidenceCompletion.sla.status,
        },
        sourceResourceType: 'tasks',
        sourceResourceId: String(domainEvidenceCompletion.task.id),
        workflowSlaInstanceId: domainEvidenceCompletion.sla.id,
        eventPayload: {
          task_id: domainEvidenceCompletion.task.id,
          workflow_sla_instance_id: domainEvidenceCompletion.sla.id,
          mutated: domainEvidenceCompletion.mutated === true,
          evidence: canonicalDomainEvidenceReference(domainEvidenceCompletion.evidence),
        },
      });
    }
    const plan = await buildCurrentStagePlan(ctx);
    await applyCurrentStagePlan(ctx, plan);
    assertRuntimeGraph(ctx.runtime, compiled);
    if (recorder.effectCount === 0) {
      throw AppError.internal(
        'Accepted pathway command produced no transition evidence',
        'PATHWAY_COMMAND_EVIDENCE_MISSING',
      );
    }
    const bundle = freezeHandlerValue(await getCarePathwayInstanceTx({
      tx,
      tenantId: normalized.tenantId,
      id: normalized.pathwayInstanceId,
    }));
    await recorder.flush(bundle);
    return { instance: bundle, events: recorder.events, replayed: false, mode: runtimeMode.mode };
  });
}

export async function executePathwayCommand(input = {}) {
  return executePathwayCommandInternal(input, null);
}

function normalizeDomainEvidenceCommandOperation(input) {
  const evidence = normalizeJsonObject(input.evidence, 'evidence');
  return Object.freeze({
    kind: 'complete_registered_domain_evidence',
    task_id: requirePositiveInteger(input.taskId, 'task_id'),
    workflow_run_id: requirePositiveInteger(input.workflowRunId, 'workflow_run_id'),
    workflow_step_id: requirePositiveInteger(input.workflowStepId, 'workflow_step_id'),
    condition_handler: requireText(
      input.conditionHandler,
      'condition_handler',
      120,
      HANDLER_ID_RE,
    ),
    evidence_fingerprint: fingerprint(evidence),
    evidence,
  });
}

function assertDomainEvidenceExecutionPostcondition(execution, commandOperation) {
  const step = execution.instance?.steps?.find(
    (candidate) => Number(candidate.id) === commandOperation.workflow_step_id,
  );
  if (!step || !['task', 'approval'].includes(step.step_kind)) {
    throw AppError.conflict(
      'Registered domain evidence did not target a human-work pathway step',
      'PATHWAY_DOMAIN_EVIDENCE_POSTCONDITION_FAILED',
    );
  }
  const events = Array.isArray(execution.events) ? execution.events : [];
  const taskCompletionEvent = events.find((event) => {
    if (
      event.transition_scope !== 'task'
      || event.transition_key !== 'domain_evidence_task_completed'
      || Number(event.workflow_step_id) !== commandOperation.workflow_step_id
    ) return false;
    const payload = parseStoredJson(event.event_payload, 'Pathway transition payload', {});
    return (
      Number(payload.task_id) === commandOperation.task_id
      && String(payload.workflow_sla_instance_id || '') !== ''
      && payload.evidence?.kind === 'pathway_registered_condition'
      && payload.evidence?.handler_id === commandOperation.condition_handler
      && payload.evidence?.decision === 'satisfied'
      && payload.evidence?.provenance
      && typeof payload.evidence.provenance === 'object'
    );
  });
  if (!taskCompletionEvent) {
    throw AppError.conflict(
      'Registered domain evidence task and SLA completion evidence is missing',
      'PATHWAY_DOMAIN_EVIDENCE_POSTCONDITION_FAILED',
    );
  }
  const completedEvent = events.find((event) => {
    if (
      event.transition_key !== 'step_completed'
      || Number(event.workflow_step_id) !== commandOperation.workflow_step_id
    ) return false;
    const payload = parseStoredJson(event.event_payload, 'Pathway transition payload', {});
    const expectedDecision = step.step_kind === 'task' ? 'task_completed' : 'approval_completed';
    return (
      payload.decision === expectedDecision
      && payload.evidence?.domain_evidence_satisfied === true
      && Number(payload.evidence?.task_id) === commandOperation.task_id
    );
  });
  const approvedPendingEvent = step.step_kind === 'approval'
    ? events.find((event) => {
      if (
        event.transition_key !== 'approval_waiting'
        || Number(event.workflow_step_id) !== commandOperation.workflow_step_id
      ) return false;
      const payload = parseStoredJson(event.event_payload, 'Pathway transition payload', {});
      return (
        payload.evidence_satisfied === true
        && Number(payload.task_id) === commandOperation.task_id
        && payload.condition_evidence
        && typeof payload.condition_evidence === 'object'
      );
    })
    : null;
  if (!completedEvent && !approvedPendingEvent) {
    throw AppError.conflict(
      'Registered domain evidence was not satisfied by the governed pathway condition',
      'PATHWAY_DOMAIN_EVIDENCE_POSTCONDITION_FAILED',
    );
  }
}

export async function completePathwayTaskAndExecuteFromRegisteredEvidence(input = {}) {
  const registry = normalizeRegistry(input.registry ?? workflowRuntimeRegistry);
  const normalized = normalizeCommandInput(input, registry);
  const commandOperation = normalizeDomainEvidenceCommandOperation(input);
  const commandFingerprint = pathwayCommandFingerprint(normalized, registry, commandOperation);
  return inTenantTx(normalized.tenantId, normalized.tx, async (tx) => {
    const commandEnvelope = Object.freeze({ ...normalized, tx });
    const replay = await findPathwayTransitionReplayTx({
      tx,
      tenantId: commandEnvelope.tenantId,
      pathwayInstanceId: commandEnvelope.pathwayInstanceId,
      idempotencyKey: commandEnvelope.idempotencyKey,
      commandFingerprint,
      lockInstance: true,
    });
    if (replay.replayed) {
      await assertCurrentInstanceOwnerTx(
        tx,
        commandEnvelope.tenantId,
        replay.pathwayInstance,
        commandEnvelope.actor,
      );
      await assertPathwayReplayDefinitionPinTx({
        tx,
        tenantId: commandEnvelope.tenantId,
        pathwayInstanceId: commandEnvelope.pathwayInstanceId,
        events: replay.events,
      });
      const prior = replayResult(replay.events);
      const execution = {
        instance: prior.resultSnapshot,
        events: replay.events,
        replayed: true,
        mode: prior.mode,
      };
      assertDomainEvidenceExecutionPostcondition(execution, commandOperation);
      return execution;
    }
    const runtimeMode = assertModeAvailable(
      await resolvePathwayModeTx({
        tx,
        tenantId: commandEnvelope.tenantId,
        pathwayKey: replay.pathwayInstance.pathway_key,
      }),
      commandEnvelope.activationEvidenceCapability,
    );
    const runtime = await lockPathwayRuntimeTx({
      tx,
      tenantId: commandEnvelope.tenantId,
      pathwayInstanceId: commandEnvelope.pathwayInstanceId,
    });
    if (!['approved', 'retired'].includes(runtime.definition.governance_status)) {
      throw AppError.conflict(
        'Pathway definition governance is no longer valid',
        'PATHWAY_DEFINITION_NOT_APPROVED',
      );
    }
    const compiled = compilePinnedDefinition(runtime.definition, registry);
    assertRuntimeGraph(runtime, compiled);
    await assertCommandOwnership(
      tx,
      commandEnvelope.tenantId,
      runtime,
      compiled,
      commandEnvelope.actor,
    );
    const targetTask = runtime.tasks.find(
      (task) => Number(task.id) === commandOperation.task_id,
    );
    if (
      !targetTask
      || Number(runtime.run.id) !== commandOperation.workflow_run_id
      || Number(targetTask.workflow_run_id) !== commandOperation.workflow_run_id
      || Number(targetTask.workflow_step_id) !== commandOperation.workflow_step_id
    ) {
      throw AppError.conflict(
        'Registered domain evidence does not match the pinned pathway runtime',
        'PATHWAY_TASK_CONTEXT_MISMATCH',
      );
    }
    void runtimeMode;
    const completion = await completePathwayTaskFromRegisteredEvidence({
      tenantId: commandEnvelope.tenantId,
      id: commandOperation.task_id,
      pathwayInstanceId: commandEnvelope.pathwayInstanceId,
      workflowRunId: commandOperation.workflow_run_id,
      workflowStepId: commandOperation.workflow_step_id,
      conditionHandler: commandOperation.condition_handler,
      evidence: commandOperation.evidence,
      actor: commandEnvelope.actor,
      signal: commandEnvelope.signal,
      executorAuthority: mintPathwayExecutorCapability(),
      tx,
    });
    if (!completion?.task || !completion?.sla) {
      throw AppError.conflict(
        'Registered domain evidence completion did not return its sealed task and SLA state',
        'PATHWAY_DOMAIN_EVIDENCE_POSTCONDITION_FAILED',
      );
    }
    const execution = await executePathwayCommandInternal({
      registry,
    }, commandOperation, completion, commandEnvelope);
    assertDomainEvidenceExecutionPostcondition(execution, commandOperation);
    return execution;
  });
}

export async function getCarePathwayInstance({ tenantId, id } = {}) {
  const tid = requireUuid(requireTenantId(tenantId), 'tenant_id');
  const instanceId = requireUuid(id, 'pathway_instance_id');
  return inTenantTx(tid, null, (tx) => getCarePathwayInstanceTx({
    tx,
    tenantId: tid,
    id: instanceId,
  }));
}

export default {
  startCarePathwayInstance,
  executePathwayCommand,
  completePathwayTaskAndExecuteFromRegisteredEvidence,
  getCarePathwayInstance,
};
