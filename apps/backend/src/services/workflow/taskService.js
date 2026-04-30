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

import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenantService.js';

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const TEXT_MAX = 8000;
const SHORT_MAX = 255;

export const TASK_KINDS = ['general', 'follow_up', 'review', 'escalation', 'verification', 'admin', 'consent', 'investigation', 'other'];
export const TASK_PRIORITIES = ['low', 'normal', 'high', 'critical'];
export const TASK_STATUSES = ['open', 'in_progress', 'blocked', 'completed', 'cancelled', 'overdue'];
export const TASK_COMMENT_KINDS = ['comment', 'system_event', 'state_change'];
export const WORKFLOW_TRIGGER_KINDS = ['manual', 'event', 'schedule', 'api', 'subgraph'];
export const WORKFLOW_STATUSES = ['started', 'running', 'blocked', 'completed', 'cancelled', 'failed'];
export const WORKFLOW_STEP_KINDS = ['task', 'approval', 'automation', 'wait', 'subworkflow', 'ai_call'];
export const WORKFLOW_STEP_STATUSES = ['pending', 'in_progress', 'blocked', 'completed', 'skipped', 'failed'];
export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'cancelled', 'expired'];
export const ESCALATION_SCOPES = ['task', 'workflow_step', 'approval'];
export const ESCALATION_TRIGGERS = ['sla_breach', 'no_progress_after', 'pending_too_long', 'on_status_change'];
export const ESCALATION_ACTIONS = ['notify', 'reassign', 'escalate_priority', 'auto_resolve', 'webhook'];
export const AUTOMATION_ACTIONS = ['create_task', 'start_workflow', 'create_approval', 'webhook', 'notify'];

const TASK_TRANSITIONS = {
  open: ['in_progress', 'blocked', 'completed', 'cancelled'],
  in_progress: ['blocked', 'completed', 'cancelled'],
  blocked: ['in_progress', 'cancelled'],
  completed: [],
  cancelled: [],
  overdue: ['in_progress', 'completed', 'cancelled'],
};

