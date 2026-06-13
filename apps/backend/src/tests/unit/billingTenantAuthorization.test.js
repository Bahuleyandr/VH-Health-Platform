import { jest } from '@jest/globals';

const TENANT = '00000000-0000-4000-8000-000000000001';
const OTHER_TENANT = '00000000-0000-4000-8000-000000000002';
const PATIENT_A = '11111111-1111-4111-8111-111111111111';
const PATIENT_B = '22222222-2222-4222-8222-222222222222';

const queryRawUnsafeMock = jest.fn();
const executeRawUnsafeMock = jest.fn();

const __prismaDefaultMock = {
  $queryRawUnsafe: queryRawUnsafeMock,
  $executeRawUnsafe: executeRawUnsafeMock,
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

const {
  collectPayment,
  listInvoices,
  settleAdvance,
} = await import('../../services/billing/billingV2Service.js');

beforeEach(() => {
  jest.clearAllMocks();
  executeRawUnsafeMock.mockResolvedValue(1);
});

describe('billing v2 tenant/object authorization', () => {
  it('adds tenant_id to invoice list SQL', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([]);

    await listInvoices({ tenantId: TENANT, limit: 10 });

    const [sql, ...params] = queryRawUnsafeMock.mock.calls[0];
    expect(sql).toContain('tenant_id = $1::uuid');
    expect(params).toEqual([TENANT, 10, 0]);
  });

  it('denies payment collection when the invoice is outside the tenant', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([]);

    await expect(
      collectPayment({
        tenantId: OTHER_TENANT,
        invoice_id: 3,
        amount: 100,
        mode: 'UPI',
      }),
    ).rejects.toMatchObject({ statusCode: 404 });

    const [sql, ...params] = queryRawUnsafeMock.mock.calls[0];
    expect(sql).toContain('FROM billing_invoices');
    expect(sql).toContain('tenant_id = $2::uuid');
    expect(params).toEqual([3, OTHER_TENANT]);
    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
  });

  it('records an allowed same-tenant invoice payment with the tenant_id stamped on the payment row', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{
        patient_uid: PATIENT_A,
        status: 'ISSUED',
        amount_due: '100',
      }])
      .mockResolvedValueOnce([{
        id: 9,
        invoice_id: 3,
        patient_uid: PATIENT_A,
        amount: '100',
      }])
      .mockResolvedValueOnce([{ paid: '100' }])
      .mockResolvedValueOnce([{ total_amount: '100' }])
      .mockResolvedValueOnce([{ id: 3, admission_id: null }]);

    const payment = await collectPayment({
      tenantId: TENANT,
      invoice_id: 3,
      amount: 100,
      mode: 'UPI',
      reference: 'UPI-OK',
    });

    expect(payment.id).toBe(9);
    const [insertSql, ...insertParams] = queryRawUnsafeMock.mock.calls[1];
    expect(insertSql).toContain('billing_payments');
    expect(insertSql).toContain('tenant_id');
    expect(insertParams.at(-1)).toBe(TENANT);
  });

  it('denies settling an advance against an invoice for a different patient', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{
        id: 4,
        patient_uid: PATIENT_A,
        status: 'ACTIVE',
        balance: '500',
      }])
      .mockResolvedValueOnce([{
        patient_uid: PATIENT_B,
        amount_due: '500',
      }]);

    await expect(
      settleAdvance({
        tenantId: TENANT,
        advance_id: 4,
        invoice_id: 8,
        amount: 100,
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'BILLING_ADVANCE_INVOICE_PATIENT_MISMATCH',
    });
  });
});
