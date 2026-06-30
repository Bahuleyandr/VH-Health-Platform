// FU2 (lab half) — the results-inbox producer hook in detectCriticalsForResults
// is best-effort / post-commit and MUST NOT break the lab write.
//
// labResultsService.detectCriticalsForResults already wraps
// enqueueCriticalResultTask in try/catch (labResultsService.js ~391). This test
// proves the contract: even when the producer THROWS, detectCriticalsForResults
// resolves (does not reject), still returns the fired alert, and the
// lab_critical_alerts INSERT still happened.
//
// We mock resultsInboxService so we can fault-inject the producer, plus the
// notification fan-out deps so the test stays focused on the alert write.
//
// Query order in detectCriticalsForResults for one breaching result (verified
// against the code):
//   Q1 lab_critical_thresholds lookup     -> [{ critical_low, critical_high, unit }]
//   (executeRaw) UPDATE lab_results is_critical
//   Q2 INSERT lab_critical_alerts         -> [{ id, ... }]
//   Q3 recipients fan-out lookup          -> []   (inside the fan-out try)
//   Q4 ordering-clinician lookup          -> []   (inside the producer try)
//   then enqueueCriticalResultTask(...)   -> (mocked: rejects)

import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const executeRawUnsafeMock = jest.fn();
const enqueueCriticalResultTaskMock = jest.fn();
const loggerErrorMock = jest.fn();

const __prismaDefaultMock = {
  $queryRawUnsafe: queryRawUnsafeMock,
  $executeRawUnsafe: executeRawUnsafeMock,
};
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  circuitBreakerStatus: jest.fn(() => ({ open: false, consecutiveFailures: 0 })),
  default: __prismaDefaultMock,
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
// The results-inbox producer — the fault-injection target.
jest.unstable_mockModule('../../services/results/resultsInboxService.js', () => ({
  enqueueCriticalResultTask: enqueueCriticalResultTaskMock,
}));
// Notification fan-out deps — mocked so the alert-write assertion isn't noisy.
jest.unstable_mockModule('../../services/notification/staffNotificationService.js', () => ({
  sendStaffNotifications: jest.fn().mockResolvedValue(undefined),
  default: { sendStaffNotifications: jest.fn().mockResolvedValue(undefined) },
}));
jest.unstable_mockModule('../../utils/notifications/notificationOutbox.js', () => ({
  default: { queue: jest.fn().mockResolvedValue(undefined) },
  notificationOutbox: { queue: jest.fn().mockResolvedValue(undefined) },
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

describe('detectCriticalsForResults — results-inbox producer is non-blocking (FU2)', () => {
  beforeEach(() => {
    queryRawUnsafeMock.mockReset();
    executeRawUnsafeMock.mockReset();
    enqueueCriticalResultTaskMock.mockReset();
    loggerErrorMock.mockReset();
    executeRawUnsafeMock.mockResolvedValue(1);
  });

  it('does NOT throw and still writes the lab_critical_alerts row when the producer rejects', async () => {
    // Producer throws — the lab write must survive it.
    enqueueCriticalResultTaskMock.mockRejectedValue(new Error('boom'));

    queryRawUnsafeMock
      // Q1 threshold lookup
      .mockResolvedValueOnce([{ critical_low: null, critical_high: '0.04', test_name: 'Troponin I', unit: 'ng/mL' }])
      // Q2 INSERT lab_critical_alerts
      .mockResolvedValueOnce([{ id: 91, result_id: 55, patient_uid: PATIENT_UID, threshold_breached: 'high' }])
      // Q3 recipients fan-out lookup (inside the fan-out try)
      .mockResolvedValueOnce([])
      // Q4 ordering-clinician lookup (inside the producer try)
      .mockResolvedValueOnce([])
      .mockResolvedValue([]);

    const result = breachingResult();

    // Must RESOLVE despite the producer throwing.
    const alerts = await detectCriticalsForResults({ tenantId: TENANT_ID, results: [result] });

    // The alert fired + was returned (the lab write completed).
    expect(alerts).toHaveLength(1);
    expect(alerts[0].id).toBe(91);
    expect(result.is_critical).toBe(true);

    // The lab_critical_alerts INSERT happened.
    const insertCall = queryRawUnsafeMock.mock.calls.find((args) =>
      /INSERT INTO lab_critical_alerts/i.test(args[0]),
    );
    expect(insertCall).toBeTruthy();

    // The is_critical UPDATE happened too.
    const updateCall = executeRawUnsafeMock.mock.calls.find((args) =>
      /UPDATE lab_results[\s\S]*SET is_critical = true/i.test(args[0]),
    );
    expect(updateCall).toBeTruthy();

    // The producer was invoked, threw, and the throw was swallowed + logged.
    expect(enqueueCriticalResultTaskMock).toHaveBeenCalledTimes(1);
    expect(enqueueCriticalResultTaskMock.mock.calls[0][0]).toMatchObject({
      tenantId: TENANT_ID,
      resourceType: 'lab_result',
      resourceId: 55,
      severity: 'critical',
    });
    expect(loggerErrorMock).toHaveBeenCalled();
  });
});
