import { AppError } from '../../utils/AppError.js';

export const WORKFLOW_STEP_KINDS = Object.freeze([
  'task',
  'approval',
  'automation',
  'wait',
  'subworkflow',
  'ai_call',
]);

// S1b-a deliberately registers no executable behavior. Later slices must add
// code-reviewed handlers here before a definition may reference them.
export const WORKFLOW_CONDITION_HANDLERS = Object.freeze({});
export const WORKFLOW_ACTION_HANDLERS = Object.freeze({});

const STEP_KIND_SET = new Set(WORKFLOW_STEP_KINDS);
const STEP_KEY_PATTERN = /^[a-z][a-z0-9_]{0,119}$/;
const ROLE_PATTERN = /^[A-Z][A-Z0-9_]{0,79}$/;
const ISO_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const ALLOWED_STEP_FIELDS = new Set([
  'step_key',
  'key',
  'step_kind',
  'kind',
  'display_name',
  'title',
  'assigned_role',
  'assignedRole',
  'due_at',
  'dueAt',
  'metadata',
  'condition_handler',
  'conditionHandler',
  'action_handler',
  'actionHandler',
]);

function invalidDefinition(message, details = null) {
  throw AppError.badRequest(message, 'INVALID_WORKFLOW_DEFINITION', details);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertDataProperties(value, label) {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      invalidDefinition(`${label} must contain only string keys`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || descriptor.get || descriptor.set) {
      invalidDefinition(`${label}.${key} must be an enumerable data property`);
    }
  }
}

function cloneJsonValue(value, label, ancestors = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalidDefinition(`${label} must contain only finite numbers`);
    return value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) invalidDefinition(`${label} must not contain circular references`);
    ancestors.add(value);
    const result = value.map((item, index) => cloneJsonValue(item, `${label}[${index}]`, ancestors));
    ancestors.delete(value);
    return Object.freeze(result);
  }
  if (!isPlainObject(value)) {
    invalidDefinition(`${label} must contain only JSON values`);
  }
  if (ancestors.has(value)) invalidDefinition(`${label} must not contain circular references`);
  assertDataProperties(value, label);
  ancestors.add(value);
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (UNSAFE_OBJECT_KEYS.has(key)) invalidDefinition(`${label} contains an unsafe key`);
    result[key] = cloneJsonValue(item, `${label}.${key}`, ancestors);
  }
  ancestors.delete(value);
  return Object.freeze(result);
}

function readAlias(step, canonicalKey, aliasKey, label) {
  const hasCanonical = Object.hasOwn(step, canonicalKey);
  const hasAlias = Object.hasOwn(step, aliasKey);
  if (hasCanonical && hasAlias) {
    invalidDefinition(`${label} must not define both ${canonicalKey} and ${aliasKey}`);
  }
  if (hasCanonical) return step[canonicalKey];
  if (hasAlias) return step[aliasKey];
  return undefined;
}

function requiredString(value, label, maxLength) {
  if (typeof value !== 'string') invalidDefinition(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized) invalidDefinition(`${label} is required`);
  if (normalized.length > maxLength) {
    invalidDefinition(`${label} must be at most ${maxLength} characters`);
  }
  return normalized;
}

function optionalString(value, label, maxLength) {
  if (value === null || value === undefined) return null;
  return requiredString(value, label, maxLength);
}

function normalizeStepKey(value, label) {
  const normalized = requiredString(value, `${label}.step_key`, 120);
  if (!STEP_KEY_PATTERN.test(normalized)) {
    invalidDefinition(`${label}.step_key must be a canonical lower_snake_case key`);
  }
  return normalized;
}

function normalizeStepKind(value, label) {
  const normalized = requiredString(value, `${label}.step_kind`, 40);
  if (!STEP_KIND_SET.has(normalized)) {
    invalidDefinition(
      `${label}.step_kind must be one of: ${WORKFLOW_STEP_KINDS.join(', ')}`,
    );
  }
  return normalized;
}

