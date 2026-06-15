/**
 * resultsInboxService — producer unit tests.
 *
 * Drives the deterministic critical-result → assigned ack-task producer
 * (design §4.1) without a live DB:
 *   - severity → priority map + task_kind='review' + related_resource link
 *   - assignment precedence (ordering clinician, else role fallback)
 *   - mig-269 SLA instance link in metadata.sla_instance_id
 *   - idempotency via the uq_task_open_per_resource index (ON CONFLICT →
 *     { created:false })
 *   - never throws (best-effort): a DB error → { created:false, error }
 *   - promoteTaskCandidate is an inert Wave-3 stub
 */

import { jest } from '@jest/globals';

const createTaskMock = jest.fn();
const startWorkflowSlaMock = jest.fn();
const loggerErrorMock = jest.fn();

// A fake tenant-scoped tx client. setTenantTx just runs the callback with it.
const fakeTx = { __isTx: true };

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {},
  setTenantTx: async (_tenantId, fn) => fn(fakeTx),
}));

jest.unstable_mockModule('../../services/workflow/taskService.js', () => ({
  default: { createTask: createTaskMock },
  createTask: createTaskMock,
}));

jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  startWorkflowSla: startWorkflowSlaMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { error: loggerErrorMock, warn: jest.fn(), info: jest.fn() },
}));

const { enqueueCriticalResultTask, promoteTaskCandidate } = await import(
  '../../services/results/resultsInboxService.js'
);

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT = '11111111-1111-4111-8111-111111111111';
const CLINICIAN = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  createTaskMock.mockReset();
  startWorkflowSlaMock.mockReset();
  loggerErrorMock.mockReset();
  startWorkflowSlaMock.mockResolvedValue({ id: 'sla-instance-1' });
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
    });
    // Runs inside the tenant-scoped tx.
    expect(startWorkflowSlaMock.mock.calls[0][1]).toMatchObject({ db: fakeTx });

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
      sla_instance_id: 'sla-instance-1',
      sla_key: 'critical_result_ack',
    });
    // Ordering clinician takes the assignee → no role fallback.
    expect(taskArg.assignedToRole == null).toBe(true);
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

  it('is idempotent: ON CONFLICT (no row) → { created:false }', async () => {
    createTaskMock.mockResolvedValueOnce(undefined); // DO NOTHING → no row
    const res = await enqueueCriticalResultTask({
      tenantId: TENANT, patientUid: PATIENT, source: 'lab_result',
      resourceType: 'lab_result', resourceId: 123, severity: 'critical',
      orderingClinicianUid: CLINICIAN,
    });
    expect(res.created).toBe(false);
    expect(res.taskId).toBeNull();
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

  it('tolerates a missing SLA instance (sla disabled) — task still created, null sla link', async () => {
    startWorkflowSlaMock.mockResolvedValueOnce(null);
    createTaskMock.mockResolvedValueOnce({ id: 8 });
    const res = await enqueueCriticalResultTask({
      tenantId: TENANT, patientUid: PATIENT, source: 'lab_result',
      resourceType: 'lab_result', resourceId: 2, severity: 'critical',
      orderingClinicianUid: CLINICIAN,
    });
    expect(res.created).toBe(true);
    expect(res.slaInstanceId).toBeNull();
    expect(createTaskMock.mock.calls[0][0].metadata.sla_instance_id).toBeNull();
  });
});

describe('promoteTaskCandidate (Wave 3 stub)', () => {
  it('is inert: returns a not-created result and creates no task', async () => {
    const res = await promoteTaskCandidate('candidate-1', { tenantId: TENANT });
    expect(res.created).toBe(false);
    expect(createTaskMock).not.toHaveBeenCalled();
  });
});
