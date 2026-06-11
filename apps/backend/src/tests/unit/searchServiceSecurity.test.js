import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $queryRawUnsafe: queryUnsafeMock,
  },
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

const { searchUsers, searchAppointments } = await import('../../utils/search/searchService.js');

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

  it('tenant-scopes appointment search', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);

    await searchAppointments('follow', 10, { tenantId: TENANT, role: 'ADMIN' });

    const [sql, searchParam, tenantParam, limitParam] = queryUnsafeMock.mock.calls[0];
    expect(sql).toContain('tenant_id = $2::uuid');
    expect(searchParam).toBe('follow:*');
    expect(tenantParam).toBe(TENANT);
    expect(limitParam).toBe(10);
  });
});
