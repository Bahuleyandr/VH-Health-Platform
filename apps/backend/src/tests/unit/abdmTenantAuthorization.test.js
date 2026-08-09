import { jest } from '@jest/globals';

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT = '11111111-1111-4111-8111-111111111111';

const queryRawUnsafeMock = jest.fn();
const verifyABHAMock = jest.fn();

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
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('../../config/abdmConfig.js', () => ({
  ABDM_CONFIG: {
    enabled: false,
    bridgeUrl: 'https://bridge.example',
    gatewayUrl: 'https://gateway.example',
    hipId: 'HIP-1',
    hipName: 'VH Health',
  },
}));

jest.unstable_mockModule('../../services/abdm/abdmGateway.js', () => ({
  default: { verifyABHA: verifyABHAMock },
}));

const abdmService = (await import('../../services/abdm/abdmService.js')).default;

beforeEach(() => {
  jest.clearAllMocks();
  queryRawUnsafeMock.mockReset();
});

describe('ABDM tenant authorization', () => {
  it('requires tenant context for ABHA registration and lookup', async () => {
    await expect(abdmService.registerABHA(PATIENT, '12-3456-7890-1234', null))
      .rejects.toMatchObject({ code: 'ABDM_TENANT_REQUIRED' });
    await expect(abdmService.getPatientByABHA('12-3456-7890-1234'))
      .rejects.toMatchObject({ code: 'ABDM_TENANT_REQUIRED' });
  });

  it('tenant-scopes patient ownership, duplicate check, and update when linking ABHA', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ uid: PATIENT, tenant_id: TENANT }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ uid: PATIENT, tenant_id: TENANT, abha_number: '12-3456-7890-1234' }]);

    await abdmService.registerABHA(PATIENT, '12-3456-7890-1234', 'patient@abdm', { tenantId: TENANT });

    expect(queryRawUnsafeMock.mock.calls[0][0]).toContain('uid = $1::uuid');
    expect(queryRawUnsafeMock.mock.calls[0][0]).toContain('tenant_id = $2::uuid');
    expect(queryRawUnsafeMock.mock.calls[0][0]).toContain("role = 'PATIENT'");
    expect(queryRawUnsafeMock.mock.calls[0].slice(1)).toEqual([PATIENT, TENANT]);

    expect(queryRawUnsafeMock.mock.calls[1][0]).toContain('tenant_id = $1::uuid');
    // Duplicate guard probes BOTH circulating spellings of the same ABHA
    // (plain 14-digit and canonical 2-4-4-4 hyphenated) — audit follow-up P13:
    // an exact-string guard let one ABHA link to two patients under two spellings.
    expect(queryRawUnsafeMock.mock.calls[1][0]).toContain('abha_number IN ($2, $3)');
    expect(queryRawUnsafeMock.mock.calls[1].slice(1)).toEqual([
      TENANT,
      '12345678901234',
      '12-3456-7890-1234',
      PATIENT,
    ]);

    expect(queryRawUnsafeMock.mock.calls[2][0]).toContain('WHERE uid = $3::uuid AND tenant_id = $4::uuid');
    expect(queryRawUnsafeMock.mock.calls[2].slice(1)).toEqual(['12-3456-7890-1234', 'patient@abdm', PATIENT, TENANT]);
  });

  it('tenant-scopes ABHA lookup and admin status aggregates', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ uid: PATIENT, tenant_id: TENANT }])
      .mockResolvedValueOnce([{ abha_registrations: 1, health_records_linked: 1 }])
      .mockResolvedValueOnce([{ exists: true }])
      .mockResolvedValueOnce([{ total: 2, pending: 1, granted: 1, denied: 0 }]);

    await abdmService.getPatientByABHA('12-3456-7890-1234', { tenantId: TENANT });
    await abdmService.getAdminStatus({ tenantId: TENANT });

    expect(queryRawUnsafeMock.mock.calls[0][0]).toContain('tenant_id = $1::uuid');
    expect(queryRawUnsafeMock.mock.calls[0][0]).toContain('abha_number IN ($2, $3)');
    expect(queryRawUnsafeMock.mock.calls[0][0]).toContain("role = 'PATIENT'");
    expect(queryRawUnsafeMock.mock.calls[0].slice(1)).toEqual([
      TENANT,
      '12345678901234',
      '12-3456-7890-1234',
    ]);

    expect(queryRawUnsafeMock.mock.calls[1][0]).toContain('FROM users');
    expect(queryRawUnsafeMock.mock.calls[1][0]).toContain('tenant_id = $1::uuid');
    expect(queryRawUnsafeMock.mock.calls[3][0]).toContain('FROM abdm_consents');
    expect(queryRawUnsafeMock.mock.calls[3][0]).toContain('tenant_id = $1::uuid');
  });

  it('fails closed when legacy spellings resolve to multiple patients', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([
      { uid: PATIENT, tenant_id: TENANT },
      { uid: '22222222-2222-4222-8222-222222222222', tenant_id: TENANT },
    ]);

    await expect(
      abdmService.getPatientByABHA('12345678901234', { tenantId: TENANT }),
    ).rejects.toMatchObject({ code: 'ABHA_MULTIPLE_PATIENTS', statusCode: 409 });
  });

  it('normalizes inbound ABHA lookup and rejects same-tenant ambiguity', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([
      { uid: PATIENT, tenant_id: TENANT },
      { uid: '22222222-2222-4222-8222-222222222222', tenant_id: TENANT },
    ]);

    await expect(
      abdmService._resolvePatientTenantByAbha('12-3456-7890-1234'),
    ).rejects.toMatchObject({ code: 'ABDM_ABHA_MULTI_PATIENT', statusCode: 409 });

    expect(queryRawUnsafeMock.mock.calls[0][0]).toContain('abha_number IN ($1, $2)');
    expect(queryRawUnsafeMock.mock.calls[0].slice(1)).toEqual([
      '12345678901234',
      '12-3456-7890-1234',
    ]);
  });
});
