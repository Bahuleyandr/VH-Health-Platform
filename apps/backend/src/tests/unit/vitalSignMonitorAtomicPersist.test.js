// C-2 (audit 2026-06-18) unit regressions for the ATOMIC clinical_alerts
// persistence in checkVitalAnomalies (src/utils/clinical/vitalSignMonitor.js).
//
// Proves:
//   1. The clinical_alerts fan-out runs inside ONE setTenantTx (all-or-nothing),
//      so two CRITICAL vitals from a single write persist together — a second
//      CRITICAL alert can't be dropped mid-loop.
//   2. A persistence failure for a CRITICAL alert is NOT swallowed to a warn:
//      it is logged at error level, reported to Sentry, and RE-THROWN so the
//      caller (and monitoring) sees the failure instead of a silent success.

import { jest } from '@jest/globals';

const queryRawMock = jest.fn();
const executeRawMock = jest.fn();
const txQueryRawMock = jest.fn();
const txExecuteRawMock = jest.fn();
const setTenantTxMock = jest.fn();
const enqueueCriticalResultTaskMock = jest.fn();
const loggerErrorMock = jest.fn();
const loggerWarnMock = jest.fn();
const sentryCaptureMock = jest.fn();
const emitVitalAnomalyMock = jest.fn();
const emitCodeBlueMock = jest.fn();

const __prismaDefaultMock = {
  $queryRawUnsafe: queryRawMock,
  $executeRawUnsafe: executeRawMock,
};
// tx client used inside setTenantTx — separate spies so we can prove the
// INSERTs ran on the transaction client, not on plain prisma.
const __txClient = {
  $queryRawUnsafe: txQueryRawMock,
  $executeRawUnsafe: txExecuteRawMock,
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: setTenantTxMock,
  setTenant: async (_t, fn) => fn(__prismaDefaultMock),
}));
jest.unstable_mockModule('../../utils/sentry.js', () => ({
  default: { captureException: sentryCaptureMock },
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: loggerWarnMock, error: loggerErrorMock, debug: jest.fn() },
}));
jest.unstable_mockModule('../../utils/websocket/realtimeEmitter.js', () => ({
  emitVitalAnomaly: emitVitalAnomalyMock,
  emitCodeBlue: emitCodeBlueMock,
}));
jest.unstable_mockModule('../../utils/notifications/notificationDispatcher.js', () => ({
  dispatch: jest.fn().mockResolvedValue(undefined),
}));
jest.unstable_mockModule('../../services/results/resultsInboxService.js', () => ({
  enqueueCriticalResultTask: enqueueCriticalResultTaskMock,
}));
const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  DEFAULT_TENANT_ID,
}));

const { checkVitalAnomalies } = await import('../../utils/clinical/vitalSignMonitor.js');

const PATIENT_ID = 7777;
const PATIENT_UID = 'b1111111-2222-4333-8444-555555550001';
const PATIENT_TENANT = '22222222-2222-4222-8222-222222222222';

function resetAll() {
  queryRawMock.mockReset();
  executeRawMock.mockReset();
  txQueryRawMock.mockReset();
  txExecuteRawMock.mockReset();
  setTenantTxMock.mockReset();
  enqueueCriticalResultTaskMock.mockReset();
  loggerErrorMock.mockReset();
  loggerWarnMock.mockReset();
  sentryCaptureMock.mockReset();
  emitVitalAnomalyMock.mockReset();
  emitCodeBlueMock.mockReset();
  enqueueCriticalResultTaskMock.mockResolvedValue({ created: true });
  executeRawMock.mockResolvedValue(1);
  // Pre-loop lookups on plain prisma:
  //   Q1 resolvePatientContext, Q2 uid + tenant (CRITICAL fired)
  queryRawMock
    .mockResolvedValueOnce([{ age_years: 50, is_pregnant: false }])
    .mockResolvedValueOnce([{ uid: PATIENT_UID, tenant_id: PATIENT_TENANT }])
    .mockResolvedValue([]);
}

describe('checkVitalAnomalies — atomic clinical_alerts persistence (C-2)', () => {
  it('persists BOTH CRITICAL alerts inside ONE setTenantTx, scoped to the patient tenant', async () => {
    resetAll();
    // setTenantTx runs the callback against the tx client.
    setTenantTxMock.mockImplementation(async (_tenantId, fn) => fn(__txClient));
    // Each tx INSERT returns a new alert id.
    txQueryRawMock
      .mockResolvedValueOnce([{ id: 1001 }])
      .mockResolvedValueOnce([{ id: 1002 }]);

    const alerts = await checkVitalAnomalies(PATIENT_ID, {
      heart_rate: 190,        // CRITICAL (>= 180)
      oxygen_saturation: 80,  // CRITICAL (<= 85)
    }, { recordedBy: 'nurse-uid' });

    expect(alerts.filter((a) => a.severity === 'CRITICAL').length).toBe(2);

    // ONE transaction opened, scoped to the patient's tenant.
    expect(setTenantTxMock).toHaveBeenCalledTimes(1);
    expect(setTenantTxMock.mock.calls[0][0]).toBe(PATIENT_TENANT);

    // Both clinical_alerts INSERTs ran on the TX client (not plain prisma).
    const txInserts = txQueryRawMock.mock.calls.filter((c) => /INSERT INTO clinical_alerts/i.test(c[0]));
    expect(txInserts.length).toBe(2);
    const plainInserts = queryRawMock.mock.calls.filter((c) => /INSERT INTO clinical_alerts/i.test(c[0]));
    expect(plainInserts.length).toBe(0);

    // Both critical alerts were enqueued to the results inbox post-commit.
    expect(enqueueCriticalResultTaskMock).toHaveBeenCalledTimes(2);
  });

  it('a persistence failure for a CRITICAL alert is escalated (error + Sentry) and RE-THROWN, not swallowed', async () => {
    resetAll();
    const boom = new Error('clinical_alerts INSERT failed');
    setTenantTxMock.mockRejectedValue(boom);

    await expect(
      checkVitalAnomalies(PATIENT_ID, { heart_rate: 190 }, { recordedBy: 'nurse-uid' }),
    ).rejects.toThrow(/clinical_alerts INSERT failed/);

    // High-severity: logged at ERROR (not warn) + reported to Sentry.
    expect(loggerErrorMock).toHaveBeenCalled();
    expect(sentryCaptureMock).toHaveBeenCalledTimes(1);
    expect(sentryCaptureMock.mock.calls[0][0]).toBe(boom);
    // Tagged as a fatal clinical-alerts CRITICAL failure.
    const ctx = sentryCaptureMock.mock.calls[0][1] || {};
    expect(ctx.level).toBe('fatal');
    expect(ctx.tags?.subsystem).toBe('clinical_alerts');

    // The failure was NOT downgraded to a benign warn-and-continue.
    expect(enqueueCriticalResultTaskMock).not.toHaveBeenCalled();
  });
});
