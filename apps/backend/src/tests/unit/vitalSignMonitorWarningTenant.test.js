// C-M2 regression pins: WARNING-only clinical_alerts batches must persist
// under the PATIENT's tenant, not the default tenant.
//
// Previously the users uid/tenant lookup ran only when a CRITICAL alert
// fired, so a warning-only batch reached `requireTenantId(null)` — in prod
// (ALLOW_DEFAULT_TENANT=true) that mis-stamped the row to DEFAULT_TENANT_ID;
// with the flag off it threw TENANT_CONTEXT_REQUIRED after the caller's
// vitals tx had already committed.
//
// Also pins:
//   * a caller-supplied context.tenantId wins and skips the users lookup for
//     warning-only, non-pregnancy batches (no extra query);
//   * at most ONE users uid/tenant lookup per invocation (the old pregnancy
//     uid lookup and critical tenant lookup are merged);
//   * a failed lookup still persists (under the default-tenant fallback)
//     rather than dropping the alert.

import { jest } from '@jest/globals';

const queryRawMock = jest.fn();
const executeRawMock = jest.fn();
const txQueryRawMock = jest.fn();
const setTenantTxMock = jest.fn();
const enqueueCriticalResultTaskMock = jest.fn();

const __prismaDefaultMock = {
  $queryRawUnsafe: queryRawMock,
  $executeRawUnsafe: executeRawMock,
};
const __txClient = {
  $queryRawUnsafe: txQueryRawMock,
  $executeRawUnsafe: jest.fn(),
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: setTenantTxMock,
  setTenant: async (_t, fn) => fn(__prismaDefaultMock),
}));
jest.unstable_mockModule('../../utils/sentry.js', () => ({
  default: { captureException: jest.fn() },
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../../utils/websocket/realtimeEmitter.js', () => ({
  emitVitalAnomaly: jest.fn(),
  emitCodeBlue: jest.fn(),
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
  requireTenantId: (tenantId) => tenantId || DEFAULT_TENANT_ID,
}));

const { checkVitalAnomalies } = await import('../../utils/clinical/vitalSignMonitor.js');

const PATIENT_ID = 8888;
const PATIENT_UID = 'c1111111-2222-4333-8444-555555550002';
const PATIENT_TENANT = '33333333-3333-4333-8333-333333333333';
const CALLER_TENANT = '44444444-4444-4444-8444-444444444444';

const tenantLookups = () =>
  queryRawMock.mock.calls.filter((c) => /SELECT\s+tenant_id::text\s+AS\s+tenant_id\s+FROM\s+users/i.test(c[0]));
const activePatientLocks = () =>
  txQueryRawMock.mock.calls.filter((c) => /FOR (?:NO KEY )?UPDATE/i.test(c[0]));

let patientContext;

function resetAll() {
  queryRawMock.mockReset();
  executeRawMock.mockReset();
  txQueryRawMock.mockReset();
  setTenantTxMock.mockReset();
  enqueueCriticalResultTaskMock.mockReset();
  enqueueCriticalResultTaskMock.mockResolvedValue({ created: true });
  executeRawMock.mockResolvedValue(1);
  setTenantTxMock.mockImplementation(async (_tenantId, fn) => fn(__txClient));
  patientContext = { age_years: 50, is_pregnant: false };
  txQueryRawMock.mockImplementation(async (sql) => {
    if (/FOR (?:NO KEY )?UPDATE/i.test(sql)) {
      return [{
        id: PATIENT_ID,
        uid: PATIENT_UID,
        is_active: true,
        status: 'active',
        merged_into_uid: null,
        is_deleted: false,
      }];
    }
    if (/DATE_PART|maternity_pregnancies/i.test(sql)) return [patientContext];
    if (/INSERT INTO clinical_alerts/i.test(sql)) return [{ id: 5001 }];
    return [];
  });
}

