import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();

const __prismaDefaultMock = {
  $queryRawUnsafe: queryUnsafeMock,
  $executeRawUnsafe: jest.fn(),
};
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  isTenantTransactionClient: (value) => value === __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { listInvoices } = await import('../../services/billing/billingV2Service.js');

beforeEach(() => {
  queryUnsafeMock.mockReset();
});

describe('billingV2Service.listInvoices', () => {
  it('projects TPA near-limit utilisation onto cashier list rows', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([{
        id: 1,
        invoice_number: 'INV-2026-000001',
        patient_uid: '11111111-1111-4111-8111-111111111111',
        patient_name: 'TPA Patient',
        invoice_type: 'ipd',
        total_amount: 79000,
        amount_paid: 0,
        amount_due: 79000,
        status: 'ISSUED',
        admission_id: 18,
        tenant_id: '00000000-0000-4000-8000-000000000001',
      }])
      .mockResolvedValueOnce([{
        root_preauth_id: 7,
        root_preauth_number: 'PA-2026-00007',
        root_preauth_status: 'approved',
        root_preauth_denial_reason: null,
        root_preauth_sanctioned_amount: 50000,
        policy_id: 3,
        cumulative_approved: 80000,
      }]);

    const rows = await listInvoices({
      patient_uid: '11111111-1111-4111-8111-111111111111',
      limit: 10,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].tpa_utilisation).toMatchObject({
      root_preauth_id: 7,
      cumulative_approved: 80000,
      total_charged: 79000,
      remaining: 1000,
      utilisation_pct: 98.8,
      status: 'near_limit',
    });
  });

  it('applies admission and numeric patient filters to invoice list SQL', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);

    await listInvoices({
      patient_id: 42,
      admission_id: 8,
      limit: 10,
    });

    const [sql, ...params] = queryUnsafeMock.mock.calls[0];
    expect(sql).toContain('patient_uid = (SELECT uid FROM users WHERE id = $1::int)');
    expect(sql).toContain('admission_id = $2::int');
    expect(params).toEqual([42, 8, 10, 0]);
  });

  it('normalizes non-finite and fractional pagination before SQL', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);

    await listInvoices({ page: '1e309', limit: '1.5' });

    const [, ...params] = queryUnsafeMock.mock.calls[0];
    expect(params.slice(-2)).toEqual([1, 0]);
  });

  it('bounds TPA projection database concurrency', async () => {
    const invoices = Array.from({ length: 17 }, (_, index) => ({
      id: index + 1,
      admission_id: index + 10,
      tenant_id: '00000000-0000-4000-8000-000000000001',
      total_amount: 100,
    }));
    let active = 0;
    let maximumActive = 0;
    queryUnsafeMock
      .mockResolvedValueOnce(invoices)
      .mockImplementation(async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
        return [{ root_preauth_id: null }];
      });

    const rows = await listInvoices({ limit: 200 });

    expect(rows).toHaveLength(17);
    expect(maximumActive).toBeLessThanOrEqual(8);
  });
});
