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
const setTenantTxMock = jest.fn(async (_tenantId, fn) => fn(__prismaDefaultMock));

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: setTenantTxMock,
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

const {
  acknowledgeColdChainTaskFromTrustedWorkflow,
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
  setTenantTxMock.mockClear();
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
    expect(setTenantTxMock).toHaveBeenCalledWith(TENANT, expect.any(Function));

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

  it('idempotently repairs the linked SLA for an already-acknowledged task without re-stamping or commenting', async () => {
    const task = {
      id: 1,
      status: 'in_progress',
      assigned_to_uid: USER,
      metadata: {
        acknowledged_at: 'earlier',
        acknowledged_by: USER,
        sla_instance_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
    };
    queryUnsafeMock
      .mockResolvedValueOnce([task])
      .mockResolvedValueOnce([task]);

    const row = await acknowledgeTask({ tenantId: TENANT, id: 1, actorUid: USER });

    expect(row.status).toBe('in_progress');
    expect(queryUnsafeMock.mock.calls.map(([sql]) => sql)).toEqual([
      expect.stringMatching(/^SELECT[\s\S]+FROM tasks/i),
      expect.stringMatching(/^WITH authorized_task[\s\S]+UPDATE workflow_sla_instances/i),
    ]);
    expect(queryUnsafeMock.mock.calls[1][0]).toMatch(/sla\.completed_at IS NULL/);
    expect(queryUnsafeMock.mock.calls[1][0]).toMatch(/authorized_task\.metadata->>'acknowledged_by'/);
    expect(queryUnsafeMock.mock.calls.some(([sql]) => /UPDATE tasks/i.test(sql))).toBe(false);
    expect(queryUnsafeMock.mock.calls.some(([sql]) => /INSERT INTO task_comments/i.test(sql))).toBe(false);
  });

  it.each([
    ['linked SLA', 2, 'SLA write failed'],
    ['audit comment', 3, 'comment write failed'],
  ])('propagates a %s failure through its own tenant transaction', async (_label, failingCall, message) => {
    const responses = [
      [{
        id: 1,
        status: 'open',
        assigned_to_uid: USER,
        metadata: { sla_instance_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      }],
      [{
        id: 1,
        status: 'in_progress',
        metadata: { sla_instance_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      }],
      [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', status: 'completed' }],
      [{ id: 10, body_kind: 'state_change' }],
    ];
    responses.forEach((response, index) => {
      if (index === failingCall) queryUnsafeMock.mockRejectedValueOnce(new Error(message));
      else queryUnsafeMock.mockResolvedValueOnce(response);
    });

    await expect(acknowledgeTask({ tenantId: TENANT, id: 1, actorUid: USER }))
      .rejects.toThrow(message);
    expect(setTenantTxMock).toHaveBeenCalledWith(TENANT, expect.any(Function));
  });
});

describe('acknowledgeTask authorization', () => {
  const OTHER = '99999999-9999-4999-8999-999999999999';
  const SLA_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const PATIENT = '44444444-4444-4444-8444-444444444444';

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

  it('revalidates assignee authority in the guarded UPDATE and denies a concurrent reassignment', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([{
        id: 1,
        status: 'open',
        assigned_to_uid: USER,
        assigned_to_role: 'DOCTOR',
        metadata: { sla_instance_id: SLA_ID },
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: 1,
        status: 'open',
        assigned_to_uid: OTHER,
        assigned_to_role: 'DOCTOR',
        metadata: { sla_instance_id: SLA_ID },
      }]);

    await expect(acknowledgeTask({
      tenantId: TENANT,
      id: 1,
      actorUid: USER,
      actorRoles: [],
    })).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });

    const updateCall = queryUnsafeMock.mock.calls[1];
    expect(updateCall[0]).toMatch(/UPDATE tasks/i);
    expect(updateCall[0]).toMatch(/'assignee'[\s\S]+assigned_to_uid/i);
    expect(updateCall.slice(1)).toEqual(expect.arrayContaining(['assignee', USER]));
    expect(queryUnsafeMock).toHaveBeenCalledTimes(3);
  });

  it('retries the guarded update through a still-valid administrator mode after reassignment', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([{
        id: 1,
        status: 'open',
        assigned_to_uid: USER,
        assigned_to_role: 'DOCTOR',
        metadata: {},
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: 1,
        status: 'overdue',
        assigned_to_uid: OTHER,
        assigned_to_role: 'DOCTOR',
        metadata: {},
      }])
      .mockResolvedValueOnce([{ id: 1, status: 'in_progress', metadata: {} }])
      .mockResolvedValueOnce([{ id: 12, body_kind: 'state_change' }]);

    const row = await acknowledgeTask({
      tenantId: TENANT,
      id: 1,
      actorUid: USER,
      actorRoles: ['ADMIN'],
    });

    expect(row.status).toBe('in_progress');
    expect(queryUnsafeMock.mock.calls[1].slice(1)[2]).toBe('assignee');
    expect(queryUnsafeMock.mock.calls[3].slice(1)[2]).toBe('admin');
    expect(queryUnsafeMock.mock.calls[4][4]).toMatch(/overdue → in_progress/);
    expect(JSON.parse(queryUnsafeMock.mock.calls[4][6])).toMatchObject({
      from: 'overdue',
      to: 'in_progress',
      via: 'admin',
    });
    expect(queryUnsafeMock).toHaveBeenCalledTimes(5);
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
    expect(queryUnsafeMock.mock.calls[1].slice(1)[2]).toBe('role');
    expect(queryUnsafeMock.mock.calls[1].slice(1)[4]).toBe('DUTY_DOCTOR');
  });

  it('allows an ADMIN task-administrator on any task', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'open', assigned_to_uid: OTHER, assigned_to_role: 'DOCTOR', metadata: {} }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'in_progress' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 7 }]);
    const row = await acknowledgeTask({ tenantId: TENANT, id: 1, actorUid: USER, actorRoles: ['ADMIN'] });
    expect(row.status).toBe('in_progress');
  });

  it('rejects a reason-only nursing override and never updates the task or linked SLA', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([{
        id: 1,
        status: 'open',
        assigned_to_uid: OTHER,
        assigned_to_role: 'DOCTOR',
        patient_uid: PATIENT,
        metadata: { sla_instance_id: SLA_ID },
      }])
      .mockResolvedValueOnce([{
        id: 1,
        status: 'in_progress',
        patient_uid: PATIENT,
        metadata: { sla_instance_id: SLA_ID },
      }])
      .mockResolvedValueOnce([{ id: SLA_ID, status: 'completed' }])
      .mockResolvedValueOnce([{ id: 8, body_kind: 'state_change' }]);

    await expect(acknowledgeTask({
      tenantId: TENANT, id: 1, actorUid: USER, actorRoles: ['NURSING_STAFF'],
      overrideReason: 'covering for the on-call doctor',
    })).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });

    // The task read is the only query: arbitrary text must not authorize the
    // task UPDATE or stop its linked SLA clock.
    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
    expect(queryUnsafeMock.mock.calls[0][0]).toMatch(/^SELECT[\s\S]+FROM tasks/i);
  });

  it('rejects an oversized break-glass selector before querying its table', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1,
      status: 'open',
      assigned_to_uid: OTHER,
      assigned_to_role: 'DOCTOR',
      patient_uid: PATIENT,
      metadata: { sla_instance_id: SLA_ID },
    }]);

    await expect(acknowledgeTask({
      tenantId: TENANT,
      id: 1,
      actorUid: USER,
      actorRoles: ['CMO'],
      breakGlassId: 2_147_483_648,
    })).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });

    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
    expect(queryUnsafeMock.mock.calls[0][0]).toMatch(/^SELECT[\s\S]+FROM tasks/i);
  });

  it('does not expose the trusted-workflow override on the public acknowledgeTask entrypoint', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1,
      status: 'open',
      assigned_to_uid: OTHER,
      related_resource_type: 'cold_chain_excursions',
      related_resource_id: '7',
      metadata: {},
    }]);

    await expect(acknowledgeTask({
      tenantId: TENANT,
      id: 1,
      actorUid: USER,
      actorRoles: ['NURSING_STAFF'],
      trustedOverride: {
        source: 'cold_chain_excursion_ack',
        reason: 'Acknowledged via cold-chain excursion acknowledgement',
        id: '7',
      },
    })).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });

    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
  });

  it('allows a CMO override only through the exact active patient break-glass record and durably records its provenance', async () => {
    const breakGlassReason = 'Emergency coverage';
    queryUnsafeMock
      .mockResolvedValueOnce([{
        id: 1,
        status: 'open',
        assigned_to_uid: OTHER,
        assigned_to_role: 'DOCTOR',
        patient_uid: PATIENT,
        metadata: {},
      }])
      .mockResolvedValueOnce([{ id: 41, actor_role: 'CMO', reason: breakGlassReason }])
      .mockResolvedValueOnce([{
        id: 1,
        status: 'in_progress',
        patient_uid: PATIENT,
        metadata: {},
      }])
      .mockResolvedValueOnce([{ id: 8, body_kind: 'state_change' }]);

    const row = await acknowledgeTask({
      tenantId: TENANT,
      id: 1,
      actorUid: USER,
      actorRoles: ['CMO'],
      breakGlassId: 41,
    });

    expect(row.status).toBe('in_progress');

    const breakGlassCall = queryUnsafeMock.mock.calls.find(([sql]) => /FROM patient_access_break_glass/i.test(sql));
    expect(breakGlassCall).toBeDefined();
    expect(breakGlassCall[0]).toMatch(/tenant_id\s*=\s*\$\d+::uuid/i);
    expect(breakGlassCall[0]).toMatch(/patient_uid\s*=\s*\$\d+::uuid/i);
    expect(breakGlassCall[0]).toMatch(/actor_uid\s*=\s*\$\d+::uuid/i);
    expect(breakGlassCall[0]).toMatch(/id\s*=\s*\$\d+::(?:int|bigint)/i);
    expect(breakGlassCall[0]).toMatch(/status\s*=\s*'active'/i);
    expect(breakGlassCall[0]).toMatch(/expires_at\s*>\s*NOW\(\)/i);
    expect(breakGlassCall[0]).toMatch(/actor_role/i);
    expect(breakGlassCall[0]).toMatch(/reason/i);
    expect(breakGlassCall.slice(1)).toEqual(expect.arrayContaining([TENANT, PATIENT, USER, 41]));

    const updateCall = queryUnsafeMock.mock.calls.find(([sql]) => /UPDATE tasks/i.test(sql));
    expect(updateCall[0]).toMatch(/acknowledge_override_source/i);
    expect(updateCall[0]).toMatch(/acknowledge_override_id/i);
    expect(updateCall[0]).toMatch(/acknowledge_override_reason/i);
    expect(updateCall[0]).toMatch(/EXISTS[\s\S]+FROM patient_access_break_glass/i);
    expect(updateCall[0]).toMatch(/bg\.status\s*=\s*'active'/i);
    expect(updateCall[0]).toMatch(/bg\.expires_at\s*>\s*NOW\(\)/i);
    expect(updateCall.slice(1)).toEqual(expect.arrayContaining([
      'patient_access_break_glass',
      '41',
      breakGlassReason,
    ]));

    const commentCall = queryUnsafeMock.mock.calls.find(([sql]) => /INSERT INTO task_comments/i.test(sql));
    const commentMetadataJson = commentCall.slice(1)
      .find((value) => typeof value === 'string' && value.includes('"override_source"'));
    expect(JSON.parse(commentMetadataJson)).toMatchObject({
      via: 'override',
      override_source: 'patient_access_break_glass',
      override_id: '41',
      override_reason: breakGlassReason,
    });
  });

  it('rejects an absent or expired break-glass record without touching the task or SLA', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([{
        id: 1,
        status: 'open',
        assigned_to_uid: OTHER,
        assigned_to_role: 'DOCTOR',
        patient_uid: PATIENT,
        metadata: { sla_instance_id: SLA_ID },
      }])
      .mockResolvedValueOnce([]);

    await expect(acknowledgeTask({
      tenantId: TENANT,
      id: 1,
      actorUid: USER,
      actorRoles: ['CMO'],
      breakGlassId: 41,
    })).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });

    expect(queryUnsafeMock).toHaveBeenCalledTimes(2);
    expect(queryUnsafeMock.mock.calls[1][0]).toMatch(/FROM patient_access_break_glass/i);
  });

  it('rejects a break-glass record whose activating role is not in the caller signed roles', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([{
        id: 1,
        status: 'open',
        assigned_to_uid: OTHER,
        assigned_to_role: 'DOCTOR',
        patient_uid: PATIENT,
        metadata: {},
      }])
      .mockResolvedValueOnce([{
        id: 41,
        actor_role: 'MEDICAL_SUPERINTENDENT',
        reason: 'Emergency coverage',
      }]);

    await expect(acknowledgeTask({
      tenantId: TENANT,
      id: 1,
      actorUid: USER,
      actorRoles: ['CMO'],
      breakGlassId: 41,
    })).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });

    expect(queryUnsafeMock).toHaveBeenCalledTimes(2);
  });

  it('uses a supplied tx client for the task read, guarded update, linked SLA, and audit comment', async () => {
    const txQuery = jest.fn()
      .mockResolvedValueOnce([{
        id: 1,
        status: 'open',
        assigned_to_uid: USER,
        patient_uid: PATIENT,
        metadata: { sla_instance_id: SLA_ID },
      }])
      .mockResolvedValueOnce([{
        id: 1,
        status: 'in_progress',
        patient_uid: PATIENT,
        metadata: { sla_instance_id: SLA_ID },
      }])
      .mockResolvedValueOnce([{ id: SLA_ID, status: 'completed' }])
      .mockResolvedValueOnce([{ id: 9, body_kind: 'state_change' }]);
    const tx = { $queryRawUnsafe: txQuery };

    const row = await acknowledgeTask({ tenantId: TENANT, id: 1, actorUid: USER, tx });

    expect(row.status).toBe('in_progress');
    expect(setTenantTxMock).not.toHaveBeenCalled();
    expect(queryUnsafeMock).not.toHaveBeenCalled();
    expect(txQuery).toHaveBeenCalledTimes(4);
    expect(txQuery.mock.calls.map(([sql]) => sql)).toEqual([
      expect.stringMatching(/^SELECT[\s\S]+FROM tasks/i),
      expect.stringMatching(/UPDATE tasks/i),
      expect.stringMatching(/UPDATE workflow_sla_instances/i),
      expect.stringMatching(/INSERT INTO task_comments/i),
    ]);
  });

  it.each([
    ['linked SLA', 2, 'tx SLA write failed'],
    ['audit comment', 3, 'tx comment write failed'],
  ])('does not swallow a supplied transaction failure from the %s write', async (_label, failingCall, message) => {
    const responses = [
      [{
        id: 1,
        status: 'open',
        assigned_to_uid: USER,
        patient_uid: PATIENT,
        metadata: { sla_instance_id: SLA_ID },
      }],
      [{
        id: 1,
        status: 'in_progress',
        patient_uid: PATIENT,
        metadata: { sla_instance_id: SLA_ID },
      }],
      [{ id: SLA_ID, status: 'completed' }],
      [{ id: 9, body_kind: 'state_change' }],
    ];
    const txQuery = jest.fn();
    responses.forEach((response, index) => {
      if (index === failingCall) txQuery.mockRejectedValueOnce(new Error(message));
      else txQuery.mockResolvedValueOnce(response);
    });
    const tx = { $queryRawUnsafe: txQuery };

    await expect(acknowledgeTask({ tenantId: TENANT, id: 1, actorUid: USER, tx }))
      .rejects.toThrow(message);
    expect(queryUnsafeMock).not.toHaveBeenCalled();
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
    expect(() => resolveAckAuthorization({ assigned_to_uid: OTHER }, { actorUid: USER, actorRoles: [], overrideReason: 'why' }))
      .toThrow(/Not authorized/);
    expect(() => resolveAckAuthorization({ assigned_to_uid: OTHER }, { actorUid: USER, actorRoles: ['NURSING_STAFF'] }))
      .toThrow(/Not authorized/);
  });
});