function resolveTenantId(options = {}) {
  return options.tenantId || DEFAULT_TENANT_ID;
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
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw AppError.badRequest(`${label} must be a valid timestamp`);
  return date.toISOString();
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
  metadata = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanTitle = safeText(title, 500);
  if (!cleanTitle) throw AppError.badRequest('title is required');

  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO tasks
         (tenant_id, workflow_run_id, workflow_step_id, parent_task_id,
          task_kind, title, description,
          patient_uid, encounter_id, related_resource_type, related_resource_id,
          priority, status,
          assigned_to_uid, assigned_to_role, created_by,
          due_at, sla_definition_id, metadata)
       VALUES ($1::uuid, $2, $3, $4,
         $5, $6, $7,
         $8::uuid, $9, $10, $11,
         $12, 'open',
         $13::uuid, $14, $15::uuid,
         $16::timestamptz, $17, $18::jsonb)
       RETURNING ${TASK_RETURNING}`,
      tid,
      workflowRunId ? normalizeId(workflowRunId, 'workflow_run_id') : null,
      workflowStepId ? normalizeId(workflowStepId, 'workflow_step_id') : null,
      parentTaskId ? normalizeId(parentTaskId, 'parent_task_id') : null,
      normalizeEnum(taskKind, TASK_KINDS, 'task_kind') || 'general',
      cleanTitle,
      safeText(description),
      maybeUuid(patientUid, 'patient_uid'),
      encounterId ? normalizeId(encounterId, 'encounter_id') : null,
      safeText(relatedResourceType, 60),
      safeText(relatedResourceId, 120),
      normalizeEnum(priority, TASK_PRIORITIES, 'priority') || 'normal',
      maybeUuid(assignedToUid, 'assigned_to_uid'),
      safeText(assignedToRole, 80),
      maybeUuid(createdBy, 'created_by'),
      normalizeTimestamp(dueAt, 'due_at'),
      slaDefinitionId ? normalizeId(slaDefinitionId, 'sla_definition_id') : null,
      JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
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

export async function getTask({ tenantId = null, id } = {}) {
  const tid = resolveTenantId({ tenantId });
  const taskId = normalizeId(id, 'task id');
  const rows = await prisma.$queryRawUnsafe(
    `SELECT ${TASK_RETURNING} FROM tasks
     WHERE id = $1 AND tenant_id = $2::uuid LIMIT 1`,
    taskId, tid,
  );
  if (!rows[0]) throw AppError.notFound('Task not found');
  return rows[0];
}

export async function transitionTask({
  tenantId = null, id, nextStatus,
  cancellationReason = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const taskId = normalizeId(id, 'task id');
  const cleanNext = normalizeEnum(nextStatus, TASK_STATUSES, 'next_status', { required: true });

  const current = await getTask({ tenantId: tid, id: taskId });
  const allowed = TASK_TRANSITIONS[current.status] || [];
  if (!allowed.includes(cleanNext)) {
    throw AppError.invalidTransition(current.status, cleanNext, allowed);
  }

  const updates = ['status = $1', 'updated_at = NOW()'];
  const params = [cleanNext];
  if (cleanNext === 'completed') {
    params.push(new Date().toISOString());
    updates.push(`completed_at = $${params.length}::timestamptz`);
  }
  if (cleanNext === 'cancelled') {
    params.push(new Date().toISOString());
    updates.push(`cancelled_at = $${params.length}::timestamptz`);
    if (cancellationReason) {
      params.push(safeText(cancellationReason));
      updates.push(`cancellation_reason = $${params.length}`);
    }
  }
  params.push(taskId);
  params.push(tid);

  const rows = await prisma.$queryRawUnsafe(
    `UPDATE tasks SET ${updates.join(', ')}
     WHERE id = $${params.length - 1} AND tenant_id = $${params.length}::uuid
     RETURNING ${TASK_RETURNING}`,
    ...params,
  );
  if (!rows[0]) throw AppError.notFound('Task not found');
  return rows[0];
}

export async function reassignTask({
  tenantId = null, id, assignedToUid = null, assignedToRole = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const taskId = normalizeId(id, 'task id');
  const updates = ['updated_at = NOW()'];
  const params = [];
  if (assignedToUid !== undefined) {
    params.push(maybeUuid(assignedToUid, 'assigned_to_uid'));
    updates.push(`assigned_to_uid = $${params.length}::uuid`);
  }
  if (assignedToRole !== undefined) {
    params.push(safeText(assignedToRole, 80));
    updates.push(`assigned_to_role = $${params.length}`);
  }
  if (params.length === 0) {
    return getTask({ tenantId: tid, id: taskId });
  }
  params.push(taskId);
  params.push(tid);
  const rows = await prisma.$queryRawUnsafe(
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
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanTaskId = normalizeId(taskId, 'task_id');
  const cleanBody = safeText(body);
  if (!cleanBody) throw AppError.badRequest('body is required');
  try {
    const rows = await prisma.$queryRawUnsafe(
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
  isActive = true,
  createdBy = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanKey = safeText(workflowKey, 120);
  if (!cleanKey) throw AppError.badRequest('workflow_key is required');
  const cleanVersion = normalizeInt(version, 'version', { min: 1, max: 1000 }) || 1;
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
      JSON.stringify(steps ? normalizeJsonArray(steps, 'steps') : []),
      JSON.stringify(triggers ? normalizeJsonArray(triggers, 'triggers') : []),
      JSON.stringify(normalizeJsonObject(defaults, 'defaults')),
      normalizeBoolean(isActive, true),
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
  const def = await prisma.$queryRawUnsafe(
    `SELECT id, workflow_key, version, steps FROM workflow_definitions
     WHERE id = $1 AND tenant_id = $2::uuid LIMIT 1`,
    defId, tid,
  );
  if (!def[0]) throw AppError.notFound('Workflow definition not found');
  const definition = def[0];

  try {
    const runRows = await prisma.$queryRawUnsafe(
      `INSERT INTO workflow_runs
         (tenant_id, workflow_definition_id, workflow_key, workflow_version,
          trigger_kind, trigger_payload, status, context,
          due_at, initiated_by, metadata)
       VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb, 'started', $7::jsonb,
         $8::timestamptz, $9::uuid, $10::jsonb)
       RETURNING ${WORKFLOW_RUN_RETURNING}`,
      tid, definition.id, definition.workflow_key, definition.version,
      normalizeEnum(triggerKind, WORKFLOW_TRIGGER_KINDS, 'trigger_kind') || 'manual',
      JSON.stringify(normalizeJsonObject(triggerPayload, 'trigger_payload')),
      JSON.stringify(normalizeJsonObject(context, 'context')),
      normalizeTimestamp(dueAt, 'due_at'),
      maybeUuid(initiatedBy, 'initiated_by'),
      JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
    );
    const run = runRows[0];

    // Materialize steps from definition into workflow_steps.
    const stepArr = Array.isArray(definition.steps) ? definition.steps : [];
    let order = 0;
    for (const step of stepArr) {
      if (!step || typeof step !== 'object') continue;
      const stepKey = safeText(step.step_key || step.key, 120);
      const stepKind = normalizeEnum(step.step_kind || step.kind, WORKFLOW_STEP_KINDS, 'step.step_kind');
      if (!stepKey || !stepKind) continue;
      try {
        await prisma.$queryRawUnsafe(
          `INSERT INTO workflow_steps
             (tenant_id, workflow_run_id, step_key, display_name, step_kind,
              status, ordering, assigned_role, due_at, metadata)
           VALUES ($1::uuid, $2, $3, $4, $5, 'pending', $6, $7, $8::timestamptz, $9::jsonb)`,
          tid, run.id, stepKey,
          safeText(step.display_name || step.title, SHORT_MAX),
          stepKind, order++,
          safeText(step.assigned_role, 80),
          normalizeTimestamp(step.due_at, 'step.due_at'),
          JSON.stringify(normalizeJsonObject(step.metadata, 'step.metadata')),
        );
      } catch (err) {
        if (!/duplicate key value/i.test(String(err?.message || ''))) throw err;
      }
    }
    return run;
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
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const runId = normalizeId(id, 'workflow_run id');
  const cleanStatus = normalizeEnum(nextStatus, WORKFLOW_STATUSES, 'next_status', { required: true });
  const updates = ['status = $1', 'updated_at = NOW()'];
  const params = [cleanStatus];
  if (currentStepKey !== null) {
    params.push(safeText(currentStepKey, 120));
    updates.push(`current_step_key = $${params.length}`);
  }
  if (cleanStatus === 'completed' || cleanStatus === 'failed' || cleanStatus === 'cancelled') {
    params.push(new Date().toISOString());
    updates.push(`ended_at = $${params.length}::timestamptz`);
  }
  if (cleanStatus === 'failed' && failureReason) {
    params.push(safeText(failureReason));
    updates.push(`failure_reason = $${params.length}`);
  }
  params.push(runId);
  params.push(tid);
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE workflow_runs SET ${updates.join(', ')}
     WHERE id = $${params.length - 1} AND tenant_id = $${params.length}::uuid
     RETURNING ${WORKFLOW_RUN_RETURNING}`,
    ...params,
  );
  if (!rows[0]) throw AppError.notFound('Workflow run not found');
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
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const runId = normalizeId(workflowRunId, 'workflow_run_id');
  const cleanStatus = normalizeEnum(nextStatus, WORKFLOW_STEP_STATUSES, 'next_status', { required: true });
  const updates = ['status = $1', 'updated_at = NOW()'];
  const params = [cleanStatus];
  if (cleanStatus === 'in_progress') {
    params.push(new Date().toISOString());
    updates.push(`started_at = $${params.length}::timestamptz`);
  }
  if (cleanStatus === 'completed' || cleanStatus === 'skipped' || cleanStatus === 'failed') {
    params.push(new Date().toISOString());
    updates.push(`completed_at = $${params.length}::timestamptz`);
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
  params.push(safeText(stepKey, 120));
  params.push(tid);
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE workflow_steps SET ${updates.join(', ')}
     WHERE workflow_run_id = $${params.length - 2}
       AND step_key = $${params.length - 1}
       AND tenant_id = $${params.length}::uuid
     RETURNING id, tenant_id, workflow_run_id, step_key, status, outcome, outcome_payload, completed_at`,
    ...params,
  );
  if (!rows[0]) throw AppError.notFound('Workflow step not found');
  return rows[0];
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

const APPROVAL_RETURNING = `id, tenant_id, workflow_run_id, task_id,
  approval_kind, subject_resource_type, subject_resource_id,
  required_approvers, required_role, status, approved_by,
  rejection_reason, expires_at, decided_at,
  metadata, created_at, updated_at`;

export async function createApproval({
  tenantId = null,
  workflowRunId = null,
  taskId = null,
  approvalKind,
  subjectResourceType = null,
  subjectResourceId = null,
  requiredApprovers = 1,
  requiredRole = null,
  expiresAt = null,
  metadata = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanKind = safeText(approvalKind, 80);
  if (!cleanKind) throw AppError.badRequest('approval_kind is required');
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO approvals
         (tenant_id, workflow_run_id, task_id,
          approval_kind, subject_resource_type, subject_resource_id,
          required_approvers, required_role, status, expires_at, metadata)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, 'pending', $9::timestamptz, $10::jsonb)
       RETURNING ${APPROVAL_RETURNING}`,
      tid,
      workflowRunId ? normalizeId(workflowRunId, 'workflow_run_id') : null,
      taskId ? normalizeId(taskId, 'task_id') : null,
      cleanKind,
      safeText(subjectResourceType, 60),
      safeText(subjectResourceId, 120),
      normalizeInt(requiredApprovers, 'required_approvers', { min: 1, max: 100 }) || 1,
      safeText(requiredRole, 80),
      normalizeTimestamp(expiresAt, 'expires_at'),
      JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
    );
    return rows[0];
  } catch (err) {
    if (isFkViolation(err)) throw AppError.badRequest('Invalid foreign key reference');
    throw err;
  }
}