describe('checkVitalAnomalies — warning-only tenant stamping (C-M2)', () => {
  it('WARNING-only batch resolves the patient tenant from users and scopes setTenantTx to it', async () => {
    resetAll();
    queryRawMock.mockResolvedValue([{ tenant_id: PATIENT_TENANT }]);

    // HR 155: above max 150, below critical 180 → WARNING only.
    const alerts = await checkVitalAnomalies(PATIENT_ID, { heart_rate: 155 }, {
      recordedBy: 'nurse-uid',
    });

    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe('WARNING');
    expect(setTenantTxMock).toHaveBeenCalledTimes(1);
    expect(setTenantTxMock.mock.calls[0][0]).toBe(PATIENT_TENANT);
    expect(setTenantTxMock.mock.calls[0][0]).not.toBe(DEFAULT_TENANT_ID);
    expect(tenantLookups()).toHaveLength(1);
    expect(activePatientLocks()).toHaveLength(1);
  });

  it('caller-supplied context.tenantId wins and SKIPS the users lookup for a warning-only batch', async () => {
    resetAll();
    queryRawMock.mockResolvedValue([]);

    await checkVitalAnomalies(PATIENT_ID, { heart_rate: 155 }, {
      recordedBy: 'nurse-uid',
      tenantId: CALLER_TENANT,
    });

    expect(setTenantTxMock.mock.calls[0][0]).toBe(CALLER_TENANT);
    expect(tenantLookups()).toHaveLength(0);
    expect(activePatientLocks()).toHaveLength(1);
  });

  it('caller tenant also wins for CRITICAL batches while the uid still resolves for the fan-out', async () => {
    resetAll();
    queryRawMock.mockResolvedValue([]);

    await checkVitalAnomalies(PATIENT_ID, { heart_rate: 190 }, {
      recordedBy: 'nurse-uid',
      tenantId: CALLER_TENANT,
    });

    expect(setTenantTxMock.mock.calls[0][0]).toBe(CALLER_TENANT);
    expect(tenantLookups()).toHaveLength(0);
    expect(activePatientLocks()).toHaveLength(1);
    expect(enqueueCriticalResultTaskMock).toHaveBeenCalledTimes(1);
    expect(enqueueCriticalResultTaskMock.mock.calls[0][0]).toMatchObject({
      tenantId: CALLER_TENANT,
      patientUid: PATIENT_UID,
    });
  });

  it('exactly ONE users uid/tenant lookup even when pregnancy mirror AND critical fan-out both need the uid', async () => {
    resetAll();
    patientContext = { age_years: 30, is_pregnant: true };
    queryRawMock.mockResolvedValue([{ tenant_id: PATIENT_TENANT }]);

    // Severe pre-eclampsia BP + proteinuria → pregnancy signals + CRITICAL screen.
    await checkVitalAnomalies(PATIENT_ID, {
      systolic_bp: 165,
      diastolic_bp: 112,
      urine_albumin: '2+',
    }, { recordedBy: 'nurse-uid' });

    expect(tenantLookups()).toHaveLength(1);
    expect(activePatientLocks()).toHaveLength(1);
    expect(setTenantTxMock.mock.calls[0][0]).toBe(PATIENT_TENANT);
    // The cds_alerts mirror used the uid from the single merged lookup.
    const cdsInserts = executeRawMock.mock.calls.filter((c) => /INSERT INTO cds_alerts/i.test(c[0]));
    expect(cdsInserts.length).toBeGreaterThanOrEqual(1);
    expect(cdsInserts[0][1]).toBe(PATIENT_UID);
  });

  it('a failed tenant lookup aborts before persistence instead of default-stamping the alert', async () => {
    resetAll();
    queryRawMock.mockRejectedValueOnce(new Error('users lookup unavailable'));

    await expect(checkVitalAnomalies(PATIENT_ID, { heart_rate: 155 }, {
      recordedBy: 'nurse-uid',
    })).rejects.toThrow('users lookup unavailable');

    expect(setTenantTxMock).not.toHaveBeenCalled();
  });
});
