import { createHash } from 'node:crypto';

import { AppError } from '../../utils/AppError.js';
import { WORKFLOW_STEP_KINDS } from './workflowDefinitionContract.js';
import {
  isWorkflowRuntimeRegistry,
  workflowRuntimeRegistry,
} from './workflowRuntimeRegistry.js';
import { assertWorkflowJsonBudget } from './workflowJsonGuard.js';
import { isPathwayHumanOwnerRole } from './workflowHumanOwnerService.js';

const STEP_KIND_SET = new Set(WORKFLOW_STEP_KINDS);
const STEP_KEY_PATTERN = /^[a-z][a-z0-9_]{0,119}$/;
const ROLE_PATTERN = /^[A-Z][A-Z0-9_]{0,79}$/;
const RULE_CODE_PATTERN = /^[a-z][a-z0-9_]{0,119}$/;
const PATHWAY_KEY_PATTERN = /^[a-z][a-z0-9_]{0,119}$/;
const ISO_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const RESERVED_DECISIONS = new Set(['blocked', 'satisfied']);
const CHILD_RELATIONSHIPS = new Set([
  'blocking',
  'ownership_transferring',
  'nonblocking_with_named_owner',
  'informational',
]);
const SLA_COMPLETION_SEMANTICS = new Set([
  'none',
  'acknowledgement',
  'domain_evidence',
]);
const TASK_KINDS = new Set([
  'general', 'follow_up', 'review', 'escalation', 'verification',
  'admin', 'consent', 'investigation', 'other',
]);
const TASK_PRIORITIES = new Set(['low', 'normal', 'high', 'critical']);
export const WORKFLOW_RUNTIME_LIMITS = Object.freeze({
  maxDefinitionSteps: 128,
  maxExceptionTransitionsPerStep: 16,
  maxChildRulesPerStep: 16,
  maxChildrenPerRule: 32,
  maxChildrenPerStage: 64,
  maxChildrenPerCommand: 64,
  maxChildWorkflowStepsPerCommand: 512,
  maxTransitionIntentsPerCommand: 512,
  maxAppliedPlansPerCommand: 384,
});
const MAX_DEFINITION_STEPS = WORKFLOW_RUNTIME_LIMITS.maxDefinitionSteps;
const MAX_EXCEPTION_TRANSITIONS_PER_STEP = WORKFLOW_RUNTIME_LIMITS.maxExceptionTransitionsPerStep;
const MAX_CHILD_RULES_PER_STEP = WORKFLOW_RUNTIME_LIMITS.maxChildRulesPerStep;
const MAX_TRANSITION_INTENTS_PER_COMMAND = WORKFLOW_RUNTIME_LIMITS.maxTransitionIntentsPerCommand;
const STEP_FIELDS = new Set([
  'step_key', 'step_kind', 'display_name', 'assigned_role', 'due_at', 'metadata',
  'condition_handler', 'action_handler', 'exception_transitions', 'child_rules',
  'work_semantics',
]);
const EXCEPTION_FIELDS = new Set(['decision_code', 'target_step_key']);
const CHILD_RULE_FIELDS = new Set([
  'rule_key', 'fanout_handler', 'child_pathway_key', 'relationship',
]);
const TASK_WORK_FIELDS = new Set([
  'task_kind', 'priority', 'title', 'description',
  'sla_completion_semantics', 'sla_rule_code',
]);
const APPROVAL_WORK_FIELDS = new Set([
  'approval_kind', 'required_approvers', 'required_role', 'subject_resource_type',
  'task_kind', 'priority', 'title', 'description',
  'sla_completion_semantics', 'sla_rule_code',
]);
const DEFINITION_FIELDS = new Set([
  'workflow_key', 'version', 'steps', 'triggers', 'defaults',
]);

function invalidDefinition(message, details = null) {
  throw AppError.badRequest(message, 'INVALID_WORKFLOW_DEFINITION', details);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) invalidDefinition(`${label} must be a plain object`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || UNSAFE_KEYS.has(key)) {
      invalidDefinition(`${label} contains an unsafe key`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || descriptor.get || descriptor.set) {
      invalidDefinition(`${label}.${key} must be an enumerable data property`);
    }
  }
}