export async function recordApprovalDecision({
  tenantId = null, id, approverUid, decision, rejectionReason = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const apId = normalizeId(id, 'approval id');
  const cleanApprover = maybeUuid(approverUid, 'approver_uid');
  if (!cleanApprover) throw AppError.badRequest('approver_uid is required');
  if (decision !== 'approve' && decision !== 'reject') {
    throw AppError.badRequest('decision must be "approve" or "reject"');
  }

  const current = await prisma.$queryRawUnsafe(
    `SELECT id, status, approved_by, required_approvers FROM approvals
     WHERE id = $1 AND tenant_id = $2::uuid LIMIT 1`,
    apId, tid,
  );
  if (!current[0]) throw AppError.notFound('Approval not found');
  if (current[0].status !== 'pending') {
    throw AppError.badRequest(`Approval already ${current[0].status}`);
  }

  if (decision === 'reject') {
    const rows = await prisma.$queryRawUnsafe(
      `UPDATE approvals
       SET status = 'rejected', rejection_reason = $1, decided_at = NOW(), updated_at = NOW()
       WHERE id = $2 AND tenant_id = $3::uuid
       RETURNING ${APPROVAL_RETURNING}`,
      safeText(rejectionReason), apId, tid,
    );
    return rows[0];
  }

  const existingApprovers = Array.isArray(current[0].approved_by) ? current[0].approved_by : [];
  if (existingApprovers.some((entry) => entry?.uid === cleanApprover)) {
    throw AppError.badRequest('Approver has already approved this gate');
  }
  const next = [...existingApprovers, { uid: cleanApprover, at: new Date().toISOString() }];
  const required = Number(current[0].required_approvers || 1);
  const reachQuorum = next.length >= required;

  const rows = await prisma.$queryRawUnsafe(
    `UPDATE approvals
     SET approved_by = $1::jsonb,
         status = $2,
         decided_at = ${reachQuorum ? 'NOW()' : 'NULL'},
         updated_at = NOW()
     WHERE id = $3 AND tenant_id = $4::uuid
     RETURNING ${APPROVAL_RETURNING}`,
    JSON.stringify(next),
    reachQuorum ? 'approved' : 'pending',
    apId, tid,
  );
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
  WORKFLOW_STATUSES,
  WORKFLOW_STEP_KINDS,
  APPROVAL_STATUSES,
};

export default {
  createTask,
  listTasks,
  getTask,
  transitionTask,
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
