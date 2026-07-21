// The alert, exact task, and SLA are materialized atomically. Only outward
// notification and realtime fan-out are best-effort after that transaction.

import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const executeRawUnsafeMock = jest.fn();
const enqueueCriticalResultTaskMock = jest.fn();
const materializeLabCriticalAlertGenerationMock = jest.fn();
const sendStaffNotificationsMock = jest.fn();
const notificationOutboxQueueMock = jest.fn();
const emitLabEventMock = jest.fn();
const loggerErrorMock = jest.fn();

const __prismaDefaultMock = {
  $queryRawUnsafe: queryRawUnsafeMock,
  $executeRawUnsafe: executeRawUnsafeMock,
};
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  circuitBreakerStatus: jest.fn(() => ({ open: false, consecutiveFailures: 0 })),
  default: __prismaDefaultMock,
  isTenantTransactionClient: () => true,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: loggerErrorMock },
}));
jest.unstable_mockModule('../../services/clinical/canonicalOperationalBridgeService.js', () => ({
  emitCriticalLabAlertAcknowledged: jest.fn(),
}));
jest.unstable_mockModule('../../services/results/resultsInboxService.js', () => ({
  enqueueCriticalResultTask: enqueueCriticalResultTaskMock,
  ensureCriticalResultTaskOpen: jest.fn().mockResolvedValue({ created: false, reopened: false, taskId: null }),
}));
jest.unstable_mockModule('../../services/lab/labCriticalAlertService.js', () => ({
  materializeLabCriticalAlertGeneration: materializeLabCriticalAlertGenerationMock,
  supersedeCriticalAlertWithDiagnosticGenerationTx: jest.fn(),
}));
jest.unstable_mockModule('../../services/diagnostics/diagnosticResultGenerationService.js', () => ({
  createLabDiagnosticGenerationTx: jest.fn(),
}));
jest.unstable_mockModule('../../services/notification/staffNotificationService.js', () => ({
  sendStaffNotifications: sendStaffNotificationsMock,
  default: { sendStaffNotifications: sendStaffNotificationsMock },
}));
jest.unstable_mockModule('../../utils/notifications/notificationOutbox.js', () => ({
  default: { queue: notificationOutboxQueueMock },
  notificationOutbox: { queue: notificationOutboxQueueMock },
}));
jest.unstable_mockModule('../../utils/websocket/realtimeEmitter.js', () => ({
  emitLabEvent: emitLabEventMock,
}));

jest.unstable_mockModule('../../services/workflow/workflowHumanOwnerService.js', () => ({
  isTaskHumanOwnerRole: () => true,
  resolveCurrentHumanActorTx: async ({
    actorUid,
    authenticatedRoles = [],
    authenticatedPrimaryRole = null,
    authenticatedRawRole = null,
  }) => {
    const role = authenticatedPrimaryRole || authenticatedRoles.find(Boolean);
    return {
      uid: String(actorUid).toLowerCase(),
      role,
      queueRole: role,
      rawRole: authenticatedRawRole || role,
    };
  },
}));

const { detectCriticalsForResults } = await import('../../services/lab/labResultsService.js');

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = '5e89c1aa-df0c-4d19-9e7e-40af85486f24';

function breachingResult() {
  return {
    id: 55,
    patient_uid: PATIENT_UID,
    investigation_id: 12,
    loinc_code: '10839-9',
    test_code: 'TROPI',
    test_name: 'Troponin I',
    value_text: '0.85',
    value_numeric: '0.85', // breaches critical_high 0.04
    unit: 'ng/mL',
    is_critical: false,
  };
}

describe('detectCriticalsForResults — atomic obligation and post-commit delivery boundary', () => {
  beforeEach(() => {
    queryRawUnsafeMock.mockReset();
    executeRawUnsafeMock.mockReset();
    enqueueCriticalResultTaskMock.mockReset();
    materializeLabCriticalAlertGenerationMock.mockReset();
    sendStaffNotificationsMock.mockReset();
    notificationOutboxQueueMock.mockReset();
    emitLabEventMock.mockReset();
    loggerErrorMock.mockReset();
    executeRawUnsafeMock.mockResolvedValue(1);
    notificationOutboxQueueMock.mockResolvedValue(undefined);
  });

  it('delegates the clinical obligation to the atomic materializer and swallows only delivery failure', async () => {
    const result = breachingResult();
    const alert = {
      id: 91,
      result_id: result.id,
      patient_uid: result.patient_uid,
      acknowledgement_task_id: 82,
    };
    materializeLabCriticalAlertGenerationMock.mockResolvedValueOnce({
      created: true,
      alert,
      task: { taskId: 82, slaInstanceId: '22222222-2222-4222-8222-222222222222' },
      state: 'critical',
      criticality: {
        matched: true,
        breached: true,
        breachedSide: 'high',
        breachedValue: 0.04,
        evaluatedValue: 0.85,
      },
    });
    queryRawUnsafeMock.mockResolvedValueOnce([{
      id: 17,
      uid: '33333333-3333-4333-8333-333333333333',
      phone: '+15555550117',
      name: 'Ordering Doctor',
    }]);
    sendStaffNotificationsMock.mockRejectedValueOnce(new Error('delivery unavailable'));

    const alerts = await detectCriticalsForResults({ tenantId: TENANT_ID, results: [result] });

    expect(alerts).toEqual([alert]);
    expect(result.is_critical).toBe(true);
    expect(materializeLabCriticalAlertGenerationMock).toHaveBeenCalledTimes(1);
    const materializerInput = materializeLabCriticalAlertGenerationMock.mock.calls[0][0];
    expect(materializerInput).toMatchObject({
      tenantId: TENANT_ID,
      resultId: 55,
      expectedPatientUid: PATIENT_UID,
      source: 'lab_result',
    });
    expect(materializerInput.evaluateCriticality).toEqual(expect.any(Function));

    expect(enqueueCriticalResultTaskMock).not.toHaveBeenCalled();
    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(1);
    expect(queryRawUnsafeMock.mock.calls[0][0]).toMatch(/SELECT DISTINCT u\.id/);
    expect(notificationOutboxQueueMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'lab_critical_alert',
      recipientId: 17,
      data: expect.objectContaining({ alert_id: 91, result_id: 55 }),
    }));
    expect(sendStaffNotificationsMock).toHaveBeenCalledTimes(1);
    expect(loggerErrorMock).toHaveBeenCalledWith(expect.stringMatching(/delivery unavailable/));
    expect(emitLabEventMock).toHaveBeenNthCalledWith(1, 'alert-fired', { tenantId: TENANT_ID });
    expect(emitLabEventMock).toHaveBeenNthCalledWith(2, 'result-pending', { tenantId: TENANT_ID });
  });

  it('propagates atomic materialization failure before any delivery fan-out', async () => {
    const result = breachingResult();
    materializeLabCriticalAlertGenerationMock.mockRejectedValueOnce(
      new Error('exact task/SLA binding failed'),
    );

    await expect(detectCriticalsForResults({
      tenantId: TENANT_ID,
      results: [result],
    })).rejects.toThrow('exact task/SLA binding failed');

    expect(result.is_critical).toBe(false);
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
    expect(enqueueCriticalResultTaskMock).not.toHaveBeenCalled();
    expect(notificationOutboxQueueMock).not.toHaveBeenCalled();
    expect(sendStaffNotificationsMock).not.toHaveBeenCalled();
    expect(emitLabEventMock).not.toHaveBeenCalled();
  });
});