function cloneJson(value, label, ancestors = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalidDefinition(`${label} must contain finite numbers`);
    return value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) invalidDefinition(`${label} must not contain circular references`);
    ancestors.add(value);
    const cloned = value.map((item, index) => cloneJson(item, `${label}[${index}]`, ancestors));
    ancestors.delete(value);
    return Object.freeze(cloned);
  }
  assertPlainObject(value, label);
  if (ancestors.has(value)) invalidDefinition(`${label} must not contain circular references`);
  ancestors.add(value);
  const cloned = {};
  for (const [key, item] of Object.entries(value)) {
    cloned[key] = cloneJson(item, `${label}.${key}`, ancestors);
  }
  ancestors.delete(value);
  return Object.freeze(cloned);
}

function assertOnlyFields(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalidDefinition(`${label}.${key} is not supported`);
  }
}

function requiredString(value, label, maxLength, pattern = null) {
  if (typeof value !== 'string') invalidDefinition(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized) invalidDefinition(`${label} is required`);
  if (normalized.length > maxLength) invalidDefinition(`${label} must be at most ${maxLength} characters`);
  if (pattern && !pattern.test(normalized)) invalidDefinition(`${label} is not canonical`);
  return normalized;
}

function optionalString(value, label, maxLength, pattern = null) {
  if (value === null || value === undefined) return null;
  return requiredString(value, label, maxLength, pattern);
}

function positiveInteger(value, label, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) invalidDefinition(`${label} must be a positive integer`);
  return value;
}

function normalizeTimestamp(value, label) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.trim() !== value) {
    invalidDefinition(`${label} must be an ISO timestamp`);
  }
  const parts = ISO_TIMESTAMP_PATTERN.exec(value);
  if (!parts) invalidDefinition(`${label} must be an ISO timestamp`);
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
    invalidDefinition(`${label} must be an ISO timestamp`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) invalidDefinition(`${label} must be an ISO timestamp`);
  return parsed.toISOString();
}

function normalizeHandlerId(value, label, resolver, stepKind) {
  if (value === null || value === undefined) return null;
  const id = requiredString(value, label, 120);
  const descriptor = resolver(id);
  if (!descriptor) invalidDefinition(`${label} is not a registered executable identifier`);
  if (!descriptor.stepKinds.includes(stepKind)) {
    invalidDefinition(`${label} is not registered for step kind ${stepKind}`);
  }
  return id;
}

function normalizeTaskWorkSemantics(value, label) {
  assertPlainObject(value, label);
  assertOnlyFields(value, TASK_WORK_FIELDS, label);
  const semantics = requiredString(
    value.sla_completion_semantics,
    `${label}.sla_completion_semantics`,
    40,
  );
  if (!SLA_COMPLETION_SEMANTICS.has(semantics)) {
    invalidDefinition(`${label}.sla_completion_semantics is unsupported`);
  }
  const slaRuleCode = optionalString(value.sla_rule_code, `${label}.sla_rule_code`, 120, RULE_CODE_PATTERN);
  if (semantics === 'none' && slaRuleCode) {
    invalidDefinition(`${label}.sla_rule_code requires acknowledgement or domain_evidence semantics`);
  }
  if (semantics !== 'none' && !slaRuleCode) {
    invalidDefinition(`${label}.sla_rule_code is required for ${semantics}`);
  }
  const taskKind = value.task_kind ?? 'general';
  if (!TASK_KINDS.has(taskKind)) invalidDefinition(`${label}.task_kind is unsupported`);
  const priority = value.priority ?? 'normal';
  if (!TASK_PRIORITIES.has(priority)) invalidDefinition(`${label}.priority is unsupported`);
  return Object.freeze({
    task_kind: taskKind,
    priority,
    title: optionalString(value.title, `${label}.title`, 500),
    description: optionalString(value.description, `${label}.description`, 8000),
    sla_completion_semantics: semantics,
    sla_rule_code: slaRuleCode,
  });
}

