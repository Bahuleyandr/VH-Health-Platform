import { jest } from '@jest/globals';

import { AppError } from '../../utils/AppError.js';

const queryRawMock = jest.fn();
const executeRawMock = jest.fn();
const transitionTaskMock = jest.fn();
const getTaskMock = jest.fn();
const createTaskMock = jest.fn();
const completeTaskFromDomainEvidenceMock = jest.fn();
const startWorkflowSlaMock = jest.fn();

const tenantTxClient = {
  $queryRawUnsafe: queryRawMock,
  $executeRawUnsafe: executeRawMock,
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: tenantTxClient,
  setTenantTx: async (_tenantId, fn) => fn(tenantTxClient),
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  requireTenantId: (tenantId) => {
    if (!tenantId) throw new Error('tenant required');
    return tenantId;
  },
}));

jest.unstable_mockModule('../../services/workflow/taskService.js', () => ({
  createTask: createTaskMock,
  completeTaskFromDomainEvidence: completeTaskFromDomainEvidenceMock,
  getTask: getTaskMock,
  transitionTask: transitionTaskMock,
}));

jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  startWorkflowSla: startWorkflowSlaMock,
}));

const { recordBodyReceive, recordMortuaryBodyRelease } = await import(
  '../../services/clinical/deathCertificationService.js'
);

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_UID = '22222222-2222-4222-8222-222222222222';

function seedReleaseQueries() {
  queryRawMock
    .mockResolvedValueOnce([{
      id: 7,
      is_medicolegal: false,
      police_clearance_at: null,
      body_released_at: null,
    }])
    .mockResolvedValueOnce([{ id: 11 }])
    .mockResolvedValueOnce([{
      id: 7,
      is_medicolegal: false,
      police_clearance_at: null,
    }])
    .mockResolvedValueOnce([{
      id: 7,
      body_released_at: '2026-07-18T10:00:00.000Z',
    }])
    .mockResolvedValueOnce([{
      id: 13,
      event_type: 'release',
    }])
    .mockResolvedValueOnce([{
      id: 17,
      status: 'in_progress',
    }]);
  executeRawMock.mockResolvedValueOnce(1);
}

beforeEach(() => {
  queryRawMock.mockReset();
  executeRawMock.mockReset();
  transitionTaskMock.mockReset();
  getTaskMock.mockReset();
  createTaskMock.mockReset();
  completeTaskFromDomainEvidenceMock.mockReset();
  startWorkflowSlaMock.mockReset().mockResolvedValue({
    id: '33333333-3333-4333-8333-333333333333',
    status: 'active',
    completed_at: null,
    due_at: '2026-07-19T10:00:00.000Z',
  });
});

function seedReceiveQueries() {
  queryRawMock
    .mockResolvedValueOnce([{
      id: 7,
      body_released_at: null,
    }])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{
      id: 11,
      event_type: 'receive',
      is_unclaimed: true,
    }]);
}

