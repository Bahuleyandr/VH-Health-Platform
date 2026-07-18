import { jest } from '@jest/globals';

import { AppError } from '../../utils/AppError.js';

const queryRawMock = jest.fn();
const executeRawMock = jest.fn();
const acknowledgeTaskMock = jest.fn();
const acknowledgeColdChainTaskFromTrustedWorkflowMock = jest.fn();
const transitionTaskMock = jest.fn();
const getTaskMock = jest.fn();
const createTaskMock = jest.fn();
const startWorkflowSlaMock = jest.fn();
const queueNotificationMock = jest.fn();
const emitColdChainEventMock = jest.fn();
const authenticateDeviceCredentialMock = jest.fn();

const mockPrisma = {
  $queryRawUnsafe: queryRawMock,
  $executeRawUnsafe: executeRawMock,
};

const tenantTxClient = {
  $queryRawUnsafe: queryRawMock,
  $executeRawUnsafe: executeRawMock,
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: mockPrisma,
  setTenantTx: async (_tenantId, fn) => fn(tenantTxClient),
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  requireTenantId: (tenantId) => {
    if (!tenantId) throw new Error('tenant required');
    return tenantId;
  },
}));

jest.unstable_mockModule('../../services/workflow/taskService.js', () => ({
  acknowledgeTask: acknowledgeTaskMock,
  acknowledgeColdChainTaskFromTrustedWorkflow: acknowledgeColdChainTaskFromTrustedWorkflowMock,
  transitionTask: transitionTaskMock,
  getTask: getTaskMock,
  createTask: createTaskMock,
}));

jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  startWorkflowSla: startWorkflowSlaMock,
}));

jest.unstable_mockModule('../../utils/notifications/notificationOutbox.js', () => ({
  notificationOutbox: { queue: queueNotificationMock },
  default: { queue: queueNotificationMock },
}));

jest.unstable_mockModule('../../utils/websocket/realtimeEmitter.js', () => ({
  emitColdChainEvent: emitColdChainEventMock,
}));

jest.unstable_mockModule('../../services/devices/deviceRegistryService.js', () => ({
  authenticateDeviceCredential: authenticateDeviceCredentialMock,
}));

const {
  acknowledgeColdChainExcursion,
  breachSurvivedGrace,
  buildTemperatureRegisterCsv,
  recordColdChainCorrectiveAction,
  runSilentSensorWatchdog,
} = await import('../../services/devices/coldChainService.js');

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_UID = '22222222-2222-4222-8222-222222222222';

