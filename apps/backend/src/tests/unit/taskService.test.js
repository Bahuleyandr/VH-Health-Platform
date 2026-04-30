/**
 * Phase B2 — taskService unit tests.
 *
 * Drives validation, the task state machine, workflow run/step
 * lifecycle, approval quorum logic, and CRUD on escalation / SLA /
 * automation rules without a live DB.
 */

import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryUnsafeMock },
}));

const {
  createApproval,
  createTask,
  createWorkflowDefinition,
  getTask,
  listApprovals,
  listAutomationRules,
  listEscalationRules,
  listSlaDefinitions,
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
  __testing__,
} = await import('../../services/workflow/taskService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const USER = '11111111-1111-4111-8111-111111111111';
const APPROVER_A = '22222222-2222-4222-8222-222222222222';
const APPROVER_B = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  queryUnsafeMock.mockReset();
});

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

describe('createTask', () => {
  it('rejects missing title', async () => {
    await expect(createTask({ tenantId: TENANT })).rejects.toThrow(/title is required/);
  });

  it('rejects unknown task_kind', async () => {
    await expect(createTask({
      tenantId: TENANT, title: 'X', taskKind: 'spaceflight',
    })).rejects.toThrow(/task_kind must be one of/);
  });

  it('inserts an open task with default priority=normal', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'open', priority: 'normal' }]);
    const row = await createTask({
      tenantId: TENANT, title: 'follow up on labs', createdBy: USER,
    });
    expect(row.status).toBe('open');
  });
});

describe('TASK_TRANSITIONS map', () => {
  it('open allows in_progress / blocked / completed / cancelled', () => {
    expect(__testing__.TASK_TRANSITIONS.open).toEqual(
      expect.arrayContaining(['in_progress', 'blocked', 'completed', 'cancelled']),
    );
  });
  it('completed and cancelled are terminal', () => {
    expect(__testing__.TASK_TRANSITIONS.completed).toEqual([]);
    expect(__testing__.TASK_TRANSITIONS.cancelled).toEqual([]);
  });
});

describe('transitionTask', () => {
  it('rejects illegal transition (completed -> open)', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'completed' }]);
    await expect(transitionTask({ tenantId: TENANT, id: 1, nextStatus: 'open' }))
      .rejects.toThrow(/transition/i);
  });

  it('flips open -> completed and stamps completed_at', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'open' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'completed' }]);
    const row = await transitionTask({ tenantId: TENANT, id: 1, nextStatus: 'completed' });
    expect(row.status).toBe('completed');
    const sql = queryUnsafeMock.mock.calls[1][0];
    expect(sql).toMatch(/completed_at = \$\d::timestamptz/);
  });

  it('records cancellation_reason on cancel', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'open' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'cancelled' }]);
    await transitionTask({
      tenantId: TENANT, id: 1, nextStatus: 'cancelled', cancellationReason: 'duplicate',
    });
    const params = queryUnsafeMock.mock.calls[1].slice(1);
    expect(params).toContain('duplicate');
  });
});

describe('reassignTask + listTasks + postTaskComment', () => {
  it('reassignTask with both uid + role updates both', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1 }]);
    await reassignTask({
      tenantId: TENANT, id: 1, assignedToUid: USER, assignedToRole: 'NURSING_STAFF',
    });
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/assigned_to_uid = \$\d::uuid/);
    expect(sql).toMatch(/assigned_to_role = \$\d/);
  });

  it('listTasks orders by priority then due_at', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1 }]);
    await listTasks({ tenantId: TENANT });
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/CASE priority WHEN 'critical' THEN 0/);
    expect(sql).toMatch(/due_at NULLS LAST/);
  });

  it('listTasks supports overdueOnly filter', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await listTasks({ tenantId: TENANT, overdueOnly: true });
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/due_at < NOW\(\)/);
  });

  it('postTaskComment requires non-empty body', async () => {
    await expect(postTaskComment({ tenantId: TENANT, taskId: 1, body: '   ' }))
      .rejects.toThrow(/body is required/);
  });

  it('postTaskComment inserts comment row', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, body: 'note' }]);
    const row = await postTaskComment({
      tenantId: TENANT, taskId: 1, authorUid: USER, body: 'note',
    });
    expect(row.id).toBe(1);
  });

  it('listTasks degrades to empty on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "tasks" does not exist'));
    const result = await listTasks({ tenantId: TENANT });
    expect(result).toEqual({ tasks: [], count: 0 });
  });
});

describe('getTask 404', () => {
  it('throws 404 when missing', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await expect(getTask({ tenantId: TENANT, id: 999 }))
      .rejects.toMatchObject({ statusCode: 404 });
  });
});

// ---------------------------------------------------------------------------
// Workflow definitions + runs + steps
// ---------------------------------------------------------------------------