function normalizeApprovalWorkSemantics(value, label) {
  assertPlainObject(value, label);
  assertOnlyFields(value, APPROVAL_WORK_FIELDS, label);
  const semantics = requiredString(
    value.sla_completion_semantics,
    `${label}.sla_completion_semantics`,
    40,
  );
  if (!SLA_COMPLETION_SEMANTICS.has(semantics)) {
    invalidDefinition(`${label}.sla_completion_semantics is unsupported`);
  }
  const slaRuleCode = optionalString(value.sla_rule_code, `${label}.sla_rule_code`, 120, RULE_CODE_PATTERN);
  if (semantics === 'none' && slaRuleCode) {
    invalidDefinition(`${label}.sla_rule_code requires acknowledgement or domain_evidence semantics`);
  }
  if (semantics !== 'none' && !slaRuleCode) {
    invalidDefinition(`${label}.sla_rule_code is required for ${semantics}`);
  }
  const taskKind = value.task_kind ?? 'review';
  if (!TASK_KINDS.has(taskKind)) invalidDefinition(`${label}.task_kind is unsupported`);
  const priority = value.priority ?? 'normal';
  if (!TASK_PRIORITIES.has(priority)) invalidDefinition(`${label}.priority is unsupported`);
  const requiredApprovers = positiveInteger(
    value.required_approvers,
    `${label}.required_approvers`,
    1,
  );
  if (requiredApprovers > 100) {
    invalidDefinition(`${label}.required_approvers must be at most 100`);
  }
  const requiredRole = optionalString(
    value.required_role,
    `${label}.required_role`,
    80,
    ROLE_PATTERN,
  );
  if (requiredRole && !isPathwayHumanOwnerRole(requiredRole)) {
    invalidDefinition(`${label}.required_role must be a route-capable human clinical role`);
  }
  return Object.freeze({
    approval_kind: requiredString(value.approval_kind, `${label}.approval_kind`, 80, RULE_CODE_PATTERN),
    required_approvers: requiredApprovers,
    required_role: requiredRole,
    subject_resource_type: optionalString(
      value.subject_resource_type,
      `${label}.subject_resource_type`,
      60,
      RULE_CODE_PATTERN,
    ),
    task_kind: taskKind,
    priority,
    title: optionalString(value.title, `${label}.title`, 500),
    description: optionalString(value.description, `${label}.description`, 8000),
    sla_completion_semantics: semantics,
    sla_rule_code: slaRuleCode,
  });
}

function normalizeWorkSemantics(value, stepKind, label) {
  if (stepKind === 'task') {
    if (value === null || value === undefined) invalidDefinition(`${label} is required for task steps`);
    return normalizeTaskWorkSemantics(value, label);
  }
  if (stepKind === 'approval') {
    if (value === null || value === undefined) invalidDefinition(`${label} is required for approval steps`);
    return normalizeApprovalWorkSemantics(value, label);
  }
  if (value !== null && value !== undefined) {
    invalidDefinition(`${label} is only valid for task or approval steps`);
  }
  return null;
}

function normalizeExceptionTransitions(value, label) {
  if (value === null || value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) invalidDefinition(`${label} must be an array`);
  if (value.length > MAX_EXCEPTION_TRANSITIONS_PER_STEP) {
    invalidDefinition(`${label} must contain at most ${MAX_EXCEPTION_TRANSITIONS_PER_STEP} entries`);
  }
  const decisions = new Set();
  return Object.freeze(value.map((transition, index) => {
    const itemLabel = `${label}[${index}]`;
    assertPlainObject(transition, itemLabel);
    assertOnlyFields(transition, EXCEPTION_FIELDS, itemLabel);
    const decisionCode = requiredString(
      transition.decision_code,
      `${itemLabel}.decision_code`,
      80,
      RULE_CODE_PATTERN,
    );
    if (RESERVED_DECISIONS.has(decisionCode)) {
      invalidDefinition(`${itemLabel}.decision_code is reserved`);
    }
    if (decisions.has(decisionCode)) invalidDefinition(`${label} repeats decision code ${decisionCode}`);
    decisions.add(decisionCode);
    return Object.freeze({
      decision_code: decisionCode,
      target_step_key: requiredString(
        transition.target_step_key,
        `${itemLabel}.target_step_key`,
        120,
        STEP_KEY_PATTERN,
      ),
    });
  }));
}

function normalizeChildRules(value, label, registry, stepKind) {
  if (value === null || value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) invalidDefinition(`${label} must be an array`);
  if (value.length > MAX_CHILD_RULES_PER_STEP) {
    invalidDefinition(`${label} must contain at most ${MAX_CHILD_RULES_PER_STEP} entries`);
  }
  const ruleKeys = new Set();
  return Object.freeze(value.map((rule, index) => {
    const itemLabel = `${label}[${index}]`;
    assertPlainObject(rule, itemLabel);
    assertOnlyFields(rule, CHILD_RULE_FIELDS, itemLabel);
    const ruleKey = requiredString(rule.rule_key, `${itemLabel}.rule_key`, 120, RULE_CODE_PATTERN);
    if (ruleKeys.has(ruleKey)) invalidDefinition(`${label} repeats rule_key ${ruleKey}`);
    ruleKeys.add(ruleKey);
    if (rule.fanout_handler === null || rule.fanout_handler === undefined) {
      invalidDefinition(`${itemLabel}.fanout_handler is required`);
    }
    const fanoutHandler = normalizeHandlerId(
      rule.fanout_handler,
      `${itemLabel}.fanout_handler`,
      registry.resolveChildFanout,
      stepKind,
    );
    const relationship = requiredString(rule.relationship, `${itemLabel}.relationship`, 80);
    if (!CHILD_RELATIONSHIPS.has(relationship)) {
      invalidDefinition(`${itemLabel}.relationship is unsupported`);
    }
    if (relationship === 'ownership_transferring') {
      invalidDefinition(`${itemLabel}.relationship is unavailable until destination acceptance is persisted`);
    }
    return Object.freeze({
      rule_key: ruleKey,
      fanout_handler: fanoutHandler,
      child_pathway_key: requiredString(
        rule.child_pathway_key,
        `${itemLabel}.child_pathway_key`,
        120,
        PATHWAY_KEY_PATTERN,
      ),
      relationship,
    });
  }));
}

