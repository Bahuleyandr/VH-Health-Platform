/**
 * Generic Tasks / Workflow / Approval / SLA / Automation service (Phase B2).
 *
 * Backs the nine tables added in migration 118:
 *   - workflow_definitions
 *   - workflow_runs / workflow_steps
 *   - tasks / task_comments
 *   - approvals
 *   - escalation_rules
 *   - sla_definitions
 *   - automation_rules
 *
 * The clinical-AI workflow runner (clinical_ai_workflow_runs) is a
 * peer, not a parent. This service owns staff-facing follow-ups,
 * non-AI approvals, generic SLA tracking. Workflow runs created here
 * can spawn AI sub-tasks via step_kind='ai_call', linking back to
 * clinical_ai_workflow_runs by foreign key in the step's outcome_payload.
 *
 * Decision-support only: no auto-resolve, no auto-billing. Escalation
 * rules + automation rules write rows; admins approve / dispatch them.
 */

import { createHash } from 'node:crypto';

import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { isAdmin } from '../../utils/roleHelpers.js';
import { isValidIdempotencyKey } from '../idempotency/idempotencyService.js';
import { roleCanBreakGlass } from '../security/breakGlassService.js';
import { requireTenantId } from '../tenant/tenantService.js';
import {
  WORKFLOW_STEP_KINDS,
  validateWorkflowDefinitionSteps,
} from './workflowDefinitionContract.js';
import { assertWorkflowJsonBudget } from './workflowJsonGuard.js';
import {
  isTaskHumanOwnerRole,
  resolveCurrentHumanActorTx,
} from './workflowHumanOwnerService.js';

export { WORKFLOW_STEP_KINDS };

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const TEXT_MAX = 8000;
const SHORT_MAX = 255;
const HANDLER_ID_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*\.v[1-9][0-9]*$/;

export const TASK_KINDS = [
  'general',
  'follow_up',
  'review',
  'pathway_owner_transfer_review',
  'escalation',
  'verification',
  'admin',
  'consent',
  'investigation',
  'other',
];
export const TASK_PRIORITIES = ['low', 'normal', 'high', 'critical'];
export const TASK_STATUSES = ['open', 'in_progress', 'blocked', 'completed', 'cancelled', 'overdue'];
export const TASK_SLA_COMPLETION_SEMANTICS = ['none', 'acknowledgement', 'domain_evidence'];
export const TASK_COMMENT_KINDS = ['comment', 'system_event', 'state_change'];
export const LAB_CRITICAL_ALERT_ACK_CONTRACT_VERSION = 2;
export const WORKFLOW_TRIGGER_KINDS = ['manual', 'event', 'schedule', 'api', 'subgraph'];
export const WORKFLOW_STATUSES = ['started', 'running', 'blocked', 'completed', 'cancelled', 'failed'];
export const WORKFLOW_STEP_STATUSES = ['pending', 'in_progress', 'blocked', 'completed', 'skipped', 'failed'];
export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'cancelled', 'expired'];
export const ESCALATION_SCOPES = ['task', 'workflow_step', 'approval'];
export const ESCALATION_TRIGGERS = ['sla_breach', 'no_progress_after', 'pending_too_long', 'on_status_change'];
export const ESCALATION_ACTIONS = ['notify', 'reassign', 'escalate_priority', 'auto_resolve', 'webhook'];
export const AUTOMATION_ACTIONS = ['create_task', 'start_workflow', 'create_approval', 'webhook', 'notify'];

const DOMAIN_EVIDENCE_COMPLETION_AUTHORITY = Symbol('DOMAIN_EVIDENCE_COMPLETION_AUTHORITY');
const TASK_SLA_SOURCE_BINDING_AUTHORITY = Symbol('TASK_SLA_SOURCE_BINDING_AUTHORITY');
const ACKNOWLEDGEMENT_TRANSITION_AUTHORITY = Symbol('ACKNOWLEDGEMENT_TRANSITION_AUTHORITY');
const LAB_CRITICAL_ALERT_ACKNOWLEDGEMENT_AUTHORITY = Symbol(
  'LAB_CRITICAL_ALERT_ACKNOWLEDGEMENT_AUTHORITY',
);
const COVERING_TRANSFER_TASK_AUTHORITY = Symbol('COVERING_TRANSFER_TASK_AUTHORITY');

const GENERIC_RUNTIME_DENIED_APPROVAL_KINDS = new Set([
  'care_pathway_definition_governance',
  'credential_privilege_grant',
]);
const COVERING_TRANSFER_TASK_CONTRACT = 'covering_clinician_transfer_review_v1';

const TASK_TRANSITIONS = {
  open: ['in_progress', 'blocked', 'completed', 'cancelled'],
  in_progress: ['blocked', 'completed', 'cancelled'],
  blocked: ['in_progress', 'cancelled'],
  completed: [],
  cancelled: [],
  overdue: ['in_progress', 'completed', 'cancelled'],
};

const WORKFLOW_RUN_TRANSITIONS = {
  started: ['running', 'cancelled', 'failed'],
  running: ['blocked', 'completed', 'cancelled', 'failed'],
  blocked: ['running', 'cancelled', 'failed'],
  completed: [],
  cancelled: [],
  failed: [],
};

const WORKFLOW_STEP_TRANSITIONS = {
  pending: ['in_progress', 'blocked', 'skipped', 'failed'],
  in_progress: ['blocked', 'completed', 'skipped', 'failed'],
  blocked: ['in_progress', 'skipped', 'failed'],
  completed: [],
  skipped: [],
  failed: [],
};

function resolveTenantId(options = {}) {
  return requireTenantId(options.tenantId);
}

function isMissingSchemaError(err) {
  return /does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

function isFkViolation(err) {
  return /foreign key constraint/i.test(String(err?.message || ''));
}

function safeText(value, max = TEXT_MAX) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return max ? text.slice(0, max) : text;
}

function normalizeId(value, label = 'id') {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw AppError.badRequest(`${label} must be a positive integer`);
  }
  return parsed;
}

function maybeUuid(value, label = 'uid') {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw AppError.badRequest(`${label} must be a UUID`);
  }
  return text;
}

function normalizeTaskAssignment({ assignedToUid = null, assignedToRole = null } = {}) {
  const uid = maybeUuid(assignedToUid, 'assigned_to_uid');
  const role = safeText(assignedToRole, 80);
  if (uid && role) {
    throw AppError.badRequest(
      'Task cannot be assigned to both a user and a role',
      'TASK_ASSIGNMENT_AMBIGUOUS',
    );
  }
  return { uid, role };
}

function requireActorUid(value, label = 'actor_uid') {
  const uid = maybeUuid(value, label);
  if (!uid) throw AppError.unauthorized('Authenticated actor is required');
  return uid;
}

function assertGenericApprovalKindAllowed(value) {
  const normalizedKind = String(value || '').trim().toLowerCase();
  if (GENERIC_RUNTIME_DENIED_APPROVAL_KINDS.has(normalizedKind)) {
    throw AppError.conflict(
      'Approval must be managed through its owning domain workflow',
      'DOMAIN_OWNED_APPROVAL_KIND',
    );
  }
}

function normalizeLimit(value, fallback = DEFAULT_LIST_LIMIT, max = MAX_LIST_LIMIT) {
  return Math.min(Math.max(Number.parseInt(value, 10) || fallback, 1), max);
}

function normalizeJsonObject(value, label) {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw AppError.badRequest(`${label} must be a JSON object`);
  }
  return value;
}

const RESERVED_TASK_METADATA_KEYS = new Set([
  'workflow_sla_instance_id',
  'sla_completion_semantics',
  'stage_occurrence_key',
  // Legacy task/SLA links were stored here. The typed column is authoritative;
  // accepting this key would recreate an ambiguous second contract.
  'sla_instance_id',
]);

function normalizeTaskMetadata(value) {
  const metadata = normalizeJsonObject(value, 'metadata');
  const reservedKey = Object.keys(metadata).find((key) => RESERVED_TASK_METADATA_KEYS.has(key));
  if (reservedKey) {
    throw AppError.badRequest(
      `metadata.${reservedKey} is reserved; use the typed task/SLA fields`,
      'TASK_METADATA_KEY_RESERVED',
    );
  }
  return metadata;
}

function normalizeJsonArray(value, label) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    throw AppError.badRequest(`${label} must be a JSON array`);
  }
  return value;
}

function normalizeEnum(value, allowed, label, { required = false } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw AppError.badRequest(`${label} is required`);
    return null;
  }
  const text = String(value).trim();
  if (!allowed.includes(text)) {
    throw AppError.badRequest(`${label} must be one of: ${allowed.join(', ')}`);
  }
  return text;
}

function normalizeBoolean(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1) return true;
  if (value === 'false' || value === 0) return false;
  return Boolean(value);
}

function normalizeInt(value, label, { min = null, max = null } = {}) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw AppError.badRequest(`${label} must be an integer`);
  if (min !== null && parsed < min) throw AppError.badRequest(`${label} must be >= ${min}`);
  if (max !== null && parsed > max) throw AppError.badRequest(`${label} must be <= ${max}`);
  return parsed;
}

function normalizeTimestamp(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date
    ? value
    : (typeof value === 'number' ? new Date(value) : new Date(String(value)));
  if (Number.isNaN(date.getTime())) throw AppError.badRequest(`${label} must be a valid timestamp`);
  // The driver-adapter raw path can reinterpret Date/string timestamp
  // parameters in the process timezone. Bind epoch milliseconds and convert
  // inside PostgreSQL so the stored timestamptz preserves the caller's instant.
  return date.getTime();
}

function parseDurableTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeStrictPositiveId(value, label) {
  const text = typeof value === 'number'
    ? (Number.isSafeInteger(value) ? String(value) : '')
    : (typeof value === 'bigint' ? value.toString() : value);
  if (typeof text !== 'string' || !/^[1-9]\d*$/.test(text)) {
    throw AppError.badRequest(
      `${label} must be a canonical positive integer`,
      'PATHWAY_TASK_CONTEXT_INVALID',
    );
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) {
    throw AppError.badRequest(
      `${label} exceeds the supported integer range`,
      'PATHWAY_TASK_CONTEXT_INVALID',
    );
  }
  return parsed;
}

function requireCanonicalHandlerId(value) {
  if (
    typeof value !== 'string'
    || value.length > 120
    || value.trim() !== value
    || !HANDLER_ID_PATTERN.test(value)
  ) {
    throw AppError.badRequest(
      'condition_handler must be a versioned canonical handler id',
      'PATHWAY_HANDLER_CONTRACT_INVALID',
    );
  }
  return value;
}

function cloneBudgetedWorkflowJson(value, label, code) {
  assertWorkflowJsonBudget(value, {
    label,
    onViolation: ({ kind, message }) => {
      throw AppError.badRequest(message, code, { field: label, violation: kind });
    },
  });
  return JSON.parse(JSON.stringify(value));
}

async function normalizePathwayEvidenceProvenance(actor, signal) {
  const cleanActor = cloneBudgetedWorkflowJson(
    normalizeJsonObject(actor, 'actor'),
    'actor',
    'PATHWAY_EVIDENCE_PROVENANCE_INVALID',
  );
  const cleanSignal = cloneBudgetedWorkflowJson(
    normalizeJsonObject(signal, 'signal'),
    'signal',
    'PATHWAY_EVIDENCE_PROVENANCE_INVALID',
  );
  const signalKind = typeof cleanSignal.kind === 'string' && cleanSignal.kind.trim() === cleanSignal.kind
    ? safeText(cleanSignal.kind, 120)
    : null;
  if (!signalKind) {
    throw AppError.badRequest(
      'Pathway evidence signal kind is required',
      'PATHWAY_EVIDENCE_PROVENANCE_INVALID',
    );
  }

  if (cleanActor.kind === 'user') {
    const uid = maybeUuid(cleanActor.uid, 'actor.uid');
    const authorizationMode = typeof cleanActor.authorizationMode === 'string'
      && cleanActor.authorizationMode.trim() === cleanActor.authorizationMode
      ? safeText(cleanActor.authorizationMode, 80)
      : null;
    if (!uid || !authorizationMode) {
      throw AppError.badRequest(
        'Normalized user evidence provenance is required',
        'PATHWAY_EVIDENCE_PROVENANCE_INVALID',
      );
    }
    return Object.freeze({
      actor_kind: 'user',
      actor_uid: uid,
      authorization_mode: authorizationMode,
      override_reason: cleanActor.overrideReason == null
        ? null
        : safeText(cleanActor.overrideReason, 2000),
      break_glass_id: cleanActor.breakGlassId == null
        ? null
        : normalizeStrictPositiveId(cleanActor.breakGlassId, 'actor.breakGlassId'),
      signal_kind: signalKind,
      source_resource_type: cleanSignal.source_resource_type || null,
      source_resource_id: cleanSignal.source_resource_id || null,
      occurred_at: cleanSignal.occurred_at || null,
    });
  }

  if (cleanActor.kind === 'system') {
    const { isRegisteredWorkflowSystemActor } = await import('./workflowRuntimeRegistry.js');
    if (!isRegisteredWorkflowSystemActor(actor)) {
      throw AppError.forbidden(
        'Pathway evidence system actor is not sealed',
        'PATHWAY_EVIDENCE_PROVENANCE_INVALID',
      );
    }
    const signalContext = cleanActor.signalContext;
    const systemKey = requireCanonicalHandlerId(cleanActor.systemKey);
    const sourceEventId = String(cleanActor.sourceEventId ?? '');
    const causationId = cleanActor.causationId == null ? null : String(cleanActor.causationId);
    if (
      !/^\d+$/.test(sourceEventId)
      || sourceEventId.length > 19
      || (causationId !== null && (
        !causationId
        || causationId.trim() !== causationId
        || causationId.length > 160
      ))
      || !signalContext
      || cleanSignal.source_resource_type !== signalContext.sourceResourceType
      || cleanSignal.source_resource_id !== signalContext.sourceResourceId
      || cleanSignal.occurred_at !== signalContext.occurredAt
    ) {
      throw AppError.badRequest(
        'Normalized system evidence provenance does not match its sealed signal context',
        'PATHWAY_EVIDENCE_PROVENANCE_INVALID',
      );
    }
    return Object.freeze({
      actor_kind: 'system',
      system_key: systemKey,
      source_event_id: sourceEventId,
      causation_id: causationId,
      signal_kind: signalKind,
      source_resource_type: signalContext.sourceResourceType,
      source_resource_id: signalContext.sourceResourceId,
      occurred_at: signalContext.occurredAt,
    });
  }

  throw AppError.badRequest(
    'Pathway evidence actor kind must be user or sealed system',
    'PATHWAY_EVIDENCE_PROVENANCE_INVALID',
  );
}

async function hasPathwayExecutorAuthority(candidate) {
  if (!candidate || typeof candidate !== 'object') return false;
  const { isPathwayExecutorCapability } = await import('../pathways/pathwayExecutorService.js');
  return typeof isPathwayExecutorCapability === 'function'
    && isPathwayExecutorCapability(candidate) === true;
}

async function assertPathwayExecutorAuthority({
  tenantId,
  workflowRunId,
  db,
  executorAuthority = null,
  verifiedExecutorAuthority = null,
}) {
  const verified = verifiedExecutorAuthority === null
    ? await hasPathwayExecutorAuthority(executorAuthority)
    : verifiedExecutorAuthority === true;
  if (!workflowRunId || verified) return verified;
  const rows = await db.$queryRawUnsafe(
    `SELECT 1
       FROM care_pathway_instances
      WHERE tenant_id = $1::uuid
        AND workflow_run_id = $2::bigint
      LIMIT 1`,
    tenantId,
    workflowRunId,
  );
  if (rows[0]) {
    throw AppError.conflict(
      'Pathway-bound workflow mutations must use the pathway executor',
      'PATHWAY_EXECUTOR_REQUIRED',
    );
  }
  return false;
}

async function taskWorkflowRunId({ tenantId, taskId, db }) {
  if (!taskId) return null;
  const rows = await db.$queryRawUnsafe(
    `SELECT COALESCE(task.workflow_run_id, step.workflow_run_id) AS workflow_run_id
       FROM tasks task
       LEFT JOIN workflow_steps step
         ON step.tenant_id = task.tenant_id
        AND step.id = task.workflow_step_id
      WHERE task.tenant_id = $1::uuid
        AND task.id = $2::bigint
      LIMIT 1`,
    tenantId,
    taskId,
  );
  return rows[0]?.workflow_run_id || null;
}

async function stepWorkflowRunId({ tenantId, workflowStepId, db }) {
  if (!workflowStepId) return null;
  const rows = await db.$queryRawUnsafe(
    `SELECT workflow_run_id
       FROM workflow_steps
      WHERE tenant_id = $1::uuid
        AND id = $2::bigint
      LIMIT 1`,
    tenantId,
    workflowStepId,
  );
  return rows[0]?.workflow_run_id || null;
}

async function taskRowWorkflowRunId({ tenantId, taskRow, db }) {
  if (!taskRow) return null;
  return taskRow.workflow_run_id || stepWorkflowRunId({
    tenantId,
    workflowStepId: taskRow.workflow_step_id,
    db,
  });
}