describe('createWorkflowDefinition', () => {
  it('rejects missing workflow_key', async () => {
    await expect(createWorkflowDefinition({ tenantId: TENANT }))
      .rejects.toThrow(/workflow_key is required/);
  });

  it('inserts a definition with default version=1', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, workflow_key: 'follow_up_v1', version: 1 }]);
    const row = await createWorkflowDefinition({
      tenantId: TENANT, workflowKey: 'follow_up_v1',
      steps: [{ step_key: 'review_lab', step_kind: 'task' }],
    });
    expect(row.version).toBe(1);
  });

  it('throws conflict on duplicate (key, version)', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'));
    await expect(createWorkflowDefinition({
      tenantId: TENANT, workflowKey: 'follow_up_v1', version: 1,
    })).rejects.toThrow(/already exists/);
  });
});

describe('startWorkflowRun materializes steps', () => {
  it('throws 404 when definition missing', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]); // definition lookup
    await expect(startWorkflowRun({ tenantId: TENANT, workflowDefinitionId: 99 }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('materializes each definition step into workflow_steps', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, workflow_key: 'follow_up_v1', version: 1,
      steps: [
        { step_key: 'review', step_kind: 'task', display_name: 'Review' },
        { step_key: 'approve', step_kind: 'approval' },
      ],
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 5, status: 'started' }]); // run insert
    queryUnsafeMock.mockResolvedValueOnce([]); // step 1 insert
    queryUnsafeMock.mockResolvedValueOnce([]); // step 2 insert
    const run = await startWorkflowRun({
      tenantId: TENANT, workflowDefinitionId: 1,
    });
    expect(run.id).toBe(5);
    const stepInsertSql = queryUnsafeMock.mock.calls[2][0];
    expect(stepInsertSql).toMatch(/INSERT INTO workflow_steps/);
  });

  it('skips invalid step entries silently', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, workflow_key: 'k', version: 1, steps: [null, { step_key: 'x', step_kind: 'fake' }],
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 5 }]);
    // Both step entries invalid (null + bad enum) — should throw on the bad enum during normalization.
    await expect(startWorkflowRun({ tenantId: TENANT, workflowDefinitionId: 1 }))
      .rejects.toThrow(/step_kind must be one of/);
  });
});

describe('transitionWorkflowRun', () => {
  it('rejects unknown next_status', async () => {
    await expect(transitionWorkflowRun({
      tenantId: TENANT, id: 1, nextStatus: 'time_out',
    })).rejects.toThrow(/next_status must be one of/);
  });

  it('flips to completed + stamps ended_at', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'completed' }]);
    await transitionWorkflowRun({ tenantId: TENANT, id: 1, nextStatus: 'completed' });
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/ended_at = \$\d::timestamptz/);
  });

  it('captures failure_reason on failure', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'failed', failure_reason: 'timeout' }]);
    await transitionWorkflowRun({
      tenantId: TENANT, id: 1, nextStatus: 'failed', failureReason: 'timeout',
    });
    const params = queryUnsafeMock.mock.calls[0].slice(1);
    expect(params).toContain('timeout');
  });
});

describe('transitionWorkflowStep + listWorkflowSteps + listWorkflowRuns', () => {
  it('transitionWorkflowStep stamps completed_at on completed', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, step_key: 'review', status: 'completed' }]);
    await transitionWorkflowStep({
      tenantId: TENANT, workflowRunId: 1, stepKey: 'review', nextStatus: 'completed',
      outcome: 'approved',
    });
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/completed_at = \$\d::timestamptz/);
    expect(sql).toMatch(/outcome = \$\d/);
  });

  it('listWorkflowSteps degrades to empty on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "workflow_steps" does not exist'));
    const result = await listWorkflowSteps({ tenantId: TENANT, workflowRunId: 1 });
    expect(result).toEqual({ steps: [], count: 0 });
  });

  it('listWorkflowRuns filters by status', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1 }]);
    await listWorkflowRuns({ tenantId: TENANT, status: 'running' });
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/status = \$2/);
  });

  it('listWorkflowDefinitions filters by category', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await listWorkflowDefinitions({ tenantId: TENANT, category: 'discharge' });
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/category = \$2/);
  });
});

// ---------------------------------------------------------------------------
// Approvals + quorum
// ---------------------------------------------------------------------------

describe('createApproval', () => {
  it('rejects missing approval_kind', async () => {
    await expect(createApproval({ tenantId: TENANT }))
      .rejects.toThrow(/approval_kind is required/);
  });

  it('inserts pending approval with default required_approvers=1', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'pending', required_approvers: 1 }]);
    const row = await createApproval({
      tenantId: TENANT, approvalKind: 'discharge_clearance',
    });
    expect(row.required_approvers).toBe(1);
  });
});

