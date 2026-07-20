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
const loggerErrorMock = jest.fn();
const loggerWarnMock = jest.fn();

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

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    error: loggerErrorMock,
    warn: loggerWarnMock,
  },
}));

const {
  acknowledgeColdChainExcursion,
  breachSurvivedGrace,
  buildTemperatureRegisterCsv,
  createColdChainUnit,
  ingestColdChainReading,
  recordColdChainCorrectiveAction,
  runSilentSensorWatchdog,
  updateColdChainUnit,
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
      status: 'active',
      completed_at: null,
    });
    queueNotificationMock.mockReset().mockResolvedValue({ id: 900 });
    emitColdChainEventMock.mockReset();
    authenticateDeviceCredentialMock.mockReset();
    loggerErrorMock.mockReset();
    loggerWarnMock.mockReset();
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

  it.each([
    ['patient', 'PATIENT'],
    ['machine', 'DEVICE_GATEWAY'],
  ])('rejects a %s role when creating a cold-chain unit', async (_label, role) => {
    await expect(createColdChainUnit({
      unit_code: 'PH-FRIDGE-1',
      display_name: 'Pharmacy Fridge 1',
      kind: 'fridge',
      department: 'pharmacy',
      device_registry_id: 9,
      min_temp_c: 2,
      max_temp_c: 8,
      alert_roles: [role],
    }, { tenantId: TENANT_ID, actorUid: ACTOR_UID })).rejects.toMatchObject({
      statusCode: 400,
      code: 'COLD_CHAIN_ALERT_ROLE_INVALID',
      details: { invalid_roles: [role] },
    });

    expect(queryRawMock).not.toHaveBeenCalled();
  });

  it('rejects an unknown role when updating a cold-chain unit without issuing the update', async () => {
    queryRawMock.mockResolvedValueOnce([{
      id: 11,
      unit_code: 'PH-FRIDGE-1',
      display_name: 'Pharmacy Fridge 1',
      kind: 'fridge',
      department: 'pharmacy',
      location_id: null,
      biomed_device_id: null,
      device_registry_id: 9,
      min_temp_c: 2,
      max_temp_c: 8,
      excursion_grace_minutes: 15,
      alert_roles: ['PHARMACY_STAFF'],
      status: 'active',
      retention_days: 730,
      metadata: {},
    }]);

    await expect(updateColdChainUnit({
      tenantId: TENANT_ID,
      id: 11,
      patch: { alert_roles: ['UNKNOWN_ROLE'] },
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'COLD_CHAIN_ALERT_ROLE_INVALID',
      details: { invalid_roles: ['UNKNOWN_ROLE'] },
    });

    expect(queryRawMock).toHaveBeenCalledTimes(1);
    expect(queryRawMock.mock.calls[0][0]).toMatch(/SELECT u\.\*/);
  });

  it('records a live excursion and degrades a legacy patient role to safe department roles', async () => {
    authenticateDeviceCredentialMock.mockResolvedValueOnce({
      id: 9,
      kind: 'fridge_sensor',
    });
    queryRawMock
      .mockResolvedValueOnce([{
        id: 11,
        unit_code: 'PH-FRIDGE-1',
        display_name: 'Pharmacy Fridge 1',
        department: 'pharmacy',
        device_registry_id: 9,
        min_temp_c: 2,
        max_temp_c: 8,
        excursion_grace_minutes: 1,
        alert_roles: ['PATIENT'],
      }])
      .mockResolvedValueOnce([{
        id: 101,
        unit_id: 11,
        temp_c: 10,
        recorded_at: '2026-07-07T10:05:00.000Z',
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        breach_started_at: '2026-07-07T10:00:00.000Z',
        last_out_of_range_at: '2026-07-07T10:05:00.000Z',
        min_seen_temp_c: 10,
        max_seen_temp_c: 10,
        reading_count: 2,
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
      .mockResolvedValueOnce([
        {
          id: 501,
          uid: '44444444-4444-4444-8444-444444444444',
          phone: '+919999999999',
          role: 'PHARMACY_STAFF',
        },
        {
          id: 502,
          uid: '55555555-5555-4555-8555-555555555555',
          phone: '+918888888888',
          role: 'PATIENT',
        },
      ])
      .mockResolvedValueOnce([{ id: 44 }]);

    const result = await ingestColdChainReading({
      unit_id: 11,
      temp_c: 10,
      recorded_at: '2026-07-07T10:05:00.000Z',
    }, {
      tenantId: TENANT_ID,
      bearerToken: 'sensor-secret',
    });

    expect(result).toMatchObject({
      action: 'excursion_opened',
      reading: { id: 101 },
      excursion: { id: 44, task_id: 77 },
      alertRoles: ['PHARMACY_STAFF', 'PHARMACY_INCHARGE'],
      alert_role_degraded: true,
      alert_role_degradation: {
        status: 'degraded',
        code: 'COLD_CHAIN_ALERT_ROLE_INVALID',
        invalid_roles: ['PATIENT'],
        fallback_roles: ['PHARMACY_STAFF', 'PHARMACY_INCHARGE'],
      },
    });
    expect(queryRawMock.mock.calls.some(([sql]) => /INSERT INTO cold_chain_readings/i.test(sql))).toBe(true);
    const excursionInsert = queryRawMock.mock.calls.find(([sql]) => /INSERT INTO cold_chain_excursions/i.test(sql));
    expect(JSON.parse(excursionInsert.at(-1))).toMatchObject({
      alert_role_degradation: {
        invalid_roles: ['PATIENT'],
        fallback_roles: ['PHARMACY_STAFF', 'PHARMACY_INCHARGE'],
      },
    });
    expect(startWorkflowSlaMock).toHaveBeenCalledWith(expect.objectContaining({
      assignedRoleCodes: ['PHARMACY_STAFF', 'PHARMACY_INCHARGE'],
      metadata: expect.objectContaining({
        alert_role_degradation: expect.objectContaining({ invalid_roles: ['PATIENT'] }),
      }),
    }), { db: tenantTxClient, strict: true });
    expect(createTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      assignedToRole: 'PHARMACY_STAFF',
      metadata: expect.objectContaining({
        alert_roles: ['PHARMACY_STAFF', 'PHARMACY_INCHARGE'],
        alert_role_degradation: expect.objectContaining({ invalid_roles: ['PATIENT'] }),
      }),
    }));
    const recipientQuery = queryRawMock.mock.calls.find(([sql]) => /FROM users/i.test(sql));
    expect(recipientQuery[2]).toEqual(['PHARMACY_STAFF', 'PHARMACY_INCHARGE']);
    expect(queueNotificationMock).toHaveBeenCalledTimes(1);
    expect(queueNotificationMock).toHaveBeenCalledWith(expect.objectContaining({ recipientId: 501 }));
    expect(queueNotificationMock).not.toHaveBeenCalledWith(expect.objectContaining({ recipientId: 502 }));
    expect(loggerErrorMock).toHaveBeenCalledWith(
      'Cold-chain alert roles degraded to safe department defaults',
      expect.objectContaining({
        tenantId: TENANT_ID,
        unitId: 11,
        eventKind: 'temperature_excursion',
        code: 'COLD_CHAIN_ALERT_ROLE_INVALID',
        invalid_roles: ['PATIENT'],
        fallback_roles: ['PHARMACY_STAFF', 'PHARMACY_INCHARGE'],
      }),
    );
  });

  it('opens a watchdog alarm with safe fallback roles when persisted roles are unknown', async () => {
    queryRawMock
      .mockResolvedValueOnce([{
        id: 11,
        unit_code: 'PH-FRIDGE-1',
        display_name: 'Pharmacy Fridge 1',
        department: 'pharmacy',
        alert_roles: ['UNKNOWN_ROLE'],
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
        role: 'PHARMACY_INCHARGE',
      }])
      .mockResolvedValueOnce([{ id: 44 }]);

    await expect(runSilentSensorWatchdog({ tenantId: TENANT_ID })).resolves.toMatchObject({
      count: 1,
      degradedCount: 1,
      degraded: [{
        unit: { id: 11 },
        excursion: { id: 44, task_id: 77 },
        alertRoles: ['PHARMACY_STAFF', 'PHARMACY_INCHARGE'],
        alert_role_degraded: true,
        alert_role_degradation: {
          code: 'COLD_CHAIN_ALERT_ROLE_INVALID',
          invalid_roles: ['UNKNOWN_ROLE'],
          fallback_roles: ['PHARMACY_STAFF', 'PHARMACY_INCHARGE'],
        },
      }],
    });

    expect(startWorkflowSlaMock).toHaveBeenCalledWith(expect.objectContaining({
      assignedRoleCodes: ['PHARMACY_STAFF', 'PHARMACY_INCHARGE'],
    }), { db: tenantTxClient, strict: true });
    expect(createTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      assignedToRole: 'PHARMACY_STAFF',
    }));
    expect(queueNotificationMock).toHaveBeenCalledWith(expect.objectContaining({
      recipientId: 501,
      title: 'Cold-chain sensor silent',
    }));
    expect(emitColdChainEventMock).toHaveBeenCalledWith(
      'silent-sensor-warning',
      expect.objectContaining({ excursionId: 44 }),
    );
    expect(loggerErrorMock).toHaveBeenCalledWith(
      'Cold-chain alert roles degraded to safe department defaults',
      expect.objectContaining({
        unitId: 11,
        eventKind: 'silent_sensor',
        invalid_roles: ['UNKNOWN_ROLE'],
        fallback_roles: ['PHARMACY_STAFF', 'PHARMACY_INCHARGE'],
      }),
    );
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

  it('stops the linked acknowledgement clock when an out-of-range corrective action records a response', async () => {
    queryRawMock
      .mockResolvedValueOnce([{
        id: 7,
        unit_id: 3,
        task_id: 55,
        status: 'acknowledged',
        severity: 'critical',
        corrective_action: 'Moved stock to backup fridge',
      }])
      .mockResolvedValueOnce([{
        id: 3,
        min_temp_c: 2,
        max_temp_c: 8,
      }])
      .mockResolvedValueOnce([{
        recorded_at: '2026-07-07T10:30:00.000Z',
        temp_c: 10,
      }]);

    await expect(recordColdChainCorrectiveAction({
      tenantId: TENANT_ID,
      id: 7,
      correctiveAction: 'Moved stock to backup fridge',
      actorUid: ACTOR_UID,
      actorRoles: ['PHARMACY_STAFF'],
    })).resolves.toMatchObject({ status: 'acknowledged' });

    expect(acknowledgeColdChainTaskFromTrustedWorkflowMock).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      id: 55,
      actorUid: ACTOR_UID,
      actorRoles: ['PHARMACY_STAFF'],
      excursionId: 7,
      tx: tenantTxClient,
    });
    expect(transitionTaskMock).not.toHaveBeenCalled();
    expect(emitColdChainEventMock).toHaveBeenCalledWith(
      'corrective-action-recorded',
      expect.objectContaining({ excursionId: 7 }),
    );
  });

  it('does not emit a corrective-action event when linked task acknowledgement aborts', async () => {
    queryRawMock.mockResolvedValueOnce([{
      id: 7,
      unit_id: 3,
      task_id: 55,
      status: 'acknowledged',
      severity: 'critical',
      corrective_action: 'Moved stock to backup fridge',
    }]);
    acknowledgeColdChainTaskFromTrustedWorkflowMock.mockRejectedValueOnce(
      new Error('task acknowledgement failed'),
    );

    await expect(recordColdChainCorrectiveAction({
      tenantId: TENANT_ID,
      id: 7,
      correctiveAction: 'Moved stock to backup fridge',
      actorUid: ACTOR_UID,
      actorRoles: ['PHARMACY_STAFF'],
    })).rejects.toThrow('task acknowledgement failed');

    expect(queryRawMock).toHaveBeenCalledTimes(1);
    expect(transitionTaskMock).not.toHaveBeenCalled();
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
      metadata: expect.objectContaining({
        task_materialization_contract: 'application_atomic_v1',
      }),
    }), { db: tenantTxClient, strict: true });
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

  it('reloads an exact typed task when a concurrent producer wins the cold-chain slot', async () => {
    createTaskMock.mockResolvedValueOnce(undefined);
    startWorkflowSlaMock.mockResolvedValueOnce({
      id: '33333333-3333-4333-8333-333333333333',
      status: 'breached',
      completed_at: null,
      due_at: '2026-07-07T10:15:00.000Z',
    });
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
      .mockResolvedValueOnce([{ id: 44, unit_id: 11, status: 'open', severity: 'warning' }])
      .mockResolvedValueOnce([{
        id: 77,
        workflow_sla_instance_id: '33333333-3333-4333-8333-333333333333',
        sla_completion_semantics: 'acknowledgement',
      }])
      .mockResolvedValueOnce([{
        id: 44,
        unit_id: 11,
        status: 'open',
        severity: 'warning',
        task_id: 77,
        sla_instance_id: '33333333-3333-4333-8333-333333333333',
      }])
      .mockResolvedValueOnce([]);

    const result = await runSilentSensorWatchdog({ tenantId: TENANT_ID });

    expect(result.count).toBe(1);
    expect(result.opened[0].excursion.task_id).toBe(77);
    expect(queryRawMock.mock.calls[2][0]).toMatch(/FOR UPDATE/);
    expect(queryRawMock.mock.calls[3][0]).toMatch(/UPDATE cold_chain_excursions/);
  });

  it('fails closed when a cold-chain task conflict carries another SLA link', async () => {
    createTaskMock.mockResolvedValueOnce(undefined);
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
      .mockResolvedValueOnce([{ id: 44, unit_id: 11, status: 'open', severity: 'warning' }])
      .mockResolvedValueOnce([{
        id: 77,
        workflow_sla_instance_id: '44444444-4444-4444-8444-444444444444',
        sla_completion_semantics: 'acknowledgement',
      }]);

    await expect(runSilentSensorWatchdog({ tenantId: TENANT_ID }))
      .rejects.toMatchObject({ code: 'COLD_CHAIN_TASK_MATERIALIZATION_FAILED' });
    expect(queryRawMock.mock.calls.some(([sql]) => /UPDATE cold_chain_excursions/i.test(sql)))
      .toBe(false);
  });

  it('preserves an actionable untyped task when the tenant has no cold-chain SLA policy', async () => {
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
      .mockResolvedValueOnce([{ id: 44, unit_id: 11, status: 'open', severity: 'warning' }])
      .mockResolvedValueOnce([{
        id: 44,
        unit_id: 11,
        status: 'open',
        severity: 'warning',
        task_id: 77,
        sla_instance_id: null,
      }])
      .mockResolvedValueOnce([]);
    startWorkflowSlaMock.mockResolvedValueOnce(null);

    await expect(runSilentSensorWatchdog({ tenantId: TENANT_ID }))
      .resolves.toMatchObject({ count: 1 });

    expect(createTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT_ID,
      slaCompletionSemantics: 'none',
      metadata: expect.objectContaining({
        requested_sla_key: 'cold_chain_excursion_ack',
        sla_policy_status: 'missing',
      }),
    }));
    const createInput = createTaskMock.mock.calls[0][0];
    expect(createInput).not.toHaveProperty('dueAt');
    expect(createInput).not.toHaveProperty('workflowSlaInstanceId');
    expect(createInput.metadata).not.toHaveProperty('sla_key');
    expect(createInput.metadata).not.toHaveProperty('sla_instance_id');
    expect(queryRawMock.mock.calls[2][4]).toBeNull();
    expect(queueNotificationMock).not.toHaveBeenCalled();
    expect(emitColdChainEventMock).toHaveBeenCalledWith(
      'silent-sensor-warning',
      expect.objectContaining({ excursionId: 44 }),
    );
  });

  it('reuses a matching degraded cold-chain task when a retry loses the task insert', async () => {
    createTaskMock.mockResolvedValueOnce(undefined);
    startWorkflowSlaMock.mockResolvedValueOnce(null);
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
      .mockResolvedValueOnce([{ id: 44, unit_id: 11, status: 'open', severity: 'warning' }])
      .mockResolvedValueOnce([{
        id: 77,
        workflow_sla_instance_id: null,
        sla_completion_semantics: 'none',
        metadata: {
          requested_sla_key: 'cold_chain_excursion_ack',
          sla_policy_status: 'missing',
        },
      }])
      .mockResolvedValueOnce([{ id: 44, unit_id: 11, task_id: 77, sla_instance_id: null }])
      .mockResolvedValueOnce([]);

    await expect(runSilentSensorWatchdog({ tenantId: TENANT_ID }))
      .resolves.toMatchObject({ count: 1 });
    expect(createTaskMock).toHaveBeenCalledTimes(1);
    expect(queryRawMock.mock.calls[2][0]).toMatch(/FOR UPDATE/);
  });

  it.each([
    ['completed', {
      id: '33333333-3333-4333-8333-333333333333',
      status: 'completed',
      completed_at: '2026-07-07T10:05:00.000Z',
    }],
    ['cancelled', {
      id: '33333333-3333-4333-8333-333333333333',
      status: 'cancelled',
      completed_at: null,
    }],
  ])('fails closed on a %s cold-chain SLA instead of fabricating degraded work', async (_label, sla) => {
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
      }]);
    startWorkflowSlaMock.mockResolvedValueOnce(sla);

    await expect(runSilentSensorWatchdog({ tenantId: TENANT_ID }))
      .rejects.toMatchObject({ code: 'COLD_CHAIN_SLA_MATERIALIZATION_FAILED' });

    expect(createTaskMock).not.toHaveBeenCalled();
    expect(queryRawMock.mock.calls.some(([sql]) => /UPDATE cold_chain_excursions/i.test(sql))).toBe(false);
    expect(queueNotificationMock).not.toHaveBeenCalled();
    expect(emitColdChainEventMock).not.toHaveBeenCalled();
  });

  it('propagates an unexpected SLA start failure before creating degraded work', async () => {
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
      .mockResolvedValueOnce([{ id: 44, unit_id: 11, status: 'open', severity: 'warning' }]);
    startWorkflowSlaMock.mockRejectedValueOnce(new Error('SLA insert failed'));

    await expect(runSilentSensorWatchdog({ tenantId: TENANT_ID }))
      .rejects.toThrow('SLA insert failed');
    expect(createTaskMock).not.toHaveBeenCalled();
    expect(queryRawMock.mock.calls.some(([sql]) => /UPDATE cold_chain_excursions/i.test(sql)))
      .toBe(false);
    expect(queueNotificationMock).not.toHaveBeenCalled();
    expect(emitColdChainEventMock).not.toHaveBeenCalled();
  });
});
