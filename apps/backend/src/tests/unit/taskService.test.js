/**
 * Phase B2 — taskService unit tests.
 *
 * Drives validation, the task state machine, workflow run/step
 * lifecycle, approval quorum logic, and CRUD on escalation / SLA /
 * automation rules without a live DB.
 */

import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();

const __prismaDefaultMock = { $queryRawUnsafe: queryUnsafeMock };

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

const {
  acknowledgeTask,
  createApproval,
  createTask,
  createWorkflowDefinition,
  getTask,
  listApprovals,
  listAutomationRules,
  listEscalationRules,
  listInboxTasks,
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

  it('uses the supplied tx client instead of the default prisma', async () => {
    const txQuery = jest.fn().mockResolvedValueOnce([{ id: 9, status: 'open' }]);
    const tx = { $queryRawUnsafe: txQuery };
    const row = await createTask({
      tenantId: TENANT, title: 'critical lab', tx,
    });
    expect(row.id).toBe(9);
    // The tx client did the work; the module-level prisma mock was untouched.
    expect(txQuery).toHaveBeenCalledTimes(1);
    expect(queryUnsafeMock).not.toHaveBeenCalled();
  });

  it('onConflictResourceDoNothing emits an ON CONFLICT DO NOTHING branch', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 2, status: 'open' }]);
    await createTask({
      tenantId: TENANT,
      title: 'critical lab',
      relatedResourceType: 'lab_result',
      relatedResourceId: '123',
      onConflictResourceDoNothing: true,
    });
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/ON CONFLICT/i);
    expect(sql).toMatch(/DO NOTHING/i);
    // Inference is on the resource triple of the partial index.
    expect(sql).toMatch(/related_resource_type/);
    expect(sql).toMatch(/related_resource_id/);
  });

  it('onConflictResourceDoNothing returns undefined when the row already exists (no RETURNING row)', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]); // conflict → DO NOTHING → no row returned
    const row = await createTask({
      tenantId: TENANT,
      title: 'critical lab',
      relatedResourceType: 'lab_result',
      relatedResourceId: '123',
      onConflictResourceDoNothing: true,
    });
    expect(row).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// acknowledgeTask + listInboxTasks (results-inbox)
// ---------------------------------------------------------------------------

describe('acknowledgeTask', () => {
  it('moves open -> in_progress, stamps metadata.acknowledged_at, posts a state_change comment', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'open', assigned_to_uid: USER, metadata: {} }]); // getTask
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'in_progress', metadata: { acknowledged_at: 'x' } }]); // UPDATE
    queryUnsafeMock.mockResolvedValueOnce([{ id: 10, body_kind: 'state_change' }]); // comment insert

    const row = await acknowledgeTask({ tenantId: TENANT, id: 1, actorUid: USER });
    expect(row.status).toBe('in_progress');

    const updateSql = queryUnsafeMock.mock.calls[1][0];
    expect(updateSql).toMatch(/UPDATE tasks/);
    expect(updateSql).toMatch(/status = /);
    expect(updateSql).toMatch(/acknowledged_at/);

    const commentSql = queryUnsafeMock.mock.calls[2][0];
    expect(commentSql).toMatch(/INSERT INTO task_comments/);
    const commentParams = queryUnsafeMock.mock.calls[2].slice(1);
    expect(commentParams).toContain('state_change');
  });

  it('acknowledges an overdue task (overdue -> in_progress)', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'overdue', assigned_to_uid: USER, metadata: {} }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'in_progress' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 11 }]);
    const row = await acknowledgeTask({ tenantId: TENANT, id: 1, actorUid: USER });
    expect(row.status).toBe('in_progress');
  });

  it('throws invalidTransition when the task is already completed', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'completed', assigned_to_uid: USER, metadata: {} }]); // getTask
    await expect(acknowledgeTask({ tenantId: TENANT, id: 1, actorUid: USER }))
      .rejects.toMatchObject({ statusCode: 400, code: 'INVALID_STATE_TRANSITION' });
  });

  it('is idempotent on an already-acknowledged (in_progress) task — no error', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'in_progress', assigned_to_uid: USER, metadata: { acknowledged_at: 'earlier' } }]);
    const row = await acknowledgeTask({ tenantId: TENANT, id: 1, actorUid: USER });
    expect(row.status).toBe('in_progress');
    // Only the getTask read ran; no second UPDATE/comment for an already-acked task.
    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
  });
});