function normalizeStep(step, index, registry) {
  const label = `steps[${index}]`;
  assertPlainObject(step, label);
  assertOnlyFields(step, STEP_FIELDS, label);
  const stepKey = requiredString(step.step_key, `${label}.step_key`, 120, STEP_KEY_PATTERN);
  const stepKind = requiredString(step.step_kind, `${label}.step_kind`, 40);
  if (!STEP_KIND_SET.has(stepKind)) invalidDefinition(`${label}.step_kind is unsupported`);
  const assignedRole = optionalString(step.assigned_role, `${label}.assigned_role`, 80, ROLE_PATTERN);
  if (assignedRole && !isPathwayHumanOwnerRole(assignedRole)) {
    invalidDefinition(`${label}.assigned_role must be a route-capable human clinical role`);
  }
  const conditionHandler = normalizeHandlerId(
    step.condition_handler,
    `${label}.condition_handler`,
    registry.resolveCondition,
    stepKind,
  );
  const actionHandler = normalizeHandlerId(
    step.action_handler,
    `${label}.action_handler`,
    registry.resolveAction,
    stepKind,
  );
  const exceptionTransitions = normalizeExceptionTransitions(
    step.exception_transitions,
    `${label}.exception_transitions`,
  );
  if (exceptionTransitions.length > 0 && !conditionHandler) {
    invalidDefinition(`${label}.exception_transitions requires condition_handler`);
  }
  if (conditionHandler) {
    const registeredDecisions = new Set(registry.resolveCondition(conditionHandler).decisionCodes);
    for (const transition of exceptionTransitions) {
      if (!registeredDecisions.has(transition.decision_code)) {
        invalidDefinition(
          `${label}.exception_transitions decision ${transition.decision_code} is not registered`,
        );
      }
    }
  }
  const childRules = normalizeChildRules(step.child_rules, `${label}.child_rules`, registry, stepKind);

  if (actionHandler && !['automation', 'ai_call'].includes(stepKind)) {
    invalidDefinition(`${label}.action_handler is supported only for automation or ai_call steps`);
  }
  if (childRules.length > 0 && stepKind !== 'subworkflow') {
    invalidDefinition(`${label}.child_rules is supported only for subworkflow steps`);
  }

  if (stepKind === 'automation' && !actionHandler) {
    invalidDefinition(`${label}.action_handler is required for automation steps`);
  }
  if (stepKind === 'wait' && !conditionHandler) {
    invalidDefinition(`${label}.condition_handler is required for wait steps`);
  }
  if (stepKind === 'subworkflow' && childRules.length === 0) {
    invalidDefinition(`${label}.child_rules is required for subworkflow steps`);
  }
  if (stepKind === 'ai_call' && !actionHandler) {
    invalidDefinition(`${label}.action_handler is required for ai_call steps`);
  }

  const workSemantics = normalizeWorkSemantics(
    step.work_semantics,
    stepKind,
    `${label}.work_semantics`,
  );
  if (
    ['task', 'approval'].includes(stepKind)
    && workSemantics.sla_completion_semantics === 'domain_evidence'
    && !conditionHandler
  ) {
    invalidDefinition(`${label}.condition_handler is required for domain_evidence task completion`);
  }
  const dueAt = normalizeTimestamp(step.due_at, `${label}.due_at`);
  if (dueAt && ['task', 'approval'].includes(stepKind)) {
    invalidDefinition(`${label}.due_at is not supported for task or approval steps; use the SLA rule`);
  }

  return Object.freeze({
    step_key: stepKey,
    step_kind: stepKind,
    display_name: optionalString(step.display_name, `${label}.display_name`, 255),
    assigned_role: assignedRole,
    due_at: dueAt,
    metadata: step.metadata === null || step.metadata === undefined
      ? Object.freeze({})
      : cloneJson(step.metadata, `${label}.metadata`),
    condition_handler: conditionHandler,
    action_handler: actionHandler,
    exception_transitions: exceptionTransitions,
    child_rules: childRules,
    work_semantics: workSemantics,
  });
}

