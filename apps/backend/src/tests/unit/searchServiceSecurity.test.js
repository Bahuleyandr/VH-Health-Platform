import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();

const __prismaDefaultMock = {
  $queryRawUnsafe: queryUnsafeMock,
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
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

const { searchUsers, searchDoctors, searchGlobal } = await import('../../utils/search/searchService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
  queryUnsafeMock.mockReset();
});

describe('global search security', () => {
  it('tenant-scopes user search and redacts contact fields for non-admin staff', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 7,
      uid: '11111111-1111-4111-8111-111111111111',
      name: 'Patient One',
      phone: '+919876543210',
      email: 'patient@example.test',
      role: 'PATIENT',
      rank: 0,
    }]);

    const results = await searchUsers('pa', 20, { tenantId: TENANT, role: 'RECEPTIONIST' });

    const [sql, searchParam, tenantParam, limitParam] = queryUnsafeMock.mock.calls[0];
    expect(sql).toContain('tenant_id = $2::uuid');
    expect(sql).toContain("role NOT IN ('ADMIN', 'SUPER_ADMIN')");
    expect(searchParam).toBe('%pa%');
    expect(tenantParam).toBe(TENANT);
    expect(limitParam).toBe(20);
    expect(results[0]).toEqual(expect.objectContaining({
      phone: '91****3210',
      email: 'p***@example.test',
      type: 'user',
    }));
  });

  it('tenant-scopes doctors directly and never borrows a cross-tenant user contact', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);

    await searchDoctors('on', 20, { tenantId: TENANT, role: 'RECEPTIONIST' });

    const [sql, searchParam, tenantParam, limitParam] = queryUnsafeMock.mock.calls[0];
    expect(sql).toContain('d.tenant_id = $2::uuid');
    expect(sql).toContain('u.tenant_id = d.tenant_id');
    expect(sql).not.toContain('DEFAULT_TENANT_ID');
    expect(sql).not.toContain('COALESCE(u.tenant_id');
    expect(searchParam).toBe('%on%');
    expect(tenantParam).toBe(TENANT);
    expect(limitParam).toBe(20);
  });

  it('global search never queries or returns appointment reason/notes', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const result = await searchGlobal('follow', 10, { tenantId: TENANT, role: 'ADMIN' });

    expect(queryUnsafeMock).toHaveBeenCalledTimes(2);
    for (const [sql] of queryUnsafeMock.mock.calls) {
      expect(sql).not.toMatch(/\bappointments\b/i);
      expect(sql).not.toMatch(/\breason\b|\bnotes\b/i);
    }
    expect(result).toEqual({ total: 0, results: [] });
  });
});
