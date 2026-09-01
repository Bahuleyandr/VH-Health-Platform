import { jest } from '@jest/globals';

const queryRawUnsafe = jest.fn();
const executeRawUnsafe = jest.fn();
const tx = {
  $queryRawUnsafe: queryRawUnsafe,
  $executeRawUnsafe: executeRawUnsafe,
  __tenantTransaction: true,
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: tx,
  setTenantTx: async (_tenantId, callback) => callback(tx),
  setTenant: async (_tenantId, callback) => callback(tx),
  runTenantScopedTransaction: async (_client, _tenantId, callback) => callback(tx),
  pickTenantClient: () => tx,
  isTenantTransactionClient: (value) => value?.__tenantTransaction === true,
}));

const {
  acknowledgeTask,
  claimInboxTask,
  claimMarMedicationExceptionTaskTx,
  createTask,
  listInboxTasks,
  reassignTask,
  transitionTask,
} = await import(
  '../../services/workflow/taskService.js'
);

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const SLA_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function exceptionTask(overrides = {}) {
  return {
    id: 41,
    tenant_id: TENANT_ID,
    task_kind: 'review',
    status: 'open',
    workflow_run_id: null,
    workflow_step_id: null,
    workflow_sla_instance_id: SLA_ID,
    sla_completion_semantics: 'domain_evidence',
    related_resource_type: 'mar_medication_exception_cases',
    related_resource_id: '73',
    metadata: {
      task_contract: 'mar_medication_exception_v1',
      exception_case_id: 73,
      medication_administration_id: 42,
      exception_kind: 'missed',
      sla_key: 'mar_medication_exception_review',
    },
    ...overrides,
  };
}

function exceptionSla(overrides = {}) {
  return {
    id: SLA_ID,
    rule_code: 'mar_medication_exception_review',
    source_table: 'mar_medication_exception_cases',
    source_id: '73',
    status: 'active',
    completed_at: null,
    due_at: new Date('2026-08-28T00:00:00.000Z'),
    ...overrides,
  };
}

beforeEach(() => {
  queryRawUnsafe.mockReset();
  executeRawUnsafe.mockReset().mockResolvedValue(1);
});