async function assertTaskSlaSourceBinding({
  tenantId,
  taskRow,
  db,
}) {
  const slaInstanceId = taskRow?.workflow_sla_instance_id;
  if (!slaInstanceId) return null;
  const rows = await db.$queryRawUnsafe(
    `SELECT sla.id, sla.rule_code, sla.source_table, sla.source_id, sla.due_at,
            sla.status, sla.completed_at
       FROM workflow_sla_instances sla
      WHERE sla.tenant_id = $1::uuid
        AND sla.id = $2::uuid
      LIMIT 1
      FOR SHARE`,
    tenantId,
    slaInstanceId,
  );
  const sla = rows[0];
  const taskResourceType = taskRow.related_resource_type == null
    ? null
    : String(taskRow.related_resource_type);
  const taskResourceId = taskRow.related_resource_id == null
    ? null
    : String(taskRow.related_resource_id);
  const sourceTable = sla?.source_table == null ? null : String(sla.source_table);
  const sourceId = sla?.source_id == null ? null : String(sla.source_id);
  const workflowStepId = taskRow.workflow_step_id == null
    ? null
    : String(taskRow.workflow_step_id);

  let valid = false;
  if (sla && workflowStepId) {
    valid = sourceTable === 'workflow_steps' && sourceId === workflowStepId;
  } else if (sla && ['critical_result_ack', 'cold_chain_excursion_ack'].includes(sla.rule_code)) {
    valid = taskRow.sla_completion_semantics === 'acknowledgement'
      && Boolean(taskResourceType && taskResourceId)
      && sourceTable === taskResourceType
      && sourceId === taskResourceId;
  } else if (sla?.rule_code === 'mortuary_unclaimed_body') {
    valid = taskRow.sla_completion_semantics === 'domain_evidence'
      && taskResourceType === 'death_record'
      && Boolean(taskResourceId)
      && sourceTable === 'death_records'
      && sourceId === taskResourceId;
    if (valid) {
      const deathRecord = await db.$queryRawUnsafe(
        `SELECT 1
           FROM death_records
          WHERE tenant_id = $1::uuid
            AND id::text = $2::text
          LIMIT 1`,
        tenantId,
        taskResourceId,
      );
      valid = Boolean(deathRecord[0]);
    }
  }

  if (!valid) {
    throw AppError.conflict(
      'Task and linked SLA source do not describe the same obligation',
      'TASK_SLA_SOURCE_BINDING_INVALID',
    );
  }
  return sla;
}