describe('acknowledgeColdChainTaskFromTrustedWorkflow', () => {
  const OTHER = '99999999-9999-4999-8999-999999999999';

  it('records normal role authority when the responder holds the task assignment', async () => {
    const txQuery = jest.fn()
      .mockResolvedValueOnce([{
        id: 55,
        status: 'open',
        assigned_to_uid: OTHER,
        assigned_to_role: 'PHARMACY_STAFF',
        related_resource_type: 'cold_chain_excursions',
        related_resource_id: '7',
        metadata: {},
      }])
      .mockResolvedValueOnce([{ id: 55, status: 'in_progress', metadata: {} }])
      .mockResolvedValueOnce([{ id: 9, body_kind: 'state_change' }]);
    const tx = { $queryRawUnsafe: txQuery };

    await acknowledgeColdChainTaskFromTrustedWorkflow({
      tenantId: TENANT,
      id: 55,
      actorUid: USER,
      actorRoles: ['PHARMACY_STAFF'],
      excursionId: 7,
      tx,
    });

    const updateParams = txQuery.mock.calls[1].slice(1);
    expect(updateParams[2]).toBe('role');
    expect(updateParams[4]).toBe('PHARMACY_STAFF');
    expect(updateParams[5]).toBeNull();
    expect(updateParams[9]).toBe('7');
  });

  it('binds a trusted cold-chain acknowledgement to the linked excursion and its supplied tx', async () => {
    const txQuery = jest.fn()
      .mockResolvedValueOnce([{
        id: 55,
        status: 'open',
        assigned_to_uid: OTHER,
        related_resource_type: 'cold_chain_excursions',
        related_resource_id: '7',
        metadata: {},
      }])
      .mockResolvedValueOnce([{
        id: 55,
        status: 'in_progress',
        related_resource_type: 'cold_chain_excursions',
        related_resource_id: '7',
        metadata: {},
      }])
      .mockResolvedValueOnce([{ id: 10, body_kind: 'state_change' }]);
    const tx = { $queryRawUnsafe: txQuery };
    const row = await acknowledgeColdChainTaskFromTrustedWorkflow({
      tenantId: TENANT,
      id: 55,
      actorUid: USER,
      actorRoles: ['PHARMACY_STAFF'],
      excursionId: 7,
      tx,
    });

    expect(row.status).toBe('in_progress');
    expect(queryUnsafeMock).not.toHaveBeenCalled();
    expect(txQuery.mock.calls.map(([sql]) => sql)).toEqual([
      expect.stringMatching(/^SELECT[\s\S]+FROM tasks/i),
      expect.stringMatching(/UPDATE tasks/i),
      expect.stringMatching(/INSERT INTO task_comments/i),
    ]);
    expect(txQuery.mock.calls[1][0]).toMatch(/acknowledge_override_source/i);
    expect(txQuery.mock.calls[1].slice(1)[2]).toBe('override');
    expect(txQuery.mock.calls[1].slice(1)).toEqual(expect.arrayContaining([
      'cold_chain_excursion_ack',
      '7',
      'Acknowledged via cold-chain excursion acknowledgement',
    ]));
  });

  it('rejects a trusted cold-chain acknowledgement when the task is linked to another excursion', async () => {
    const txQuery = jest.fn().mockResolvedValueOnce([{
      id: 55,
      status: 'open',
      assigned_to_uid: OTHER,
      related_resource_type: 'cold_chain_excursions',
      related_resource_id: '8',
      metadata: {},
    }]);
    const tx = { $queryRawUnsafe: txQuery };

    await expect(acknowledgeColdChainTaskFromTrustedWorkflow({
      tenantId: TENANT,
      id: 55,
      actorUid: USER,
      excursionId: 7,
      tx,
    })).rejects.toMatchObject({ statusCode: 403 });

    expect(txQuery).toHaveBeenCalledTimes(1);
    expect(queryUnsafeMock).not.toHaveBeenCalled();
  });

  it('rejects the trusted entrypoint without the caller transaction', async () => {
    await expect(acknowledgeColdChainTaskFromTrustedWorkflow({
      tenantId: TENANT,
      id: 55,
      actorUid: USER,
      excursionId: 7,
    })).rejects.toMatchObject({ statusCode: 500, code: 'TRUSTED_TASK_ACK_TRANSACTION_REQUIRED' });

    expect(queryUnsafeMock).not.toHaveBeenCalled();
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

describe('workflow transition maps', () => {
  it('allows active run progress while keeping terminal runs immutable', () => {
    expect(__testing__.WORKFLOW_RUN_TRANSITIONS.started).toContain('running');
    expect(__testing__.WORKFLOW_RUN_TRANSITIONS.started).not.toContain('completed');
    expect(__testing__.WORKFLOW_RUN_TRANSITIONS.running).toContain('completed');
    expect(__testing__.WORKFLOW_RUN_TRANSITIONS.blocked).not.toContain('completed');
    expect(__testing__.WORKFLOW_RUN_TRANSITIONS.completed).toEqual([]);
    expect(__testing__.WORKFLOW_RUN_TRANSITIONS.cancelled).toEqual([]);
    expect(__testing__.WORKFLOW_RUN_TRANSITIONS.failed).toEqual([]);
  });

  it('allows pending step progress while keeping terminal steps immutable', () => {
    expect(__testing__.WORKFLOW_STEP_TRANSITIONS.pending).toContain('in_progress');
    expect(__testing__.WORKFLOW_STEP_TRANSITIONS.pending).not.toContain('completed');
    expect(__testing__.WORKFLOW_STEP_TRANSITIONS.in_progress).toContain('completed');
    expect(__testing__.WORKFLOW_STEP_TRANSITIONS.blocked).not.toContain('completed');
    expect(__testing__.WORKFLOW_STEP_TRANSITIONS.completed).toEqual([]);
    expect(__testing__.WORKFLOW_STEP_TRANSITIONS.skipped).toEqual([]);
    expect(__testing__.WORKFLOW_STEP_TRANSITIONS.failed).toEqual([]);
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
    expect(sql).toMatch(/AND status = \$\d/);
    expect(queryUnsafeMock.mock.calls[1]).toContain('open');
    expect(setTenantTxMock).toHaveBeenCalledWith(TENANT, expect.any(Function));
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

  it('validates an explicitly supplied server actor before mutation', async () => {
    await expect(transitionTask({
      tenantId: TENANT, id: 1, nextStatus: 'completed', actorUid: null,
    })).rejects.toMatchObject({ statusCode: 401 });
    expect(queryUnsafeMock).not.toHaveBeenCalled();
  });

  it('reports a compare-and-set loser as conflict when the tenant row still exists', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'open' }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'completed' }]);
    await expect(transitionTask({ tenantId: TENANT, id: 1, nextStatus: 'completed' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'TASK_TRANSITION_CONFLICT' });
  });

  it('propagates linked SLA failure through the task transition transaction', async () => {
    const task = {
      id: 1,
      status: 'open',
      metadata: { sla_instance_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    };
    queryUnsafeMock.mockResolvedValueOnce([task]);
    queryUnsafeMock.mockResolvedValueOnce([{ ...task, status: 'completed' }]);
    queryUnsafeMock.mockRejectedValueOnce(new Error('SLA write failed'));

    await expect(transitionTask({ tenantId: TENANT, id: 1, nextStatus: 'completed' }))
      .rejects.toThrow('SLA write failed');
    expect(setTenantTxMock).toHaveBeenCalledWith(TENANT, expect.any(Function));
  });

  it('preserves a supplied transaction without nesting setTenantTx', async () => {
    const txQuery = jest.fn()
      .mockResolvedValueOnce([{ id: 1, status: 'open', metadata: {} }])
      .mockResolvedValueOnce([{ id: 1, status: 'completed', metadata: {} }]);
    const tx = { $queryRawUnsafe: txQuery };

    const row = await transitionTask({
      tenantId: TENANT, id: 1, nextStatus: 'completed', tx,
    });

    expect(row.status).toBe('completed');
    expect(setTenantTxMock).not.toHaveBeenCalled();
    expect(queryUnsafeMock).not.toHaveBeenCalled();
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
    expect(queryUnsafeMock.mock.calls[0]).toContain(false);
  });

  it('rejects active definitions until governance activation exists', async () => {
    await expect(createWorkflowDefinition({
      tenantId: TENANT,
      workflowKey: 'follow_up_v1',
      steps: [{ step_key: 'review_lab', step_kind: 'task' }],
      isActive: true,
    })).rejects.toMatchObject({ code: 'WORKFLOW_DEFINITION_ACTIVATION_UNAVAILABLE' });
    expect(queryUnsafeMock).not.toHaveBeenCalled();
  });

  it('validates the complete definition contract before insert', async () => {
    await expect(createWorkflowDefinition({
      tenantId: TENANT,
      workflowKey: 'follow_up_v1',
      steps: [{ step_key: 'review_lab', step_kind: 'unsupported' }],
    })).rejects.toMatchObject({ code: 'INVALID_WORKFLOW_DEFINITION' });
    expect(queryUnsafeMock).not.toHaveBeenCalled();
  });

  it('rejects stored triggers while the registered trigger set is empty', async () => {
    await expect(createWorkflowDefinition({
      tenantId: TENANT,
      workflowKey: 'follow_up_v1',
      steps: [{ step_key: 'review_lab', step_kind: 'task' }],
      triggers: [{ event_type: 'lab.result.signed_off' }],
    })).rejects.toMatchObject({ code: 'WORKFLOW_TRIGGER_ACTIVATION_UNAVAILABLE' });
    expect(queryUnsafeMock).not.toHaveBeenCalled();
  });

  it('throws conflict on duplicate (key, version)', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'));
    await expect(createWorkflowDefinition({
      tenantId: TENANT, workflowKey: 'follow_up_v1', version: 1,
      steps: [{ step_key: 'review_lab', step_kind: 'task' }],
    })).rejects.toThrow(/already exists/);
  });
});

describe('startWorkflowRun materializes steps', () => {
  it('requires an initiator before opening the tenant transaction', async () => {
    await expect(startWorkflowRun({ tenantId: TENANT, workflowDefinitionId: 99 }))
      .rejects.toMatchObject({ statusCode: 401 });
    expect(setTenantTxMock).not.toHaveBeenCalled();
    expect(queryUnsafeMock).not.toHaveBeenCalled();
  });

  it('throws 404 when definition missing', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]); // definition lookup
    await expect(startWorkflowRun({
      tenantId: TENANT, workflowDefinitionId: 99, initiatedBy: USER,
    }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('materializes each definition step into workflow_steps', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, workflow_key: 'follow_up_v1', version: 1,
      is_active: true,
      steps: [
        { step_key: 'review', step_kind: 'task', display_name: 'Review' },
        { step_key: 'approve', step_kind: 'approval' },
      ],
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 5, status: 'started' }]); // run insert
    queryUnsafeMock.mockResolvedValueOnce([]); // step 1 insert
    queryUnsafeMock.mockResolvedValueOnce([]); // step 2 insert
    const run = await startWorkflowRun({
      tenantId: TENANT, workflowDefinitionId: 1, initiatedBy: USER,
    });
    expect(run.id).toBe(5);
    expect(setTenantTxMock).toHaveBeenCalledWith(TENANT, expect.any(Function));
    expect(queryUnsafeMock.mock.calls[0][0]).toMatch(/FOR SHARE/);
    const stepInsertSql = queryUnsafeMock.mock.calls[2][0];
    expect(stepInsertSql).toMatch(/INSERT INTO workflow_steps/);
  });

  it('rejects an inactive definition before inserting a run', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, workflow_key: 'k', version: 1, is_active: false,
      steps: [{ step_key: 'review', step_kind: 'task' }],
    }]);
    await expect(startWorkflowRun({
      tenantId: TENANT, workflowDefinitionId: 1, initiatedBy: USER,
    }))
      .rejects.toMatchObject({ code: 'INACTIVE_WORKFLOW_DEFINITION' });
    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed stored steps before inserting a run', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, workflow_key: 'k', version: 1, is_active: true,
      steps: [null, { step_key: 'x', step_kind: 'fake' }],
    }]);
    await expect(startWorkflowRun({
      tenantId: TENANT, workflowDefinitionId: 1, initiatedBy: USER,
    }))
      .rejects.toMatchObject({ code: 'INVALID_WORKFLOW_DEFINITION' });
    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a legacy stored definition with unregistered triggers before run insert', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1,
      workflow_key: 'k',
      version: 1,
      is_active: true,
      steps: [{ step_key: 'review', step_kind: 'task' }],
      triggers: [{ event_type: 'lab.result.signed_off' }],
    }]);
    await expect(startWorkflowRun({
      tenantId: TENANT, workflowDefinitionId: 1, initiatedBy: USER,
    }))
      .rejects.toMatchObject({ code: 'WORKFLOW_TRIGGER_ACTIVATION_UNAVAILABLE' });
    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
  });

  it('does not swallow a step materialization failure', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, workflow_key: 'k', version: 1, is_active: true,
      steps: [{ step_key: 'review', step_kind: 'task' }],
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 5 }]);
    queryUnsafeMock.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'));
    await expect(startWorkflowRun({
      tenantId: TENANT, workflowDefinitionId: 1, initiatedBy: USER,
    }))
      .rejects.toThrow(/duplicate key value/);
  });
});

