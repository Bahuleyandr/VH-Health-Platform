import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const executeRawUnsafeMock = jest.fn();
const transactionMock = jest.fn();
const txQueryRawUnsafeMock = jest.fn();
const txExecuteRawUnsafeMock = jest.fn();

const __prismaDefaultMock = {
  $queryRawUnsafe: queryRawUnsafeMock,
  $executeRawUnsafe: executeRawUnsafeMock,
  $transaction: transactionMock,
};
const __prismaTxMock = {
  $queryRawUnsafe: txQueryRawUnsafeMock,
  $executeRawUnsafe: txExecuteRawUnsafeMock,
};
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  circuitBreakerStatus: jest.fn(() => ({ open: false, consecutiveFailures: 0 })),
  default: __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => fn(__prismaTxMock),
  setTenant: async (_tenantId, fn) => fn(__prismaTxMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaTxMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordCanonicalClinicalEvent: jest.fn(),
}));

jest.unstable_mockModule('../../services/lab/labResultsService.js', () => ({
  ingestOruMessage: jest.fn(),
  detectCriticalsForResults: jest.fn(),
}));

const {
  getSpecimenLabel,
  scanReceiveSpecimen,
  ingestInterfaceMessage,
  listInterfaceMessages,
} = await import('../../services/lab/labClosedLoopService.js');

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const ACTOR_UID = '11111111-1111-4111-8111-111111111111';

describe('labClosedLoopService tenant scoping', () => {
  beforeEach(() => {
    queryRawUnsafeMock.mockReset();
    executeRawUnsafeMock.mockReset();
    transactionMock.mockReset();
    txQueryRawUnsafeMock.mockReset();
    txExecuteRawUnsafeMock.mockReset();
    executeRawUnsafeMock.mockResolvedValue(1);
    txExecuteRawUnsafeMock.mockResolvedValue(1);
    transactionMock.mockImplementation(async (callback) => callback({
      $queryRawUnsafe: txQueryRawUnsafeMock,
      $executeRawUnsafe: txExecuteRawUnsafeMock,
    }));
  });

  it('loads and marks specimen labels within the caller tenant', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{
      id: 77,
      tenant_id: TENANT_ID,
      specimen_uid: '33333333-3333-4333-8333-333333333333',
      patient_uid: '44444444-4444-4444-8444-444444444444',
      booking_id: 12,
      accession_number: 'ACC-77',
      barcode: 'ACC-77',
      specimen_type: 'blood',
      container_type: 'edta',
      priority: 'routine',
      status: 'ordered',
      collected_at: null,
      received_at: null,
      label_printed_at: null,
      patient_name: 'Patient One',
    }]);

    const label = await getSpecimenLabel(77, { actorUid: ACTOR_UID, tenantId: TENANT_ID });

    expect(label.specimen_id).toBe(77);
    expect(queryRawUnsafeMock.mock.calls[0][0]).toMatch(/s\.tenant_id = \$2::uuid/);
    expect(queryRawUnsafeMock.mock.calls[0][1]).toBe(77);
    expect(queryRawUnsafeMock.mock.calls[0][2]).toBe(TENANT_ID);
    expect(executeRawUnsafeMock.mock.calls[0][0]).toMatch(/tenant_id = \$3::uuid/);
    expect(executeRawUnsafeMock.mock.calls[0][3]).toBe(TENANT_ID);
  });

  it('lists interface messages only inside the caller tenant', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([]);

    await listInterfaceMessages({ tenantId: TENANT_ID, status: 'failed', limit: 25 });

    expect(queryRawUnsafeMock.mock.calls[0][0]).toMatch(/WHERE tenant_id = \$1::uuid/);
    expect(queryRawUnsafeMock.mock.calls[0][1]).toBe(TENANT_ID);
    expect(queryRawUnsafeMock.mock.calls[0][2]).toBe('failed');
    expect(queryRawUnsafeMock.mock.calls[0][3]).toBe(25);
  });

  it('receives scanned specimens only inside the caller tenant', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{
      id: 77,
      tenant_id: TENANT_ID,
      specimen_uid: '33333333-3333-4333-8333-333333333333',
      patient_uid: '44444444-4444-4444-8444-444444444444',
      booking_id: 12,
      accession_number: 'ACC-77',
      barcode: 'ACC-77',
      specimen_type: 'blood',
      container_type: 'edta',
      priority: 'routine',
      status: 'collected',
      collected_at: null,
      received_at: null,
      label_printed_at: null,
      patient_name: 'Patient One',
    }]);
    txQueryRawUnsafeMock.mockResolvedValueOnce([{ id: 77, tenant_id: TENANT_ID, status: 'received' }]);

    await scanReceiveSpecimen({
      barcode: 'ACC-77',
      actorUid: ACTOR_UID,
      tenantId: TENANT_ID,
    });

    expect(queryRawUnsafeMock.mock.calls[0][0]).toMatch(/UPPER\(s\.barcode\) = UPPER\(\$1\) AND s\.tenant_id = \$2::uuid/);
    expect(queryRawUnsafeMock.mock.calls[0][2]).toBe(TENANT_ID);
    expect(txQueryRawUnsafeMock.mock.calls[0][0]).toMatch(/WHERE id = \$1::int AND tenant_id = \$3::uuid/);
    expect(txQueryRawUnsafeMock.mock.calls[0][3]).toBe(TENANT_ID);
  });

  it('matches ASTM interface accessions only against tenant-owned specimens', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ id: 501 }])
      .mockResolvedValueOnce([]);

    await expect(ingestInterfaceMessage({
      protocol: 'astm_e1394',
      rawMessage: 'H|\\^&|||Analyzer\rO|1|ACC-77\rR|1|^^^GLU|5.8|mmol/L|3.9^6.1|N||F',
      tenantId: TENANT_ID,
    })).rejects.toMatchObject({ statusCode: 404 });

    expect(queryRawUnsafeMock.mock.calls[0][0]).toMatch(/INSERT INTO lab_interface_messages/);
    expect(queryRawUnsafeMock.mock.calls[0][1]).toBe(TENANT_ID);
    expect(queryRawUnsafeMock.mock.calls[1][0]).toMatch(/COALESCE\(s\.barcode, s\.accession_number\)[\s\S]*s\.tenant_id = \$2::uuid/);
    expect(queryRawUnsafeMock.mock.calls[1][2]).toBe(TENANT_ID);
  });
});
