/**
 * resultsInboxService — producer unit tests.
 *
 * Drives the deterministic critical-result → assigned ack-task producer
 * (design §4.1) without a live DB:
 *   - severity → priority map + task_kind='review' + related_resource link
 *   - assignment precedence (ordering clinician, else role fallback)
 *   - mig-269 SLA instance link in tasks.workflow_sla_instance_id
 *   - idempotency via the uq_task_open_per_resource index (ON CONFLICT →
 *     { created:false })
 *   - standalone calls never throw; strict caller-owned transactions rethrow
 *   - promoteTaskCandidate is an inert Wave-3 stub
 */

import { jest } from '@jest/globals';

const createTaskMock = jest.fn();
const transitionTaskMock = jest.fn();
const supersedeAcknowledgementTaskMock = jest.fn();
const postTaskCommentMock = jest.fn();
const startWorkflowSlaMock = jest.fn();
const loggerErrorMock = jest.fn();
const loggerWarnMock = jest.fn();
const resolveClinicalTaskOwnerTxMock = jest.fn();
const repairCriticalResultTaskOwnerTxMock = jest.fn();
const lockResultsInboxResourceTxMock = jest.fn();
// Candidate-row reader used by promoteTaskCandidate inside the tenant tx.
const txQueryMock = jest.fn();

// A fake tenant-scoped tx client. setTenantTx just runs the callback with it.
// $queryRawUnsafe is delegated to txQueryMock so promoteTaskCandidate's candidate
// read can be stubbed per-test.
const fakeTx = { __isTx: true, $queryRawUnsafe: (...args) => txQueryMock(...args) };

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {},
  setTenantTx: async (_tenantId, fn) => fn(fakeTx),
}));

jest.unstable_mockModule('../../services/workflow/taskService.js', () => ({
  default: {
    createTask: createTaskMock,
    transitionTask: transitionTaskMock,
    supersedeAcknowledgementTaskFromTrustedWorkflow: supersedeAcknowledgementTaskMock,
    postTaskComment: postTaskCommentMock,
  },
  createTask: createTaskMock,
  transitionTask: transitionTaskMock,
  supersedeAcknowledgementTaskFromTrustedWorkflow: supersedeAcknowledgementTaskMock,
  postTaskComment: postTaskCommentMock,
}));

jest.unstable_mockModule('../../services/workflow/workflowHumanOwnerService.js', () => ({
  resolveClinicalTaskOwnerTx: resolveClinicalTaskOwnerTxMock,
  repairCriticalResultTaskOwnerTx: repairCriticalResultTaskOwnerTxMock,
}));

jest.unstable_mockModule('../../services/results/resultsInboxResourceLock.js', () => ({
  lockResultsInboxResourceTx: lockResultsInboxResourceTxMock,
}));

jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  startWorkflowSla: startWorkflowSlaMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { error: loggerErrorMock, warn: loggerWarnMock, info: jest.fn() },
}));

// abnormal_result_triage module-enabled gate (dynamic-imported by the bridge).
const getClinicalAiModuleMock = jest.fn();
jest.unstable_mockModule('../../services/ai/clinicalAiModuleService.js', () => ({
  getClinicalAiModule: getClinicalAiModuleMock,
}));

const {
  enqueueCriticalResultTask,
  ensureCriticalResultTaskOpen,
  promoteTaskCandidate,
  promoteAbnormalTriageResult,
} = await import(
  '../../services/results/resultsInboxService.js'
);

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT = '11111111-1111-4111-8111-111111111111';
const CLINICIAN = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  createTaskMock.mockReset();
  transitionTaskMock.mockReset();
  supersedeAcknowledgementTaskMock.mockReset();
  postTaskCommentMock.mockReset();
  startWorkflowSlaMock.mockReset();
  loggerErrorMock.mockReset();
  loggerWarnMock.mockReset();
  resolveClinicalTaskOwnerTxMock.mockReset().mockImplementation(async ({
    requestedUid,
    fallbackRole,
  }) => ({
    assignedToUid: requestedUid || null,
    assignedToRole: requestedUid ? null : fallbackRole,
    resolution: requestedUid ? 'requested_active_clinician' : 'route_role_fallback',
    fallbackReason: requestedUid ? null : 'no_named_clinician',
  }));
  repairCriticalResultTaskOwnerTxMock.mockReset().mockImplementation(async ({ task }) => task);
  lockResultsInboxResourceTxMock.mockReset().mockResolvedValue(undefined);
  txQueryMock.mockReset().mockResolvedValue([]);
  getClinicalAiModuleMock.mockReset();
  startWorkflowSlaMock.mockResolvedValue({
    id: 'sla-instance-1',
    rule_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    status: 'active',
    completed_at: null,
  });
  transitionTaskMock.mockResolvedValue({ id: 17, status: 'completed' });
  supersedeAcknowledgementTaskMock.mockResolvedValue({ id: 17, status: 'completed' });
  postTaskCommentMock.mockResolvedValue({ id: 1 });
});