describe('MAR medication exception task authority', () => {
  test('the generic task API cannot mint the protected exception contract', async () => {
    await expect(createTask({
      tenantId: TENANT_ID,
      taskKind: 'review',
      title: 'Spoofed MAR medication exception',
      relatedResourceType: 'mar_medication_exception_cases',
      relatedResourceId: '73',
      assignedToRole: 'DOCTOR',
      workflowSlaInstanceId: SLA_ID,
      slaCompletionSemantics: 'domain_evidence',
      metadata: {
        task_contract: 'mar_medication_exception_v1',
        exception_case_id: 73,
        medication_administration_id: 42,
        exception_kind: 'missed',
      },
    })).rejects.toMatchObject({ code: 'TASK_CONTRACT_FACTORY_REQUIRED' });
    expect(queryRawUnsafe).not.toHaveBeenCalled();
  });

  test.each(['completed', 'blocked'])(
    'the generic transition API cannot move the exact contract-bound task to %s',
    async (nextStatus) => {
      queryRawUnsafe.mockResolvedValueOnce([exceptionTask()]);

      await expect(transitionTask({
        tenantId: TENANT_ID,
        id: 41,
        nextStatus,
        actorUid: '00000000-0000-4000-8000-000000000002',
      })).rejects.toMatchObject({ code: 'MAR_EXCEPTION_TASK_WORKFLOW_REQUIRED' });

      expect(queryRawUnsafe.mock.calls.some(([sql]) => /UPDATE tasks/i.test(sql))).toBe(false);
    },
  );

  test('the generic role-queue claim cannot split MAR case and task ownership', async () => {
    const actorUid = '00000000-0000-4000-8000-000000000002';
    queryRawUnsafe
      .mockResolvedValueOnce([{ uid: actorUid, role: 'DOCTOR' }])
      .mockResolvedValueOnce([exceptionTask({
        assigned_to_uid: null,
        assigned_to_role: 'DOCTOR',
      })]);

    await expect(claimInboxTask({
      tenantId: TENANT_ID,
      id: 41,
      actorUid,
      actorRoles: ['DOCTOR'],
      actorPrimaryRole: 'DOCTOR',
      actorRawRole: 'DOCTOR',
      idempotencyKey: 'mar-exception-generic-claim-denied',
      tx,
    })).rejects.toMatchObject({
      code: 'MAR_EXCEPTION_TASK_CLAIM_WORKFLOW_REQUIRED',
    });

    expect(queryRawUnsafe.mock.calls.some(([sql]) => /UPDATE tasks/i.test(sql))).toBe(false);
  });

  test('a malformed contract-bound MAR task cannot widen the exact claim factory', async () => {
    const actorUid = '00000000-0000-4000-8000-000000000002';
    queryRawUnsafe
      .mockResolvedValueOnce([{ uid: actorUid, role: 'DOCTOR' }])
      .mockResolvedValueOnce([exceptionTask({
        related_resource_id: '74',
        assigned_to_uid: null,
        assigned_to_role: 'DOCTOR',
      })]);

    await expect(claimInboxTask({
      tenantId: TENANT_ID,
      id: 41,
      actorUid,
      actorRoles: ['DOCTOR'],
      actorPrimaryRole: 'DOCTOR',
      actorRawRole: 'DOCTOR',
      idempotencyKey: 'mar-exception-malformed-claim-denied',
      tx,
    })).rejects.toMatchObject({
      code: 'MAR_EXCEPTION_TASK_CLAIM_WORKFLOW_REQUIRED',
    });

    expect(queryRawUnsafe.mock.calls.some(([sql]) => /UPDATE tasks/i.test(sql))).toBe(false);
  });

  test('a mismatched SLA source remains non-actionable before any mutation', async () => {
    queryRawUnsafe
      .mockResolvedValueOnce([exceptionTask()])
      .mockResolvedValueOnce([exceptionSla({ source_id: '74' })]);

    await expect(transitionTask({
      tenantId: TENANT_ID,
      id: 41,
      nextStatus: 'in_progress',
      actorUid: '00000000-0000-4000-8000-000000000002',
    })).rejects.toMatchObject({ code: 'MAR_EXCEPTION_TASK_WORKFLOW_REQUIRED' });

    expect(queryRawUnsafe.mock.calls.some(([sql]) => /UPDATE tasks/i.test(sql))).toBe(false);
  });

  test.each([
    ['clear ownership', { assignedToUid: null, assignedToRole: null }],
    ['assign another prescriber queue', { assignedToRole: 'DUTY_DOCTOR' }],
  ])('generic reassignment cannot %s', async (_label, assignment) => {
    queryRawUnsafe.mockResolvedValueOnce([exceptionTask({
      assigned_to_uid: null,
      assigned_to_role: 'DOCTOR',
    })]);

    await expect(reassignTask({
      tenantId: TENANT_ID,
      id: 41,
      ...assignment,
      tx,
    })).rejects.toMatchObject({ code: 'MAR_EXCEPTION_TASK_WORKFLOW_REQUIRED' });

    expect(queryRawUnsafe.mock.calls.some(([sql]) => /UPDATE tasks/i.test(sql))).toBe(false);
    expect(executeRawUnsafe).not.toHaveBeenCalled();
  });

  test.each([
    ['unassigned role queue as ADMIN', 'ADMIN', null, 'DOCTOR'],
    [
      'named prescriber',
      'CONSULTANT',
      '00000000-0000-4000-8000-000000000002',
      null,
    ],
  ])('generic acknowledgement rejects a %s without writes', async (
    _label,
    actorRole,
    assignedUid,
    assignedRole,
  ) => {
    const actorUid = '00000000-0000-4000-8000-000000000002';
    queryRawUnsafe
      .mockResolvedValueOnce([{ uid: actorUid, role: actorRole }])
      .mockResolvedValueOnce([exceptionTask({
        assigned_to_uid: assignedUid,
        assigned_to_role: assignedRole,
      })]);

    await expect(acknowledgeTask({
      tenantId: TENANT_ID,
      id: 41,
      actorUid,
      actorRoles: [actorRole],
      actorPrimaryRole: actorRole,
      actorRawRole: actorRole,
      tx,
    })).rejects.toMatchObject({ code: 'MAR_EXCEPTION_TASK_WORKFLOW_REQUIRED' });

    expect(queryRawUnsafe.mock.calls.some(([sql]) => /UPDATE tasks/i.test(sql))).toBe(false);
    expect(queryRawUnsafe.mock.calls.some(([sql]) => /INSERT INTO task_comments/i.test(sql))).toBe(false);
    expect(executeRawUnsafe).not.toHaveBeenCalled();
  });

  test.each([
    'DOCTOR',
    'DUTY_DOCTOR',
    'CONSULTANT',
    'JUNIOR_DOCTOR',
    'RESIDENT',
  ])('%s can see only the exact canonical MAR coverage branch', async (actorRole) => {
    const actorUid = '00000000-0000-4000-8000-000000000002';
    queryRawUnsafe
      .mockResolvedValueOnce([{ uid: actorUid, role: actorRole }])
      .mockResolvedValueOnce([]);

    const result = await listInboxTasks({
      tenantId: TENANT_ID,
      assigneeUid: actorUid,
      roles: [actorRole],
      primaryRole: actorRole,
      rawRole: actorRole,
      tx,
    });

    expect(result).toEqual({ tasks: [], count: 0 });
    expect(queryRawUnsafe.mock.calls[1][0]).toMatch(
      /task_contract' = 'mar_medication_exception_v1'/,
    );
    expect(queryRawUnsafe.mock.calls[1][0]).toMatch(
      /exception_case\.assigned_prescriber_uid IS NULL/,
    );
    expect(queryRawUnsafe.mock.calls[1][6]).toBe(true);
  });

  test('a non-prescriber role cannot enter the canonical MAR coverage branch', async () => {
    const actorUid = '00000000-0000-4000-8000-000000000002';
    queryRawUnsafe
      .mockResolvedValueOnce([{ uid: actorUid, role: 'NURSING_STAFF' }])
      .mockResolvedValueOnce([]);

    await listInboxTasks({
      tenantId: TENANT_ID,
      assigneeUid: actorUid,
      roles: ['NURSING_STAFF'],
      primaryRole: 'NURSING_STAFF',
      rawRole: 'NURSING_STAFF',
      tx,
    });

    expect(queryRawUnsafe.mock.calls[1][6]).toBe(false);
  });

  test('a legacy prescriber alias cannot see or claim the exact MAR coverage branch', async () => {
    const actorUid = '00000000-0000-4000-8000-000000000002';
    queryRawUnsafe
      .mockResolvedValueOnce([{ uid: actorUid, role: 'DMO' }])
      .mockResolvedValueOnce([]);

    await listInboxTasks({
      tenantId: TENANT_ID,
      assigneeUid: actorUid,
      roles: ['DMO'],
      primaryRole: 'DMO',
      rawRole: 'DMO',
      tx,
    });
    expect(queryRawUnsafe.mock.calls[1][6]).toBe(false);

    queryRawUnsafe.mockReset();
    queryRawUnsafe.mockResolvedValueOnce([{ uid: actorUid, role: 'DMO' }]);
    await expect(claimMarMedicationExceptionTaskTx({
      tenantId: TENANT_ID,
      id: 41,
      actorUid,
      actorRoles: ['DMO'],
      actorPrimaryRole: 'DMO',
      actorRawRole: 'DMO',
      idempotencyKey: 'mar-exception-legacy-alias-denied',
      tx,
    })).rejects.toMatchObject({
      statusCode: 403,
      code: 'TASK_CLAIM_FORBIDDEN',
    });
    expect(queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(executeRawUnsafe).not.toHaveBeenCalled();
  });

  test('a duty doctor claims the canonical DOCTOR queue with exact actor-role evidence', async () => {
    const actorUid = '00000000-0000-4000-8000-000000000002';
    const queuedTask = exceptionTask({
      assigned_to_uid: null,
      assigned_to_role: 'DOCTOR',
    });
    const claimedTask = exceptionTask({
      assigned_to_uid: actorUid,
      assigned_to_role: null,
      metadata: {
        ...queuedTask.metadata,
        role_claimed_actor_role: 'DUTY_DOCTOR',
        role_claimed_actor_raw_role: 'DUTY_DOCTOR',
      },
    });
    queryRawUnsafe
      .mockResolvedValueOnce([{ uid: actorUid, role: 'DUTY_DOCTOR' }])
      .mockResolvedValueOnce([queuedTask])
      .mockResolvedValueOnce([exceptionSla()])
      .mockResolvedValueOnce([claimedTask])
      .mockResolvedValueOnce([{ id: SLA_ID }])
      .mockResolvedValueOnce([{ id: 1 }]);

    const claimed = await claimMarMedicationExceptionTaskTx({
      tenantId: TENANT_ID,
      id: 41,
      actorUid,
      actorRoles: ['DUTY_DOCTOR'],
      actorPrimaryRole: 'DUTY_DOCTOR',
      actorRawRole: 'DUTY_DOCTOR',
      idempotencyKey: 'mar-exception-duty-doctor-claim',
      tx,
    });

    expect(claimed).toMatchObject({ assigned_to_uid: actorUid, assigned_to_role: null });
    const updateCall = queryRawUnsafe.mock.calls.find(([sql]) => /UPDATE tasks/i.test(sql));
    expect(updateCall[5]).toBe('DOCTOR');
    expect(JSON.parse(updateCall[9])).toEqual({
      role_claimed_actor_role: 'DUTY_DOCTOR',
      role_claimed_actor_raw_role: 'DUTY_DOCTOR',
    });
  });
});
