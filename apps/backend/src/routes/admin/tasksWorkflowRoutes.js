/**
 * Admin routes for Tasks / Workflow / Approval (Phase B2).
 *
 * Mounted at /api/v1/admin/workflow via routes/admin/index.js.
 */

import express from 'express';

import { success } from '../../utils/responseHelper.js';
import {
  createApproval,
  createTask,
  createWorkflowDefinition,
  getTask,
  listApprovals,
  listAutomationRules,
  listEscalationRules,
  listSlaDefinitions,
  listTaskComments,
  listTasks,
  listWorkflowDefinitions,
  listWorkflowRuns,
  listWorkflowSteps,
  postTaskComment,
  reassignTask,
  recordApprovalDecision,
  startWorkflowRun,
  transitionTask,
  transitionWorkflowRun,
  transitionWorkflowStep,
  upsertAutomationRule,
  upsertEscalationRule,
  upsertSlaDefinition,
} from '../../services/workflow/taskService.js';

const router = express.Router();

// Tasks
router.post('/tasks', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await createTask({
      tenantId: req.tenantId,
      workflowRunId: b.workflow_run_id,
      workflowStepId: b.workflow_step_id,
      parentTaskId: b.parent_task_id,
      taskKind: b.task_kind,
      title: b.title,
      description: b.description,
      patientUid: b.patient_uid,
      encounterId: b.encounter_id,
      relatedResourceType: b.related_resource_type,
      relatedResourceId: b.related_resource_id,
      priority: b.priority,
      assignedToUid: b.assigned_to_uid,
      assignedToRole: b.assigned_to_role,
      createdBy: b.created_by || req.user?.uid || null,
      dueAt: b.due_at,
      slaDefinitionId: b.sla_definition_id,
      metadata: b.metadata,
    });
    return success(res, row, 'Task created', 201);
  } catch (err) { return next(err); }
});

router.get('/tasks', async (req, res, next) => {
  try {
    const result = await listTasks({
      tenantId: req.tenantId,
      status: req.query.status || null,
      priority: req.query.priority || null,
      taskKind: req.query.task_kind || null,
      assignedToUid: req.query.assigned_to_uid || null,
      assignedToRole: req.query.assigned_to_role || null,
      patientUid: req.query.patient_uid || null,
      workflowRunId: req.query.workflow_run_id || null,
      overdueOnly: String(req.query.overdue_only || '').toLowerCase() === 'true',
      limit: req.query.limit,
    });
    return success(res, result, 'Tasks retrieved');
  } catch (err) { return next(err); }
});

router.get('/tasks/:id', async (req, res, next) => {
  try {
    const row = await getTask({ tenantId: req.tenantId, id: req.params.id });
    return success(res, row, 'Task retrieved');
  } catch (err) { return next(err); }
});

router.patch('/tasks/:id/transition', async (req, res, next) => {
  try {
    const row = await transitionTask({
      tenantId: req.tenantId,
      id: req.params.id,
      nextStatus: req.body?.next_status,
      cancellationReason: req.body?.cancellation_reason,
    });
    return success(res, row, 'Task transitioned');
  } catch (err) { return next(err); }
});

router.patch('/tasks/:id/assign', async (req, res, next) => {
  try {
    const row = await reassignTask({
      tenantId: req.tenantId,
      id: req.params.id,
      assignedToUid: req.body?.assigned_to_uid,
      assignedToRole: req.body?.assigned_to_role,
    });
    return success(res, row, 'Task reassigned');
  } catch (err) { return next(err); }
});

router.post('/tasks/:id/comments', async (req, res, next) => {
  try {
    const row = await postTaskComment({
      tenantId: req.tenantId,
      taskId: req.params.id,
      authorUid: req.user?.uid || null,
      body: req.body?.body,
      bodyKind: req.body?.body_kind,
      metadata: req.body?.metadata,
    });
    return success(res, row, 'Comment posted', 201);
  } catch (err) { return next(err); }
});

router.get('/tasks/:id/comments', async (req, res, next) => {
  try {
    const result = await listTaskComments({
      tenantId: req.tenantId,
      taskId: req.params.id,
      limit: req.query.limit,
    });
    return success(res, result, 'Comments retrieved');
  } catch (err) { return next(err); }
});

// Workflow definitions + runs
router.post('/workflow-definitions', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await createWorkflowDefinition({
      tenantId: req.tenantId,
      workflowKey: b.workflow_key,
      version: b.version,
      displayName: b.display_name,
      description: b.description,
      category: b.category,
      steps: b.steps,
      triggers: b.triggers,
      defaults: b.defaults,
      isActive: b.is_active,
      createdBy: req.user?.uid || null,
    });
    return success(res, row, 'Workflow definition saved', 201);
  } catch (err) { return next(err); }
});

router.get('/workflow-definitions', async (req, res, next) => {
  try {
    const result = await listWorkflowDefinitions({
      tenantId: req.tenantId,
      isActive: req.query.is_active != null ? req.query.is_active === 'true' : null,
      category: req.query.category || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Definitions retrieved');
  } catch (err) { return next(err); }
});

router.post('/workflow-runs', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await startWorkflowRun({
      tenantId: req.tenantId,
      workflowDefinitionId: b.workflow_definition_id,
      triggerKind: b.trigger_kind,
      triggerPayload: b.trigger_payload,
      context: b.context,
      dueAt: b.due_at,
      initiatedBy: req.user?.uid || null,
      metadata: b.metadata,
    });
    return success(res, row, 'Workflow run started', 201);
  } catch (err) { return next(err); }
});

