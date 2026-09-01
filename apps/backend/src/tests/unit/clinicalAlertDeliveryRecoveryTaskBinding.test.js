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
  createTask,
  reassignTask,
  transitionTask,
} = await import(
  '../../services/workflow/taskService.js'
);

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const SLA_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function recoveryTask(overrides = {}) {
  return {
    id: 41,
    tenant_id: TENANT_ID,
    task_kind: 'escalation',
    status: 'open',
    workflow_run_id: null,
    workflow_step_id: null,
    workflow_sla_instance_id: SLA_ID,
    sla_completion_semantics: 'domain_evidence',
    related_resource_type: 'clinical_alert_delivery_recovery_cases',
    related_resource_id: '73',
    metadata: {
      task_contract: 'clinical_alert_delivery_recovery_v1',
      case_kind: 'manual_hold',
      obligation_id: '91',
    },
    ...overrides,
  };
}

function recoverySla(overrides = {}) {
  return {
    id: SLA_ID,
    rule_code: 'clinical_alert_delivery_manual_hold_review',
    source_table: 'clinical_alert_delivery_recovery_cases',
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

describe('clinical alert delivery recovery task binding', () => {
  test('an exact existing admin recovery task remains actionable through taskService', async () => {
    const task = recoveryTask();
    queryRawUnsafe
      .mockResolvedValueOnce([task])
      .mockResolvedValueOnce([recoverySla()])
      .mockResolvedValueOnce([{ ...task, status: 'in_progress' }]);

    const transitioned = await transitionTask({
      tenantId: TENANT_ID,
      id: task.id,
      nextStatus: 'in_progress',
    });

    expect(transitioned.status).toBe('in_progress');
    expect(queryRawUnsafe.mock.calls[1][0]).toMatch(/workflow_sla_instances/i);
    expect(queryRawUnsafe.mock.calls[2][0]).toMatch(/UPDATE tasks/i);
  });

  test('the generic transition API cannot park an exact recovery task outside its workflow', async () => {
    queryRawUnsafe.mockResolvedValueOnce([recoveryTask()]);

    await expect(transitionTask({
      tenantId: TENANT_ID,
      id: 41,
      nextStatus: 'blocked',
      actorUid: '00000000-0000-4000-8000-000000000002',
    })).rejects.toMatchObject({
      code: 'CLINICAL_ALERT_RECOVERY_TASK_WORKFLOW_REQUIRED',
    });

    expect(queryRawUnsafe.mock.calls.some(([sql]) => /UPDATE tasks/i.test(sql))).toBe(false);
    expect(executeRawUnsafe).not.toHaveBeenCalled();
  });

  test.each([
    [
      'an arbitrary recovery source',
      recoveryTask(),
      recoverySla({ source_table: 'clinical_orders', source_id: '91' }),
    ],
    [
      'an unrelated typed SLA rule',
      recoveryTask({
        metadata: {},
        related_resource_type: 'unregistered_resource',
        related_resource_id: '73',
      }),
      recoverySla({
        rule_code: 'unregistered_task_clock',
        source_table: 'unregistered_resource',
      }),
    ],
  ])('rejects %s before mutation', async (_label, task, sla) => {
    queryRawUnsafe
      .mockResolvedValueOnce([task])
      .mockResolvedValueOnce([sla]);

    await expect(transitionTask({
      tenantId: TENANT_ID,
      id: task.id,
      nextStatus: 'in_progress',
    })).rejects.toMatchObject({ code: 'TASK_SLA_SOURCE_BINDING_INVALID' });

    expect(queryRawUnsafe.mock.calls.some(([sql]) => /UPDATE tasks/i.test(sql))).toBe(false);
  });

  test('the generic task API cannot mint the protected recovery contract', async () => {
    await expect(createTask({
      tenantId: TENANT_ID,
      taskKind: 'escalation',
      title: 'Spoofed clinical alert recovery',
      relatedResourceType: 'clinical_alert_delivery_recovery_cases',
      relatedResourceId: '73',
      assignedToRole: 'ADMIN',
      workflowSlaInstanceId: SLA_ID,
      slaCompletionSemantics: 'domain_evidence',
      metadata: {
        task_contract: 'clinical_alert_delivery_recovery_v1',
        case_kind: 'manual_hold',
      },
    })).rejects.toMatchObject({ code: 'TASK_CONTRACT_FACTORY_REQUIRED' });
    expect(queryRawUnsafe).not.toHaveBeenCalled();
  });

  test.each([
    ['clear ownership', { assignedToUid: null, assignedToRole: null }],
    ['assign a clinical queue', { assignedToRole: 'DOCTOR' }],
  ])('generic reassignment cannot %s', async (_label, assignment) => {
    queryRawUnsafe.mockResolvedValueOnce([recoveryTask({
      assigned_to_uid: null,
      assigned_to_role: 'ADMIN',
    })]);

    await expect(reassignTask({
      tenantId: TENANT_ID,
      id: 41,
      ...assignment,
      tx,
    })).rejects.toMatchObject({
      code: 'CLINICAL_ALERT_RECOVERY_TASK_WORKFLOW_REQUIRED',
    });

    expect(queryRawUnsafe.mock.calls.some(([sql]) => /UPDATE tasks/i.test(sql))).toBe(false);
    expect(executeRawUnsafe).not.toHaveBeenCalled();
  });

  test.each([
    ['unassigned ADMIN queue', null],
    ['named ADMIN owner', '00000000-0000-4000-8000-000000000002'],
  ])('generic acknowledgement cannot mutate an %s task', async (_label, assignedUid) => {
    const actorUid = '00000000-0000-4000-8000-000000000002';
    queryRawUnsafe
      .mockResolvedValueOnce([{ uid: actorUid, role: 'ADMIN' }])
      .mockResolvedValueOnce([recoveryTask({
        assigned_to_uid: assignedUid,
        assigned_to_role: assignedUid ? null : 'ADMIN',
      })]);

    await expect(acknowledgeTask({
      tenantId: TENANT_ID,
      id: 41,
      actorUid,
      actorRoles: ['ADMIN'],
      actorPrimaryRole: 'ADMIN',
      actorRawRole: 'ADMIN',
      tx,
    })).rejects.toMatchObject({
      code: 'CLINICAL_ALERT_RECOVERY_TASK_WORKFLOW_REQUIRED',
    });

    expect(queryRawUnsafe.mock.calls.some(([sql]) => /UPDATE tasks/i.test(sql))).toBe(false);
    expect(queryRawUnsafe.mock.calls.some(([sql]) => /INSERT INTO task_comments/i.test(sql))).toBe(false);
    expect(executeRawUnsafe).not.toHaveBeenCalled();
  });
});