describe('recordApprovalDecision', () => {
  it('rejects missing approver_uid', async () => {
    await expect(recordApprovalDecision({ tenantId: TENANT, id: 1, decision: 'approve' }))
      .rejects.toThrow(/approver_uid is required/);
  });

  it('rejects invalid decision', async () => {
    await expect(recordApprovalDecision({
      tenantId: TENANT, id: 1, approverUid: APPROVER_A, decision: 'maybe',
    })).rejects.toThrow(/decision must be "approve" or "reject"/);
  });

  it('rejects when already decided', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'approved' }]);
    await expect(recordApprovalDecision({
      tenantId: TENANT, id: 1, approverUid: APPROVER_A, decision: 'approve',
    })).rejects.toThrow(/already approved/);
  });

  it('rejects double-approve from same approver', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, status: 'pending', required_approvers: 2,
      approved_by: [{ uid: APPROVER_A, at: new Date().toISOString() }],
    }]);
    await expect(recordApprovalDecision({
      tenantId: TENANT, id: 1, approverUid: APPROVER_A, decision: 'approve',
    })).rejects.toThrow(/already approved this gate/);
  });

  it('keeps pending status until quorum reached', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, status: 'pending', required_approvers: 2, approved_by: [],
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'pending', approved_by: [{ uid: APPROVER_A }] }]);
    const row = await recordApprovalDecision({
      tenantId: TENANT, id: 1, approverUid: APPROVER_A, decision: 'approve',
    });
    expect(row.status).toBe('pending');
  });

  it('flips to approved when quorum met', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, status: 'pending', required_approvers: 2,
      approved_by: [{ uid: APPROVER_A, at: new Date().toISOString() }],
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'approved' }]);
    const row = await recordApprovalDecision({
      tenantId: TENANT, id: 1, approverUid: APPROVER_B, decision: 'approve',
    });
    expect(row.status).toBe('approved');
  });

  it('reject path stamps decided_at + rejection_reason', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, status: 'pending', required_approvers: 2, approved_by: [],
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'rejected' }]);
    await recordApprovalDecision({
      tenantId: TENANT, id: 1, approverUid: APPROVER_A, decision: 'reject',
      rejectionReason: 'incomplete chart',
    });
    const params = queryUnsafeMock.mock.calls[1].slice(1);
    expect(params).toContain('incomplete chart');
  });

  it('listApprovals filters by workflow_run_id', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await listApprovals({ tenantId: TENANT, workflowRunId: 5 });
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/workflow_run_id = \$2/);
  });
});

// ---------------------------------------------------------------------------
// Escalation rules + SLA + automation rules
// ---------------------------------------------------------------------------

describe('escalation / SLA / automation upserts', () => {
  it('upsertEscalationRule rejects unknown action_kind', async () => {
    await expect(upsertEscalationRule({
      tenantId: TENANT, displayName: 'X', triggerCondition: 'sla_breach', actionKind: 'magic',
    })).rejects.toThrow(/action_kind must be one of/);
  });

  it('upsertEscalationRule inserts new rule when id is null', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, display_name: 'X' }]);
    const row = await upsertEscalationRule({
      tenantId: TENANT, displayName: 'X',
      triggerCondition: 'sla_breach', actionKind: 'notify',
    });
    expect(row.id).toBe(1);
  });

  it('upsertEscalationRule updates when id provided', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 7, display_name: 'X', is_active: false }]);
    const row = await upsertEscalationRule({
      tenantId: TENANT, id: 7, displayName: 'X',
      triggerCondition: 'sla_breach', actionKind: 'notify', isActive: false,
    });
    expect(row.is_active).toBe(false);
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/UPDATE escalation_rules/);
  });

  it('upsertSlaDefinition rejects missing target_minutes', async () => {
    await expect(upsertSlaDefinition({ tenantId: TENANT, slaKey: 'x' }))
      .rejects.toThrow(/target_minutes is required/);
  });

  it('upsertSlaDefinition rejects warn_at_pct out of range', async () => {
    await expect(upsertSlaDefinition({
      tenantId: TENANT, slaKey: 'x', targetMinutes: 30, warnAtPct: 150,
    })).rejects.toThrow(/warn_at_pct must be <= 100/);
  });

  it('upsertAutomationRule rejects missing event_type', async () => {
    await expect(upsertAutomationRule({
      tenantId: TENANT, displayName: 'X', actionKind: 'notify',
    })).rejects.toThrow(/event_type is required/);
  });

  it('listEscalationRules + listSlaDefinitions + listAutomationRules degrade on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "escalation_rules" does not exist'));
    expect(await listEscalationRules({ tenantId: TENANT })).toEqual({ rules: [], count: 0 });
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "sla_definitions" does not exist'));
    expect(await listSlaDefinitions({ tenantId: TENANT })).toEqual({ slas: [], count: 0 });
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "automation_rules" does not exist'));
    expect(await listAutomationRules({ tenantId: TENANT })).toEqual({ rules: [], count: 0 });
  });
});
