import { WORKFLOW_STEP_KINDS } from './workflowDefinitionContract.js';
import { DIAGNOSTIC_PATHWAY_RUNTIME_HANDLERS } from '../pathways/diagnosticsPathwayHandlers.js';
import { REFERRAL_PATHWAY_RUNTIME_HANDLERS } from '../pathways/referralPathwayHandlers.js';

const HANDLER_ID_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*\.v[1-9][0-9]*$/;
const DECISION_CODE_PATTERN = /^[a-z][a-z0-9_]{0,79}$/;
const SOURCE_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,79}$/;
const ISO_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const STEP_KIND_SET = new Set(WORKFLOW_STEP_KINDS);
const PG_BIGINT_MAX = 9223372036854775807n;
const registriesByVersion = new Map();
const registeredSystemActors = new WeakMap();

function requirePositiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return value;
}

function requireHandlerId(value) {
  if (
    typeof value !== 'string'
    || value.length > 120
    || value.trim() !== value
    || !HANDLER_ID_PATTERN.test(value)
  ) {
    throw new TypeError('Workflow runtime handler id must be a versioned canonical identifier');
  }
  return value;
}

function requireSourceEventId(value) {
  if (value === null || value === undefined || value === '') {
    throw new TypeError('Workflow runtime system actor sourceEventId is required');
  }
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError('Workflow runtime system actor sourceEventId must be a safe non-negative integer');
  }
  const text = typeof value === 'bigint' ? value.toString() : String(value).trim();
  if (!/^\d+$/.test(text)) {
    throw new TypeError('Workflow runtime system actor sourceEventId must be a non-negative integer');
  }
  const normalized = text.replace(/^0+(?=\d)/, '');
  if (normalized.length > 19 || BigInt(normalized) > PG_BIGINT_MAX) {
    throw new TypeError('Workflow runtime system actor sourceEventId exceeds PostgreSQL BIGINT');
  }
  return normalized;
}

function normalizeCausationId(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.trim() !== value || value.length > 160) {
    throw new TypeError('Workflow runtime system actor causationId must be a canonical string');
  }
  return value;
}

function normalizeOccurredAt(value) {
  if (typeof value !== 'string' || value.trim() !== value) {
    throw new TypeError('Workflow runtime system actor signalContext.occurredAt must be an ISO timestamp');
  }
  const parts = ISO_TIMESTAMP_PATTERN.exec(value);
  if (!parts) {
    throw new TypeError('Workflow runtime system actor signalContext.occurredAt must be an ISO timestamp');
  }
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
  ) {
    throw new TypeError('Workflow runtime system actor signalContext.occurredAt must be an ISO timestamp');
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new TypeError('Workflow runtime system actor signalContext.occurredAt must be an ISO timestamp');
  }
  return parsed.toISOString();
}

function normalizeSignalContext(value) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw new TypeError('Workflow runtime system actor signalContext is required');
  }
  const allowed = new Set(['sourceResourceType', 'sourceResourceId', 'occurredAt']);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !allowed.has(key) || !descriptor?.enumerable || descriptor.get || descriptor.set) {
      throw new TypeError('Workflow runtime system actor signalContext is invalid');
    }
  }
  if (
    typeof value.sourceResourceType !== 'string'
    || value.sourceResourceType.trim() !== value.sourceResourceType
    || !SOURCE_TYPE_PATTERN.test(value.sourceResourceType)
  ) {
    throw new TypeError('Workflow runtime system actor signalContext.sourceResourceType is invalid');
  }
  if (
    typeof value.sourceResourceId !== 'string'
    || !value.sourceResourceId.trim()
    || value.sourceResourceId.trim() !== value.sourceResourceId
    || value.sourceResourceId.length > 160
  ) {
    throw new TypeError('Workflow runtime system actor signalContext.sourceResourceId is invalid');
  }
  return Object.freeze({
    sourceResourceType: value.sourceResourceType,
    sourceResourceId: value.sourceResourceId,
    occurredAt: normalizeOccurredAt(value.occurredAt),
  });
}

function normalizeStepKinds(value, handlerId) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`Workflow runtime handler ${handlerId} must declare stepKinds`);
  }
  const normalized = [];
  const seen = new Set();
  for (const stepKind of value) {
    if (!STEP_KIND_SET.has(stepKind)) {
      throw new TypeError(`Workflow runtime handler ${handlerId} has an unsupported step kind`);
    }
    if (seen.has(stepKind)) {
      throw new TypeError(`Workflow runtime handler ${handlerId} repeats step kind ${stepKind}`);
    }
    seen.add(stepKind);
    normalized.push(stepKind);
  }
  return Object.freeze(normalized);
}