function normalizeRole(value, label) {
  if (value === null || value === undefined) return null;
  const normalized = requiredString(value, `${label}.assigned_role`, 80).toUpperCase();
  if (!ROLE_PATTERN.test(normalized)) {
    invalidDefinition(`${label}.assigned_role must be a canonical role code`);
  }
  return normalized;
}

function normalizeTimestamp(value, label) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !value.trim()) {
    invalidDefinition(`${label}.due_at must be an ISO-8601 timestamp string`);
  }
  const timestamp = value.trim();
  const parts = ISO_TIMESTAMP_PATTERN.exec(timestamp);
  if (!parts) invalidDefinition(`${label}.due_at must be a valid ISO-8601 timestamp`);
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
    year < 1
    || month < 1
    || month > 12
    || day < 1
    || day > daysInMonth[month]
    || hour > 23
    || minute > 59
    || second > 59
    || offsetHours > 23
    || offsetMinutes > 59
  ) {
    invalidDefinition(`${label}.due_at must be a valid ISO-8601 timestamp`);
  }
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    invalidDefinition(`${label}.due_at must be a valid ISO-8601 timestamp`);
  }
  return parsed.toISOString();
}

function normalizeMetadata(value, label) {
  if (value === null || value === undefined) return Object.freeze({});
  if (!isPlainObject(value)) invalidDefinition(`${label}.metadata must be a plain JSON object`);
  return cloneJsonValue(value, `${label}.metadata`);
}

function normalizeHandler(value, label, registry) {
  if (value === null || value === undefined) return null;
  const normalized = requiredString(value, label, 120);
  if (!Object.hasOwn(registry, normalized)) {
    invalidDefinition(`${label} is not a registered executable identifier`);
  }
  return normalized;
}

function normalizeStep(step, index) {
  const label = `steps[${index}]`;
  if (!isPlainObject(step)) invalidDefinition(`${label} must be a plain object`);
  assertDataProperties(step, label);
  for (const key of Object.keys(step)) {
    if (!ALLOWED_STEP_FIELDS.has(key)) {
      invalidDefinition(`${label}.${key} is not supported`);
    }
  }

  const stepKey = normalizeStepKey(readAlias(step, 'step_key', 'key', label), label);
  const stepKind = normalizeStepKind(readAlias(step, 'step_kind', 'kind', label), label);
  const displayName = optionalString(
    readAlias(step, 'display_name', 'title', label),
    `${label}.display_name`,
    255,
  );
  const assignedRole = normalizeRole(
    readAlias(step, 'assigned_role', 'assignedRole', label),
    label,
  );
  const dueAt = normalizeTimestamp(readAlias(step, 'due_at', 'dueAt', label), label);
  const conditionHandler = normalizeHandler(
    readAlias(step, 'condition_handler', 'conditionHandler', label),
    `${label}.condition_handler`,
    WORKFLOW_CONDITION_HANDLERS,
  );
  const actionHandler = normalizeHandler(
    readAlias(step, 'action_handler', 'actionHandler', label),
    `${label}.action_handler`,
    WORKFLOW_ACTION_HANDLERS,
  );

  return Object.freeze({
    step_key: stepKey,
    display_name: displayName,
    step_kind: stepKind,
    assigned_role: assignedRole,
    due_at: dueAt,
    metadata: normalizeMetadata(step.metadata, label),
    condition_handler: conditionHandler,
    action_handler: actionHandler,
  });
}

/**
 * Validate and canonicalize the migration-118 workflow step subset.
 * No stored value is interpreted or executed.
 */
export function validateWorkflowDefinitionSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0) {
    invalidDefinition('steps must be a non-empty array');
  }

  const seenKeys = new Set();
  const normalized = steps.map((step, index) => {
    const result = normalizeStep(step, index);
    if (seenKeys.has(result.step_key)) {
      invalidDefinition(`steps contains duplicate step_key: ${result.step_key}`);
    }
    seenKeys.add(result.step_key);
    return result;
  });
  return Object.freeze(normalized);
}

export default {
  WORKFLOW_STEP_KINDS,
  WORKFLOW_CONDITION_HANDLERS,
  WORKFLOW_ACTION_HANDLERS,
  validateWorkflowDefinitionSteps,
};