describe('enqueueCriticalResultTask', () => {
  it('creates a review task: severity→priority, resource link, assignee, SLA link', async () => {
    createTaskMock.mockResolvedValueOnce({ id: 77 });
    const res = await enqueueCriticalResultTask({
      tenantId: TENANT,
      patientUid: PATIENT,
      source: 'lab_result',
      resourceType: 'lab_result',
      resourceId: 123,
      severity: 'critical',
      title: 'Critical lab: Potassium',
      summary: 'K+ 6.9',
      orderingClinicianUid: CLINICIAN,
    });

    expect(res).toEqual({ created: true, taskId: 77, slaInstanceId: 'sla-instance-1' });

    // SLA instance created on the mig-269 critical_result_ack clock.
    expect(startWorkflowSlaMock).toHaveBeenCalledTimes(1);
    const slaArg = startWorkflowSlaMock.mock.calls[0][0];
    expect(slaArg).toMatchObject({
      tenantId: TENANT,
      ruleCode: 'critical_result_ack',
      patientUid: PATIENT,
      sourceTable: 'lab_result',
      sourceId: '123',
      metadata: {
        source: 'lab_result',
        task_materialization_contract: 'application_atomic_v1',
      },
    });
    // Migration 352 exposes global SLA rules under a concrete tenant GUC, so
    // the SLA and task are created atomically on the same tenant transaction.
    expect(startWorkflowSlaMock.mock.calls[0][1]).toEqual({ db: fakeTx });
    expect(lockResultsInboxResourceTxMock).toHaveBeenCalledWith({
      tx: fakeTx,
      tenantId: TENANT,
      resourceType: 'lab_result',
      resourceId: '123',
    });

    // Task created with the right shape + idempotency guard + tx.
    const taskArg = createTaskMock.mock.calls[0][0];
    expect(taskArg).toMatchObject({
      tenantId: TENANT,
      taskKind: 'review',
      priority: 'critical',
      relatedResourceType: 'lab_result',
      relatedResourceId: '123',
      assignedToUid: CLINICIAN,
      onConflictResourceDoNothing: true,
      tx: fakeTx,
    });
    expect(taskArg.metadata).toMatchObject({
      source: 'lab_result',
      sla_key: 'critical_result_ack',
    });
    expect(taskArg.workflowSlaInstanceId).toBe('sla-instance-1');
    expect(taskArg.slaCompletionSemantics).toBe('acknowledgement');
    // Ordering clinician takes the assignee → no role fallback.
    expect(taskArg.assignedToRole == null).toBe(true);
    expect(resolveClinicalTaskOwnerTxMock).toHaveBeenCalledWith({
      tx: fakeTx,
      tenantId: TENANT,
      requestedUid: CLINICIAN,
      fallbackRole: 'DUTY_DOCTOR',
    });
  });

  it('maps high severity → high priority', async () => {
    createTaskMock.mockResolvedValueOnce({ id: 1 });
    await enqueueCriticalResultTask({
      tenantId: TENANT, patientUid: PATIENT, source: 'lab_result',
      resourceType: 'lab_result', resourceId: 5, severity: 'high',
      orderingClinicianUid: CLINICIAN,
    });
    expect(createTaskMock.mock.calls[0][0].priority).toBe('high');
  });

  it('falls back to a role assignee when there is no ordering clinician', async () => {
    createTaskMock.mockResolvedValueOnce({ id: 2 });
    await enqueueCriticalResultTask({
      tenantId: TENANT, patientUid: PATIENT, source: 'vital_alert',
      resourceType: 'clinical_alert', resourceId: 9, severity: 'critical',
      // no orderingClinicianUid → falls back to DUTY role
    });
    const taskArg = createTaskMock.mock.calls[0][0];
    expect(taskArg.assignedToUid == null).toBe(true);
    // Abstract DUTY token resolves to a concrete clinical duty role code.
    expect(taskArg.assignedToRole).toBe('DUTY_DOCTOR');
  });

  it('honours an explicit careTeamRoleHint over the DUTY default', async () => {
    createTaskMock.mockResolvedValueOnce({ id: 3 });
    await enqueueCriticalResultTask({
      tenantId: TENANT, patientUid: PATIENT, source: 'lab_result',
      resourceType: 'lab_result', resourceId: 10, severity: 'critical',
      careTeamRoleHint: 'NURSING_INCHARGE',
    });
    expect(createTaskMock.mock.calls[0][0].assignedToRole).toBe('NURSING_INCHARGE');
  });

  it('resolves the abstract LEADERSHIP token to a concrete leadership role', async () => {
    createTaskMock.mockResolvedValueOnce({ id: 4 });
    await enqueueCriticalResultTask({
      tenantId: TENANT, patientUid: PATIENT, source: 'lab_result',
      resourceType: 'lab_result', resourceId: 11, severity: 'critical',
      careTeamRoleHint: 'LEADERSHIP',
    });
    expect(createTaskMock.mock.calls[0][0].assignedToRole).toBe('CMO');
  });

  it('is idempotent only when an ON CONFLICT winner carries the exact typed SLA link', async () => {
    createTaskMock.mockResolvedValueOnce(undefined); // DO NOTHING → no row
    txQueryMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: 77,
        status: 'open',
        workflow_sla_instance_id: 'sla-instance-1',
        sla_completion_semantics: 'acknowledgement',
        metadata: { sla_key: 'critical_result_ack' },
      }]);
    const res = await enqueueCriticalResultTask({
      tenantId: TENANT, patientUid: PATIENT, source: 'lab_result',
      resourceType: 'lab_result', resourceId: 123, severity: 'critical',
      orderingClinicianUid: CLINICIAN,
    });
    expect(res.created).toBe(false);
    expect(res.taskId).toBe(77);
  });

  it('fails loudly when an ON CONFLICT winner is not linked to the exact SLA', async () => {
    createTaskMock.mockResolvedValueOnce(undefined);
    txQueryMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: 77,
        status: 'open',
        workflow_sla_instance_id: null,
        sla_completion_semantics: 'none',
        metadata: {},
      }]);

    const res = await enqueueCriticalResultTask({
      tenantId: TENANT, patientUid: PATIENT, source: 'lab_result',
      resourceType: 'lab_result', resourceId: 123, severity: 'critical',
      orderingClinicianUid: CLINICIAN,
    });

    expect(res).toMatchObject({ created: false, taskId: null, slaInstanceId: null });
    expect(res.error).toMatch(/incompatible SLA obligation/);
    expect(loggerErrorMock).toHaveBeenCalled();
  });

  it('upgrades an unacknowledged pre-580 critical task to the exact typed SLA', async () => {
    const legacy = {
      id: 66,
      status: 'open',
      workflow_sla_instance_id: null,
      sla_completion_semantics: 'none',
      metadata: { sla_key: 'critical_result_ack' },
    };
    txQueryMock
      .mockResolvedValueOnce([legacy])
      .mockResolvedValueOnce([{
        ...legacy,
        workflow_sla_instance_id: 'sla-instance-1',
        sla_completion_semantics: 'acknowledgement',
      }]);

    const res = await enqueueCriticalResultTask({
      tenantId: TENANT, patientUid: PATIENT, source: 'lab_result',
      resourceType: 'lab_result', resourceId: 123, severity: 'critical',
      orderingClinicianUid: CLINICIAN,
    });

    expect(res).toEqual({
      created: false,
      upgraded: true,
      taskId: 66,
      slaInstanceId: 'sla-instance-1',
    });
    expect(txQueryMock.mock.calls[1][0]).toMatch(/UPDATE tasks/);
    expect(createTaskMock).not.toHaveBeenCalled();
  });

  it.each(['in_progress', 'completed'])(
    'reconciles a pre-580 %s acknowledgement without creating a false fresh alert',
    async (status) => {
      const legacy = {
        id: 66,
        status,
        workflow_sla_instance_id: null,
        sla_completion_semantics: 'none',
        metadata: {
          sla_key: 'critical_result_ack',
          acknowledged_at: '2026-07-19T00:00:00Z',
          acknowledged_by: CLINICIAN,
          acknowledged_via: 'role',
        },
      };
      txQueryMock
        .mockResolvedValueOnce([legacy])
        .mockResolvedValueOnce([{
          ...legacy,
          workflow_sla_instance_id: 'sla-instance-1',
          sla_completion_semantics: 'acknowledgement',
        }])
        .mockResolvedValueOnce([{ id: 'sla-instance-1' }]);

      const res = await enqueueCriticalResultTask({
        tenantId: TENANT, patientUid: PATIENT, source: 'lab_result',
        resourceType: 'lab_result', resourceId: 123, severity: 'critical',
      });

      expect(res).toMatchObject({
        created: false,
        skipped: true,
        reason: 'legacy_task_ack_reconciled',
        taskId: 66,
        slaInstanceId: 'sla-instance-1',
      });
      expect(startWorkflowSlaMock).toHaveBeenCalled();
      const reconciliationCall = txQueryMock.mock.calls[2];
      expect(reconciliationCall[0]).toMatch(/'completed_via', 'task_ack'/);
      expect(reconciliationCall[0]).toMatch(/'completed_by_task', \$2::bigint/);
      expect(reconciliationCall[0]).toMatch(/'acknowledged_at'/);
      expect(reconciliationCall[0]).toMatch(/'acknowledged_by', \$6::text/);
      expect(reconciliationCall[0]).toMatch(/'acknowledged_via', \$7::text/);
      expect(reconciliationCall[0]).toMatch(/to_timestamp\(\$3::double precision \/ 1000\.0\)/);
      expect(reconciliationCall.slice(1)).toEqual([
        'sla-instance-1',
        66,
        new Date('2026-07-19T00:00:00Z').getTime(),
        status,
        TENANT,
        CLINICIAN,
        'role',
      ]);
      expect(createTaskMock).not.toHaveBeenCalled();
    },
  );

  it('reconciles a completed exact typed task instead of false-realerting its incomplete SLA', async () => {
    txQueryMock
      .mockResolvedValueOnce([{
        id: 66,
        status: 'completed',
        completed_at: new Date('2026-07-19T00:01:00Z'),
        workflow_sla_instance_id: 'sla-instance-1',
        sla_completion_semantics: 'acknowledgement',
        metadata: {
          sla_key: 'critical_result_ack',
          acknowledged_at: '2026-07-19T00:01:00Z',
          acknowledged_by: CLINICIAN,
          acknowledged_via: 'assignee',
        },
        linked_sla_rule_code: 'critical_result_ack',
        linked_sla_source_table: 'lab_result',
        linked_sla_source_id: '123',
      }])
      .mockResolvedValueOnce([{ id: 'sla-instance-1' }]);

    const res = await enqueueCriticalResultTask({
      tenantId: TENANT, patientUid: PATIENT, source: 'lab_result',
      resourceType: 'lab_result', resourceId: 123, severity: 'critical',
    });

    expect(res).toMatchObject({
      created: false,
      skipped: true,
      reason: 'task_already_acknowledged',
      taskId: 66,
      slaInstanceId: 'sla-instance-1',
    });
    expect(txQueryMock.mock.calls[1][3])
      .toBe(new Date('2026-07-19T00:01:00.000Z').getTime());
    expect(createTaskMock).not.toHaveBeenCalled();
  });

  it('uses the durable acknowledgement receipt when task completion happened after the SLA due time', async () => {
    txQueryMock
      .mockResolvedValueOnce([{
        id: 66,
        status: 'completed',
        completed_at: new Date('2026-07-19T00:20:00Z'),
        workflow_sla_instance_id: 'sla-instance-1',
        sla_completion_semantics: 'acknowledgement',
        metadata: {
          sla_key: 'critical_result_ack',
          acknowledged_at: '2026-07-19T00:05:00Z',
          acknowledged_by: CLINICIAN,
          acknowledged_via: 'admin',
        },
        linked_sla_rule_code: 'critical_result_ack',
        linked_sla_source_table: 'lab_result',
        linked_sla_source_id: '123',
      }])
      .mockResolvedValueOnce([{ id: 'sla-instance-1' }]);

    const res = await enqueueCriticalResultTask({
      tenantId: TENANT, patientUid: PATIENT, source: 'lab_result',
      resourceType: 'lab_result', resourceId: 123, severity: 'critical',
    });

    expect(res).toMatchObject({
      created: false,
      skipped: true,
      reason: 'task_already_acknowledged',
    });
    expect(txQueryMock.mock.calls[1][3])
      .toBe(new Date('2026-07-19T00:05:00.000Z').getTime());
    expect(txQueryMock.mock.calls[1][3])
      .not.toBe(new Date('2026-07-19T00:20:00.000Z').getTime());
  });

  it.each([
    ['missing', { acknowledged_by: CLINICIAN, acknowledged_via: 'assignee' }],
    ['malformed', {
      acknowledged_at: 'not-a-timestamp',
      acknowledged_by: CLINICIAN,
      acknowledged_via: 'assignee',
    }],
  ])('refuses automatic reconciliation of an in-progress task with a %s receipt', async (_label, metadata) => {
    txQueryMock.mockResolvedValueOnce([{
      id: 66,
      status: 'in_progress',
      completed_at: null,
      workflow_sla_instance_id: 'sla-instance-1',
      sla_completion_semantics: 'acknowledgement',
      metadata: { sla_key: 'critical_result_ack', ...metadata },
      linked_sla_rule_code: 'critical_result_ack',
      linked_sla_source_table: 'lab_result',
      linked_sla_source_id: '123',
    }]);

    const res = await enqueueCriticalResultTask({
      tenantId: TENANT, patientUid: PATIENT, source: 'lab_result',
      resourceType: 'lab_result', resourceId: 123, severity: 'critical',
    });

    expect(res).toMatchObject({ created: false, taskId: null, slaInstanceId: null });
    expect(res.error).toMatch(/manual SLA reconciliation is required/i);
    expect(txQueryMock).toHaveBeenCalledTimes(1);
    expect(createTaskMock).not.toHaveBeenCalled();
  });

  it('does not fabricate an acknowledgement receipt from completed_at', async () => {
    txQueryMock.mockResolvedValueOnce([{
      id: 66,
      status: 'completed',
      completed_at: new Date('2026-07-19T00:20:00Z'),
      workflow_sla_instance_id: 'sla-instance-1',
      sla_completion_semantics: 'acknowledgement',
      metadata: {
        sla_key: 'critical_result_ack',
        acknowledged_by: CLINICIAN,
        acknowledged_via: 'assignee',
      },
      linked_sla_rule_code: 'critical_result_ack',
      linked_sla_source_table: 'lab_result',
      linked_sla_source_id: '123',
    }]);

    const res = await enqueueCriticalResultTask({
      tenantId: TENANT, patientUid: PATIENT, source: 'lab_result',
      resourceType: 'lab_result', resourceId: 123, severity: 'critical',
    });

    expect(res).toMatchObject({ created: false, taskId: null, slaInstanceId: null });
    expect(res.error).toMatch(/acknowledgement receipt is missing or invalid/i);
    expect(txQueryMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['missing actor', { acknowledged_via: 'assignee' }],
    ['invalid actor', { acknowledged_by: 'not-a-uuid', acknowledged_via: 'assignee' }],
    ['missing mode', { acknowledged_by: CLINICIAN }],
    ['invalid mode', { acknowledged_by: CLINICIAN, acknowledged_via: 'system' }],
  ])('refuses automatic reconciliation with %s authorization evidence', async (_label, authMetadata) => {
    txQueryMock.mockResolvedValueOnce([{
      id: 66,
      status: 'in_progress',
      completed_at: null,
      workflow_sla_instance_id: 'sla-instance-1',
      sla_completion_semantics: 'acknowledgement',
      metadata: {
        sla_key: 'critical_result_ack',
        acknowledged_at: '2026-07-19T00:05:00Z',
        ...authMetadata,
      },
      linked_sla_rule_code: 'critical_result_ack',
      linked_sla_source_table: 'lab_result',
      linked_sla_source_id: '123',
    }]);

    const res = await enqueueCriticalResultTask({
      tenantId: TENANT, patientUid: PATIENT, source: 'lab_result',
      resourceType: 'lab_result', resourceId: 123, severity: 'critical',
    });

    expect(res).toMatchObject({ created: false, taskId: null, slaInstanceId: null });
    expect(res.error).toMatch(/authorization evidence is missing or invalid/i);
    expect(txQueryMock).toHaveBeenCalledTimes(1);
    expect(createTaskMock).not.toHaveBeenCalled();
  });

  it('fails before starting an SLA when an unrelated untyped task owns the active slot', async () => {
    txQueryMock.mockResolvedValueOnce([{
      id: 66,
      status: 'open',
      workflow_sla_instance_id: null,
      sla_completion_semantics: 'none',
      metadata: { source: 'other_workflow' },
    }]);

    const res = await enqueueCriticalResultTask({
      tenantId: TENANT, patientUid: PATIENT, source: 'lab_result',
      resourceType: 'lab_result', resourceId: 123, severity: 'critical',
    });

    expect(res.error).toMatch(/incompatible untyped task/);
    expect(startWorkflowSlaMock).not.toHaveBeenCalled();
    expect(createTaskMock).not.toHaveBeenCalled();
  });

  it('never throws: a DB error returns { created:false, error } and logs', async () => {
    createTaskMock.mockRejectedValueOnce(new Error('connection reset'));
    const res = await enqueueCriticalResultTask({
      tenantId: TENANT, patientUid: PATIENT, source: 'lab_result',
      resourceType: 'lab_result', resourceId: 1, severity: 'critical',
      orderingClinicianUid: CLINICIAN,
    });
    expect(res.created).toBe(false);
    expect(res.error).toMatch(/connection reset/);
    expect(loggerErrorMock).toHaveBeenCalled();
  });

  it('reuses a caller transaction and rethrows in strict atomic-write mode', async () => {
    txQueryMock.mockRejectedValueOnce(new Error('strict producer failure'));

    await expect(enqueueCriticalResultTask({
      tenantId: TENANT,
      patientUid: PATIENT,
      source: 'investigation',
      resourceType: 'investigations',
      resourceId: 51,
      severity: 'critical',
      tx: fakeTx,
      strict: true,
    })).rejects.toThrow('strict producer failure');

    expect(loggerErrorMock).not.toHaveBeenCalled();
  });

  it('fails closed when the SLA rule is unavailable and never creates an untracked task', async () => {
    startWorkflowSlaMock.mockResolvedValueOnce(null);
    const res = await enqueueCriticalResultTask({
      tenantId: TENANT, patientUid: PATIENT, source: 'lab_result',
      resourceType: 'lab_result', resourceId: 2, severity: 'critical',
      orderingClinicianUid: CLINICIAN,
    });
    expect(res.created).toBe(false);
    expect(res.slaInstanceId).toBeNull();
    expect(res.error).toMatch(/SLA rule is unavailable/);
    expect(createTaskMock).not.toHaveBeenCalled();
  });

  it.each([
    ['completed_at receipt', { status: 'breached', completed_at: new Date('2026-07-19T00:00:00Z') }],
    ['completed status', { status: 'completed', completed_at: null }],
    ['cancelled status', { status: 'cancelled', completed_at: null }],
  ])('does not attach a new task to a terminal SLA identified by %s', async (_label, terminal) => {
    startWorkflowSlaMock.mockResolvedValueOnce({
      id: 'sla-instance-1',
      rule_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      ...terminal,
    });

    const res = await enqueueCriticalResultTask({
      tenantId: TENANT, patientUid: PATIENT, source: 'lab_result',
      resourceType: 'lab_result', resourceId: 2, severity: 'critical',
      orderingClinicianUid: CLINICIAN,
    });

    expect(res).toMatchObject({
      created: false,
      skipped: true,
      reason: 'sla_terminal',
      slaInstanceId: 'sla-instance-1',
    });
    expect(createTaskMock).not.toHaveBeenCalled();
  });
});