describe('transitionWorkflowRun', () => {
  it('rejects unknown next_status', async () => {
    await expect(transitionWorkflowRun({
      tenantId: TENANT, id: 1, nextStatus: 'time_out',
    })).rejects.toThrow(/next_status must be one of/);
  });

  it('flips to completed + stamps ended_at', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'running' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'completed' }]);
    await transitionWorkflowRun({
      tenantId: TENANT, id: 1, nextStatus: 'completed', actorUid: USER,
    });
    const sql = queryUnsafeMock.mock.calls[1][0];
    expect(sql).toMatch(/ended_at = \$\d::timestamptz/);
    expect(sql).toMatch(/AND status = \$\d/);
    expect(queryUnsafeMock.mock.calls[1]).toContain('running');
  });

  it('captures failure_reason on failure', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'running' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'failed', failure_reason: 'timeout' }]);
    await transitionWorkflowRun({
      tenantId: TENANT, id: 1, nextStatus: 'failed', failureReason: 'timeout', actorUid: USER,
    });
    const params = queryUnsafeMock.mock.calls[1].slice(1);
    expect(params).toContain('timeout');
  });

  it('requires an authenticated actor before reading the run', async () => {
    await expect(transitionWorkflowRun({ tenantId: TENANT, id: 1, nextStatus: 'completed' }))
      .rejects.toMatchObject({ statusCode: 401 });
    expect(queryUnsafeMock).not.toHaveBeenCalled();
  });

  it('keeps terminal run states immutable', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'completed' }]);
    await expect(transitionWorkflowRun({
      tenantId: TENANT, id: 1, nextStatus: 'running', actorUid: USER,
    })).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
  });

  it('reports a compare-and-set loser as conflict', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'running' }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1 }]);
    await expect(transitionWorkflowRun({
      tenantId: TENANT, id: 1, nextStatus: 'completed', actorUid: USER,
    })).rejects.toMatchObject({ code: 'WORKFLOW_RUN_TRANSITION_CONFLICT' });
  });
});