function normalizeDecisionCodes(value, handlerId) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`Workflow condition handler ${handlerId} must declare decisionCodes`);
  }
  const normalized = [];
  const seen = new Set();
  for (const decisionCode of value) {
    if (
      typeof decisionCode !== 'string'
      || decisionCode.trim() !== decisionCode
      || !DECISION_CODE_PATTERN.test(decisionCode)
    ) {
      throw new TypeError(`Workflow condition handler ${handlerId} has an invalid decision code`);
    }
    if (seen.has(decisionCode)) {
      throw new TypeError(`Workflow condition handler ${handlerId} repeats decision code ${decisionCode}`);
    }
    seen.add(decisionCode);
    normalized.push(decisionCode);
  }
  return Object.freeze(normalized);
}

function normalizeHandlerEntries(entries, kind) {
  if (!Array.isArray(entries)) {
    throw new TypeError(`Workflow runtime ${kind} handlers must be an array`);
  }
  const handlers = new Map();
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new TypeError(`Workflow runtime ${kind} entries must be [id, descriptor] tuples`);
    }
    const id = requireHandlerId(entry[0]);
    if (handlers.has(id)) {
      throw new TypeError(`Duplicate workflow runtime ${kind} handler: ${id}`);
    }
    const descriptor = entry[1];
    if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
      throw new TypeError(`Workflow runtime handler ${id} descriptor must be an object`);
    }
    const callbackName = kind === 'condition' ? 'evaluate' : kind === 'action' ? 'execute' : 'resolve';
    if (typeof descriptor[callbackName] !== 'function') {
      throw new TypeError(`Workflow runtime handler ${id} must define ${callbackName}()`);
    }
    const normalized = {
      id,
      stepKinds: normalizeStepKinds(descriptor.stepKinds, id),
      [callbackName]: descriptor[callbackName],
    };
    if (kind === 'condition') {
      normalized.decisionCodes = normalizeDecisionCodes(descriptor.decisionCodes, id);
      if (descriptor.loadEvidence !== null && descriptor.loadEvidence !== undefined) {
        if (typeof descriptor.loadEvidence !== 'function') {
          throw new TypeError(`Workflow condition handler ${id} loadEvidence must be a function`);
        }
        normalized.loadEvidence = descriptor.loadEvidence;
      }
    }
    handlers.set(id, Object.freeze(normalized));
  }
  return handlers;
}

/**
 * Construct an immutable, exact-match registry. Handler behavior is versioned
 * by identifier; changing behavior requires a new id rather than replacement.
 */
export function createWorkflowRuntimeRegistry({
  version = 1,
  conditions = [],
  actions = [],
  childFanouts = [],
  systemActors = [],
} = {}) {
  const normalizedVersion = requirePositiveInteger(version, 'Workflow runtime registry version');
  const conditionHandlers = normalizeHandlerEntries(conditions, 'condition');
  const actionHandlers = normalizeHandlerEntries(actions, 'action');
  const childFanoutHandlers = normalizeHandlerEntries(childFanouts, 'child fan-out');
  if (!Array.isArray(systemActors)) {
    throw new TypeError('Workflow runtime system actors must be an array');
  }
  const systemActorKeys = [];
  const seenSystemActors = new Set();
  for (const value of systemActors) {
    const systemActorKey = requireHandlerId(value);
    if (seenSystemActors.has(systemActorKey)) {
      throw new TypeError(`Duplicate workflow runtime system actor: ${systemActorKey}`);
    }
    seenSystemActors.add(systemActorKey);
    systemActorKeys.push(systemActorKey);
  }
  if (registriesByVersion.has(normalizedVersion)) {
    throw new TypeError(`Workflow runtime registry version ${normalizedVersion} is already registered`);
  }

  const registry = Object.freeze({
    version: normalizedVersion,
    conditionHandlerIds: Object.freeze([...conditionHandlers.keys()]),
    actionHandlerIds: Object.freeze([...actionHandlers.keys()]),
    childFanoutHandlerIds: Object.freeze([...childFanoutHandlers.keys()]),
    systemActorKeys: Object.freeze(systemActorKeys),
    resolveCondition(id) {
      return typeof id === 'string' ? conditionHandlers.get(id) : undefined;
    },
    resolveAction(id) {
      return typeof id === 'string' ? actionHandlers.get(id) : undefined;
    },
    resolveChildFanout(id) {
      return typeof id === 'string' ? childFanoutHandlers.get(id) : undefined;
    },
    hasSystemActor(id) {
      return typeof id === 'string' && seenSystemActors.has(id);
    },
  });
  registriesByVersion.set(normalizedVersion, registry);
  return registry;
}

