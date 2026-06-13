import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();

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

const {
  addIsolate,
  addSensitivity,
  getOrder,
} = await import('../../services/lab/microbiologyService.js');

const TENANT_ID = '00000000-0000-4000-8000-000000000001';

describe('microbiologyService tenant object predicates', () => {
  beforeEach(() => {
    queryRawUnsafeMock.mockReset();
  });

  it('adds isolates only through a tenant-owned order', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{ id: 10, order_id: 5 }]);

    await addIsolate({
      tenantId: TENANT_ID,
      order_id: 5,
      organism_name: 'E. coli',
      is_esbl: true,
    });

    const call = queryRawUnsafeMock.mock.calls[0];
    expect(call[0]).toMatch(/FROM micro_orders o/);
    expect(call[0]).toMatch(/o\.id = \$1::int/);
    expect(call[0]).toMatch(/o\.tenant_id = \$12::uuid/);
    expect(call[1]).toBe(5);
    expect(call[12]).toBe(TENANT_ID);
  });

  it('rejects isolate creation when the order is not visible in the tenant', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([]);

    await expect(addIsolate({
      tenantId: TENANT_ID,
      order_id: 5,
      organism_name: 'E. coli',
    })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('verifies isolate ownership before sensitivity upsert', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ id: 22 }])
      .mockResolvedValueOnce([{ id: 33, isolate_id: 22, antibiotic_code: 'CIP' }]);

    await addSensitivity({
      tenantId: TENANT_ID,
      isolate_id: 22,
      antibiotic_code: 'CIP',
      antibiotic_name: 'Ciprofloxacin',
      result: 'R',
    });

    const ownership = queryRawUnsafeMock.mock.calls[0];
    expect(ownership[0]).toMatch(/JOIN micro_orders o ON o\.id = i\.order_id/);
    expect(ownership[0]).toMatch(/i\.id = \$1::int/);
    expect(ownership[0]).toMatch(/o\.tenant_id = \$2::uuid/);
    expect(ownership[1]).toBe(22);
    expect(ownership[2]).toBe(TENANT_ID);

    const upsert = queryRawUnsafeMock.mock.calls[1];
    expect(upsert[0]).toMatch(/INSERT INTO micro_sensitivities/);
    expect(upsert[1]).toBe(22);
  });

  it('loads order children through the tenant-owned order', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ id: 5, tenant_id: TENANT_ID }])
      .mockResolvedValueOnce([{ id: 22, order_id: 5 }])
      .mockResolvedValueOnce([{ id: 33, isolate_id: 22 }]);

    await getOrder({ tenantId: TENANT_ID, id: 5 });

    expect(queryRawUnsafeMock.mock.calls[1][0]).toMatch(/JOIN micro_orders o ON o\.id = i\.order_id/);
    expect(queryRawUnsafeMock.mock.calls[1][0]).toMatch(/o\.tenant_id = \$2::uuid/);
    expect(queryRawUnsafeMock.mock.calls[2][0]).toMatch(/JOIN micro_orders o ON o\.id = i\.order_id/);
    expect(queryRawUnsafeMock.mock.calls[2][0]).toMatch(/o\.tenant_id = \$2::uuid/);
  });
});
