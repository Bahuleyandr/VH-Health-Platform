import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $queryRawUnsafe: queryUnsafeMock,
    $executeRawUnsafe: jest.fn(),
  },
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
});