describe('coldChainService invariants', () => {
  beforeEach(() => {
    queryRawMock.mockReset();
    executeRawMock.mockReset();
    acknowledgeTaskMock.mockReset().mockResolvedValue({ id: 55, status: 'in_progress' });
    acknowledgeColdChainTaskFromTrustedWorkflowMock.mockReset().mockResolvedValue({ id: 55, status: 'in_progress' });
    transitionTaskMock.mockReset().mockResolvedValue({ id: 55, status: 'completed' });
    getTaskMock.mockReset();
    createTaskMock.mockReset().mockResolvedValue({ id: 77 });
    startWorkflowSlaMock.mockReset().mockResolvedValue({
      id: '33333333-3333-4333-8333-333333333333',
      due_at: '2026-07-07T10:15:00.000Z',
    });
    queueNotificationMock.mockReset().mockResolvedValue({ id: 900 });
    emitColdChainEventMock.mockReset();
    authenticateDeviceCredentialMock.mockReset();
  });

  it('keeps door-open transients inside the grace window from opening an excursion', () => {
    expect(breachSurvivedGrace({
      breachStartedAt: '2026-07-07T10:00:00.000Z',
      observedAt: '2026-07-07T10:14:59.000Z',
      graceMinutes: 15,
    })).toBe(false);
    expect(breachSurvivedGrace({
      breachStartedAt: '2026-07-07T10:00:00.000Z',
      observedAt: '2026-07-07T10:15:00.000Z',
      graceMinutes: 15,
    })).toBe(true);
  });

  it('builds a stable monthly register CSV and marks out-of-range readings', () => {
    const csv = buildTemperatureRegisterCsv({
      month: '2026-07',
      unit: {
        unit_code: 'PH-FRIDGE-1',
        display_name: 'Pharmacy Fridge 1',
        min_temp_c: 2,
        max_temp_c: 8,
      },
      readings: [
        {
          recorded_at: '2026-07-07T10:00:00.000Z',
          temp_c: 4.4,
          humidity_pct: 42,
          battery_pct: 88,
        },
        {
          recorded_at: '2026-07-07T10:05:00.000Z',
          temp_c: 10.1,
          humidity_pct: null,
          battery_pct: 87,
        },
      ],
    });

    expect(csv).toBe([
      'unit_code,unit_name,month,recorded_at,temp_c,humidity_pct,battery_pct,in_range',
      'PH-FRIDGE-1,Pharmacy Fridge 1,2026-07,2026-07-07T10:00:00.000Z,4.4,42,88,true',
      'PH-FRIDGE-1,Pharmacy Fridge 1,2026-07,2026-07-07T10:05:00.000Z,10.1,,87,false',
      '',
    ].join('\n'));
  });

  it('acknowledges the linked workflow task through the trusted cold-chain entrypoint on the exact tenant tx', async () => {
    queryRawMock
      .mockResolvedValueOnce([{
        id: 7,
        unit_id: 3,
        task_id: 55,
        status: 'acknowledged',
        severity: 'critical',
      }])
      .mockResolvedValueOnce([{
        id: 3,
        unit_code: 'BB-FREEZER-1',
        display_name: 'Blood bank freezer',
        department: 'blood_bank',
      }]);

    await expect(acknowledgeColdChainExcursion({
      tenantId: TENANT_ID,
      id: 7,
      actorUid: ACTOR_UID,
      actorRoles: ['PHARMACY_STAFF'],
    })).resolves.toMatchObject({ id: 7, status: 'acknowledged' });

    expect(acknowledgeColdChainTaskFromTrustedWorkflowMock).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      id: 55,
      actorUid: ACTOR_UID,
      actorRoles: ['PHARMACY_STAFF'],
      excursionId: 7,
      tx: tenantTxClient,
    });
    expect(acknowledgeTaskMock).not.toHaveBeenCalled();
    expect(emitColdChainEventMock).toHaveBeenCalledWith('excursion-acknowledged', expect.objectContaining({
      tenantId: TENANT_ID,
      unitId: 3,
      excursionId: 7,
    }));
  });

  it('does not emit the post-commit excursion event when linked task acknowledgement aborts', async () => {
    queryRawMock.mockResolvedValueOnce([{
      id: 7,
      unit_id: 3,
      task_id: 55,
      status: 'acknowledged',
      severity: 'critical',
    }]);
    acknowledgeColdChainTaskFromTrustedWorkflowMock.mockRejectedValueOnce(new Error('task acknowledgement failed'));

    await expect(acknowledgeColdChainExcursion({
      tenantId: TENANT_ID,
      id: 7,
      actorUid: ACTOR_UID,
      actorRoles: ['PHARMACY_STAFF'],
    })).rejects.toThrow('task acknowledgement failed');

    expect(emitColdChainEventMock).not.toHaveBeenCalled();
  });

  it('continues excursion closure after a task CAS loser verifies terminal state in the same tx', async () => {
    queryRawMock
      .mockResolvedValueOnce([{
        id: 7,
        unit_id: 3,
        task_id: 55,
        status: 'acknowledged',
        corrective_action: 'Moved stock to backup fridge',
      }])
      .mockResolvedValueOnce([{
        id: 3,
        min_temp_c: 2,
        max_temp_c: 8,
      }])
      .mockResolvedValueOnce([{
        recorded_at: '2026-07-07T10:30:00.000Z',
        temp_c: 4,
      }])
      .mockResolvedValueOnce([{
        id: 7,
        unit_id: 3,
        task_id: 55,
        status: 'closed',
      }]);
    transitionTaskMock.mockRejectedValueOnce(
      AppError.conflict('Task status changed', 'TASK_TRANSITION_CONFLICT'),
    );
    getTaskMock.mockResolvedValueOnce({ id: 55, status: 'completed' });

    const result = await recordColdChainCorrectiveAction({
      tenantId: TENANT_ID,
      id: 7,
      correctiveAction: 'Moved stock to backup fridge',
      actorUid: ACTOR_UID,
    });

    expect(result.status).toBe('closed');
    expect(getTaskMock).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      id: 55,
      tx: tenantTxClient,
    });
    expect(queryRawMock.mock.calls[3][0]).toMatch(/SET status = 'closed'/);
  });

  it('retries completion only when the CAS re-read remains legally completable', async () => {
    queryRawMock
      .mockResolvedValueOnce([{
        id: 7,
        unit_id: 3,
        task_id: 55,
        status: 'acknowledged',
        corrective_action: 'Moved stock to backup fridge',
      }])
      .mockResolvedValueOnce([{ id: 3, min_temp_c: 2, max_temp_c: 8 }])
      .mockResolvedValueOnce([{ recorded_at: '2026-07-07T10:30:00.000Z', temp_c: 4 }])
      .mockResolvedValueOnce([{ id: 7, status: 'closed' }]);
    transitionTaskMock
      .mockRejectedValueOnce(AppError.conflict('Task status changed', 'TASK_TRANSITION_CONFLICT'))
      .mockResolvedValueOnce({ id: 55, status: 'completed' });
    getTaskMock.mockResolvedValueOnce({ id: 55, status: 'in_progress' });

    await expect(recordColdChainCorrectiveAction({
      tenantId: TENANT_ID,
      id: 7,
      correctiveAction: 'Moved stock to backup fridge',
      actorUid: ACTOR_UID,
    })).resolves.toMatchObject({ status: 'closed' });
    expect(transitionTaskMock).toHaveBeenCalledTimes(2);
  });

  it('opens silent-sensor warnings through task, notification, and realtime rails', async () => {
    queryRawMock
      .mockResolvedValueOnce([{
        id: 11,
        unit_code: 'PH-FRIDGE-1',
        display_name: 'Pharmacy Fridge 1',
        department: 'pharmacy',
        alert_roles: ['PHARMACY_STAFF'],
        device_code: 'SENSOR-1',
        last_seen_at: '2026-07-07T09:00:00.000Z',
        expected_interval_seconds: 300,
      }])
      .mockResolvedValueOnce([{
        id: 44,
        unit_id: 11,
        status: 'open',
        severity: 'warning',
      }])
      .mockResolvedValueOnce([{
        id: 44,
        unit_id: 11,
        status: 'open',
        severity: 'warning',
        task_id: 77,
        sla_instance_id: '33333333-3333-4333-8333-333333333333',
      }])
      .mockResolvedValueOnce([{
        id: 501,
        uid: '44444444-4444-4444-8444-444444444444',
        phone: '+919999999999',
        role: 'PHARMACY_STAFF',
      }])
      .mockResolvedValueOnce([{ id: 44 }]);

    const result = await runSilentSensorWatchdog({ tenantId: TENANT_ID });

    expect(result.count).toBe(1);
    expect(startWorkflowSlaMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT_ID,
      ruleCode: 'cold_chain_excursion_ack',
      sourceTable: 'cold_chain_excursions',
      sourceId: '44',
    }), { db: tenantTxClient });
    expect(createTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT_ID,
      taskKind: 'review',
      relatedResourceType: 'cold_chain_excursions',
      relatedResourceId: '44',
      assignedToRole: 'PHARMACY_STAFF',
    }));
    expect(queueNotificationMock).toHaveBeenCalledWith(expect.objectContaining({
      recipientId: 501,
      title: 'Cold-chain sensor silent',
      data: expect.objectContaining({ event_kind: 'silent_sensor', excursion_id: 44 }),
    }));
    expect(emitColdChainEventMock).toHaveBeenCalledWith('silent-sensor-warning', expect.objectContaining({
      tenantId: TENANT_ID,
      unitId: 11,
      excursionId: 44,
    }));
  });
});