describe('ensureCriticalResultTaskOpen', () => {
  it('decides whether an open window can be reused only while holding its row lock', async () => {
    txQueryMock
      .mockResolvedValueOnce([{
        id: 17,
        status: 'open',
        workflow_sla_instance_id: 'sla-instance-1',
        sla_completion_semantics: 'acknowledgement',
      }])
      .mockResolvedValueOnce([{
        id: 'sla-instance-1',
        rule_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        status: 'active',
        completed_at: null,
      }]);

    const result = await ensureCriticalResultTaskOpen({
      tenantId: TENANT,
      patientUid: PATIENT,
      source: 'lab_result',
      resourceType: 'lab_result',
      resourceId: 123,
      orderingClinicianUid: CLINICIAN,
      reason: 'corrected_result',
      supersededByActorUid: CLINICIAN,
    });

    expect(result).toMatchObject({ created: false, reopened: false, taskId: 17 });
    expect(lockResultsInboxResourceTxMock).toHaveBeenCalledWith({
      tx: fakeTx,
      tenantId: TENANT,
      resourceType: 'lab_result',
      resourceId: '123',
    });
    expect(repairCriticalResultTaskOwnerTxMock).toHaveBeenCalledWith(expect.objectContaining({
      tx: fakeTx,
      tenantId: TENANT,
      requestedUid: CLINICIAN,
      fallbackRole: 'DUTY_DOCTOR',
      task: expect.objectContaining({ id: 17, status: 'open' }),
    }));
    expect(txQueryMock.mock.calls[0][0]).toMatch(/FOR UPDATE/i);
    expect(postTaskCommentMock).toHaveBeenCalledWith(expect.objectContaining({ tx: fakeTx }));
    expect(startWorkflowSlaMock).not.toHaveBeenCalled();
    expect(createTaskMock).not.toHaveBeenCalled();
  });

  it('archives and clears prior completion evidence when it re-arms the SLA', async () => {
    const active = {
      id: 17,
      status: 'in_progress',
      workflow_sla_instance_id: 'sla-instance-1',
      sla_completion_semantics: 'acknowledgement',
    };
    txQueryMock
      .mockResolvedValueOnce([active])
      .mockResolvedValueOnce([{
        id: 'sla-instance-1',
        rule_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        status: 'completed',
        completed_at: new Date('2026-07-19T00:00:00Z'),
      }])
      .mockResolvedValueOnce([{ receipt_valid: true }])
      .mockResolvedValueOnce([{ target_minutes: 15 }])
      .mockResolvedValueOnce([{ id: 'sla-instance-1' }]);
    createTaskMock.mockResolvedValueOnce({ id: 18 });

    const result = await ensureCriticalResultTaskOpen({
      tenantId: TENANT,
      patientUid: PATIENT,
      source: 'lab_result',
      resourceType: 'lab_result',
      resourceId: 123,
      orderingClinicianUid: CLINICIAN,
      reason: 'corrected_result',
      supersededByActorUid: CLINICIAN,
    });

    expect(result).toMatchObject({
      created: true,
      reopened: true,
      taskId: 18,
      supersededTaskId: 17,
    });
    const receiptLookup = txQueryMock.mock.calls[2];
    expect(receiptLookup[0]).toContain('lab_critical_alert_acknowledgement_receipts');
    expect(receiptLookup.slice(1)).toEqual([
      TENANT,
      123,
      PATIENT,
      17,
      'sla-instance-1',
    ]);
    const [sql, ...params] = txQueryMock.mock.calls[4];
    expect(sql).toContain("- 'completed_via'");
    expect(sql).toContain("- 'completed_by_task'");
    expect(sql).toContain("- 'completed_by'");
    expect(sql).toContain("- 'acknowledged_by'");
    expect(sql).toContain("- 'completion_evidence'");
    expect(sql).toContain("- 'ack_contract_version'");
    expect(sql).toContain("'reopen_history'");
    expect(sql).toContain("'prior_status'");
    expect(sql).toContain("'prior_started_at'");
    expect(sql).toContain("'prior_due_at'");
    expect(sql).toContain("'prior_completed_at'");
    expect(sql).toContain("'prior_breached_at'");
    expect(sql).toContain("'prior_escalated_at'");
    expect(sql).toContain("'prior_ack_contract_version'");
    expect(sql).toContain("'prior_completion_evidence'");
    expect(params).toEqual([
      'sla-instance-1',
      TENANT,
      15,
      'corrected_result',
    ]);
    expect(startWorkflowSlaMock).not.toHaveBeenCalled();
    expect(supersedeAcknowledgementTaskMock).toHaveBeenCalledWith({
      tenantId: TENANT,
      id: 17,
      relatedResourceType: 'lab_result',
      relatedResourceId: '123',
      workflowSlaInstanceId: 'sla-instance-1',
      supersededByActorUid: CLINICIAN,
      tx: fakeTx,
    });
  });

  it('keeps blocked resume and completion in one transaction if the second step fails', async () => {
    const active = {
      id: 17,
      status: 'blocked',
      workflow_sla_instance_id: 'sla-instance-1',
      sla_completion_semantics: 'acknowledgement',
    };
    txQueryMock
      .mockResolvedValueOnce([active])
      .mockResolvedValueOnce([{
        id: 'sla-instance-1',
        rule_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        status: 'active',
        completed_at: null,
      }])
      .mockResolvedValueOnce([{ target_minutes: 15 }])
      .mockResolvedValueOnce([{ id: 'sla-instance-1' }]);
    supersedeAcknowledgementTaskMock
      .mockRejectedValueOnce(new Error('forced completion failure'));

    const result = await ensureCriticalResultTaskOpen({
      tenantId: TENANT,
      patientUid: PATIENT,
      source: 'lab_result',
      resourceType: 'lab_result',
      resourceId: 123,
      orderingClinicianUid: CLINICIAN,
      reason: 'corrected_result',
      supersededByActorUid: CLINICIAN,
    });

    expect(supersedeAcknowledgementTaskMock).toHaveBeenCalledTimes(1);
    expect(supersedeAcknowledgementTaskMock.mock.calls[0][0]).toMatchObject({
      id: 17,
      relatedResourceType: 'lab_result',
      relatedResourceId: '123',
      workflowSlaInstanceId: 'sla-instance-1',
      supersededByActorUid: CLINICIAN,
      tx: fakeTx,
    });
    expect(transitionTaskMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ created: false, error: 'forced completion failure' });
    expect(startWorkflowSlaMock).not.toHaveBeenCalled();
    expect(createTaskMock).not.toHaveBeenCalled();
    expect(loggerErrorMock).toHaveBeenCalledWith(
      'ensureCriticalResultTaskOpen failed',
      expect.objectContaining({ err: 'forced completion failure' }),
    );
  });

  it('preserves lineage from the latest terminal predecessor during an explicit reopen', async () => {
    const predecessor = {
      id: 16,
      status: 'completed',
      workflow_sla_instance_id: 'sla-instance-1',
      sla_completion_semantics: 'acknowledgement',
    };
    txQueryMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([predecessor])
      .mockResolvedValueOnce([{
        id: 'sla-instance-1',
        rule_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        status: 'completed',
        completed_at: new Date('2026-07-19T00:00:00Z'),
      }])
      .mockResolvedValueOnce([{ receipt_valid: true }])
      .mockResolvedValueOnce([{ target_minutes: 15 }])
      .mockResolvedValueOnce([{ id: 'sla-instance-1' }]);
    createTaskMock.mockResolvedValueOnce({ id: 18 });

    const result = await ensureCriticalResultTaskOpen({
      tenantId: TENANT,
      patientUid: PATIENT,
      source: 'lab_result',
      resourceType: 'lab_result',
      resourceId: 123,
      orderingClinicianUid: CLINICIAN,
      reason: 'corrected_result',
    });

    expect(result).toMatchObject({
      created: true,
      reopened: true,
      taskId: 18,
      supersededTaskId: 16,
    });
    expect(txQueryMock.mock.calls[1][0]).toMatch(/status IN \('completed', 'cancelled'\)/);
    expect(txQueryMock.mock.calls[1][0]).toMatch(/FOR UPDATE/);
    expect(createTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ reopened_from_task_id: 16 }),
    }));
    expect(postTaskCommentMock).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 16,
      metadata: expect.objectContaining({ superseded_by_task_id: 18 }),
      tx: fakeTx,
    }));
  });

  it('fails closed before mutation when a terminal lab SLA has no immutable predecessor receipt', async () => {
    txQueryMock
      .mockResolvedValueOnce([{
        id: 17,
        status: 'in_progress',
        workflow_sla_instance_id: 'sla-instance-1',
        sla_completion_semantics: 'acknowledgement',
      }])
      .mockResolvedValueOnce([{
        id: 'sla-instance-1',
        rule_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        status: 'completed',
        completed_at: new Date('2026-07-19T00:00:00Z'),
      }])
      .mockResolvedValueOnce([]);

    await expect(ensureCriticalResultTaskOpen({
      tenantId: TENANT,
      patientUid: PATIENT,
      source: 'lab_result',
      resourceType: 'lab_result',
      resourceId: 123,
      orderingClinicianUid: CLINICIAN,
      reason: 'corrected_result',
      supersededByActorUid: CLINICIAN,
      tx: fakeTx,
      strict: true,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'LAB_CRITICAL_ALERT_ACK_RECONCILIATION_REQUIRED',
    });

    expect(txQueryMock).toHaveBeenCalledTimes(3);
    expect(supersedeAcknowledgementTaskMock).not.toHaveBeenCalled();
    expect(createTaskMock).not.toHaveBeenCalled();
    expect(postTaskCommentMock).not.toHaveBeenCalled();
  });

  it('keeps a newly materialized SLA in the replacement-task transaction on insert failure', async () => {
    txQueryMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    createTaskMock.mockRejectedValueOnce(new Error('forced replacement insert failure'));

    const result = await ensureCriticalResultTaskOpen({
      tenantId: TENANT,
      patientUid: PATIENT,
      source: 'lab_result',
      resourceType: 'lab_result',
      resourceId: 123,
      orderingClinicianUid: CLINICIAN,
      reason: 'corrected_result',
    });

    expect(result).toMatchObject({ created: false, error: 'forced replacement insert failure' });
    expect(startWorkflowSlaMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceTable: 'lab_result',
        sourceId: '123',
        metadata: expect.objectContaining({
          task_materialization_contract: 'application_atomic_v1',
        }),
      }),
      { db: fakeTx },
    );
    expect(createTaskMock).toHaveBeenCalledWith(expect.objectContaining({ tx: fakeTx }));
    expect(txQueryMock).toHaveBeenCalledTimes(3);
    expect(postTaskCommentMock).not.toHaveBeenCalled();
  });

  it('reuses a caller transaction and rethrows reopen failures in strict mode', async () => {
    txQueryMock.mockRejectedValueOnce(new Error('strict reopen failure'));

    await expect(ensureCriticalResultTaskOpen({
      tenantId: TENANT,
      patientUid: PATIENT,
      source: 'investigation',
      resourceType: 'investigations',
      resourceId: 51,
      reason: 'investigation_result_rerun',
      tx: fakeTx,
      strict: true,
    })).rejects.toThrow('strict reopen failure');

    expect(loggerErrorMock).not.toHaveBeenCalled();
  });
});

