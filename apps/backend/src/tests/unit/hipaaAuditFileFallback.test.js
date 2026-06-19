/**
 * Audit §3 (PHI/audit) fail-safe regression — logPhiAccess deferred-write path.
 *
 * logPhiAccess() defers the hipaa_access_log INSERT into a fire-and-forget
 * setImmediate callback. HIPAA audit must NEVER be silently lost, so a DB-write
 * failure inside that deferred callback must fall back to the Winston file sink
 * (carrying the access tuple), and the fallback itself must be defensive — if
 * the file sink throws, the failure must not escape as an unhandled rejection
 * out of the detached setImmediate (which would silently drop the audit).
 *
 * Pure unit test: prisma + logger fully mocked, no DB.
 */

import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const warnMock = jest.fn();
const errorMock = jest.fn();

const __prismaDefaultMock = {
  $queryRawUnsafe: queryRawUnsafeMock,
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    warn: warnMock,
    error: errorMock,
  },
}));

const { logPhiAccess } = await import('../../utils/hipaaAudit.js');

const TENANT = '00000000-0000-4000-8000-000000000777';
const ACTOR = '11111111-1111-4111-8111-111111111111';
const PATIENT = '22222222-2222-4222-8222-222222222222';

async function flushImmediate() {
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  queryRawUnsafeMock.mockReset();
  warnMock.mockReset();
  errorMock.mockReset();
});

describe('logPhiAccess durable file fallback', () => {
  it('falls back to the Winston file sink with the access tuple when the DB write fails', async () => {
    queryRawUnsafeMock.mockRejectedValue(new Error('hipaa_access_log table missing'));

    logPhiAccess({
      userId: ACTOR,
      userRole: 'RECEPTIONIST',
      patientId: PATIENT,
      recordType: 'PATIENT_SEARCH',
      action: 'VIEW',
      ip: '127.0.0.1',
      requestId: 'req-phi-fallback',
      actorUid: ACTOR,
      subjectUid: ACTOR,
      actingAsDependent: false,
      deviceType: 'desktop',
      tenantId: TENANT,
    });

    await flushImmediate();

    expect(warnMock).toHaveBeenCalledTimes(1);
    const [msg, payload] = warnMock.mock.calls[0];
    expect(String(msg)).toMatch(/hipaa/i);
    expect(payload).toEqual(
      expect.objectContaining({
        accessed_by: ACTOR,
        accessed_by_role: 'RECEPTIONIST',
        patient_id: PATIENT,
        record_type: 'PATIENT_SEARCH',
        action: 'VIEW',
        tenant_id: TENANT,
      }),
    );
  });

  it('does not produce an unhandled rejection if the file sink itself throws', async () => {
    queryRawUnsafeMock.mockRejectedValue(new Error('db down'));
    // Simulate a Winston transport / serialization failure on the fallback.
    warnMock.mockImplementation(() => {
      throw new Error('winston transport exploded');
    });

    const unhandled = [];
    const onUnhandled = (err) => unhandled.push(err);
    process.on('unhandledRejection', onUnhandled);

    try {
      expect(() =>
        logPhiAccess({
          userId: ACTOR,
          userRole: 'DOCTOR',
          patientId: PATIENT,
          recordType: 'CLINICAL_NOTE',
          action: 'VIEW',
          tenantId: TENANT,
        }),
      ).not.toThrow();

      await flushImmediate();
      // give any rejected microtask a chance to surface
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(unhandled).toHaveLength(0);
      // Last-resort console sink is used instead (defensive inner catch).
      expect(warnMock).toHaveBeenCalled();
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });
});