describe('transitionWorkflowStep + listWorkflowSteps + listWorkflowRuns', () => {
  it('transitionWorkflowStep stamps completed_at on completed', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'in_progress' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, step_key: 'review', status: 'completed' }]);
    await transitionWorkflowStep({
      tenantId: TENANT, workflowRunId: 1, stepKey: 'review', nextStatus: 'completed',
      outcome: 'approved', actorUid: USER,
    });
    const sql = queryUnsafeMock.mock.calls[1][0];
    expect(sql).toMatch(/completed_at = \$\d::timestamptz/);
    expect(sql).toMatch(/outcome = \$\d/);
    expect(sql).toMatch(/AND status = \$\d/);
  });

  it('preserves the original started_at when a blocked step resumes', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'blocked' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'in_progress' }]);

    await transitionWorkflowStep({
      tenantId: TENANT,
      workflowRunId: 1,
      stepKey: 'review',
      nextStatus: 'in_progress',
      actorUid: USER,
    });

    expect(queryUnsafeMock.mock.calls[1][0])
      .toMatch(/started_at = COALESCE\(started_at, \$\d::timestamptz\)/);
  });

  it('requires an authenticated actor before reading the step', async () => {
    await expect(transitionWorkflowStep({
      tenantId: TENANT, workflowRunId: 1, stepKey: 'review', nextStatus: 'completed',
    })).rejects.toMatchObject({ statusCode: 401 });
    expect(queryUnsafeMock).not.toHaveBeenCalled();
  });

  it('keeps terminal step states immutable', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'completed' }]);
    await expect(transitionWorkflowStep({
      tenantId: TENANT,
      workflowRunId: 1,
      stepKey: 'review',
      nextStatus: 'in_progress',
      actorUid: USER,
    })).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
  });

  it('reports a compare-and-set loser as conflict', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'in_progress' }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1 }]);
    await expect(transitionWorkflowStep({
      tenantId: TENANT,
      workflowRunId: 1,
      stepKey: 'review',
      nextStatus: 'completed',
      actorUid: USER,
    })).rejects.toMatchObject({ code: 'WORKFLOW_STEP_TRANSITION_CONFLICT' });
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

  it('rejects domain-owned credential grants before inserting', async () => {
    await expect(createApproval({
      tenantId: TENANT,
      approvalKind: ' CREDENTIAL_PRIVILEGE_GRANT ',
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'DOMAIN_OWNED_APPROVAL_KIND',
    });
    expect(queryUnsafeMock).not.toHaveBeenCalled();
  });
});