router.get('/workflow-runs', async (req, res, next) => {
  try {
    const result = await listWorkflowRuns({
      tenantId: req.tenantId,
      status: req.query.status || null,
      workflowKey: req.query.workflow_key || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Workflow runs retrieved');
  } catch (err) { return next(err); }
});

router.patch('/workflow-runs/:id/transition', async (req, res, next) => {
  try {
    const row = await transitionWorkflowRun({
      tenantId: req.tenantId,
      id: req.params.id,
      nextStatus: req.body?.next_status,
      failureReason: req.body?.failure_reason,
      currentStepKey: req.body?.current_step_key ?? null,
    });
    return success(res, row, 'Workflow run transitioned');
  } catch (err) { return next(err); }
});

router.get('/workflow-runs/:id/steps', async (req, res, next) => {
  try {
    const result = await listWorkflowSteps({
      tenantId: req.tenantId,
      workflowRunId: req.params.id,
    });
    return success(res, result, 'Steps retrieved');
  } catch (err) { return next(err); }
});

router.patch('/workflow-runs/:id/steps/:stepKey/transition', async (req, res, next) => {
  try {
    const row = await transitionWorkflowStep({
      tenantId: req.tenantId,
      workflowRunId: req.params.id,
      stepKey: req.params.stepKey,
      nextStatus: req.body?.next_status,
      outcome: req.body?.outcome,
      outcomePayload: req.body?.outcome_payload,
    });
    return success(res, row, 'Step transitioned');
  } catch (err) { return next(err); }
});

// Approvals
router.post('/approvals', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await createApproval({
      tenantId: req.tenantId,
      workflowRunId: b.workflow_run_id,
      taskId: b.task_id,
      approvalKind: b.approval_kind,
      subjectResourceType: b.subject_resource_type,
      subjectResourceId: b.subject_resource_id,
      requiredApprovers: b.required_approvers,
      requiredRole: b.required_role,
      expiresAt: b.expires_at,
      metadata: b.metadata,
    });
    return success(res, row, 'Approval created', 201);
  } catch (err) { return next(err); }
});

router.get('/approvals', async (req, res, next) => {
  try {
    const result = await listApprovals({
      tenantId: req.tenantId,
      status: req.query.status || null,
      workflowRunId: req.query.workflow_run_id || null,
      taskId: req.query.task_id || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Approvals retrieved');
  } catch (err) { return next(err); }
});

router.post('/approvals/:id/decide', async (req, res, next) => {
  try {
    const row = await recordApprovalDecision({
      tenantId: req.tenantId,
      id: req.params.id,
      approverUid: req.user?.uid || req.body?.approver_uid,
      decision: req.body?.decision,
      rejectionReason: req.body?.rejection_reason,
    });
    return success(res, row, 'Approval decision recorded');
  } catch (err) { return next(err); }
});

// Escalation + SLA + Automation rules
router.put('/escalation-rules', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await upsertEscalationRule({
      tenantId: req.tenantId,
      id: b.id,
      displayName: b.display_name,
      description: b.description,
      scope: b.scope,
      matchFilter: b.match_filter,
      triggerCondition: b.trigger_condition,
      triggerWindowMinutes: b.trigger_window_minutes,
      actionKind: b.action_kind,
      actionPayload: b.action_payload,
      isActive: b.is_active,
      createdBy: req.user?.uid || null,
    });
    return success(res, row, 'Escalation rule saved');
  } catch (err) { return next(err); }
});

router.get('/escalation-rules', async (req, res, next) => {
  try {
    const result = await listEscalationRules({
      tenantId: req.tenantId,
      isActive: req.query.is_active != null ? req.query.is_active === 'true' : null,
      scope: req.query.scope || null,
    });
    return success(res, result, 'Escalation rules retrieved');
  } catch (err) { return next(err); }
});

router.put('/sla-definitions', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await upsertSlaDefinition({
      tenantId: req.tenantId,
      slaKey: b.sla_key,
      displayName: b.display_name,
      description: b.description,
      targetMinutes: b.target_minutes,
      warnAtPct: b.warn_at_pct,
      businessHoursOnly: b.business_hours_only,
      metadata: b.metadata,
    });
    return success(res, row, 'SLA definition saved');
  } catch (err) { return next(err); }
});

router.get('/sla-definitions', async (req, res, next) => {
  try {
    const result = await listSlaDefinitions({ tenantId: req.tenantId });
    return success(res, result, 'SLA definitions retrieved');
  } catch (err) { return next(err); }
});

router.put('/automation-rules', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await upsertAutomationRule({
      tenantId: req.tenantId,
      id: b.id,
      displayName: b.display_name,
      description: b.description,
      eventType: b.event_type,
      matchFilter: b.match_filter,
      actionKind: b.action_kind,
      actionPayload: b.action_payload,
      isActive: b.is_active,
      createdBy: req.user?.uid || null,
    });
    return success(res, row, 'Automation rule saved');
  } catch (err) { return next(err); }
});

router.get('/automation-rules', async (req, res, next) => {
  try {
    const result = await listAutomationRules({
      tenantId: req.tenantId,
      eventType: req.query.event_type || null,
      isActive: req.query.is_active != null ? req.query.is_active === 'true' : null,
    });
    return success(res, result, 'Automation rules retrieved');
  } catch (err) { return next(err); }
});

export default router;
