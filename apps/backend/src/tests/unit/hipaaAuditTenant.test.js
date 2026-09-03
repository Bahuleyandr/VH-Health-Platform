import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const warnMock = jest.fn();

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
  },
}));

const { logPhiAccess, logPhiAccessBatch } = await import('../../utils/hipaaAudit.js');

const TENANT = '00000000-0000-4000-8000-000000000777';
const ACTOR = '11111111-1111-4111-8111-111111111111';
const PATIENT = '22222222-2222-4222-8222-222222222222';

async function flushImmediate() {
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

beforeEach(() => {
  queryRawUnsafeMock.mockReset().mockResolvedValue({});
  warnMock.mockReset();
});

describe('logPhiAccess tenant context', () => {
  it('awaits one transaction-scoped insert for a bounded reconciliation batch', async () => {
    const db = { $executeRawUnsafe: jest.fn(async () => 2) };
    const entries = [1, 2].map(index => ({
      userId: ACTOR,
      userRole: 'MEDICAL_RECORDS',
      patientId: PATIENT,
      recordType: `clinical_import_reconciliation:item-${index}`,
      action: 'VIEW',
      tenantId: TENANT,
      requestId: 'req-reconciliation-batch',
    }));

    await logPhiAccessBatch(entries, { db });

    expect(db.$executeRawUnsafe).toHaveBeenCalledTimes(1);
    expect(db.$executeRawUnsafe.mock.calls[0][0]).toMatch(/INSERT INTO hipaa_access_log[\s\S]*jsonb_to_recordset/);
    const rows = JSON.parse(db.$executeRawUnsafe.mock.calls[0][1]);
    expect(rows.map(row => row.record_type)).toEqual(entries.map(entry => entry.recordType));
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  });

  it('rethrows a transaction-scoped reconciliation audit failure', async () => {
    const auditFailure = new Error('HIPAA batch insert failed');
    const db = { $executeRawUnsafe: jest.fn(async () => { throw auditFailure; }) };

    await expect(logPhiAccessBatch([{
      userId: ACTOR,
      userRole: 'MEDICAL_RECORDS',
      patientId: PATIENT,
      recordType: 'clinical_import_reconciliation:item-1',
      tenantId: TENANT,
    }], { db })).rejects.toBe(auditFailure);
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('writes request tenant and device context into hipaa_access_log', async () => {
    logPhiAccess({
      userId: ACTOR,
      userRole: 'RECEPTIONIST',
      patientId: PATIENT,
      recordType: 'PATIENT_SEARCH',
      action: 'VIEW',
      ip: '127.0.0.1',
      requestId: 'req-front-office-phi',
      actorUid: ACTOR,
      subjectUid: ACTOR,
      actingAsDependent: false,
      deviceType: 'desktop',
      tenantId: TENANT,
    });

    await flushImmediate();

    expect(queryRawUnsafeMock).toHaveBeenCalledWith(
      expect.stringContaining('device_type, tenant_id'),
      ACTOR,
      'RECEPTIONIST',
      PATIENT,
      'PATIENT_SEARCH',
      'VIEW',
      '127.0.0.1',
      'req-front-office-phi',
      ACTOR,
      ACTOR,
      false,
      'desktop',
      TENANT,
    );
  });
});