async function completeLinkedSla({
  tenantId,
  taskRow,
  db = null,
  completedBy = null,
  completionTrigger,
  completedAt = null,
  evidence = null,
  ackContractVersion = null,
  strict = false,
}) {
  const slaInstanceId = taskRow?.workflow_sla_instance_id;
  if (!slaInstanceId) return null;
  const semantics = taskRow?.sla_completion_semantics || 'none';
  const triggerAllowed = (
    semantics === 'acknowledgement'
      && (completionTrigger === 'acknowledgement' || completionTrigger === 'task_completion')
  ) || (semantics === 'domain_evidence' && completionTrigger === 'domain_evidence');
  if (!triggerAllowed) return null;
  const completionMarker = completionTrigger === 'acknowledgement' ? 'task_ack' : completionTrigger;
  const completionInstant = completionTrigger === 'acknowledgement'
    ? (parseDurableTimestamp(completedAt) || parseDurableTimestamp(taskRow?.metadata?.acknowledged_at))
    : (parseDurableTimestamp(completedAt) || new Date());
  if (!completionInstant) {
    throw AppError.conflict(
      'A durable acknowledgement receipt is required to complete the linked SLA',
      'TASK_ACKNOWLEDGEMENT_RECEIPT_REQUIRED',
    );
  }
  const client = db || prisma;
  try {
    const rows = await client.$queryRawUnsafe(
      `UPDATE workflow_sla_instances
              SET status = CASE
                WHEN due_at IS NOT NULL AND to_timestamp($7::double precision / 1000.0) > due_at
                  THEN CASE WHEN status = 'escalated' THEN 'escalated' ELSE 'breached' END
                ELSE 'completed'
              END,
              completed_at = to_timestamp($7::double precision / 1000.0),
              breached_at = CASE
                WHEN due_at IS NOT NULL AND to_timestamp($7::double precision / 1000.0) > due_at THEN due_at
                ELSE NULL
              END,
              metadata = COALESCE(metadata, '{}'::jsonb)
                || jsonb_build_object(
                     'completed_via', $4::text,
                     'completed_by_task', $1::int
                   )
                || CASE WHEN $5::text IS NOT NULL
                        THEN jsonb_build_object('completed_by', $5::text)
                        ELSE '{}'::jsonb END
                 || CASE WHEN $6::jsonb IS NOT NULL
                         THEN jsonb_build_object('completion_evidence', $6::jsonb)
                         ELSE '{}'::jsonb END
                 || CASE WHEN $8::int IS NOT NULL
                         THEN jsonb_build_object('ack_contract_version', $8::int)
                         ELSE '{}'::jsonb END,
              updated_at = NOW()
        WHERE id = $2::uuid
          AND tenant_id = $3::uuid
          AND status NOT IN ('completed', 'cancelled')
          AND completed_at IS NULL
        RETURNING id, status, completed_at`,
      taskRow.id,
      String(slaInstanceId),
      tenantId,
      completionMarker,
      completedBy ? String(completedBy) : null,
      evidence ? JSON.stringify(evidence) : null,
      completionInstant.getTime(),
      ackContractVersion,
    );
    return rows[0] || null;
  } catch (err) {
    if (strict) throw err;
    if (isMissingSchemaError(err)) return null;
    logger.warn('completeLinkedSla: SLA completion failed', {
      taskId: taskRow?.id, slaInstanceId, err: err?.message,
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

const TASK_RETURNING = `id, tenant_id, workflow_run_id, workflow_step_id, parent_task_id,
  task_kind, title, description, patient_uid, encounter_id,
  related_resource_type, related_resource_id,
  priority, status, assigned_to_uid, assigned_to_role, created_by,
  due_at, completed_at, cancelled_at, cancellation_reason,
  sla_definition_id, sla_breached_at,
  workflow_sla_instance_id, sla_completion_semantics, stage_occurrence_key,
  metadata, created_at, updated_at`;

export async function createTask({
  tenantId = null,
  workflowRunId = null,
  workflowStepId = null,
  parentTaskId = null,
  taskKind = 'general',
  title,
  description = null,
  patientUid = null,
  encounterId = null,
  relatedResourceType = null,
  relatedResourceId = null,
  priority = 'normal',
  assignedToUid = null,
  assignedToRole = null,
  createdBy = null,
  dueAt = null,
  slaDefinitionId = null,
  workflowSlaInstanceId = null,
  slaCompletionSemantics = 'none',
  stageOccurrenceKey = null,
  metadata = null,
  executorAuthority = null,
  // Optional transaction client (e.g. a setTenantTx tx) — defaults to the
  // singleton. Lets the results-inbox producer create a task inside the same
  // tenant-scoped transaction as its SLA-instance link.
  tx = null,
  // When true, append `ON CONFLICT … DO NOTHING` inferring the partial unique
  // index `uq_task_open_per_resource` (expanded by migration 580). Makes the producer's
  // "one open task per result resource" insert race-safe: a concurrent insert
  // for the same (tenant, related_resource_type, related_resource_id) while an
  // open/in_progress/blocked/overdue task already exists is a no-op (RETURNING yields
  // no row → this returns undefined).
  onConflictResourceDoNothing = false,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanTitle = safeText(title, 500);
  if (!cleanTitle) throw AppError.badRequest('title is required');
  const db = tx || prisma;
  const cleanWorkflowRunId = workflowRunId ? normalizeId(workflowRunId, 'workflow_run_id') : null;
  const cleanWorkflowStepId = workflowStepId ? normalizeId(workflowStepId, 'workflow_step_id') : null;
  const cleanParentTaskId = parentTaskId ? normalizeId(parentTaskId, 'parent_task_id') : null;
  const cleanRelatedResourceType = safeText(relatedResourceType, 60);
  const cleanRelatedResourceId = safeText(relatedResourceId, 120);
  const assignment = normalizeTaskAssignment({ assignedToUid, assignedToRole });
  const cleanWorkflowSlaInstanceId = maybeUuid(workflowSlaInstanceId, 'workflow_sla_instance_id');
  const cleanSlaCompletionSemantics = normalizeEnum(
    slaCompletionSemantics,
    TASK_SLA_COMPLETION_SEMANTICS,
    'sla_completion_semantics',
  ) || 'none';
  if (Boolean(cleanWorkflowSlaInstanceId) !== (cleanSlaCompletionSemantics !== 'none')) {
    throw AppError.badRequest(
      'workflow_sla_instance_id and a non-none sla_completion_semantics must be supplied together',
      'TASK_SLA_CONTRACT_INVALID',
    );
  }
  const cleanStageOccurrenceKey = safeText(stageOccurrenceKey, 200);
  const cleanMetadata = normalizeTaskMetadata(metadata);
  const verifiedExecutorAuthority = await hasPathwayExecutorAuthority(executorAuthority);
  await assertPathwayExecutorAuthority({
    tenantId: tid,
    workflowRunId: cleanWorkflowRunId,
    db,
    executorAuthority,
    verifiedExecutorAuthority,
  });
  if (!verifiedExecutorAuthority) {
    const attachedStepRunId = await stepWorkflowRunId({
      tenantId: tid,
      workflowStepId: cleanWorkflowStepId,
      db,
    });
    if (attachedStepRunId && String(attachedStepRunId) !== String(cleanWorkflowRunId || '')) {
      await assertPathwayExecutorAuthority({
        tenantId: tid,
        workflowRunId: attachedStepRunId,
        db,
        executorAuthority,
      });
    }
    const parentRunId = await taskWorkflowRunId({ tenantId: tid, taskId: cleanParentTaskId, db });
    if (parentRunId && String(parentRunId) !== String(cleanWorkflowRunId || '')) {
      await assertPathwayExecutorAuthority({
        tenantId: tid,
        workflowRunId: parentRunId,
        db,
        executorAuthority,
      });
    }
  }
  const linkedSla = await assertTaskSlaSourceBinding({
    tenantId: tid,
    taskRow: {
      workflow_sla_instance_id: cleanWorkflowSlaInstanceId,
      sla_completion_semantics: cleanSlaCompletionSemantics,
      workflow_step_id: cleanWorkflowStepId,
      related_resource_type: cleanRelatedResourceType,
      related_resource_id: cleanRelatedResourceId,
    },
    db,
  });
  const suppliedDueAt = normalizeTimestamp(dueAt, 'due_at');
  let taskDueAt = suppliedDueAt;
  if (cleanWorkflowSlaInstanceId) {
    const linkedSlaDueAt = normalizeTimestamp(linkedSla?.due_at, 'linked SLA due_at');
    if (linkedSlaDueAt === null) {
      throw AppError.conflict(
        'Typed task SLA must have a due_at deadline',
        'TASK_SLA_DUE_AT_MISSING',
      );
    }
    if (suppliedDueAt !== null) {
      throw AppError.badRequest(
        'Typed task due_at is derived from the linked SLA and must not be supplied',
        'TASK_SLA_DUE_AT_DERIVED',
      );
    }
    // The INSERT selects this deadline from workflow_sla_instances directly.
    // A JS Date cannot carry PostgreSQL's microseconds, so round-tripping the
    // selected value through Prisma would violate the exact DB invariant.
    taskDueAt = null;
  }

  // Infer the partial unique index by its column list + predicate (Postgres
  // resolves a partial unique index from a matching ON CONFLICT predicate; the
  // index is not a named constraint so it cannot be targeted by name).
  const conflictClause = onConflictResourceDoNothing
    ? `ON CONFLICT (tenant_id, related_resource_type, related_resource_id)
         WHERE status IN ('open', 'in_progress', 'blocked', 'overdue')
           AND related_resource_type IS NOT NULL
           AND related_resource_id IS NOT NULL
       DO NOTHING`
    : '';

  try {
    const rows = await db.$queryRawUnsafe(
      `INSERT INTO tasks
         (tenant_id, workflow_run_id, workflow_step_id, parent_task_id,
          task_kind, title, description,
          patient_uid, encounter_id, related_resource_type, related_resource_id,
          priority, status,
          assigned_to_uid, assigned_to_role, created_by,
          due_at, sla_definition_id,
          workflow_sla_instance_id, sla_completion_semantics, stage_occurrence_key,
          metadata)
       VALUES ($1::uuid, $2, $3, $4,
         $5, $6, $7,
         $8::uuid, $9, $10, $11,
         $12, 'open',
         $13::uuid, $14, $15::uuid,
         CASE WHEN $18::uuid IS NULL
              THEN to_timestamp($16::double precision / 1000.0)
              ELSE (
                SELECT sla.due_at
                  FROM workflow_sla_instances sla
                 WHERE sla.tenant_id = $1::uuid
                   AND sla.id = $18::uuid
              )
          END, $17,
         $18::uuid, $19, $20,
         $21::jsonb)
       ${conflictClause}
       RETURNING ${TASK_RETURNING}`,
      tid,
      cleanWorkflowRunId,
      cleanWorkflowStepId,
      cleanParentTaskId,
      normalizeEnum(taskKind, TASK_KINDS, 'task_kind') || 'general',
      cleanTitle,
      safeText(description),
      maybeUuid(patientUid, 'patient_uid'),
      encounterId ? normalizeId(encounterId, 'encounter_id') : null,
      cleanRelatedResourceType,
      cleanRelatedResourceId,
      normalizeEnum(priority, TASK_PRIORITIES, 'priority') || 'normal',
      assignment.uid,
      assignment.role,
      maybeUuid(createdBy, 'created_by'),
      taskDueAt,
      slaDefinitionId ? normalizeId(slaDefinitionId, 'sla_definition_id') : null,
      cleanWorkflowSlaInstanceId,
      cleanSlaCompletionSemantics,
      cleanStageOccurrenceKey,
      JSON.stringify(cleanMetadata),
    );
    return rows[0];
  } catch (err) {
    if (isFkViolation(err)) throw AppError.badRequest('Invalid foreign key reference');
    throw err;
  }
}

export async function listTasks({
  tenantId = null,
  status = null,
  priority = null,
  taskKind = null,
  assignedToUid = null,
  assignedToRole = null,
  patientUid = null,
  workflowRunId = null,
  overdueOnly = false,
  limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (status) {
    params.push(normalizeEnum(status, TASK_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  if (priority) {
    params.push(normalizeEnum(priority, TASK_PRIORITIES, 'priority'));
    filters.push(`priority = $${params.length}`);
  }
  if (taskKind) {
    params.push(normalizeEnum(taskKind, TASK_KINDS, 'task_kind'));
    filters.push(`task_kind = $${params.length}`);
  }
  if (assignedToUid) {
    params.push(maybeUuid(assignedToUid, 'assigned_to_uid'));
    filters.push(`assigned_to_uid = $${params.length}::uuid`);
  }
  if (assignedToRole) {
    params.push(safeText(assignedToRole, 80));
    filters.push(`assigned_to_role = $${params.length}`);
  }
  if (patientUid) {
    params.push(maybeUuid(patientUid, 'patient_uid'));
    filters.push(`patient_uid = $${params.length}::uuid`);
  }
  if (workflowRunId) {
    params.push(normalizeId(workflowRunId, 'workflow_run_id'));
    filters.push(`workflow_run_id = $${params.length}`);
  }
  if (overdueOnly) {
    filters.push(`due_at IS NOT NULL AND due_at < NOW() AND status IN ('open', 'in_progress', 'blocked')`);
  }
  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${TASK_RETURNING} FROM tasks
       WHERE ${filters.join(' AND ')}
       ORDER BY
         CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
         due_at NULLS LAST,
         created_at DESC
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    return { tasks: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { tasks: [], count: 0 };
    throw err;
  }
}

// Optional `tx` (a setTenantTx tx client) threads these through the SAME
// tenant-scoped transaction as the caller; defaults to the singleton. Used by
// the escalation engine so an auto_resolve / reassign action and its
// metadata-escalation marker commit atomically. Backward-compatible: existing
// callers pass no tx and run on the singleton exactly as before.
export async function getTask({ tenantId = null, id, tx = null } = {}) {
  const tid = resolveTenantId({ tenantId });
  const taskId = normalizeId(id, 'task id');
  const db = tx || prisma;
  const rows = await db.$queryRawUnsafe(
    `SELECT ${TASK_RETURNING} FROM tasks
     WHERE id = $1 AND tenant_id = $2::uuid LIMIT 1`,
    taskId, tid,
  );
  if (!rows[0]) throw AppError.notFound('Task not found');
  return rows[0];
}

async function getTaskForUpdate({ tenantId, id, db }) {
  const rows = await db.$queryRawUnsafe(
    `SELECT ${TASK_RETURNING} FROM tasks
      WHERE id = $1 AND tenant_id = $2::uuid
      FOR UPDATE`,
    id,
    tenantId,
  );
  if (!rows[0]) throw AppError.notFound('Task not found');
  return rows[0];
}

function isCoveringTransferReviewTask(taskRow) {
  return taskRow?.task_kind === 'pathway_owner_transfer_review'
    && taskRow?.related_resource_type === 'care_handoff_instance'
    && taskRow?.metadata?.task_contract === COVERING_TRANSFER_TASK_CONTRACT;
}

function assertGenericTaskMutationAllowed(taskRow, authority = null) {
  if (
    isCoveringTransferReviewTask(taskRow)
    && authority !== COVERING_TRANSFER_TASK_AUTHORITY
  ) {
    throw AppError.conflict(
      'Covering-transfer review tasks must use the pathway ownership workflow',
      'COVERING_TRANSFER_TASK_WORKFLOW_REQUIRED',
    );
  }
}

export async function transitionTask({
  tenantId = null, id, nextStatus,
  cancellationReason = null,
  actorUid = undefined,
  executorAuthority = null,
  domainEvidenceAuthority = null,
  slaSourceBindingAuthority = null,
  acknowledgementTransitionAuthority = null,
  coveringTransferTaskAuthority = null,
  tx = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const taskId = normalizeId(id, 'task id');
  const cleanNext = normalizeEnum(nextStatus, TASK_STATUSES, 'next_status', { required: true });
  // ADMIN HTTP callers always pass actorUid (including null when authentication
  // context is absent), which is validated here. Trusted in-process task
  // producers omit the property until S1b-b adds durable user/system events.
  if (actorUid !== undefined) requireActorUid(actorUid);
  if (!tx) {
    return setTenantTx(tid, (scopedTx) => transitionTask({
      tenantId: tid,
      id: taskId,
      nextStatus: cleanNext,
      cancellationReason,
      actorUid,
      executorAuthority,
      domainEvidenceAuthority,
      slaSourceBindingAuthority,
      acknowledgementTransitionAuthority,
      coveringTransferTaskAuthority,
      tx: scopedTx,
    }));
  }
  const db = tx;

  const current = await getTaskForUpdate({ tenantId: tid, id: taskId, db });
  assertGenericTaskMutationAllowed(current, coveringTransferTaskAuthority);
  const attachedRunId = await taskRowWorkflowRunId({ tenantId: tid, taskRow: current, db });
  await assertPathwayExecutorAuthority({
    tenantId: tid,
    workflowRunId: attachedRunId,
    db,
    executorAuthority,
  });
  if (slaSourceBindingAuthority !== TASK_SLA_SOURCE_BINDING_AUTHORITY) {
    await assertTaskSlaSourceBinding({ tenantId: tid, taskRow: current, db });
  }
  if (
    cleanNext === 'in_progress'
    && current.sla_completion_semantics === 'acknowledgement'
    && current.workflow_sla_instance_id
    && acknowledgementTransitionAuthority !== ACKNOWLEDGEMENT_TRANSITION_AUTHORITY
  ) {
    throw AppError.conflict(
      'Acknowledgement-tracked tasks must use the acknowledgement workflow',
      'TASK_ACKNOWLEDGEMENT_REQUIRED',
    );
  }
  if (
    cleanNext === 'completed'
    && current.sla_completion_semantics === 'domain_evidence'
    && domainEvidenceAuthority !== DOMAIN_EVIDENCE_COMPLETION_AUTHORITY
  ) {
    throw AppError.conflict(
      'Registered domain evidence is required to complete this task',
      'DOMAIN_EVIDENCE_REQUIRED',
    );
  }
  const allowed = TASK_TRANSITIONS[current.status] || [];
  if (!allowed.includes(cleanNext)) {
    throw AppError.invalidTransition(current.status, cleanNext, allowed);
  }
  if (
    cleanNext === 'cancelled'
    && current.sla_completion_semantics !== 'none'
    && current.workflow_sla_instance_id
  ) {
    const linkedSla = await db.$queryRawUnsafe(
      `SELECT completed_at
         FROM workflow_sla_instances
        WHERE id = $1::uuid
          AND tenant_id = $2::uuid
        FOR UPDATE`,
      current.workflow_sla_instance_id,
      tid,
    );
    if (!linkedSla[0]?.completed_at) {
      throw AppError.conflict(
        'A task with an incomplete linked SLA cannot be cancelled',
        'TASK_LINKED_SLA_INCOMPLETE',
      );
    }
  }

  const updates = ['status = $1', 'updated_at = NOW()'];
  const params = [cleanNext];
  let transitionInstant = null;
  if (cleanNext === 'completed') {
    transitionInstant = new Date();
    params.push(transitionInstant.getTime());
    updates.push(`completed_at = to_timestamp($${params.length}::double precision / 1000.0)`);
  }
  if (cleanNext === 'cancelled') {
    transitionInstant = new Date();
    params.push(transitionInstant.getTime());
    updates.push(`cancelled_at = to_timestamp($${params.length}::double precision / 1000.0)`);
    if (cancellationReason) {
      params.push(safeText(cancellationReason));
      updates.push(`cancellation_reason = $${params.length}`);
    }
  }
  params.push(taskId);
  params.push(tid);
  params.push(current.status);

  const rows = await db.$queryRawUnsafe(
    `UPDATE tasks SET ${updates.join(', ')}
     WHERE id = $${params.length - 2}
       AND tenant_id = $${params.length - 1}::uuid
       AND status = $${params.length}
     RETURNING ${TASK_RETURNING}`,
    ...params,
  );
  if (!rows[0]) {
    await getTask({ tenantId: tid, id: taskId, tx });
    throw AppError.conflict('Task status changed before transition completed', 'TASK_TRANSITION_CONFLICT');
  }

  // A direct completion closes only an acknowledgement-semantics SLA.
  // Cancellation is work withdrawal, never evidence that the obligation was met.
  if (cleanNext === 'completed') {
    await completeLinkedSla({
      tenantId: tid,
      taskRow: rows[0],
      db,
      completionTrigger: 'task_completion',
      completedAt: transitionInstant,
      completedBy: actorUid,
      strict: true,
    });
  }
  return rows[0];
}

/**
 * Narrow in-process bridge for corrected-result supersession. The private
 * capability never leaves this module, so generic routes and caller-supplied
 * objects cannot manufacture supersession or the blocked -> in_progress edge.
 */
export async function supersedeAcknowledgementTaskFromTrustedWorkflow({
  tenantId = null,
  id,
  relatedResourceType,
  relatedResourceId,
  workflowSlaInstanceId,
  supersededByActorUid,
  tx = null,
} = {}) {
  if (!tx) {
    throw AppError.internal(
      'Trusted acknowledgement supersession requires a transaction',
      'TRUSTED_TASK_SUPERSESSION_TRANSACTION_REQUIRED',
    );
  }
  const tid = resolveTenantId({ tenantId });
  const supersessionActorUid = requireActorUid(
    supersededByActorUid,
    'superseded_by_actor_uid',
  );
  const taskId = normalizeId(id, 'task id');
  const expectedResourceType = safeText(relatedResourceType, 120);
  const expectedResourceId = safeText(relatedResourceId, 255);
  const expectedSlaId = maybeUuid(workflowSlaInstanceId, 'workflow_sla_instance_id');
  if (!expectedResourceType || !expectedResourceId || !expectedSlaId) {
    throw AppError.badRequest(
      'Trusted acknowledgement supersession requires its exact resource and SLA binding',
      'ACKNOWLEDGEMENT_SUPERSESSION_INVALID',
    );
  }

  let current = await getTaskForUpdate({ tenantId: tid, id: taskId, db: tx });
  const linkedSla = await assertTaskSlaSourceBinding({ tenantId: tid, taskRow: current, db: tx });
  if (
    current.sla_completion_semantics !== 'acknowledgement'
    || String(current.workflow_sla_instance_id || '') !== expectedSlaId
    || current.related_resource_type !== expectedResourceType
    || String(current.related_resource_id || '') !== expectedResourceId
    || linkedSla?.rule_code !== 'critical_result_ack'
  ) {
    throw AppError.conflict(
      'Task is not the expected critical-result acknowledgement obligation',
      'ACKNOWLEDGEMENT_SUPERSESSION_INVALID',
    );
  }
  if (!['open', 'overdue', 'blocked', 'in_progress'].includes(current.status)) {
    throw AppError.invalidTransition(current.status, 'completed', TASK_TRANSITIONS[current.status] || []);
  }
  if (current.status === 'blocked') {
    current = await transitionTask({
      tenantId: tid,
      id: taskId,
      nextStatus: 'in_progress',
      acknowledgementTransitionAuthority: ACKNOWLEDGEMENT_TRANSITION_AUTHORITY,
      slaSourceBindingAuthority: TASK_SLA_SOURCE_BINDING_AUTHORITY,
      tx,
    });
  }
  return transitionTask({
    tenantId: tid,
    id: taskId,
    nextStatus: 'completed',
    actorUid: supersessionActorUid,
    slaSourceBindingAuthority: TASK_SLA_SOURCE_BINDING_AUTHORITY,
    tx,
  });
}

const DOMAIN_EVIDENCE_VALIDATORS = Object.freeze({
  mortuary_body_release: async ({ tenantId, taskRow, evidenceResourceType, evidenceResourceId, db }) => {
    if (evidenceResourceType !== 'body_custody_event') return null;
    const evidenceId = String(evidenceResourceId || '').trim();
    const deathRecordId = String(taskRow.related_resource_id || '').trim();
    if (
      taskRow.related_resource_type !== 'death_record'
      || !/^[1-9]\d*$/.test(evidenceId)
      || !/^[1-9]\d*$/.test(deathRecordId)
    ) {
      return null;
    }
    const rows = await db.$queryRawUnsafe(
      `SELECT custody.id, custody.event_type, custody.event_at, custody.created_at,
              (EXTRACT(EPOCH FROM custody.event_at) * 1000)::double precision AS event_at_epoch_ms,
              (EXTRACT(EPOCH FROM custody.created_at) * 1000)::double precision AS created_at_epoch_ms
         FROM body_custody_events custody
        WHERE custody.tenant_id = $1::uuid
          AND custody.id::text = $2::text
          AND custody.death_record_id::text = $3::text
          AND custody.event_type = 'release'
          AND EXISTS (
            SELECT 1
              FROM workflow_sla_instances sla
             WHERE sla.tenant_id = custody.tenant_id
               AND sla.id = $4::uuid
               AND sla.rule_code = 'mortuary_unclaimed_body'
          )
        LIMIT 1`,
      tenantId,
      evidenceId,
      deathRecordId,
      taskRow.workflow_sla_instance_id,
    );
    if (!rows[0]) return null;
    return {
      kind: 'mortuary_body_release',
      resource_type: 'body_custody_event',
      resource_id: String(rows[0].id),
      occurred_at: new Date(rows[0].event_at_epoch_ms).toISOString(),
      recorded_at: new Date(rows[0].created_at_epoch_ms).toISOString(),
    };
  },
});

export async function completeTaskFromDomainEvidence({
  tenantId = null,
  id,
  evidenceKind,
  evidenceResourceType,
  evidenceResourceId,
  actorUid = null,
  executorAuthority = null,
  tx = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const taskId = normalizeId(id, 'task id');
  if (!tx) {
    return setTenantTx(tid, (scopedTx) => completeTaskFromDomainEvidence({
      tenantId: tid,
      id: taskId,
      evidenceKind,
      evidenceResourceType,
      evidenceResourceId,
      actorUid,
      executorAuthority,
      tx: scopedTx,
    }));
  }

  let current = await getTaskForUpdate({ tenantId: tid, id: taskId, db: tx });
  const attachedRunId = await taskRowWorkflowRunId({ tenantId: tid, taskRow: current, db: tx });
  await assertPathwayExecutorAuthority({
    tenantId: tid,
    workflowRunId: attachedRunId,
    db: tx,
    executorAuthority,
  });
  await assertTaskSlaSourceBinding({ tenantId: tid, taskRow: current, db: tx });
  if (
    current.sla_completion_semantics !== 'domain_evidence'
    || !current.workflow_sla_instance_id
  ) {
    throw AppError.conflict(
      'Task is not registered for domain-evidence SLA completion',
      'DOMAIN_EVIDENCE_COMPLETION_NOT_ALLOWED',
    );
  }

  const cleanEvidenceKind = safeText(evidenceKind, 120);
  const validator = DOMAIN_EVIDENCE_VALIDATORS[cleanEvidenceKind];
  if (!validator) {
    throw AppError.badRequest('Unregistered domain evidence kind', 'DOMAIN_EVIDENCE_KIND_UNREGISTERED');
  }
  const evidence = await validator({
    tenantId: tid,
    taskRow: current,
    evidenceResourceType: safeText(evidenceResourceType, 120),
    evidenceResourceId,
    db: tx,
  });
  if (!evidence) {
    throw AppError.conflict('Registered domain evidence was not found', 'DOMAIN_EVIDENCE_NOT_FOUND');
  }

  const wasCompleted = current.status === 'completed';
  if (current.status === 'cancelled') {
    throw AppError.invalidTransition('cancelled', 'completed', TASK_TRANSITIONS.cancelled);
  }
  if (!wasCompleted) {
    if (current.status === 'blocked') {
      current = await transitionTask({
        tenantId: tid,
        id: taskId,
        nextStatus: 'in_progress',
        executorAuthority,
        slaSourceBindingAuthority: TASK_SLA_SOURCE_BINDING_AUTHORITY,
        tx,
      });
    }
    current = await transitionTask({
      tenantId: tid,
      id: taskId,
      nextStatus: 'completed',
      ...(actorUid ? { actorUid } : {}),
      executorAuthority,
      domainEvidenceAuthority: DOMAIN_EVIDENCE_COMPLETION_AUTHORITY,
      slaSourceBindingAuthority: TASK_SLA_SOURCE_BINDING_AUTHORITY,
      tx,
    });
  }

  const completedSla = await completeLinkedSla({
    tenantId: tid,
    taskRow: current,
    db: tx,
    completedBy: actorUid,
    completionTrigger: 'domain_evidence',
    completedAt: evidence.recorded_at,
    evidence,
    strict: true,
  });
  if (!completedSla) {
    const existing = await tx.$queryRawUnsafe(
      `SELECT id, completed_at, metadata
         FROM workflow_sla_instances
        WHERE id = $1::uuid
          AND tenant_id = $2::uuid
        LIMIT 1`,
      current.workflow_sla_instance_id,
      tid,
    );
    if (!existing[0]?.completed_at) {
      throw AppError.conflict('SLA completion changed concurrently', 'SLA_COMPLETION_CONFLICT');
    }
    const storedEvidence = existing[0].metadata?.completion_evidence;
    const evidenceMatches = (
      existing[0].metadata?.completed_via === 'domain_evidence'
      && storedEvidence?.kind === evidence.kind
      && storedEvidence?.resource_type === evidence.resource_type
      && String(storedEvidence?.resource_id || '') === evidence.resource_id
    );
    if (!evidenceMatches) {
      throw AppError.conflict(
        'Existing SLA completion is not backed by the registered domain evidence',
        'SLA_DOMAIN_EVIDENCE_MISMATCH',
      );
    }
  }

  if (!wasCompleted) {
    await postTaskComment({
      tenantId: tid,
      taskId,
      authorUid: actorUid,
      body: `Task completed from registered domain evidence ${evidence.kind}:${evidence.resource_id}`,
      bodyKind: 'state_change',
      metadata: { to: 'completed', completion_via: 'domain_evidence', evidence },
      tx,
    });
  }
  return current;
}

export async function completePathwayTaskFromRegisteredEvidence({
  tenantId = null,
  pathwayInstanceId,
  id,
  workflowRunId,
  workflowStepId,
  conditionHandler,
  evidence = {},
  actor = null,
  signal = null,
  executorAuthority = null,
  tx = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  if (!await hasPathwayExecutorAuthority(executorAuthority)) {
    throw AppError.conflict(
      'Pathway-bound workflow mutations must use the pathway executor',
      'PATHWAY_EXECUTOR_REQUIRED',
    );
  }
  const taskId = normalizeStrictPositiveId(id, 'task id');
  const runId = normalizeStrictPositiveId(workflowRunId, 'workflow_run_id');
  const stepId = normalizeStrictPositiveId(workflowStepId, 'workflow_step_id');
  const cleanPathwayInstanceId = maybeUuid(pathwayInstanceId, 'pathway_instance_id');
  if (!cleanPathwayInstanceId) {
    throw AppError.badRequest(
      'pathway_instance_id is required',
      'PATHWAY_TASK_CONTEXT_INVALID',
    );
  }
  const { isTenantTransactionClient } = await import('../../lib/prisma.js');
  if (!tx || !isTenantTransactionClient(tx)) {
    throw AppError.conflict(
      'Pathway evidence completion requires a branded tenant transaction',
      'PATHWAY_RUNTIME_TX_REQUIRED',
    );
  }
  const cleanHandler = requireCanonicalHandlerId(conditionHandler);
  const payload = cloneBudgetedWorkflowJson(
    normalizeJsonObject(evidence, 'evidence'),
    'evidence',
    'PATHWAY_HANDLER_CONTRACT_INVALID',
  );
  const provenance = await normalizePathwayEvidenceProvenance(actor, signal);
  const cleanActorUid = provenance.actor_kind === 'user' ? provenance.actor_uid : null;
  const normalizedEvidence = Object.freeze(cloneBudgetedWorkflowJson({
    kind: 'pathway_registered_condition',
    handler_id: cleanHandler,
    decision: 'satisfied',
    resource_type: 'workflow_steps',
    resource_id: String(stepId),
    payload,
    provenance,
  }, 'normalized_evidence', 'PATHWAY_HANDLER_CONTRACT_INVALID'));

  // Resolve without taking a row lock, then acquire the complete runtime using
  // the executor's single global lock order (instance, run, children, steps,
  // tasks, approvals, handoffs, SLAs). Locking the task first here would
  // deadlock against an executor transaction that already owns the instance.
  const pathwayRows = await tx.$queryRawUnsafe(
    `SELECT id
      FROM care_pathway_instances
      WHERE tenant_id = $1::uuid
        AND workflow_run_id = $2::bigint
        AND id = $3::uuid
      LIMIT 1`,
    tid,
    runId,
    cleanPathwayInstanceId,
  );
  if (!pathwayRows[0]?.id) {
    throw AppError.conflict(
      'Pathway task run and step context is not registered',
      'PATHWAY_TASK_CONTEXT_MISMATCH',
    );
  }
  const { lockPathwayRuntimeTx } = await import('../pathways/pathwayRuntimePersistence.js');
  const runtime = await lockPathwayRuntimeTx({
    tx,
    tenantId: tid,
    pathwayInstanceId: pathwayRows[0].id,
  });
  const current = runtime.tasks.find((task) => Number(task.id) === taskId);
  const step = runtime.steps.find((candidate) => Number(candidate.id) === stepId);
  if (
    Number(runtime.run?.id) !== runId
    || !step
    || Number(step.workflow_run_id) !== runId
    || !current
    || Number(current.workflow_run_id) !== runId
    || Number(current.workflow_step_id) !== stepId
  ) {
    throw AppError.conflict(
      'Pathway task does not belong to the supplied run and step',
      'PATHWAY_TASK_CONTEXT_MISMATCH',
    );
  }
  let pinnedSteps = runtime.definition?.steps;
  if (typeof pinnedSteps === 'string') {
    try {
      pinnedSteps = JSON.parse(pinnedSteps);
    } catch {
      pinnedSteps = null;
    }
  }
  const pinnedStep = Array.isArray(pinnedSteps)
    ? pinnedSteps.find((candidate) => candidate?.step_key === step.step_key)
    : null;
  const pinnedHandler = safeText(pinnedStep?.condition_handler, 120);
  if (!pinnedStep || !pinnedHandler || pinnedHandler !== cleanHandler) {
    throw AppError.conflict(
      'Pathway evidence handler does not match the pinned governed step',
      'PATHWAY_HANDLER_CONTRACT_INVALID',
    );
  }
  let taskState = current;
  const linkedSla = await assertTaskSlaSourceBinding({
    tenantId: tid,
    taskRow: taskState,
    db: tx,
  });
  if (
    taskState.sla_completion_semantics !== 'domain_evidence'
    || !taskState.workflow_sla_instance_id
  ) {
    throw AppError.conflict(
      'Pathway task is not registered for domain-evidence SLA completion',
      'DOMAIN_EVIDENCE_COMPLETION_NOT_ALLOWED',
    );
  }

  const previousTaskStatus = taskState.status;
  const previousSlaStatus = linkedSla.status;
  const wasCompleted = taskState.status === 'completed';
  if (taskState.status === 'cancelled') {
    throw AppError.invalidTransition('cancelled', 'completed', TASK_TRANSITIONS.cancelled);
  }
  if (!wasCompleted) {
    if (taskState.status === 'blocked') {
      taskState = await transitionTask({
        tenantId: tid,
        id: taskId,
        nextStatus: 'in_progress',
        executorAuthority,
        slaSourceBindingAuthority: TASK_SLA_SOURCE_BINDING_AUTHORITY,
        tx,
      });
    }
    taskState = await transitionTask({
      tenantId: tid,
      id: taskId,
      nextStatus: 'completed',
      ...(cleanActorUid ? { actorUid: cleanActorUid } : {}),
      executorAuthority,
      domainEvidenceAuthority: DOMAIN_EVIDENCE_COMPLETION_AUTHORITY,
      slaSourceBindingAuthority: TASK_SLA_SOURCE_BINDING_AUTHORITY,
      tx,
    });
  }

  const completedSla = await completeLinkedSla({
    tenantId: tid,
    taskRow: taskState,
    db: tx,
    completedBy: cleanActorUid,
    completionTrigger: 'domain_evidence',
    evidence: normalizedEvidence,
    strict: true,
  });
  const slaRows = await tx.$queryRawUnsafe(
    `SELECT *,
            (metadata->'completion_evidence' = $3::jsonb) AS evidence_matches
       FROM workflow_sla_instances
      WHERE id = $1::uuid
        AND tenant_id = $2::uuid
      LIMIT 1`,
    taskState.workflow_sla_instance_id,
    tid,
    JSON.stringify(normalizedEvidence),
  );
  const sla = slaRows[0];
  if (!sla?.completed_at) {
    throw AppError.conflict('SLA completion changed concurrently', 'SLA_COMPLETION_CONFLICT');
  }
  if (!completedSla && (
    sla.metadata?.completed_via !== 'domain_evidence'
    || sla.evidence_matches !== true
  )) {
    throw AppError.conflict(
      'Existing SLA completion is not backed by the same registered pathway evidence',
      'SLA_DOMAIN_EVIDENCE_MISMATCH',
    );
  }

  if (!wasCompleted) {
    await postTaskComment({
      tenantId: tid,
      taskId,
      authorUid: cleanActorUid,
      body: `Task completed from registered pathway condition ${cleanHandler}`,
      bodyKind: 'state_change',
      metadata: {
        to: 'completed',
        completion_via: 'domain_evidence',
        evidence: normalizedEvidence,
      },
      tx,
    });
  }
  return Object.freeze({
    task: taskState,
    sla,
    evidence: normalizedEvidence,
    previousTaskStatus,
    previousSlaStatus,
    mutated: !wasCompleted || Boolean(completedSla),
  });
}

const TASK_CLAIMABLE_STATUSES = new Set(['open', 'in_progress', 'blocked', 'overdue']);
const TASK_CLAIM_FORBIDDEN_MESSAGE = 'Not authorized to claim this task';

function normalizeClaimIdempotencyKey(value) {
  const key = typeof value === 'string' ? value.trim() : '';
  if (!isValidIdempotencyKey(key)) {
    throw AppError.badRequest(
      'Idempotency-Key must be 1-200 chars [A-Za-z0-9_-:.]',
      'TASK_CLAIM_IDEMPOTENCY_KEY_INVALID',
    );
  }
  return key;
}

function deriveTaskClaimReceipt({ tenantId, taskId, actorUid, rawKey }) {
  const commandFingerprint = createHash('sha256')
    .update(JSON.stringify({
      operation: 'clinical_inbox_task_claim',
      tenantId,
      taskId: String(taskId),
      actorUid,
    }))
    .digest('hex');
  const receipt = createHash('sha256')
    .update(JSON.stringify({ commandFingerprint, rawKey }))
    .digest('hex');
  return Object.freeze({
    commandFingerprint,
    receipt: `task-claim-v1:${receipt}`,
  });
}

function taskClaimForbidden(taskRow = null) {
  const err = AppError.forbidden(TASK_CLAIM_FORBIDDEN_MESSAGE, 'TASK_CLAIM_FORBIDDEN');
  if (taskRow?.patient_uid) {
    Object.defineProperty(err, 'phiPatientUid', {
      value: String(taskRow.patient_uid),
      enumerable: false,
    });
  }
  return err;
}

function acknowledgedByUid(taskRow) {
  const value = String(taskRow?.metadata?.acknowledged_by || '').trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value) ? value : null;
}

async function claimTaskForCurrentActorTx({
  tenantId,
  taskId,
  actor,
  idempotencyKey,
  db,
} = {}) {
  const current = await getTaskForUpdate({ tenantId, id: taskId, db });
  const claimReceipt = deriveTaskClaimReceipt({
    tenantId,
    taskId,
    actorUid: actor.uid,
    rawKey: idempotencyKey,
  });
  const currentUid = String(current.assigned_to_uid || '').trim().toLowerCase() || null;
  const currentRole = String(current.assigned_to_role || '').trim().toUpperCase() || null;
  const receiptKey = String(current.metadata?.role_claim_receipt || '').trim();
  const receiptFingerprint = String(current.metadata?.role_claim_command_fingerprint || '').trim();
  const receiptActor = String(current.metadata?.role_claimed_by || '').trim().toLowerCase();

  if (
    currentUid === actor.uid
    && receiptKey === claimReceipt.receipt
    && receiptFingerprint === claimReceipt.commandFingerprint
    && receiptActor === actor.uid
  ) {
    return Object.freeze({ task: current, replayed: true });
  }
  if (
    !TASK_CLAIMABLE_STATUSES.has(String(current.status || '').toLowerCase())
    || currentUid
    || !currentRole
    || currentRole !== actor.queueRole
  ) {
    throw taskClaimForbidden(current);
  }
  const recordedAcker = acknowledgedByUid(current);
  const recordedRoleAcknowledgementReceipt = Boolean(
    current.status === 'in_progress'
    && recordedAcker
  );
  if (recordedRoleAcknowledgementReceipt && recordedAcker !== actor.uid) {
    throw taskClaimForbidden(current);
  }

  const attachedRunId = await taskRowWorkflowRunId({ tenantId, taskRow: current, db });
  await assertPathwayExecutorAuthority({
    tenantId,
    workflowRunId: attachedRunId,
    db,
    executorAuthority: null,
  });
  const linkedSla = await assertTaskSlaSourceBinding({ tenantId, taskRow: current, db });
  const claimedAt = new Date().toISOString();
  const rows = await db.$queryRawUnsafe(
    `UPDATE tasks
        SET assigned_to_uid = $3::uuid,
            assigned_to_role = NULL,
            metadata = COALESCE(metadata, '{}'::jsonb)
              || jsonb_build_object(
                   'role_claim_receipt', $4::text,
                   'role_claim_command_fingerprint', $8::text,
                   'role_claimed_by', $3::text,
                   'role_claimed_from_role', $5::text,
                   'role_claimed_at', $6::text
                 ),
            updated_at = NOW()
      WHERE tenant_id = $1::uuid
        AND id = $2::bigint
        AND status = $7::text
        AND assigned_to_uid IS NULL
        AND UPPER(BTRIM(assigned_to_role)) = $5::text
      RETURNING ${TASK_RETURNING}`,
    tenantId,
    taskId,
    actor.uid,
    claimReceipt.receipt,
    actor.queueRole,
    claimedAt,
    current.status,
    claimReceipt.commandFingerprint,
  );
  const claimed = rows[0];
  if (!claimed) throw taskClaimForbidden(current);

  if (linkedSla && !linkedSla.completed_at && !['completed', 'cancelled'].includes(linkedSla.status)) {
    const slaRows = await db.$queryRawUnsafe(
      `UPDATE workflow_sla_instances
          SET assigned_user_uid = $3::uuid,
              assigned_role_codes = ARRAY[]::text[],
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND id = $2::uuid
          AND completed_at IS NULL
          AND status NOT IN ('completed', 'cancelled')
        RETURNING id`,
      tenantId,
      linkedSla.id,
      actor.uid,
    );
    if (!slaRows[0]) {
      throw AppError.conflict(
        'Task claim changed before linked SLA ownership was updated',
        'TASK_CLAIM_SLA_CONFLICT',
      );
    }
  }

  await postTaskComment({
    tenantId,
    taskId,
    authorUid: actor.uid,
    body: `Task claimed from ${actor.queueRole} role queue`,
    bodyKind: 'state_change',
    metadata: {
      from_assigned_to_role: actor.queueRole,
      to_assigned_to_uid: actor.uid,
      claimed_at: claimedAt,
      claim_receipt: claimReceipt.receipt,
      command_fingerprint: claimReceipt.commandFingerprint,
    },
    tx: db,
  });
  return Object.freeze({ task: claimed, replayed: false });
}

export async function claimInboxTask({
  tenantId = null,
  id,
  actorUid = null,
  actorRoles = [],
  actorPrimaryRole = null,
  actorRawRole = null,
  idempotencyKey,
  tx = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const taskId = normalizeId(id, 'task id');
  const key = normalizeClaimIdempotencyKey(idempotencyKey);
  if (!tx) {
    return setTenantTx(tid, (tenantTx) => claimInboxTask({
      tenantId: tid,
      id: taskId,
      actorUid,
      actorRoles,
      actorPrimaryRole,
      actorRawRole,
      idempotencyKey: key,
      tx: tenantTx,
    }));
  }
  const actor = await resolveCurrentHumanActorTx({
    tx,
    tenantId: tid,
    actorUid,
    authenticatedRoles: actorRoles,
    authenticatedPrimaryRole: actorPrimaryRole,
    authenticatedRawRole: actorRawRole,
    rolePredicate: isTaskHumanOwnerRole,
  });
  const claimed = await claimTaskForCurrentActorTx({
    tenantId: tid,
    taskId,
    actor,
    idempotencyKey: key,
    db: tx,
  });
  return Object.freeze({ ...claimed.task, replayed: claimed.replayed });
}

/**
 * Acknowledge a task: open|overdue → in_progress, stamping
 * `metadata.acknowledged_at` and appending a `state_change` task_comment.
 *
 * This is the results-inbox "assignee saw it / stopped the escalation clock"
 * action (design §4.5). It is a thin, intention-revealing wrapper over the
 * existing state machine: the engine treats an in_progress task as acked, so
 * no new status is introduced. Already-acknowledged (in_progress) tasks are
 * returned without re-stamping or duplicating the audit comment; the same
 * authority-checked statement repairs any legacy active linked SLA. A
 * completed/cancelled task cannot be acknowledged → AppError.invalidTransition
 * (400).
 */
function actorRolesUpper(actorRoles) {
  const arr = Array.isArray(actorRoles) ? actorRoles : (actorRoles ? [actorRoles] : []);
  return arr.map((r) => String(r || '').trim().toUpperCase()).filter(Boolean);
}

const ACK_FORBIDDEN_MESSAGE = 'Not authorized to acknowledge this task';
const COLD_CHAIN_ACK_SOURCE = 'cold_chain_excursion_ack';
const COLD_CHAIN_ACK_REASON = 'Acknowledged via cold-chain excursion acknowledgement';
const POSTGRES_INT_MAX = 2_147_483_647;

function ackForbidden(taskRow = null) {
  const err = AppError.forbidden(ACK_FORBIDDEN_MESSAGE);
  if (taskRow?.patient_uid) {
    // Internal-only context for phiAccessLogger. Keep it non-enumerable so the
    // generic 403 response cannot disclose which patient owns a probed task id.
    Object.defineProperty(err, 'phiPatientUid', {
      value: String(taskRow.patient_uid),
      enumerable: false,
    });
  }
  return err;
}

// Who may acknowledge a task — and thereby STOP its escalation/SLA clock.
// Caller text is never authority. Normal authority comes from assignment or task
// administration; an override must already have been verified against a durable
// server-side authority record before it reaches this resolver.
function resolveDirectAckAuthorization(taskRow, {
  actorUid = null,
  actorRoles = [],
  actorRole = null,
  actorQueueRole = null,
} = {}) {
  const roles = actorRolesUpper(actorRoles);
  const canonicalRole = String(actorRole || '').trim().toUpperCase() || null;
  const queueRole = String(actorQueueRole || '').trim().toUpperCase() || null;
  const callerUid = actorUid ? String(actorUid).toLowerCase() : null;
  const assignedUid = taskRow?.assigned_to_uid ? String(taskRow.assigned_to_uid).toLowerCase() : null;
  const assignedRole = taskRow?.assigned_to_role ? String(taskRow.assigned_to_role).trim().toUpperCase() : null;
  const claimedBy = String(taskRow?.metadata?.role_claimed_by || '').trim().toLowerCase() || null;
  const claimedFromRole = String(taskRow?.metadata?.role_claimed_from_role || '')
    .trim().toUpperCase() || null;

  if (!callerUid) return null;
  if (
    callerUid === assignedUid
    && callerUid === claimedBy
    && queueRole
    && queueRole === claimedFromRole
  ) {
    return { mode: 'role', assignedRole: claimedFromRole };
  }
  if (callerUid && assignedUid && callerUid === assignedUid) return { mode: 'assignee' };
  if (
    !assignedUid
    && assignedRole
    && (queueRole ? queueRole === assignedRole : roles.includes(assignedRole))
  ) {
    return { mode: 'role', assignedRole };
  }
  if (isAdmin(canonicalRole) || roles.some((r) => isAdmin(r))) return { mode: 'admin' };
  return null;
}

function resolveAckAuthorization(taskRow, {
  actorUid = null,
  actorRoles = [],
  actorRole = null,
  actorQueueRole = null,
  verifiedOverride = null,
} = {}) {
  const direct = resolveDirectAckAuthorization(taskRow, {
    actorUid,
    actorRoles,
    actorRole,
    actorQueueRole,
  });
  if (direct) return direct;
  if (verifiedOverride?.source && verifiedOverride?.id && verifiedOverride?.reason) {
    return { mode: 'override', ...verifiedOverride };
  }
  throw ackForbidden(taskRow);
}

async function loadVerifiedPatientBreakGlass({
  tenantId, taskRow, actorUid, actorRoles, breakGlassId, db,
}) {
  const numericId = Number(breakGlassId);
  if (
    !Number.isSafeInteger(numericId)
    || numericId <= 0
    || numericId > POSTGRES_INT_MAX
    || !taskRow?.patient_uid
    || !actorUid
  ) return null;

  const roles = actorRolesUpper(actorRoles);
  if (!roles.some((role) => roleCanBreakGlass(role))) return null;

  const rows = await db.$queryRawUnsafe(
    `SELECT id, actor_role, reason
       FROM patient_access_break_glass
      WHERE tenant_id = $1::uuid
        AND patient_uid = $2::uuid
        AND actor_uid = $3::uuid
        AND id = $4::int
        AND status = 'active'
        AND expires_at > NOW()
      LIMIT 1`,
    tenantId,
    taskRow.patient_uid,
    actorUid,
    numericId,
  );
  const row = rows[0];
  const sessionRole = row?.actor_role ? String(row.actor_role).trim().toUpperCase() : null;
  const reason = safeText(row?.reason, TEXT_MAX);
  if (!row || !sessionRole || !roles.includes(sessionRole) || !roleCanBreakGlass(sessionRole) || !reason) return null;

  return {
    source: 'patient_access_break_glass',
    id: String(row.id),
    reason,
    sessionRole,
  };
}

function resolveTrustedWorkflowOverride(taskRow, trustedOverride) {
  const source = safeText(trustedOverride?.source, 120);
  const resourceId = safeText(trustedOverride?.id, 120);
  const reason = safeText(trustedOverride?.reason, TEXT_MAX);
  if (
    source !== COLD_CHAIN_ACK_SOURCE
    || reason !== COLD_CHAIN_ACK_REASON
    || taskRow?.related_resource_type !== 'cold_chain_excursions'
    || String(taskRow?.related_resource_id || '') !== resourceId
  ) return null;

  return { source, id: resourceId, reason };
}

async function resolveVerifiedAckAuthorization({
  tenantId,
  taskRow,
  actorUid,
  actorRoles,
  actorRole,
  actorQueueRole,
  breakGlassId,
  trustedOverride,
  db,
}) {
  let verifiedOverride = null;
  if (trustedOverride) {
    verifiedOverride = resolveTrustedWorkflowOverride(taskRow, trustedOverride);
    if (!verifiedOverride) throw ackForbidden(taskRow);
  }

  let authz = resolveDirectAckAuthorization(taskRow, {
    actorUid,
    actorRoles,
    actorRole,
    actorQueueRole,
  });
  if (!authz && !verifiedOverride && breakGlassId !== null && breakGlassId !== undefined) {
    verifiedOverride = await loadVerifiedPatientBreakGlass({
      tenantId,
      taskRow,
      actorUid,
      actorRoles,
      breakGlassId,
      db,
    });
  }

  authz ||= resolveAckAuthorization(taskRow, {
    actorUid,
    actorRoles,
    actorRole,
    actorQueueRole,
    verifiedOverride,
  });
  return { authz, verifiedOverride };
}

// Shared by the state-changing CAS and the idempotent-repair read. This makes
// the database statement that stops (or repairs) the SLA clock re-check the
// exact authority selected from the pre-read instead of trusting stale state.
const ACK_AUTHORITY_PREDICATE = `
  (
    ($3::text = 'assignee' AND tasks.assigned_to_uid = $4::uuid)
    OR (
      $3::text = 'role'
      AND (
        (
          tasks.assigned_to_uid IS NULL
          AND UPPER(TRIM(tasks.assigned_to_role)) = $5::text
        )
        OR (
          tasks.assigned_to_uid = $4::uuid
          AND LOWER(COALESCE(tasks.metadata->>'role_claimed_by', '')) = LOWER($4::text)
          AND UPPER(COALESCE(tasks.metadata->>'role_claimed_from_role', '')) = $5::text
        )
      )
    )
    OR $3::text = 'admin'
    OR (
      $3::text = 'override'
      AND (
        (
          $6::text = 'patient_access_break_glass'
          AND EXISTS (
            SELECT 1
              FROM patient_access_break_glass bg
             WHERE bg.id = $11::int
               AND bg.tenant_id = $2::uuid
               AND bg.patient_uid = tasks.patient_uid
               AND bg.actor_uid = $4::uuid
               AND UPPER(TRIM(bg.actor_role)) = $9::text
               AND bg.reason = $8::text
               AND bg.status = 'active'
               AND bg.expires_at > NOW()
          )
        )
        OR (
          $6::text = 'cold_chain_excursion_ack'
          AND tasks.related_resource_type = 'cold_chain_excursions'
          AND tasks.related_resource_id = $7::text
        )
      )
    )
  )
  AND (
    $10::text IS NULL
    OR (
      tasks.related_resource_type = 'cold_chain_excursions'
      AND tasks.related_resource_id = $10::text
    )
  )`;

function ackAuthorityParams({ tenantId, taskId, actorUid, authz, trustedResourceId = null }) {
  return [
    taskId,
    tenantId,
    authz.mode,
    actorUid,
    authz.assignedRole || null,
    authz.source || null,
    authz.id || null,
    authz.reason || null,
    authz.sessionRole || null,
    trustedResourceId,
    authz.source === 'patient_access_break_glass' ? Number(authz.id) : null,
  ];
}

async function reconcileInProgressAcknowledgement({
  tenantId,
  taskId,
  actorUid,
  authz,
  trustedResourceId,
  taskRow,
  db,
}) {
  const authorityParams = ackAuthorityParams({
    tenantId, taskId, actorUid, authz, trustedResourceId,
  });
  const rows = await db.$queryRawUnsafe(
    `SELECT ${TASK_RETURNING}
       FROM tasks
      WHERE tasks.id = $1
        AND tasks.tenant_id = $2::uuid
        AND tasks.status = 'in_progress'
        AND ${ACK_AUTHORITY_PREDICATE}
      LIMIT 1
      FOR UPDATE`,
    ...authorityParams,
  );
  const current = rows[0];
  if (!current) throw ackForbidden(taskRow);
  await assertTaskSlaSourceBinding({ tenantId, taskRow: current, db });

  const durableReceipt = parseDurableTimestamp(current.metadata?.acknowledged_at);
  if (durableReceipt) {
    await completeLinkedSla({
      tenantId,
      taskRow: current,
      db,
      completedBy: current.metadata?.acknowledged_by || actorUid,
      completionTrigger: 'acknowledgement',
      completedAt: durableReceipt,
      strict: true,
    });
    return current;
  }

  // Some pre-receipt releases could leave a task in_progress without durable
  // acknowledgement evidence. An authorized re-ack repairs the receipt and
  // records that repair before the SLA clock is reconciled in this transaction.
  const previousAcknowledgedAt = current.metadata?.acknowledged_at ?? null;
  const repairedFrom = previousAcknowledgedAt === null ? 'missing' : 'malformed';
  const repairedAt = new Date().toISOString();
  const repairedRows = await db.$queryRawUnsafe(
    `WITH repair_input AS (
       SELECT to_char(
                to_timestamp($12::double precision / 1000.0) AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
              ) AS acknowledged_at,
              $13::jsonb AS previous_acknowledged_at,
              $14::text AS repaired_from
     )
     UPDATE tasks
        SET metadata = COALESCE(metadata, '{}'::jsonb)
          || jsonb_build_object(
               'acknowledged_at', repair_input.acknowledged_at,
               'acknowledged_by', $4::text,
               'acknowledged_via', $3::text,
               'acknowledgement_receipt_repaired', TRUE,
               'previous_acknowledged_at', repair_input.previous_acknowledged_at,
               'acknowledgement_receipt_repaired_from', repair_input.repaired_from
             )
          || CASE WHEN $6::text IS NOT NULL
                  THEN jsonb_build_object(
                    'acknowledge_override_source', $6::text,
                    'acknowledge_override_id', $7::text,
                    'acknowledge_override_reason', $8::text
                  )
                  ELSE '{}'::jsonb END,
            updated_at = NOW()
       FROM repair_input
      WHERE tasks.id = $1
        AND tasks.tenant_id = $2::uuid
        AND tasks.status = 'in_progress'
        AND ${ACK_AUTHORITY_PREDICATE}
      RETURNING ${TASK_RETURNING}`,
    ...authorityParams,
    new Date(repairedAt).getTime(),
    JSON.stringify(previousAcknowledgedAt),
    repairedFrom,
  );
  const repaired = repairedRows[0];
  if (!repaired) throw ackForbidden(taskRow);

  await completeLinkedSla({
    tenantId,
    taskRow: repaired,
    db,
    completedBy: actorUid,
    completionTrigger: 'acknowledgement',
    completedAt: repairedAt,
    strict: true,
  });
  const overrideNote = authz.mode === 'override'
    ? ` [override ${authz.source}:${authz.id}: ${authz.reason}]`
    : '';
  await postTaskComment({
    tenantId,
    taskId,
    authorUid: actorUid,
    body: `Task acknowledgement receipt repaired (in_progress) via ${authz.mode}${overrideNote}`,
    bodyKind: 'state_change',
    metadata: {
      from: 'in_progress',
      to: 'in_progress',
      acknowledged_at: repairedAt,
      previous_acknowledged_at: previousAcknowledgedAt,
      via: authz.mode,
      receipt_repaired: true,
      repaired_from: repairedFrom,
      ...(authz.mode === 'override' ? {
        override_source: authz.source,
        override_id: authz.id,
        override_reason: authz.reason,
      } : {}),
    },
    tx: db,
  });
  return repaired;
}

async function updateTaskForAcknowledgement({
  tenantId,
  taskId,
  actorUid,
  authz,
  trustedResourceId,
  acknowledgedAt,
  allowBlocked = false,
  ackContractVersion = null,
  db,
}) {
  const authorityParams = ackAuthorityParams({
    tenantId, taskId, actorUid, authz, trustedResourceId,
  });
  const acknowledgeableStatuses = allowBlocked
    ? "('open', 'overdue', 'blocked')"
    : "('open', 'overdue')";
  return db.$queryRawUnsafe(
    `WITH ack_input AS (
       SELECT to_char(
                to_timestamp($12::double precision / 1000.0) AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
              ) AS acknowledged_at
     )
     UPDATE tasks
        SET status = 'in_progress',
            metadata = COALESCE(metadata, '{}'::jsonb)
                || jsonb_build_object('acknowledged_at', ack_input.acknowledged_at, 'acknowledged_by', $4::text, 'acknowledged_via', $3::text)
                || CASE WHEN $6::text IS NOT NULL
                        THEN jsonb_build_object(
                          'acknowledge_override_source', $6::text,
                          'acknowledge_override_id', $7::text,
                          'acknowledge_override_reason', $8::text
                        )
                        ELSE '{}'::jsonb END
                || CASE WHEN $13::int IS NOT NULL
                        THEN jsonb_build_object('ack_contract_version', $13::int)
                        ELSE '{}'::jsonb END,
             updated_at = NOW()
       FROM ack_input
      WHERE tasks.id = $1::int AND tasks.tenant_id = $2::uuid
        AND tasks.status IN ${acknowledgeableStatuses}
        AND ${ACK_AUTHORITY_PREDICATE}
      RETURNING ${TASK_RETURNING}`,
    ...authorityParams,
    new Date(acknowledgedAt).getTime(),
    ackContractVersion,
  );
}

function hasLabCriticalAlertBinding(taskRow) {
  return taskRow?.metadata?.lab_critical_alert_id !== undefined
    && taskRow?.metadata?.lab_critical_alert_id !== null;
}

async function assertLabCriticalAlertAcknowledgementBoundary({
  tenantId,
  taskRow,
  authority,
  db,
}) {
  const hasBinding = hasLabCriticalAlertBinding(taskRow);
  const hasAuthority = authority?.capability === LAB_CRITICAL_ALERT_ACKNOWLEDGEMENT_AUTHORITY;
  if (!hasBinding && !hasAuthority) return;

  if (!hasAuthority) {
    throw AppError.conflict(
      'Lab critical-result tasks must be acknowledged through the critical-alert workflow',
      'LAB_CRITICAL_ALERT_ACK_REQUIRED',
    );
  }

  const alertId = normalizeId(authority.alertId, 'critical alert id');
  const resultId = safeText(authority.resultId, 120);
  const patientUid = maybeUuid(authority.patientUid, 'patient_uid');
  if (
    !resultId
    || !patientUid
    || String(taskRow.metadata.lab_critical_alert_id) !== String(alertId)
  ) {
    throw AppError.forbidden('Not authorized to acknowledge this task');
  }

  const bindings = await db.$queryRawUnsafe(
    `SELECT alert.id
       FROM tasks AS task
       JOIN lab_critical_alerts AS alert
         ON alert.tenant_id = task.tenant_id
        AND alert.acknowledgement_task_id = task.id
       JOIN workflow_sla_instances AS sla
         ON sla.tenant_id = task.tenant_id
        AND sla.id = task.workflow_sla_instance_id
      WHERE task.tenant_id = $1::uuid
        AND task.id = $2::int
        AND alert.id = $3::int
        AND alert.result_id::text = $4::text
        AND alert.patient_uid = $5::uuid
        AND alert.superseded_at IS NULL
        AND task.patient_uid = alert.patient_uid
        AND task.related_resource_type = 'lab_result'
        AND task.related_resource_id = alert.result_id::text
        AND task.sla_completion_semantics = 'acknowledgement'
        AND task.metadata->>'lab_critical_alert_id' = alert.id::text
        AND (
          alert.generation_signoff_id IS NULL
          OR task.metadata->>'lab_alert_generation_signoff_id'
               = alert.generation_signoff_id::text
        )
        AND task.metadata->>'lab_alert_generation_state'
             = alert.generation_metadata->>'corrected_state'
        AND sla.rule_code = 'critical_result_ack'
        AND sla.source_table = 'lab_result'
        AND sla.source_id = alert.result_id::text
        AND sla.patient_uid = alert.patient_uid
      LIMIT 2`,
    tenantId,
    taskRow.id,
    alertId,
    resultId,
    patientUid,
  );
  if (bindings.length !== 1) {
    throw AppError.forbidden('Not authorized to acknowledge this task');
  }
}

async function acknowledgeTaskInternal({
  tenantId = null,
  id,
  actorUid = null,
  actorRoles = [],
  actorPrimaryRole = null,
  actorRawRole = null,
  breakGlassId = null,
  trustedOverride = null,
  labCriticalAlertAuthority = null,
  executorAuthority = null,
  tx = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const taskId = normalizeId(id, 'task id');
  const db = tx || prisma;

  const currentActor = await resolveCurrentHumanActorTx({
    tx: db,
    tenantId: tid,
    actorUid: requireActorUid(actorUid),
    authenticatedRoles: actorRoles,
    authenticatedPrimaryRole: actorPrimaryRole,
    authenticatedRawRole: actorRawRole,
    rolePredicate: (role) => (
      isTaskHumanOwnerRole(role)
      || isAdmin(role)
      || role === 'SUPER_ADMIN'
    ),
  });
  const ackUid = currentActor.uid;
  const currentActorRoles = [currentActor.role];

  // Pre-read for a clean, intention-revealing error before attempting the write.
  let current = await getTask({ tenantId: tid, id: taskId, tx });

  const recordedRoleAcknowledgementReceipt = Boolean(
    current.status === 'in_progress'
    && !current.assigned_to_uid
    && current.assigned_to_role
    && acknowledgedByUid(current),
  );
  if (
    recordedRoleAcknowledgementReceipt
    && acknowledgedByUid(current) !== ackUid
    && !isAdmin(currentActor.role)
  ) {
    throw ackForbidden(current);
  }

  // A role-queue acknowledgement is also the moment responsibility becomes
  // personal. Claim under the same transaction before stopping the SLA clock.
  // Legacy in_progress rows may be repaired only by their recorded acker.
  if (
    !current.assigned_to_uid
    && String(current.assigned_to_role || '').trim().toUpperCase() === currentActor.queueRole
    && (
      !recordedRoleAcknowledgementReceipt
      || acknowledgedByUid(current) === ackUid
    )
  ) {
    const claim = await claimTaskForCurrentActorTx({
      tenantId: tid,
      taskId,
      actor: currentActor,
      idempotencyKey: `task-role-ack:${taskId}:${ackUid}`,
      db,
    });
    current = claim.task;
  }

  // Authorize BEFORE any idempotent return, so an unauthorized caller neither
  // stops the clock nor learns the task's state/PHI. Throws forbidden otherwise.
  const { authz, verifiedOverride } = await resolveVerifiedAckAuthorization({
    tenantId: tid,
    taskRow: current,
    actorUid: ackUid,
    actorRoles: currentActorRoles,
    actorRole: currentActor.role,
    actorQueueRole: currentActor.queueRole,
    breakGlassId,
    trustedOverride,
    db,
  });
  // A lab critical alert, its task receipt, linked SLA, task comment, and
  // canonical clinical evidence are one clinical transition. Generic task
  // callers may never execute only the task/SLA half. Migration 581 makes the
  // metadata pointer immutable for every alert-bound task; the dedicated
  // transaction-only entrypoint below additionally revalidates the exact
  // current tenant/alert/task/resource/SLA binding before mutation.
  await assertLabCriticalAlertAcknowledgementBoundary({
    tenantId: tid,
    taskRow: current,
    authority: labCriticalAlertAuthority,
    db,
  });
  const allowBlocked = labCriticalAlertAuthority?.capability
    === LAB_CRITICAL_ALERT_ACKNOWLEDGEMENT_AUTHORITY;
  const ackContractVersion = allowBlocked
    ? LAB_CRITICAL_ALERT_ACK_CONTRACT_VERSION
    : null;
  // Only an authorized task actor may learn that this work is pathway-bound.
  // The generic route still fails closed for valid assignees/roles; probes keep
  // the same non-enumerating 403 response as every other unauthorized task id.
  const attachedRunId = await taskRowWorkflowRunId({ tenantId: tid, taskRow: current, db });
  await assertPathwayExecutorAuthority({
    tenantId: tid,
    workflowRunId: attachedRunId,
    db,
    executorAuthority,
  });
  let effectiveAuthz = authz;
  let effectiveTrustedResourceId = trustedOverride ? verifiedOverride.id : null;
  let effectiveFromStatus = current.status;

  // Already acknowledged → do not re-stamp or duplicate the comment, but repair
  // a legacy task/SLA split after atomically re-checking current authority.
  if (current.status === 'in_progress') {
    return reconcileInProgressAcknowledgement({
      tenantId: tid,
      taskId,
      actorUid: ackUid,
      authz: effectiveAuthz,
      trustedResourceId: effectiveTrustedResourceId,
      taskRow: current,
      db,
    });
  }
  // Terminal states can never be acknowledged.
  if (current.status === 'completed' || current.status === 'cancelled') {
    throw AppError.invalidTransition(current.status, 'in_progress', TASK_TRANSITIONS[current.status] || []);
  }

  // Atomic state change: guard the acknowledgeable statuses IN the UPDATE so a
  // concurrent completion/cancel (or a racing acker) cannot be flipped back to
  // in_progress between the pre-read and the write (TOCTOU). RETURNING yields no
  // row when the guard excludes the current status. `acknowledged_via` records
  // the authorization mode; a verified override stamps its durable authority
  // source, record id, and server-loaded reason.
  const ackedAt = new Date().toISOString();
  let rows = await updateTaskForAcknowledgement({
    tenantId: tid,
    taskId,
    actorUid: ackUid,
    authz: effectiveAuthz,
    trustedResourceId: effectiveTrustedResourceId,
    acknowledgedAt: ackedAt,
    allowBlocked,
    ackContractVersion,
    db,
  });
  if (!rows[0]) {
    // The guarded UPDATE matched nothing: status or authority changed. Re-read
    // without returning task details until current authority is re-established.
    const after = await getTask({ tenantId: tid, id: taskId, tx });
    const fresh = await resolveVerifiedAckAuthorization({
      tenantId: tid,
      taskRow: after,
      actorUid: ackUid,
      actorRoles: currentActorRoles,
      actorRole: currentActor.role,
      actorQueueRole: currentActor.queueRole,
      breakGlassId,
      trustedOverride,
      db,
    });
    if (after.status === 'in_progress') {
      return reconcileInProgressAcknowledgement({
        tenantId: tid,
        taskId,
        actorUid: ackUid,
        authz: fresh.authz,
        trustedResourceId: trustedOverride ? fresh.verifiedOverride.id : null,
        taskRow: after,
        db,
      });
    }
    if (
      after.status === 'open'
      || after.status === 'overdue'
      || (allowBlocked && after.status === 'blocked')
    ) {
      // The selected authority can change while another valid mode remains
      // (for example, an assignee who is also an administrator). Retry the CAS
      // once with freshly resolved authority before returning a generic denial.
      effectiveAuthz = fresh.authz;
      effectiveTrustedResourceId = trustedOverride ? fresh.verifiedOverride.id : null;
      rows = await updateTaskForAcknowledgement({
        tenantId: tid,
        taskId,
        actorUid: ackUid,
        authz: effectiveAuthz,
        trustedResourceId: effectiveTrustedResourceId,
        acknowledgedAt: ackedAt,
        allowBlocked,
        ackContractVersion,
        db,
      });
      if (!rows[0]) throw ackForbidden(after);
      effectiveFromStatus = after.status;
    } else {
      // Otherwise it was completed/cancelled out from under us → not acknowledgeable.
      throw AppError.invalidTransition(after.status, 'in_progress', TASK_TRANSITIONS[after.status] || []);
    }
  }

  // The guarded task UPDATE above acquires the task row lock before we touch
  // the SLA row. Corrected-result reopen follows the same task -> SLA order.
  await assertTaskSlaSourceBinding({ tenantId: tid, taskRow: rows[0], db });

  // Acknowledging a critical result STOPS the SLA clock (audit C-3): complete
  // the linked mig-269 instance so it leaves 'active'/'breached' and the
  // escalation backfill stops re-creating a task for this already-handled
  // result. Inside a caller transaction both this write and the audit comment
  // are load-bearing so all acknowledgement state commits or rolls back as one.
  await completeLinkedSla({
    tenantId: tid,
    taskRow: rows[0],
    db,
    completedBy: ackUid,
    completionTrigger: 'acknowledgement',
    completedAt: ackedAt,
    ackContractVersion,
    strict: Boolean(tx),
  });

  const overrideNote = effectiveAuthz.mode === 'override'
    ? ` [override ${effectiveAuthz.source}:${effectiveAuthz.id}: ${effectiveAuthz.reason}]`
    : '';
  const commentWrite = () => postTaskComment({
    tenantId: tid,
    taskId,
    authorUid: ackUid,
    body: `Task acknowledged (${effectiveFromStatus} → in_progress) via ${effectiveAuthz.mode}${overrideNote}`,
    bodyKind: 'state_change',
    metadata: {
      from: effectiveFromStatus, to: 'in_progress', acknowledged_at: ackedAt, via: effectiveAuthz.mode,
      ...(ackContractVersion ? { ack_contract_version: ackContractVersion } : {}),
      ...(effectiveAuthz.mode === 'override' ? {
        override_source: effectiveAuthz.source,
        override_id: effectiveAuthz.id,
        override_reason: effectiveAuthz.reason,
      } : {}),
    },
    tx,
  });
  if (tx) {
    await commentWrite();
  } else {
    try {
      await commentWrite();
    } catch (err) {
      logger.warn('acknowledgeTask: state_change comment failed', { taskId, err: err?.message });
    }
  }
  return rows[0];
}

export async function acknowledgeTask({
  tenantId = null, id, actorUid = null, actorRoles = [], actorPrimaryRole = null,
  actorRawRole = null,
  breakGlassId = null,
  executorAuthority = null, tx = null,
} = {}) {
  const args = {
    tenantId, id, actorUid, actorRoles, actorPrimaryRole, actorRawRole,
    breakGlassId, executorAuthority, tx,
  };
  if (tx) return acknowledgeTaskInternal(args);

  const tid = resolveTenantId({ tenantId });
  return setTenantTx(tid, (tenantTx) => acknowledgeTaskInternal({
    ...args,
    tenantId: tid,
    tx: tenantTx,
  }));
}

export async function acknowledgeLabCriticalAlertTaskFromTrustedWorkflow({
  tenantId = null,
  id,
  alertId,
  resultId,
  patientUid,
  actorUid = null,
  actorRoles = [],
  actorPrimaryRole = null,
  actorRawRole = null,
  breakGlassId = null,
  tx = null,
} = {}) {
  if (!tx) {
    throw AppError.internal(
      'Critical-alert task acknowledgement requires a transaction',
      'LAB_CRITICAL_ALERT_ACK_TRANSACTION_REQUIRED',
    );
  }
  return acknowledgeTaskInternal({
    tenantId,
    id,
    actorUid,
    actorRoles,
    actorPrimaryRole,
    actorRawRole,
    breakGlassId,
    labCriticalAlertAuthority: {
      capability: LAB_CRITICAL_ALERT_ACKNOWLEDGEMENT_AUTHORITY,
      alertId,
      resultId,
      patientUid,
    },
    tx,
  });
}

export async function acknowledgeColdChainTaskFromTrustedWorkflow({
  tenantId = null,
  id,
  actorUid = null,
  actorRoles = [],
  actorPrimaryRole = null,
  actorRawRole = null,
  excursionId,
  tx = null,
} = {}) {
  if (!tx) {
    throw AppError.internal(
      'Trusted workflow acknowledgement requires a transaction',
      'TRUSTED_TASK_ACK_TRANSACTION_REQUIRED',
    );
  }
  const trustedOverride = {
    source: COLD_CHAIN_ACK_SOURCE,
    reason: COLD_CHAIN_ACK_REASON,
    id: String(excursionId),
  };
  return acknowledgeTaskInternal({
    tenantId, id, actorUid, actorRoles, actorPrimaryRole, actorRawRole, trustedOverride, tx,
  });
}

/**
 * Results-inbox query: the open work for "me or my role".
 *
 * Returns tasks in the active inbox statuses (open / in_progress / overdue)
 * assigned to `assigneeUid` OR to any of `roles`, ordered by clinical urgency
 * (priority, then due_at). Thin wrapper over the same raw SELECT `listTasks`
 * uses; degrades to empty when the schema is absent (mirrors listTasks).
 */
export async function listInboxTasks({
  tenantId = null,
  assigneeUid = null,
  roles = [],
  primaryRole = null,
  rawRole = null,
  limit = DEFAULT_LIST_LIMIT,
  tx = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  if (!tx) {
    return setTenantTx(tid, (tenantTx) => listInboxTasks({
      tenantId: tid,
      assigneeUid,
      roles,
      primaryRole,
      rawRole,
      limit,
      tx: tenantTx,
    }));
  }
  const actor = await resolveCurrentHumanActorTx({
    tx,
    tenantId: tid,
    actorUid: assigneeUid,
    authenticatedRoles: roles,
    authenticatedPrimaryRole: primaryRole,
    authenticatedRawRole: rawRole,
    rolePredicate: isTaskHumanOwnerRole,
  });

  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await tx.$queryRawUnsafe(
      `SELECT ${TASK_RETURNING} FROM tasks
       WHERE tenant_id = $1::uuid
         AND status IN ('open', 'in_progress', 'overdue')
         AND (
           assigned_to_uid = $2::uuid
           OR (
             assigned_to_uid IS NULL
             AND UPPER(BTRIM(assigned_to_role)) = $3::text
           )
         )
       ORDER BY
         CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
         due_at NULLS LAST,
         created_at DESC
       LIMIT $4`,
      tid,
      actor.uid,
      actor.queueRole,
      safeLimit,
    );
    return { tasks: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { tasks: [], count: 0 };
    throw err;
  }
}

export async function settleCoveringTransferReviewTaskTx({
  tenantId = null,
  id,
  handoffId,
  recipientUid,
  actorUid,
  outcome,
  reason = null,
  tx,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  if (!tx) {
    throw AppError.internal(
      'Covering-transfer task settlement requires a transaction',
      'COVERING_TRANSFER_TASK_TX_REQUIRED',
    );
  }
  const taskId = normalizeId(id, 'task id');
  const cleanHandoffId = maybeUuid(handoffId, 'handoff_id');
  const cleanRecipientUid = maybeUuid(recipientUid, 'recipient_uid');
  const cleanActorUid = requireActorUid(actorUid);
  const cleanOutcome = normalizeEnum(
    outcome,
    ['accepted', 'declined', 'cancelled'],
    'outcome',
    { required: true },
  );
  const cleanReason = safeText(reason, TEXT_MAX);
  if (cleanOutcome !== 'accepted' && !cleanReason) {
    throw AppError.badRequest(
      'A reason is required to close a covering-transfer task',
      'COVERING_TRANSFER_TASK_REASON_REQUIRED',
    );
  }

  const current = await getTaskForUpdate({ tenantId: tid, id: taskId, db: tx });
  assertGenericTaskMutationAllowed(current, COVERING_TRANSFER_TASK_AUTHORITY);
  const bindings = await tx.$queryRawUnsafe(
    `SELECT chi.id
       FROM care_handoff_instances chi
       JOIN tasks task
         ON task.tenant_id = chi.tenant_id
        AND task.id = chi.task_id
      WHERE chi.tenant_id = $1::uuid
        AND chi.id = $2::uuid
        AND chi.task_id = $3::bigint
        AND chi.intended_recipient_uid = $4::uuid
        AND chi.handoff_type = 'covering_clinician_reassignment'
        AND chi.status = 'requested'
        AND task.patient_uid = chi.patient_uid
        AND task.workflow_run_id IS NULL
        AND task.workflow_step_id IS NULL
        AND task.task_kind = 'pathway_owner_transfer_review'
        AND task.related_resource_type = 'care_handoff_instance'
        AND task.related_resource_id = chi.id::text
        AND task.assigned_to_uid = chi.intended_recipient_uid
        AND task.assigned_to_role IS NULL
        AND task.workflow_sla_instance_id IS NULL
        AND task.sla_completion_semantics = 'none'
      LIMIT 1
      FOR SHARE`,
    tid,
    cleanHandoffId,
    taskId,
    cleanRecipientUid,
  );
  if (
    !bindings[0]
    || current.workflow_run_id !== null
    || current.workflow_step_id !== null
    || String(current.patient_uid || '') === ''
    || current.related_resource_type !== 'care_handoff_instance'
    || String(current.related_resource_id || '').toLowerCase() !== cleanHandoffId.toLowerCase()
    || String(current.assigned_to_uid || '').toLowerCase() !== cleanRecipientUid.toLowerCase()
    || current.assigned_to_role !== null
    || current.workflow_sla_instance_id !== null
    || current.sla_completion_semantics !== 'none'
    || !TASK_CLAIMABLE_STATUSES.has(current.status)
  ) {
    throw AppError.conflict(
      'Covering-transfer review task binding is invalid',
      'COVERING_TRANSFER_TASK_BINDING_INVALID',
    );
  }

  const nextStatus = cleanOutcome === 'accepted' ? 'completed' : 'cancelled';
  const settledAt = new Date().toISOString();
  const rows = await tx.$queryRawUnsafe(
    `UPDATE tasks
        SET status = $3::text,
            completed_at = CASE WHEN $3::text = 'completed' THEN $4::timestamptz ELSE NULL END,
            cancelled_at = CASE WHEN $3::text = 'cancelled' THEN $4::timestamptz ELSE NULL END,
            cancellation_reason = CASE WHEN $3::text = 'cancelled' THEN $5::text ELSE NULL END,
            metadata = COALESCE(metadata, '{}'::jsonb)
              || jsonb_build_object(
                   'covering_transfer_outcome', $6::text,
                   'covering_transfer_settled_by', $7::text,
                   'covering_transfer_settled_at', $4::text
                 ),
            updated_at = NOW()
      WHERE tenant_id = $1::uuid
        AND id = $2::bigint
        AND status = $8::text
      RETURNING ${TASK_RETURNING}`,
    tid,
    taskId,
    nextStatus,
    settledAt,
    cleanReason,
    cleanOutcome,
    cleanActorUid,
    current.status,
  );
  const settled = rows[0];
  if (!settled) {
    throw AppError.conflict(
      'Covering-transfer review task changed before settlement',
      'COVERING_TRANSFER_TASK_CAS_CONFLICT',
    );
  }
  await postTaskComment({
    tenantId: tid,
    taskId,
    authorUid: cleanActorUid,
    body: `Covering clinician transfer ${cleanOutcome}`,
    bodyKind: 'state_change',
    metadata: {
      from: current.status,
      to: nextStatus,
      outcome: cleanOutcome,
      handoff_id: cleanHandoffId,
      ...(cleanReason ? { reason: cleanReason } : {}),
    },
    tx,
  });
  return settled;
}

export async function reassignTask({
  tenantId = null, id, assignedToUid, assignedToRole,
  executorAuthority = null,
  tx = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const taskId = normalizeId(id, 'task id');
  const db = tx || prisma;
  if (assignedToUid === undefined && assignedToRole === undefined) {
    throw AppError.badRequest(
      'Task reassignment requires a user or role field',
      'TASK_ASSIGNMENT_REQUIRED',
    );
  }
  const assignment = normalizeTaskAssignment({ assignedToUid, assignedToRole });
  const updates = [
    'assigned_to_uid = $1::uuid',
    'assigned_to_role = $2',
    'updated_at = NOW()',
  ];
  const params = [assignment.uid, assignment.role];
  if (!tx) {
    return setTenantTx(tid, (scopedTx) => reassignTask({
      tenantId: tid,
      id: taskId,
      assignedToUid,
      assignedToRole,
      executorAuthority,
      tx: scopedTx,
    }));
  }
  const current = await getTaskForUpdate({ tenantId: tid, id: taskId, db });
  assertGenericTaskMutationAllowed(current);
  const attachedRunId = await taskRowWorkflowRunId({ tenantId: tid, taskRow: current, db });
  await assertPathwayExecutorAuthority({
    tenantId: tid,
    workflowRunId: attachedRunId,
    db,
    executorAuthority,
  });
  params.push(taskId);
  params.push(tid);
  const rows = await db.$queryRawUnsafe(
    `UPDATE tasks SET ${updates.join(', ')}
     WHERE id = $${params.length - 1} AND tenant_id = $${params.length}::uuid
     RETURNING ${TASK_RETURNING}`,
    ...params,
  );
  if (!rows[0]) throw AppError.notFound('Task not found');
  return rows[0];
}

export async function postTaskComment({
  tenantId = null, taskId,
  authorUid = null, body, bodyKind = 'comment',
  metadata = null,
  tx = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanTaskId = normalizeId(taskId, 'task_id');
  const cleanBody = safeText(body);
  if (!cleanBody) throw AppError.badRequest('body is required');
  const db = tx || prisma;
  try {
    const rows = await db.$queryRawUnsafe(
      `INSERT INTO task_comments
         (tenant_id, task_id, author_uid, body, body_kind, metadata)
       VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6::jsonb)
       RETURNING id, tenant_id, task_id, author_uid, body, body_kind, metadata, created_at`,
      tid, cleanTaskId, maybeUuid(authorUid, 'author_uid'),
      cleanBody,
      normalizeEnum(bodyKind, TASK_COMMENT_KINDS, 'body_kind') || 'comment',
      JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
    );
    return rows[0];
  } catch (err) {
    if (isFkViolation(err)) throw AppError.badRequest('Invalid task_id');
    throw err;
  }
}

export async function listTaskComments({
  tenantId = null, taskId, limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanTaskId = normalizeId(taskId, 'task_id');
  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, task_id, author_uid, body, body_kind, metadata, created_at
       FROM task_comments
       WHERE tenant_id = $1::uuid AND task_id = $2
       ORDER BY created_at ASC
       LIMIT $3`,
      tid, cleanTaskId, safeLimit,
    );
    return { comments: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { comments: [], count: 0 };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Workflow definitions
// ---------------------------------------------------------------------------

const WORKFLOW_DEF_RETURNING = `id, tenant_id, workflow_key, version, display_name,
  description, category, steps, triggers, defaults, is_active,
  created_by, created_at, updated_at`;

export async function createWorkflowDefinition({
  tenantId = null,
  workflowKey,
  version = 1,
  displayName = null,
  description = null,
  category = null,
  steps = null,
  triggers = null,
  defaults = null,
  isActive = false,
  createdBy = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanKey = safeText(workflowKey, 120);
  if (!cleanKey) throw AppError.badRequest('workflow_key is required');
  const cleanVersion = normalizeInt(version, 'version', { min: 1, max: 1000 }) || 1;
  const normalizedSteps = validateWorkflowDefinitionSteps(steps);
  const normalizedTriggers = normalizeJsonArray(triggers, 'triggers');
  if (normalizedTriggers.length > 0) {
    throw AppError.badRequest(
      'Workflow definition triggers are unavailable until registered handlers exist',
      'WORKFLOW_TRIGGER_ACTIVATION_UNAVAILABLE',
    );
  }
  const cleanIsActive = normalizeBoolean(isActive, false);
  if (cleanIsActive) {
    throw AppError.badRequest(
      'New workflow definitions must be inactive until governance activation is available',
      'WORKFLOW_DEFINITION_ACTIVATION_UNAVAILABLE',
    );
  }
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO workflow_definitions
         (tenant_id, workflow_key, version, display_name, description, category,
          steps, triggers, defaults, is_active, created_by)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11::uuid)
       RETURNING ${WORKFLOW_DEF_RETURNING}`,
      tid, cleanKey, cleanVersion,
      safeText(displayName, SHORT_MAX), safeText(description),
      safeText(category, 80),
      JSON.stringify(normalizedSteps),
      JSON.stringify(normalizedTriggers),
      JSON.stringify(normalizeJsonObject(defaults, 'defaults')),
      false,
      maybeUuid(createdBy, 'created_by'),
    );
    return rows[0];
  } catch (err) {
    if (/duplicate key value/i.test(String(err?.message || ''))) {
      throw AppError.conflict(`workflow_key/version pair already exists: ${cleanKey} v${cleanVersion}`);
    }
    throw err;
  }
}

export async function listWorkflowDefinitions({
  tenantId = null, isActive = null, category = null, limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (isActive !== null) {
    params.push(normalizeBoolean(isActive));
    filters.push(`is_active = $${params.length}`);
  }
  if (category) {
    params.push(safeText(category, 80));
    filters.push(`category = $${params.length}`);
  }
  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${WORKFLOW_DEF_RETURNING} FROM workflow_definitions
       WHERE ${filters.join(' AND ')}
       ORDER BY workflow_key, version DESC
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    return { definitions: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { definitions: [], count: 0 };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Workflow runs (start + transition)
// ---------------------------------------------------------------------------

const WORKFLOW_RUN_RETURNING = `id, tenant_id, workflow_definition_id, workflow_key, workflow_version,
  pathway_governance_id, pathway_definition_checksum,
  trigger_kind, trigger_payload, status, current_step_key, context,
  started_at, ended_at, due_at, initiated_by, failure_reason,
  metadata, created_at, updated_at`;

export async function startWorkflowRun({
  tenantId = null,
  workflowDefinitionId,
  triggerKind = 'manual',
  triggerPayload = null,
  context = null,
  dueAt = null,
  initiatedBy = null,
  metadata = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const defId = normalizeId(workflowDefinitionId, 'workflow_definition_id');
  const cleanInitiatedBy = requireActorUid(initiatedBy, 'initiated_by');
  try {
    return await setTenantTx(tid, async (tx) => {
      const definitions = await tx.$queryRawUnsafe(
        `SELECT definition.id, definition.workflow_key, definition.version,
                definition.steps, definition.triggers, definition.is_active,
                EXISTS (
                  SELECT 1
                    FROM care_pathway_definition_governance AS governance
                   WHERE governance.tenant_id = definition.tenant_id
                     AND governance.workflow_definition_id = definition.id
                ) AS has_pathway_governance
           FROM workflow_definitions AS definition
          WHERE definition.id = $1 AND definition.tenant_id = $2::uuid
         LIMIT 1
         FOR SHARE`,
        defId, tid,
      );
      if (!definitions[0]) throw AppError.notFound('Workflow definition not found');
      const definition = definitions[0];
      if (definition.has_pathway_governance === true) {
        throw AppError.conflict(
          'Governed care pathway definitions must be started through the pathway executor',
          'CARE_PATHWAY_DEFINITION_REQUIRES_PATHWAY_EXECUTOR',
        );
      }
      if (!definition.is_active) {
        throw AppError.badRequest('Workflow definition is inactive', 'INACTIVE_WORKFLOW_DEFINITION');
      }
      const normalizedSteps = validateWorkflowDefinitionSteps(definition.steps);
      const normalizedTriggers = normalizeJsonArray(definition.triggers, 'triggers');
      if (normalizedTriggers.length > 0) {
        throw AppError.badRequest(
          'Workflow definition contains unregistered triggers',
          'WORKFLOW_TRIGGER_ACTIVATION_UNAVAILABLE',
        );
      }

      const runRows = await tx.$queryRawUnsafe(
        `INSERT INTO workflow_runs
           (tenant_id, workflow_definition_id, workflow_key, workflow_version,
            trigger_kind, trigger_payload, status, context,
            due_at, initiated_by, metadata)
         VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb, 'started', $7::jsonb,
           to_timestamp($8::double precision / 1000.0), $9::uuid, $10::jsonb)
         RETURNING ${WORKFLOW_RUN_RETURNING}`,
        tid, definition.id, definition.workflow_key, definition.version,
        normalizeEnum(triggerKind, WORKFLOW_TRIGGER_KINDS, 'trigger_kind') || 'manual',
        JSON.stringify(normalizeJsonObject(triggerPayload, 'trigger_payload')),
        JSON.stringify(normalizeJsonObject(context, 'context')),
        normalizeTimestamp(dueAt, 'due_at'),
        cleanInitiatedBy,
        JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
      );
      const run = runRows[0];

      for (const [order, step] of normalizedSteps.entries()) {
        await tx.$queryRawUnsafe(
          `INSERT INTO workflow_steps
             (tenant_id, workflow_run_id, step_key, display_name, step_kind,
               status, ordering, assigned_role, due_at, metadata)
            VALUES ($1::uuid, $2, $3, $4, $5, 'pending', $6, $7,
              to_timestamp($8::double precision / 1000.0), $9::jsonb)`,
          tid, run.id, step.step_key,
          step.display_name,
          step.step_kind, order,
          step.assigned_role,
          normalizeTimestamp(step.due_at, `steps[${order}].due_at`),
          JSON.stringify(step.metadata),
        );
      }
      return run;
    });
  } catch (err) {
    if (isFkViolation(err)) throw AppError.badRequest('Invalid foreign key reference');
    throw err;
  }
}

export async function listWorkflowRuns({
  tenantId = null, status = null, workflowKey = null,
  limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (status) {
    params.push(normalizeEnum(status, WORKFLOW_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  if (workflowKey) {
    params.push(safeText(workflowKey, 120));
    filters.push(`workflow_key = $${params.length}`);
  }
  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${WORKFLOW_RUN_RETURNING} FROM workflow_runs
       WHERE ${filters.join(' AND ')}
       ORDER BY started_at DESC
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    return { runs: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { runs: [], count: 0 };
    throw err;
  }
}

export async function transitionWorkflowRun({
  tenantId = null, id, nextStatus,
  failureReason = null, currentStepKey = null,
  actorUid = null,
  executorAuthority = null,
  tx = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const runId = normalizeId(id, 'workflow_run id');
  const cleanStatus = normalizeEnum(nextStatus, WORKFLOW_STATUSES, 'next_status', { required: true });
  requireActorUid(actorUid);
  if (!tx) {
    return setTenantTx(tid, (scopedTx) => transitionWorkflowRun({
      tenantId: tid,
      id: runId,
      nextStatus: cleanStatus,
      failureReason,
      currentStepKey,
      actorUid,
      executorAuthority,
      tx: scopedTx,
    }));
  }
  const db = tx;
  await assertPathwayExecutorAuthority({
    tenantId: tid,
    workflowRunId: runId,
    db,
    executorAuthority,
  });
  const currentRows = await db.$queryRawUnsafe(
    `SELECT id, status FROM workflow_runs
     WHERE id = $1 AND tenant_id = $2::uuid LIMIT 1`,
    runId, tid,
  );
  if (!currentRows[0]) throw AppError.notFound('Workflow run not found');
  const currentStatus = currentRows[0].status;
  const allowed = WORKFLOW_RUN_TRANSITIONS[currentStatus] || [];
  if (!allowed.includes(cleanStatus)) {
    throw AppError.invalidTransition(currentStatus, cleanStatus, allowed);
  }
  const updates = ['status = $1', 'updated_at = NOW()'];
  const params = [cleanStatus];
  if (currentStepKey !== null) {
    params.push(safeText(currentStepKey, 120));
    updates.push(`current_step_key = $${params.length}`);
  }
  if (cleanStatus === 'completed' || cleanStatus === 'failed' || cleanStatus === 'cancelled') {
    params.push(Date.now());
    updates.push(`ended_at = to_timestamp($${params.length}::double precision / 1000.0)`);
  }
  if (cleanStatus === 'failed' && failureReason) {
    params.push(safeText(failureReason));
    updates.push(`failure_reason = $${params.length}`);
  }
  params.push(runId);
  params.push(tid);
  params.push(currentStatus);
  const rows = await db.$queryRawUnsafe(
    `UPDATE workflow_runs SET ${updates.join(', ')}
     WHERE id = $${params.length - 2}
       AND tenant_id = $${params.length - 1}::uuid
       AND status = $${params.length}
     RETURNING ${WORKFLOW_RUN_RETURNING}`,
    ...params,
  );
  if (!rows[0]) {
    const latest = await db.$queryRawUnsafe(
      `SELECT id FROM workflow_runs
       WHERE id = $1 AND tenant_id = $2::uuid LIMIT 1`,
      runId, tid,
    );
    if (!latest[0]) throw AppError.notFound('Workflow run not found');
    throw AppError.conflict(
      'Workflow run status changed before transition completed',
      'WORKFLOW_RUN_TRANSITION_CONFLICT',
    );
  }
  return rows[0];
}

export async function listWorkflowSteps({ tenantId = null, workflowRunId } = {}) {
  const tid = resolveTenantId({ tenantId });
  const runId = normalizeId(workflowRunId, 'workflow_run_id');
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, workflow_run_id, step_key, display_name, step_kind,
              status, ordering, assigned_to, assigned_role,
              due_at, started_at, completed_at, outcome, outcome_payload,
              metadata, created_at, updated_at
       FROM workflow_steps
       WHERE tenant_id = $1::uuid AND workflow_run_id = $2
       ORDER BY ordering, step_key`,
      tid, runId,
    );
    return { steps: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { steps: [], count: 0 };
    throw err;
  }
}

export async function transitionWorkflowStep({
  tenantId = null, workflowRunId, stepKey, nextStatus,
  outcome = null, outcomePayload = null,
  actorUid = null,
  executorAuthority = null,
  tx = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const runId = normalizeId(workflowRunId, 'workflow_run_id');
  const cleanStatus = normalizeEnum(nextStatus, WORKFLOW_STEP_STATUSES, 'next_status', { required: true });
  requireActorUid(actorUid);
  const cleanStepKey = safeText(stepKey, 120);
  if (!cleanStepKey) throw AppError.badRequest('step_key is required');
  if (!tx) {
    return setTenantTx(tid, (scopedTx) => transitionWorkflowStep({
      tenantId: tid,
      workflowRunId: runId,
      stepKey: cleanStepKey,
      nextStatus: cleanStatus,
      outcome,
      outcomePayload,
      actorUid,
      executorAuthority,
      tx: scopedTx,
    }));
  }
  const db = tx;
  await assertPathwayExecutorAuthority({
    tenantId: tid,
    workflowRunId: runId,
    db,
    executorAuthority,
  });
  const currentRows = await db.$queryRawUnsafe(
    `SELECT id, status FROM workflow_steps
     WHERE workflow_run_id = $1 AND step_key = $2 AND tenant_id = $3::uuid LIMIT 1`,
    runId, cleanStepKey, tid,
  );
  if (!currentRows[0]) throw AppError.notFound('Workflow step not found');
  const currentStatus = currentRows[0].status;
  const allowed = WORKFLOW_STEP_TRANSITIONS[currentStatus] || [];
  if (!allowed.includes(cleanStatus)) {
    throw AppError.invalidTransition(currentStatus, cleanStatus, allowed);
  }
  const updates = ['status = $1', 'updated_at = NOW()'];
  const params = [cleanStatus];
  if (cleanStatus === 'in_progress') {
    params.push(Date.now());
    updates.push(`started_at = COALESCE(started_at, to_timestamp($${params.length}::double precision / 1000.0))`);
  }
  if (cleanStatus === 'completed' || cleanStatus === 'skipped' || cleanStatus === 'failed') {
    params.push(Date.now());
    updates.push(`completed_at = to_timestamp($${params.length}::double precision / 1000.0)`);
  }
  if (outcome) {
    params.push(safeText(outcome, 40));
    updates.push(`outcome = $${params.length}`);
  }
  if (outcomePayload) {
    params.push(JSON.stringify(normalizeJsonObject(outcomePayload, 'outcome_payload')));
    updates.push(`outcome_payload = $${params.length}::jsonb`);
  }
  params.push(runId);
  params.push(cleanStepKey);
  params.push(tid);
  params.push(currentStatus);
  const rows = await db.$queryRawUnsafe(
    `UPDATE workflow_steps SET ${updates.join(', ')}
     WHERE workflow_run_id = $${params.length - 3}
       AND step_key = $${params.length - 2}
       AND tenant_id = $${params.length - 1}::uuid
       AND status = $${params.length}
     RETURNING id, tenant_id, workflow_run_id, step_key, status, outcome, outcome_payload, completed_at`,
    ...params,
  );
  if (!rows[0]) {
    const latest = await db.$queryRawUnsafe(
      `SELECT id FROM workflow_steps
       WHERE workflow_run_id = $1 AND step_key = $2 AND tenant_id = $3::uuid LIMIT 1`,
      runId, cleanStepKey, tid,
    );
    if (!latest[0]) throw AppError.notFound('Workflow step not found');
    throw AppError.conflict(
      'Workflow step status changed before transition completed',
      'WORKFLOW_STEP_TRANSITION_CONFLICT',
    );
  }
  return rows[0];
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

const APPROVAL_RETURNING = `id, tenant_id, workflow_run_id, workflow_step_id, task_id,
  approval_kind, subject_resource_type, subject_resource_id,
  required_approvers, required_role, status, approved_by,
  rejection_reason, expires_at, decided_at,
  created_by, decided_by, materialization_key,
  metadata, created_at, updated_at`;

export async function createApproval({
  tenantId = null,
  workflowRunId = null,
  workflowStepId = null,
  taskId = null,
  approvalKind,
  subjectResourceType = null,
  subjectResourceId = null,
  requiredApprovers = 1,
  requiredRole = null,
  expiresAt = null,
  createdBy = null,
  materializationKey = null,
  metadata = null,
  executorAuthority = null,
  tx = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanKind = safeText(approvalKind, 80);
  if (!cleanKind) throw AppError.badRequest('approval_kind is required');
  assertGenericApprovalKindAllowed(cleanKind);
  const db = tx || prisma;
  const cleanWorkflowRunId = workflowRunId ? normalizeId(workflowRunId, 'workflow_run_id') : null;
  const cleanWorkflowStepId = workflowStepId ? normalizeId(workflowStepId, 'workflow_step_id') : null;
  const cleanTaskId = taskId ? normalizeId(taskId, 'task_id') : null;
  const verifiedExecutorAuthority = await hasPathwayExecutorAuthority(executorAuthority);
  if (!verifiedExecutorAuthority) {
    await assertPathwayExecutorAuthority({
      tenantId: tid,
      workflowRunId: cleanWorkflowRunId,
      db,
      executorAuthority,
      verifiedExecutorAuthority,
    });
    const attachedTaskRunId = await taskWorkflowRunId({ tenantId: tid, taskId: cleanTaskId, db });
    if (attachedTaskRunId && String(attachedTaskRunId) !== String(cleanWorkflowRunId || '')) {
      await assertPathwayExecutorAuthority({
        tenantId: tid,
        workflowRunId: attachedTaskRunId,
        db,
        executorAuthority,
      });
    }
    const attachedStepRunId = await stepWorkflowRunId({
      tenantId: tid,
      workflowStepId: cleanWorkflowStepId,
      db,
    });
    if (attachedStepRunId && String(attachedStepRunId) !== String(cleanWorkflowRunId || '')) {
      await assertPathwayExecutorAuthority({
        tenantId: tid,
        workflowRunId: attachedStepRunId,
        db,
        executorAuthority,
      });
    }
  }
  try {
    const rows = await db.$queryRawUnsafe(
      `INSERT INTO approvals
         (tenant_id, workflow_run_id, workflow_step_id, task_id,
           approval_kind, subject_resource_type, subject_resource_id,
           required_approvers, required_role, status, expires_at,
           created_by, materialization_key, metadata)
        VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, 'pending',
          to_timestamp($10::double precision / 1000.0),
          $11::uuid, $12, $13::jsonb)
        RETURNING ${APPROVAL_RETURNING}`,
      tid,
      cleanWorkflowRunId,
      cleanWorkflowStepId,
      cleanTaskId,
      cleanKind,
      safeText(subjectResourceType, 60),
      safeText(subjectResourceId, 120),
      normalizeInt(requiredApprovers, 'required_approvers', { min: 1, max: 100 }) || 1,
      safeText(requiredRole, 80),
      normalizeTimestamp(expiresAt, 'expires_at'),
      maybeUuid(createdBy, 'created_by'),
      safeText(materializationKey, 200),
      JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
    );
    return rows[0];
  } catch (err) {
    if (isFkViolation(err)) throw AppError.badRequest('Invalid foreign key reference');
    throw err;
  }
}

export async function recordApprovalDecision({
  tenantId = null, id, actorUid, actorRoles = [], decision, rejectionReason = null,
  executorAuthority = null, tx = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const apId = normalizeId(id, 'approval id');
  const cleanApprover = requireActorUid(actorUid).toLowerCase();
  const roles = actorRolesUpper(actorRoles);
  if (decision !== 'approve' && decision !== 'reject') {
    throw AppError.badRequest('decision must be "approve" or "reject"');
  }
  if (!tx) {
    return setTenantTx(tid, (scopedTx) => recordApprovalDecision({
      tenantId: tid,
      id: apId,
      actorUid: cleanApprover,
      actorRoles,
      decision,
      rejectionReason,
      executorAuthority,
      tx: scopedTx,
    }));
  }

  const current = await tx.$queryRawUnsafe(
      `SELECT id, status, approval_kind, approved_by, required_approvers, required_role,
              workflow_run_id, workflow_step_id, task_id,
              expires_at,
              (expires_at IS NOT NULL AND expires_at <= NOW()) AS is_expired
         FROM approvals
       WHERE id = $1 AND tenant_id = $2::uuid
       FOR UPDATE`,
      apId, tid,
  );
  if (!current[0]) throw AppError.notFound('Approval not found');
  const attachedRunId = current[0].workflow_run_id
    || await taskWorkflowRunId({ tenantId: tid, taskId: current[0].task_id, db: tx })
    || await stepWorkflowRunId({
      tenantId: tid,
      workflowStepId: current[0].workflow_step_id,
      db: tx,
    });
  await assertPathwayExecutorAuthority({
    tenantId: tid,
    workflowRunId: attachedRunId,
    db: tx,
    executorAuthority,
  });
  assertGenericApprovalKindAllowed(current[0].approval_kind);
  if (current[0].status !== 'pending') {
    throw AppError.badRequest(`Approval already ${current[0].status}`);
  }
  if (current[0].is_expired) {
    throw AppError.conflict('Approval has expired', 'APPROVAL_EXPIRED');
  }

  const requiredRole = safeText(current[0].required_role, 80)?.toUpperCase() || null;
  const isTaskAdministrator = roles.some((role) => isAdmin(role)) || roles.includes('SUPER_ADMIN');
  if (requiredRole && !roles.includes(requiredRole) && !isTaskAdministrator) {
    throw AppError.forbidden('Not authorized to decide this approval');
  }

  if (decision === 'reject') {
    const rows = await tx.$queryRawUnsafe(
        `UPDATE approvals
         SET status = 'rejected', rejection_reason = $1,
             decided_by = $2::uuid, decided_at = NOW(), updated_at = NOW()
         WHERE id = $3 AND tenant_id = $4::uuid AND status = 'pending'
         RETURNING ${APPROVAL_RETURNING}`,
        safeText(rejectionReason), cleanApprover, apId, tid,
      );
    if (!rows[0]) {
      throw AppError.conflict('Approval status changed before decision completed', 'APPROVAL_DECISION_CONFLICT');
    }
    return rows[0];
  }

  const existingApprovers = Array.isArray(current[0].approved_by) ? current[0].approved_by : [];
  if (existingApprovers.some(
    (entry) => String(entry?.uid || '').toLowerCase() === cleanApprover,
  )) {
    throw AppError.badRequest('Approver has already approved this gate');
  }
  const next = [...existingApprovers, { uid: cleanApprover, at: new Date().toISOString() }];
  const required = Number(current[0].required_approvers || 1);
  const reachQuorum = next.length >= required;

  const rows = await tx.$queryRawUnsafe(
      `UPDATE approvals
       SET approved_by = $1::jsonb,
           status = $2,
           decided_by = $3::uuid,
           decided_at = CASE WHEN $3::uuid IS NOT NULL THEN NOW() ELSE NULL END,
           updated_at = NOW()
       WHERE id = $4 AND tenant_id = $5::uuid AND status = 'pending'
       RETURNING ${APPROVAL_RETURNING}`,
      JSON.stringify(next),
      reachQuorum ? 'approved' : 'pending',
      reachQuorum ? cleanApprover : null,
      apId, tid,
    );
  if (!rows[0]) {
    throw AppError.conflict('Approval status changed before decision completed', 'APPROVAL_DECISION_CONFLICT');
  }
  return rows[0];
}

export async function listApprovals({
  tenantId = null, status = null, workflowRunId = null, taskId = null,
  limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (status) {
    params.push(normalizeEnum(status, APPROVAL_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  if (workflowRunId) {
    params.push(normalizeId(workflowRunId, 'workflow_run_id'));
    filters.push(`workflow_run_id = $${params.length}`);
  }
  if (taskId) {
    params.push(normalizeId(taskId, 'task_id'));
    filters.push(`task_id = $${params.length}`);
  }
  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${APPROVAL_RETURNING} FROM approvals
       WHERE ${filters.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    return { approvals: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { approvals: [], count: 0 };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Escalation rules + SLA + automation rules (CRUD only — engine left to a
// follow-up). These tables matter for hospitals that want to plug their
// own rule engine in later.
// ---------------------------------------------------------------------------

export async function upsertEscalationRule({
  tenantId = null,
  id = null,
  displayName,
  description = null,
  scope = 'task',
  matchFilter = null,
  triggerCondition,
  triggerWindowMinutes = null,
  actionKind,
  actionPayload = null,
  isActive = true,
  createdBy = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanName = safeText(displayName, SHORT_MAX);
  if (!cleanName) throw AppError.badRequest('display_name is required');

  if (id) {
    const ruleId = normalizeId(id, 'escalation_rule id');
    const rows = await prisma.$queryRawUnsafe(
      `UPDATE escalation_rules
       SET display_name = $1, description = $2, scope = $3, match_filter = $4::jsonb,
           trigger_condition = $5, trigger_window_minutes = $6,
           action_kind = $7, action_payload = $8::jsonb,
           is_active = $9, updated_at = NOW()
       WHERE id = $10 AND tenant_id = $11::uuid
       RETURNING id, tenant_id, display_name, description, scope, match_filter,
                 trigger_condition, trigger_window_minutes, action_kind, action_payload,
                 is_active, created_by, created_at, updated_at`,
      cleanName, safeText(description),
      normalizeEnum(scope, ESCALATION_SCOPES, 'scope') || 'task',
      JSON.stringify(normalizeJsonObject(matchFilter, 'match_filter')),
      normalizeEnum(triggerCondition, ESCALATION_TRIGGERS, 'trigger_condition', { required: true }),
      normalizeInt(triggerWindowMinutes, 'trigger_window_minutes', { min: 1, max: 1440 * 30 }),
      normalizeEnum(actionKind, ESCALATION_ACTIONS, 'action_kind', { required: true }),
      JSON.stringify(normalizeJsonObject(actionPayload, 'action_payload')),
      normalizeBoolean(isActive, true),
      ruleId, tid,
    );
    if (!rows[0]) throw AppError.notFound('Escalation rule not found');
    return rows[0];
  }

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO escalation_rules
       (tenant_id, display_name, description, scope, match_filter,
        trigger_condition, trigger_window_minutes, action_kind, action_payload,
        is_active, created_by)
     VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6, $7, $8, $9::jsonb, $10, $11::uuid)
     RETURNING id, tenant_id, display_name, description, scope, match_filter,
               trigger_condition, trigger_window_minutes, action_kind, action_payload,
               is_active, created_by, created_at, updated_at`,
    tid, cleanName, safeText(description),
    normalizeEnum(scope, ESCALATION_SCOPES, 'scope') || 'task',
    JSON.stringify(normalizeJsonObject(matchFilter, 'match_filter')),
    normalizeEnum(triggerCondition, ESCALATION_TRIGGERS, 'trigger_condition', { required: true }),
    normalizeInt(triggerWindowMinutes, 'trigger_window_minutes', { min: 1, max: 1440 * 30 }),
    normalizeEnum(actionKind, ESCALATION_ACTIONS, 'action_kind', { required: true }),
    JSON.stringify(normalizeJsonObject(actionPayload, 'action_payload')),
    normalizeBoolean(isActive, true),
    maybeUuid(createdBy, 'created_by'),
  );
  return rows[0];
}

export async function listEscalationRules({
  tenantId = null, isActive = null, scope = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (isActive !== null) {
    params.push(normalizeBoolean(isActive));
    filters.push(`is_active = $${params.length}`);
  }
  if (scope) {
    params.push(normalizeEnum(scope, ESCALATION_SCOPES, 'scope'));
    filters.push(`scope = $${params.length}`);
  }
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, display_name, description, scope, match_filter,
              trigger_condition, trigger_window_minutes, action_kind, action_payload,
              is_active, created_at, updated_at
       FROM escalation_rules
       WHERE ${filters.join(' AND ')}
       ORDER BY scope, display_name`,
      ...params,
    );
    return { rules: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { rules: [], count: 0 };
    throw err;
  }
}

export async function upsertSlaDefinition({
  tenantId = null,
  slaKey,
  displayName = null,
  description = null,
  targetMinutes,
  warnAtPct = 75,
  businessHoursOnly = false,
  metadata = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanKey = safeText(slaKey, 120);
  if (!cleanKey) throw AppError.badRequest('sla_key is required');
  const target = normalizeInt(targetMinutes, 'target_minutes', { min: 1, max: 1440 * 365 });
  if (!target) throw AppError.badRequest('target_minutes is required');
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO sla_definitions
       (tenant_id, sla_key, display_name, description,
        target_minutes, warn_at_pct, business_hours_only, metadata)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::jsonb)
     ON CONFLICT (tenant_id, sla_key) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       description = EXCLUDED.description,
       target_minutes = EXCLUDED.target_minutes,
       warn_at_pct = EXCLUDED.warn_at_pct,
       business_hours_only = EXCLUDED.business_hours_only,
       metadata = EXCLUDED.metadata,
       updated_at = NOW()
     RETURNING id, tenant_id, sla_key, display_name, description,
               target_minutes, warn_at_pct, business_hours_only, metadata,
               created_at, updated_at`,
    tid, cleanKey, safeText(displayName, SHORT_MAX), safeText(description),
    target,
    normalizeInt(warnAtPct, 'warn_at_pct', { min: 0, max: 100 }) ?? 75,
    normalizeBoolean(businessHoursOnly, false),
    JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
  );
  return rows[0];
}

export async function listSlaDefinitions({ tenantId = null } = {}) {
  const tid = resolveTenantId({ tenantId });
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, sla_key, display_name, description,
              target_minutes, warn_at_pct, business_hours_only, metadata,
              created_at, updated_at
       FROM sla_definitions
       WHERE tenant_id = $1::uuid
       ORDER BY sla_key`,
      tid,
    );
    return { slas: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { slas: [], count: 0 };
    throw err;
  }
}

export async function upsertAutomationRule({
  tenantId = null, id = null,
  displayName, description = null,
  eventType,
  matchFilter = null, actionKind, actionPayload = null,
  isActive = true, createdBy = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanName = safeText(displayName, SHORT_MAX);
  if (!cleanName) throw AppError.badRequest('display_name is required');
  const cleanEvent = safeText(eventType, 120);
  if (!cleanEvent) throw AppError.badRequest('event_type is required');

  if (id) {
    const ruleId = normalizeId(id, 'automation_rule id');
    const rows = await prisma.$queryRawUnsafe(
      `UPDATE automation_rules
       SET display_name = $1, description = $2, event_type = $3,
           match_filter = $4::jsonb, action_kind = $5, action_payload = $6::jsonb,
           is_active = $7, updated_at = NOW()
       WHERE id = $8 AND tenant_id = $9::uuid
       RETURNING id, tenant_id, display_name, description, event_type, match_filter,
                 action_kind, action_payload, is_active, last_fired_at, fire_count,
                 created_at, updated_at`,
      cleanName, safeText(description), cleanEvent,
      JSON.stringify(normalizeJsonObject(matchFilter, 'match_filter')),
      normalizeEnum(actionKind, AUTOMATION_ACTIONS, 'action_kind', { required: true }),
      JSON.stringify(normalizeJsonObject(actionPayload, 'action_payload')),
      normalizeBoolean(isActive, true),
      ruleId, tid,
    );
    if (!rows[0]) throw AppError.notFound('Automation rule not found');
    return rows[0];
  }

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO automation_rules
       (tenant_id, display_name, description, event_type, match_filter,
        action_kind, action_payload, is_active, created_by)
     VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8, $9::uuid)
     RETURNING id, tenant_id, display_name, description, event_type, match_filter,
               action_kind, action_payload, is_active, last_fired_at, fire_count,
               created_at, updated_at`,
    tid, cleanName, safeText(description), cleanEvent,
    JSON.stringify(normalizeJsonObject(matchFilter, 'match_filter')),
    normalizeEnum(actionKind, AUTOMATION_ACTIONS, 'action_kind', { required: true }),
    JSON.stringify(normalizeJsonObject(actionPayload, 'action_payload')),
    normalizeBoolean(isActive, true),
    maybeUuid(createdBy, 'created_by'),
  );
  return rows[0];
}

export async function listAutomationRules({
  tenantId = null, eventType = null, isActive = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (eventType) {
    params.push(safeText(eventType, 120));
    filters.push(`event_type = $${params.length}`);
  }
  if (isActive !== null) {
    params.push(normalizeBoolean(isActive));
    filters.push(`is_active = $${params.length}`);
  }
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, display_name, description, event_type, match_filter,
              action_kind, action_payload, is_active, last_fired_at, fire_count,
              created_at, updated_at
       FROM automation_rules
       WHERE ${filters.join(' AND ')}
       ORDER BY event_type, display_name`,
      ...params,
    );
    return { rules: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { rules: [], count: 0 };
    throw err;
  }
}

export const __testing__ = {
  TASK_STATUSES,
  TASK_TRANSITIONS,
  TASK_PRIORITIES,
  TASK_KINDS,
  WORKFLOW_RUN_TRANSITIONS,
  WORKFLOW_STEP_TRANSITIONS,
  WORKFLOW_STATUSES,
  WORKFLOW_STEP_KINDS,
  APPROVAL_STATUSES,
  resolveAckAuthorization,
};

export default {
  createTask,
  listTasks,
  listInboxTasks,
  claimInboxTask,
  getTask,
  transitionTask,
  supersedeAcknowledgementTaskFromTrustedWorkflow,
  completeTaskFromDomainEvidence,
  completePathwayTaskFromRegisteredEvidence,
  acknowledgeTask,
  acknowledgeColdChainTaskFromTrustedWorkflow,
  settleCoveringTransferReviewTaskTx,
  reassignTask,
  postTaskComment,
  listTaskComments,
  createWorkflowDefinition,
  listWorkflowDefinitions,
  startWorkflowRun,
  listWorkflowRuns,
  transitionWorkflowRun,
  listWorkflowSteps,
  transitionWorkflowStep,
  createApproval,
  recordApprovalDecision,
  listApprovals,
  upsertEscalationRule,
  listEscalationRules,
  upsertSlaDefinition,
  listSlaDefinitions,
  upsertAutomationRule,
  listAutomationRules,
};