describe('mortuary SLA policy compatibility', () => {
  it('materializes configured mortuary work as a typed exact-deadline task', async () => {
    seedReceiveQueries();
    createTaskMock.mockResolvedValueOnce({ id: 17 });

    await expect(recordBodyReceive({
      tenantId: TENANT_ID,
      id: 7,
      is_unclaimed: true,
      performed_by: ACTOR_UID,
      performed_by_role: 'MEDICAL_RECORDS',
    })).resolves.toMatchObject({ id: 11, event_type: 'receive' });

    expect(startWorkflowSlaMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT_ID,
      ruleCode: 'mortuary_unclaimed_body',
      sourceTable: 'death_records',
      sourceId: '7',
      metadata: expect.objectContaining({
        task_materialization_contract: 'application_atomic_v1',
      }),
    }), { db: tenantTxClient, strict: true });
    const createInput = createTaskMock.mock.calls[0][0];
    expect(createInput).toMatchObject({
      workflowSlaInstanceId: '33333333-3333-4333-8333-333333333333',
      slaCompletionSemantics: 'domain_evidence',
      metadata: {
        source: 'mortuary_body_custody',
        sla_key: 'mortuary_unclaimed_body',
      },
      tx: tenantTxClient,
    });
    expect(createInput).not.toHaveProperty('dueAt');
  });

  it('keeps receipt and an old-release-readable untyped task when policy is missing', async () => {
    seedReceiveQueries();
    startWorkflowSlaMock.mockResolvedValueOnce(null);
    createTaskMock.mockResolvedValueOnce({ id: 17 });

    await expect(recordBodyReceive({
      tenantId: TENANT_ID,
      id: 7,
      is_unclaimed: true,
      performed_by: ACTOR_UID,
      performed_by_role: 'MEDICAL_RECORDS',
    })).resolves.toMatchObject({ id: 11, is_unclaimed: true });

    const createInput = createTaskMock.mock.calls[0][0];
    expect(createInput).toMatchObject({
      slaCompletionSemantics: 'none',
      metadata: {
        source: 'mortuary_body_custody',
        sla_key: 'mortuary_unclaimed_body',
        requested_sla_key: 'mortuary_unclaimed_body',
        sla_policy_status: 'missing',
      },
      tx: tenantTxClient,
    });
    expect(createInput).not.toHaveProperty('workflowSlaInstanceId');
    expect(createInput).not.toHaveProperty('dueAt');
    expect(createInput.metadata).not.toHaveProperty('sla_instance_id');
  });

  it('reuses a matching degraded mortuary task when a concurrent producer wins', async () => {
    seedReceiveQueries();
    startWorkflowSlaMock.mockResolvedValueOnce(null);
    createTaskMock.mockResolvedValueOnce(undefined);
    queryRawMock.mockResolvedValueOnce([{
      id: 17,
      workflow_sla_instance_id: null,
      sla_completion_semantics: 'none',
      metadata: {
        sla_key: 'mortuary_unclaimed_body',
        requested_sla_key: 'mortuary_unclaimed_body',
        sla_policy_status: 'missing',
      },
    }]);

    await expect(recordBodyReceive({
      tenantId: TENANT_ID,
      id: 7,
      is_unclaimed: true,
      performed_by: ACTOR_UID,
      performed_by_role: 'MEDICAL_RECORDS',
    })).resolves.toMatchObject({ id: 11 });
    expect(createTaskMock).toHaveBeenCalledTimes(1);
    expect(queryRawMock.mock.calls[3][0]).toMatch(/FOR UPDATE/);
  });

  it('propagates unexpected SLA failures instead of fabricating degraded work', async () => {
    seedReceiveQueries();
    startWorkflowSlaMock.mockRejectedValueOnce(new Error('SLA insert failed'));

    await expect(recordBodyReceive({
      tenantId: TENANT_ID,
      id: 7,
      is_unclaimed: true,
      performed_by: ACTOR_UID,
      performed_by_role: 'MEDICAL_RECORDS',
    })).rejects.toThrow('SLA insert failed');
    expect(createTaskMock).not.toHaveBeenCalled();
  });
});

describe('mortuary task completion concurrency', () => {
  it('continues body release when a task CAS loser verifies terminal state in the same tx', async () => {
    seedReleaseQueries();
    transitionTaskMock.mockRejectedValueOnce(
      AppError.conflict('Task status changed', 'TASK_TRANSITION_CONFLICT'),
    );
    getTaskMock.mockResolvedValueOnce({ id: 17, status: 'completed' });

    const result = await recordMortuaryBodyRelease({
      tenantId: TENANT_ID,
      id: 7,
      performed_by: ACTOR_UID,
      performed_by_role: 'MEDICAL_RECORDS',
      body_released_to_name: 'Relative',
      body_released_to_relation: 'sibling',
      release_method: 'family',
    });

    expect(result.death_record.body_released_at).toBeTruthy();
    expect(result.custody_event.event_type).toBe('release');
    expect(getTaskMock).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      id: 17,
      tx: tenantTxClient,
    });
  });

  it('retries from the re-read status only while a legal completion path remains', async () => {
    seedReleaseQueries();
    transitionTaskMock
      .mockRejectedValueOnce(AppError.conflict('Task status changed', 'TASK_TRANSITION_CONFLICT'))
      .mockResolvedValueOnce({ id: 17, status: 'in_progress' })
      .mockResolvedValueOnce({ id: 17, status: 'completed' });
    getTaskMock.mockResolvedValueOnce({ id: 17, status: 'blocked' });

    await expect(recordMortuaryBodyRelease({
      tenantId: TENANT_ID,
      id: 7,
      performed_by: ACTOR_UID,
      performed_by_role: 'MEDICAL_RECORDS',
      body_released_to_name: 'Relative',
      body_released_to_relation: 'sibling',
      release_method: 'family',
    })).resolves.toMatchObject({
      death_record: { id: 7 },
      custody_event: { event_type: 'release' },
    });

    expect(transitionTaskMock.mock.calls.map(([options]) => options.nextStatus))
      .toEqual(['completed', 'in_progress', 'completed']);
  });
});