describe('recordApprovalDecision', () => {
  it('rejects a missing authenticated actor', async () => {
    await expect(recordApprovalDecision({ tenantId: TENANT, id: 1, decision: 'approve' }))
      .rejects.toMatchObject({ statusCode: 401 });
  });

  it('rejects invalid decision', async () => {
    await expect(recordApprovalDecision({
      tenantId: TENANT, id: 1, actorUid: APPROVER_A, decision: 'maybe',
    })).rejects.toThrow(/decision must be "approve" or "reject"/);
  });

  it('rejects domain-owned credential grants after the locked read and before mutation', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1,
      status: 'pending',
      approval_kind: 'credential_privilege_grant',
      expires_at: null,
      is_expired: false,
    }]);

    await expect(recordApprovalDecision({
      tenantId: TENANT,
      id: 1,
      actorUid: APPROVER_A,
      decision: 'approve',
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'DOMAIN_OWNED_APPROVAL_KIND',
    });

    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
    expect(queryUnsafeMock.mock.calls[0][0]).toMatch(/approval_kind/);
    expect(queryUnsafeMock.mock.calls[0][0]).toMatch(/expires_at/);
    expect(queryUnsafeMock.mock.calls[0][0])
      .toMatch(/expires_at\s+IS\s+NOT\s+NULL\s+AND\s+expires_at\s*<=\s*NOW\(\)/i);
  });

  it('rejects an expired pending approval using the database expiry result', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1,
      status: 'pending',
      approval_kind: 'discharge_clearance',
      approved_by: [],
      required_approvers: 1,
      expires_at: '2026-07-18T00:00:00.000Z',
      is_expired: true,
    }]);

    await expect(recordApprovalDecision({
      tenantId: TENANT,
      id: 1,
      actorUid: APPROVER_A,
      decision: 'approve',
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'APPROVAL_EXPIRED',
    });
    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
  });

  it('rejects when already decided', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'approved' }]);
    await expect(recordApprovalDecision({
      tenantId: TENANT, id: 1, actorUid: APPROVER_A, decision: 'approve',
    })).rejects.toThrow(/already approved/);
    expect(queryUnsafeMock.mock.calls[0][0]).toMatch(/FOR UPDATE/);
  });

  it('rejects double-approve from same approver', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, status: 'pending', required_approvers: 2,
      approved_by: [{ uid: APPROVER_A, at: new Date().toISOString() }],
    }]);
    await expect(recordApprovalDecision({
      tenantId: TENANT, id: 1, actorUid: APPROVER_A, decision: 'approve',
    })).rejects.toThrow(/already approved this gate/);
  });

  it('rejects a mixed-case UUID replay from the same approver', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1,
      status: 'pending',
      required_approvers: 2,
      approved_by: [{ uid: APPROVER_A.toUpperCase(), at: new Date().toISOString() }],
    }]);
    await expect(recordApprovalDecision({
      tenantId: TENANT,
      id: 1,
      actorUid: APPROVER_A,
      decision: 'approve',
    })).rejects.toThrow(/already approved this gate/);
    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
  });

  it('keeps pending status until quorum reached', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, status: 'pending', required_approvers: 2, approved_by: [],
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'pending', approved_by: [{ uid: APPROVER_A }] }]);
    const row = await recordApprovalDecision({
      tenantId: TENANT, id: 1, actorUid: APPROVER_A, decision: 'approve',
    });
    expect(row.status).toBe('pending');
    expect(setTenantTxMock).toHaveBeenCalledWith(TENANT, expect.any(Function));
    expect(queryUnsafeMock.mock.calls[1][0]).toMatch(/status = 'pending'/);
  });

  it('flips to approved when quorum met', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, status: 'pending', required_approvers: 2,
      approved_by: [{ uid: APPROVER_A, at: new Date().toISOString() }],
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'approved' }]);
    const row = await recordApprovalDecision({
      tenantId: TENANT, id: 1, actorUid: APPROVER_B, decision: 'approve',
    });
    expect(row.status).toBe('approved');
  });

  it('reject path stamps decided_at + rejection_reason', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, status: 'pending', required_approvers: 2, approved_by: [],
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'rejected' }]);
    await recordApprovalDecision({
      tenantId: TENANT, id: 1, actorUid: APPROVER_A, decision: 'reject',
      rejectionReason: 'incomplete chart',
    });
    const params = queryUnsafeMock.mock.calls[1].slice(1);
    expect(params).toContain('incomplete chart');
  });

  it('enforces required_role inside the locked transaction', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1,
      status: 'pending',
      required_approvers: 1,
      required_role: 'CMO',
      approved_by: [],
    }]);
    await expect(recordApprovalDecision({
      tenantId: TENANT,
      id: 1,
      actorUid: APPROVER_A,
      actorRoles: ['DOCTOR'],
      decision: 'approve',
    })).rejects.toMatchObject({ statusCode: 403 });
    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
  });

  it('allows ADMIN and SUPER_ADMIN to administer a role-gated approval', async () => {
    for (const role of ['ADMIN', 'SUPER_ADMIN']) {
      queryUnsafeMock.mockResolvedValueOnce([{
        id: 1,
        status: 'pending',
        required_approvers: 1,
        required_role: 'CMO',
        approved_by: [],
      }]);
      queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'approved' }]);
      const row = await recordApprovalDecision({
        tenantId: TENANT,
        id: 1,
        actorUid: APPROVER_A,
        actorRoles: [role],
        decision: 'approve',
      });
      expect(row.status).toBe('approved');
    }
  });

  it('allows a holder of required_role to approve', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1,
      status: 'pending',
      required_approvers: 1,
      required_role: 'CMO',
      approved_by: [],
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'approved' }]);
    const row = await recordApprovalDecision({
      tenantId: TENANT,
      id: 1,
      actorUid: APPROVER_A,
      actorRoles: ['cmo'],
      decision: 'approve',
    });
    expect(row.status).toBe('approved');
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
