// Unit regressions for the results-inbox vital-alert producer hook in
// `checkVitalAnomalies` (src/utils/clinical/vitalSignMonitor.js).
//
// Covers two follow-up fixes from the results-inbox escalation review:
//
//   FU3 — the CRITICAL vital → results-inbox task must land under the
//   PATIENT's tenant, not the hardcoded DEFAULT_TENANT_ID. clinical_alerts
//   is not tenant-keyed, but `users` carries tenant_id; the producer hook now
//   reads users.uid + users.tenant_id and enqueues with that tenant (falling
//   back to the default only when it can't be resolved).
//
//   FU2 — the producer hook is best-effort / post-commit and MUST NOT break
//   the clinical write. Even when enqueueCriticalResultTask THROWS, the
//   clinical_alerts INSERT must still have happened and checkVitalAnomalies
//   must resolve with the generated alerts.
//
// The patient tenant is resolved before the transaction. The transaction
// then locks the active merge survivor, resolves that survivor's cohort, and
// persists the alert before the post-commit results-inbox fan-out.

import { jest } from '@jest/globals';

const queryRawMock = jest.fn();
const executeRawMock = jest.fn();
const enqueueCriticalResultTaskMock = jest.fn();
const loggerErrorMock = jest.fn();
const loggerWarnMock = jest.fn();

const __prismaDefaultMock = {
  $queryRawUnsafe: queryRawMock,
  $executeRawUnsafe: executeRawMock,
};
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: loggerWarnMock, error: loggerErrorMock, debug: jest.fn() },
}));
jest.unstable_mockModule('../../utils/websocket/realtimeEmitter.js', () => ({
  emitVitalAnomaly: jest.fn(),
  emitCodeBlue: jest.fn(),
}));
jest.unstable_mockModule('../../utils/notifications/notificationDispatcher.js', () => ({
  dispatch: jest.fn().mockResolvedValue(undefined),
}));
// Mock the results-inbox producer so we can assert on (and fault-inject) it.
jest.unstable_mockModule('../../services/results/resultsInboxService.js', () => ({
  enqueueCriticalResultTask: enqueueCriticalResultTaskMock,
}));
// DEFAULT_TENANT_ID is a plain const; mock the module to keep the literal
// deterministic without pulling tenantService's prisma/logger graph.
const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  DEFAULT_TENANT_ID,
  resolveTenantOrThrow: (req) => req?.tenantId || DEFAULT_TENANT_ID,
  requireTenantId: (tenantId) => tenantId || DEFAULT_TENANT_ID,
}));

const { checkVitalAnomalies } = await import('../../utils/clinical/vitalSignMonitor.js');

const PATIENT_ID = 8888;
const PATIENT_UID = 'a1111111-2222-4333-8444-555555550001';
const PATIENT_TENANT = '11111111-1111-4111-8111-111111111111';
const CLINICAL_ALERT_ID = 9001;

// Mock the query sequence for a CRITICAL non-pregnant vital.
function mockCriticalNonPregnant({ withTenant = true } = {}) {
  queryRawMock.mockReset();
  executeRawMock.mockReset();
  enqueueCriticalResultTaskMock.mockReset();
  loggerErrorMock.mockReset();
  loggerWarnMock.mockReset();
  enqueueCriticalResultTaskMock.mockResolvedValue({ created: true, taskId: 1, slaInstanceId: 's1' });
  queryRawMock.mockImplementation(async (sql) => {
    if (/SELECT\s+tenant_id::text\s+AS\s+tenant_id\s+FROM\s+users/i.test(sql)) {
      return [{ tenant_id: withTenant ? PATIENT_TENANT : null }];
    }
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
    if (/DATE_PART|maternity_pregnancies/i.test(sql)) {
      return [{ age_years: 50, is_pregnant: false }];
    }
    if (/INSERT INTO clinical_alerts/i.test(sql)) return [{ id: CLINICAL_ALERT_ID }];
    return [];
  });
  executeRawMock.mockResolvedValue(1);
}

describe('checkVitalAnomalies — results-inbox producer hook (FU3 tenant + FU2 non-blocking)', () => {
  it('FU3: enqueues the critical-vital task under the PATIENT tenant (not the default)', async () => {
    mockCriticalNonPregnant({ withTenant: true });

    const alerts = await checkVitalAnomalies(PATIENT_ID, {
      oxygen_saturation: 80, // critical_min 85 -> CRITICAL
    }, { recordedBy: 'nurse-uid' });

    expect(alerts.length).toBeGreaterThanOrEqual(1);
    expect(alerts[0].severity).toBe('CRITICAL');

    // The tenant lookup scoped the transaction before the survivor lock.
    const tenantLookup = queryRawMock.mock.calls.find((args) =>
      /SELECT\s+tenant_id::text\s+AS\s+tenant_id\s+FROM\s+users/i.test(args[0]),
    );
    expect(tenantLookup).toBeTruthy();

    // The producer was called once, scoped to the patient's tenant + the
    // clinical_alert id, NOT the hardcoded default tenant.
    expect(enqueueCriticalResultTaskMock).toHaveBeenCalledTimes(1);
    const arg = enqueueCriticalResultTaskMock.mock.calls[0][0];
    expect(arg.tenantId).toBe(PATIENT_TENANT);
    expect(arg.tenantId).not.toBe(DEFAULT_TENANT_ID);
    expect(arg.resourceId).toBe(CLINICAL_ALERT_ID);
    expect(arg.resourceType).toBe('clinical_alert');
    expect(arg.source).toBe('vital_alert');
    expect(arg.patientUid).toBe(PATIENT_UID);
  });

  it('FU3: falls back to DEFAULT_TENANT_ID when the user row has no tenant_id', async () => {
    mockCriticalNonPregnant({ withTenant: false });

    await checkVitalAnomalies(PATIENT_ID, { heart_rate: 190 }, { recordedBy: 'nurse-uid' });

    expect(enqueueCriticalResultTaskMock).toHaveBeenCalledTimes(1);
    expect(enqueueCriticalResultTaskMock.mock.calls[0][0].tenantId).toBe(DEFAULT_TENANT_ID);
  });

  it('FU2: a producer throw does NOT break the clinical write (alerts returned + clinical_alerts INSERTed)', async () => {
    mockCriticalNonPregnant({ withTenant: true });
    enqueueCriticalResultTaskMock.mockRejectedValue(new Error('boom'));

    // Must RESOLVE, not reject, despite the producer throwing.
    const alerts = await checkVitalAnomalies(PATIENT_ID, {
      oxygen_saturation: 80,
    }, { recordedBy: 'nurse-uid' });

    // Clinical path survived: alerts came back …
    expect(Array.isArray(alerts)).toBe(true);
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    expect(alerts[0].severity).toBe('CRITICAL');

    // … the clinical_alerts INSERT still ran …
    const insertCall = queryRawMock.mock.calls.find((args) =>
      /INSERT INTO clinical_alerts/i.test(args[0]),
    );
    expect(insertCall).toBeTruthy();

    // … the producer was invoked and threw, and the throw was swallowed + logged.
    expect(enqueueCriticalResultTaskMock).toHaveBeenCalledTimes(1);
    expect(loggerErrorMock).toHaveBeenCalled();
  });
});