describe('acknowledgeTask authorization', () => {
  const OTHER = '99999999-9999-4999-8999-999999999999';
  const SLA_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  it('rejects a caller who is neither assignee, role-holder, nor override — and never runs the clock-stopping UPDATE', async () => {
    // Task belongs to a DIFFERENT clinician and is linked to an SLA instance.
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, status: 'open', assigned_to_uid: OTHER, assigned_to_role: 'DOCTOR',
      metadata: { sla_instance_id: SLA_ID },
    }]); // getTask
    await expect(acknowledgeTask({
      tenantId: TENANT, id: 1, actorUid: USER, actorRoles: ['NURSING_STAFF'],
    })).rejects.toMatchObject({ statusCode: 403 });
    // Only the getTask read ran: no UPDATE tasks (status flip) and therefore no
    // completeLinkedSla UPDATE — the escalation clock is NOT stopped.
    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
  });

  it('allows the assignee (by uid)', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'open', assigned_to_uid: USER, metadata: {} }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'in_progress' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 5 }]);
    const row = await acknowledgeTask({ tenantId: TENANT, id: 1, actorUid: USER, actorRoles: [] });
    expect(row.status).toBe('in_progress');
  });

  it('allows a holder of the assigned role even when the assignee uid differs', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'open', assigned_to_uid: OTHER, assigned_to_role: 'DUTY_DOCTOR', metadata: {} }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'in_progress' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 6 }]);
    const row = await acknowledgeTask({ tenantId: TENANT, id: 1, actorUid: USER, actorRoles: ['DUTY_DOCTOR'] });
    expect(row.status).toBe('in_progress');
  });

  it('allows an ADMIN task-administrator on any task', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'open', assigned_to_uid: OTHER, assigned_to_role: 'DOCTOR', metadata: {} }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'in_progress' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 7 }]);
    const row = await acknowledgeTask({ tenantId: TENANT, id: 1, actorUid: USER, actorRoles: ['ADMIN'] });
    expect(row.status).toBe('in_progress');
  });

  it('allows an explicit audited override and records the reason on the UPDATE + audit comment', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'open', assigned_to_uid: OTHER, assigned_to_role: 'DOCTOR', metadata: {} }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'in_progress' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 8 }]);
    const row = await acknowledgeTask({
      tenantId: TENANT, id: 1, actorUid: USER, actorRoles: ['NURSING_STAFF'],
      overrideReason: 'covering for the on-call doctor',
    });
    expect(row.status).toBe('in_progress');
    // The override reason is bound as an UPDATE param (metadata provenance)...
    expect(queryUnsafeMock.mock.calls[1].slice(1)).toContain('covering for the on-call doctor');
    // ...and appears in the state_change audit comment body.
    const commentArgs = queryUnsafeMock.mock.calls[2].slice(1);
    expect(commentArgs.some((p) => typeof p === 'string' && p.includes('override'))).toBe(true);
  });

  it('rejects an unassigned task with no override (no assignee, no role, no admin)', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'open', assigned_to_uid: null, assigned_to_role: null, metadata: {} }]);
    await expect(acknowledgeTask({
      tenantId: TENANT, id: 1, actorUid: USER, actorRoles: ['DOCTOR'],
    })).rejects.toMatchObject({ statusCode: 403 });
    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
  });

  it('resolveAckAuthorization (pure) — assignee/role/admin/override modes and rejection', () => {
    const { resolveAckAuthorization } = __testing__;
    expect(resolveAckAuthorization({ assigned_to_uid: USER }, { actorUid: USER }).mode).toBe('assignee');
    expect(resolveAckAuthorization({ assigned_to_role: 'DOCTOR' }, { actorUid: OTHER, actorRoles: ['DOCTOR'] }).mode).toBe('role');
    expect(resolveAckAuthorization({ assigned_to_uid: OTHER }, { actorUid: USER, actorRoles: ['SUPER_ADMIN'] }).mode).toBe('admin');
    expect(resolveAckAuthorization({ assigned_to_uid: OTHER }, { actorUid: USER, actorRoles: [], overrideReason: 'why' }).mode).toBe('override');
    expect(() => resolveAckAuthorization({ assigned_to_uid: OTHER }, { actorUid: USER, actorRoles: ['NURSING_STAFF'] }))
      .toThrow(/Not authorized/);
  });
});

describe('listInboxTasks', () => {
  it('filters by assignee-OR-role and open/in_progress/overdue, ordered by priority then due_at', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1 }, { id: 2 }]);
    const result = await listInboxTasks({
      tenantId: TENANT, assigneeUid: USER, roles: ['DOCTOR', 'DUTY_DOCTOR'],
    });
    expect(result.count).toBe(2);
    const sql = queryUnsafeMock.mock.calls[0][0];
    // me OR my role
    expect(sql).toMatch(/assigned_to_uid = /);
    expect(sql).toMatch(/assigned_to_role/);
    // inbox status set
    expect(sql).toMatch(/'open', 'in_progress', 'overdue'/);
    // ordering
    expect(sql).toMatch(/CASE priority WHEN 'critical' THEN 0/);
    expect(sql).toMatch(/due_at/);
  });

  it('works with only an assignee and no roles', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1 }]);
    const result = await listInboxTasks({ tenantId: TENANT, assigneeUid: USER, roles: [] });
    expect(result.count).toBe(1);
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/assigned_to_uid = /);
  });

  it('degrades to empty on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "tasks" does not exist'));
    const result = await listInboxTasks({ tenantId: TENANT, assigneeUid: USER, roles: ['DOCTOR'] });
    expect(result).toEqual({ tasks: [], count: 0 });
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