export function isWorkflowRuntimeRegistry(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && Number.isInteger(value.version)
    && registriesByVersion.get(value.version) === value
  );
}

export function createRegisteredWorkflowSystemActor({
  registry = workflowRuntimeRegistry,
  systemKey,
  sourceEventId,
  causationId = null,
  signalContext,
} = {}) {
  if (!isWorkflowRuntimeRegistry(registry)) {
    throw new TypeError('registry is not a workflow runtime registry');
  }
  const normalizedSystemKey = requireHandlerId(systemKey);
  if (!registry.hasSystemActor(normalizedSystemKey)) {
    throw new TypeError(`Workflow runtime system actor is not registered: ${normalizedSystemKey}`);
  }
  const normalizedSignalContext = normalizeSignalContext(signalContext);
  const actor = Object.freeze({
    kind: 'system',
    systemKey: normalizedSystemKey,
    sourceEventId: requireSourceEventId(sourceEventId),
    causationId: normalizeCausationId(causationId),
    signalContext: normalizedSignalContext,
  });
  registeredSystemActors.set(actor, Object.freeze({
    registry,
    signalContext: normalizedSignalContext,
  }));
  return actor;
}

export function isRegisteredWorkflowSystemActor(actor, { registry = null } = {}) {
  const binding = actor && typeof actor === 'object'
    ? registeredSystemActors.get(actor)
    : undefined;
  if (!binding) return false;
  return registry === null ? true : binding.registry === registry;
}

// Retained for checksum/replay compatibility with the S1b-b no-op runtime.
export const workflowRuntimeRegistryV1 = createWorkflowRuntimeRegistry({ version: 1 });

export const workflowRuntimeRegistryV2 = createWorkflowRuntimeRegistry({
  version: 2,
  conditions: [
    ['diagnostics.route_generation.v1', DIAGNOSTIC_PATHWAY_RUNTIME_HANDLERS.routeGeneration],
    ['diagnostics.normal_closure.v1', DIAGNOSTIC_PATHWAY_RUNTIME_HANDLERS.normalClosure],
    ['diagnostics.doctor_action.v1', DIAGNOSTIC_PATHWAY_RUNTIME_HANDLERS.doctorAction],
  ],
  actions: [
    ['diagnostics.finalize.v1', DIAGNOSTIC_PATHWAY_RUNTIME_HANDLERS.finalize],
  ],
  systemActors: ['diagnostics.pathway_projector.v1'],
});

export const workflowRuntimeRegistry = createWorkflowRuntimeRegistry({
  version: 3,
  conditions: [
    ['diagnostics.route_generation.v1', DIAGNOSTIC_PATHWAY_RUNTIME_HANDLERS.routeGeneration],
    ['diagnostics.normal_closure.v1', DIAGNOSTIC_PATHWAY_RUNTIME_HANDLERS.normalClosure],
    ['diagnostics.doctor_action.v1', DIAGNOSTIC_PATHWAY_RUNTIME_HANDLERS.doctorAction],
    ['referral.receiver_acceptance.v1', REFERRAL_PATHWAY_RUNTIME_HANDLERS.receiverAcceptance],
    ['referral.signed_response.v1', REFERRAL_PATHWAY_RUNTIME_HANDLERS.signedResponse],
    ['referral.originator_closure.v1', REFERRAL_PATHWAY_RUNTIME_HANDLERS.originatorClosure],
  ],
  actions: [
    ['diagnostics.finalize.v1', DIAGNOSTIC_PATHWAY_RUNTIME_HANDLERS.finalize],
    ['referral.finalize.v1', REFERRAL_PATHWAY_RUNTIME_HANDLERS.finalize],
  ],
  systemActors: [
    'diagnostics.pathway_projector.v1',
    'referral.pathway_projector.v1',
  ],
});

export default workflowRuntimeRegistry;