describe('promoteTaskCandidate (Wave 3 dormant AI bridge)', () => {
  it('accepted candidate → enqueues a task with resourceType task_candidate', async () => {
    // Candidate row read inside the tenant tx.
    txQueryMock.mockResolvedValueOnce([{
      id: 42,
      patient_uid: PATIENT,
      task_title: 'Repeat potassium in 6h',
      task_description: 'K+ trending up; recheck.',
      priority: 'urgent',
      owner_role: 'DOCTOR',
      reviewer_decision: 'accepted',
    }]);
    createTaskMock.mockResolvedValueOnce({ id: 501 });

    const res = await promoteTaskCandidate(42, { tenantId: TENANT });

    expect(res.created).toBe(true);
    expect(res.taskId).toBe(501);
    // The producer was invoked once, mapping the candidate fields.
    expect(createTaskMock).toHaveBeenCalledTimes(1);
    const taskArg = createTaskMock.mock.calls[0][0];
    expect(taskArg).toMatchObject({
      tenantId: TENANT,
      taskKind: 'review',
      relatedResourceType: 'task_candidate',
      relatedResourceId: '42',
      patientUid: PATIENT,
      assignedToRole: 'DOCTOR',
      onConflictResourceDoNothing: true,
    });
    // urgent candidate priority is not 'critical' → high producer severity.
    expect(taskArg.priority).toBe('high');
    expect(taskArg.metadata).toMatchObject({ source: 'task_candidate' });
  });

  it('critical candidate → critical task priority', async () => {
    txQueryMock.mockResolvedValueOnce([{
      id: 7, patient_uid: PATIENT, task_title: 'Call rapid response',
      priority: 'critical', owner_role: 'DOCTOR', reviewer_decision: 'accepted',
    }]);
    createTaskMock.mockResolvedValueOnce({ id: 9 });

    const res = await promoteTaskCandidate(7, { tenantId: TENANT });
    expect(res.created).toBe(true);
    expect(createTaskMock.mock.calls[0][0].priority).toBe('critical');
  });

  it('non-accepted candidate → skipped, no task created', async () => {
    txQueryMock.mockResolvedValueOnce([{
      id: 8, patient_uid: PATIENT, task_title: 'Maybe later',
      priority: 'routine', owner_role: 'NURSING_STAFF', reviewer_decision: 'pending',
    }]);

    const res = await promoteTaskCandidate(8, { tenantId: TENANT });
    expect(res).toMatchObject({ created: false, skipped: true });
    expect(createTaskMock).not.toHaveBeenCalled();
  });

  it('missing candidate → skipped, no task created', async () => {
    txQueryMock.mockResolvedValueOnce([]);
    const res = await promoteTaskCandidate(999, { tenantId: TENANT });
    expect(res).toMatchObject({ created: false, skipped: true });
    expect(createTaskMock).not.toHaveBeenCalled();
  });

  it('never throws: a DB error → { created:false } and logs', async () => {
    txQueryMock.mockRejectedValueOnce(new Error('boom'));
    const res = await promoteTaskCandidate(1, { tenantId: TENANT });
    expect(res.created).toBe(false);
    expect(loggerErrorMock).toHaveBeenCalled();
  });
});