function assertStaticIntentBudget(steps) {
  let deterministicChainCost = 0;
  let reservesChildFanout = false;
  for (const step of steps) {
    const autoCompletes = (
      step.step_kind === 'wait'
      || ['automation', 'ai_call'].includes(step.step_kind)
      || (
        step.step_kind === 'subworkflow'
        && !step.child_rules.some((rule) => rule.relationship === 'blocking')
      )
    );
    if (!autoCompletes) {
      deterministicChainCost = 0;
      reservesChildFanout = false;
      continue;
    }
    deterministicChainCost += 3 + (step.action_handler ? 1 : 0);
    if (step.step_kind === 'subworkflow' && step.child_rules.length > 0) {
      reservesChildFanout = true;
    }
    const childFanoutReserve = reservesChildFanout
      ? WORKFLOW_RUNTIME_LIMITS.maxChildrenPerCommand
      : 0;
    if (3 + deterministicChainCost + childFanoutReserve > MAX_TRANSITION_INTENTS_PER_COMMAND) {
      invalidDefinition(
        `definition deterministic auto-chain exceeds ${MAX_TRANSITION_INTENTS_PER_COMMAND} transition intents`,
      );
    }
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function checksumCompiledWorkflowDefinition(compiled) {
  return createHash('sha256').update(stableJson({
    workflow_key: compiled.workflow_key,
    version: compiled.version,
    registry_version: compiled.registry_version,
    steps: compiled.steps,
    defaults: compiled.defaults,
    triggers: compiled.triggers,
  })).digest('hex');
}

export function compileWorkflowDefinition(definition, {
  registry = workflowRuntimeRegistry,
} = {}) {
  assertWorkflowJsonBudget(definition, {
    label: 'definition',
    onViolation: ({ kind, message }) => invalidDefinition(message, { json_violation: kind }),
  });
  assertPlainObject(definition, 'definition');
  assertOnlyFields(definition, DEFINITION_FIELDS, 'definition');
  if (!isWorkflowRuntimeRegistry(registry)) {
    invalidDefinition('registry is not a workflow runtime registry');
  }
  const workflowKey = requiredString(
    definition.workflow_key,
    'definition.workflow_key',
    120,
    PATHWAY_KEY_PATTERN,
  );
  const version = positiveInteger(definition.version, 'definition.version', 1);
  if (!Array.isArray(definition.steps) || definition.steps.length === 0) {
    invalidDefinition('definition.steps must be a non-empty array');
  }
  if (definition.steps.length > MAX_DEFINITION_STEPS) {
    invalidDefinition(`definition.steps must contain at most ${MAX_DEFINITION_STEPS} entries`);
  }
  const seen = new Set();
  const steps = Object.freeze(definition.steps.map((step, index) => {
    const normalized = normalizeStep(step, index, registry);
    if (seen.has(normalized.step_key)) {
      invalidDefinition(`definition.steps repeats step_key ${normalized.step_key}`);
    }
    seen.add(normalized.step_key);
    return normalized;
  }));
  const indexes = new Map(steps.map((step, index) => [step.step_key, index]));
  for (const [index, step] of steps.entries()) {
    for (const transition of step.exception_transitions) {
      const targetIndex = indexes.get(transition.target_step_key);
      if (targetIndex === undefined) {
        invalidDefinition(
          `steps[${index}].exception_transitions targets an unknown step ${transition.target_step_key}`,
        );
      }
      if (targetIndex <= index) {
        invalidDefinition(
          `steps[${index}].exception_transitions must target a later step`,
        );
      }
    }
  }
  assertStaticIntentBudget(steps);
  const triggers = definition.triggers ?? [];
  if (!Array.isArray(triggers)) invalidDefinition('definition.triggers must be an array');
  if (triggers.length > 0) {
    invalidDefinition('definition.triggers are unavailable until registered trigger handlers exist');
  }
  const defaults = definition.defaults === null || definition.defaults === undefined
    ? Object.freeze({})
    : cloneJson(definition.defaults, 'definition.defaults');
  const compiled = {
    workflow_key: workflowKey,
    version,
    registry_version: registry.version,
    steps,
    triggers: Object.freeze([]),
    defaults,
  };
  compiled.checksum = checksumCompiledWorkflowDefinition(compiled);
  return Object.freeze(compiled);
}

export default compileWorkflowDefinition;
