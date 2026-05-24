import { jest } from '@jest/globals';

const mockPrisma = { $queryRawUnsafe: jest.fn(), $executeRawUnsafe: jest.fn() };

jest.unstable_mockModule('../../lib/prisma.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { collectPayment, reversePayment } = await import('../../services/billing/billingV2Service.js');

describe('billing v2 payment invoice totals', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.$executeRawUnsafe.mockResolvedValue(1);
  });

  it('keeps advance settlements in amount_paid when collecting the balance payment', async () => {
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([{
        patient_uid: '11111111-1111-4111-8111-111111111111',
        status: 'PARTIAL',
        amount_due: '2300',
      }])
      .mockResolvedValueOnce([{ id: 9, invoice_id: 3, amount: '2300' }])
      .mockResolvedValueOnce([{ paid: '17300' }])
      .mockResolvedValueOnce([{ total_amount: '17300' }]);

    await collectPayment({
      invoice_id: 3,
      amount: 2300,
      mode: 'CASH',
      // CASH_PAYMENT_REQUIRES_SHIFT guard added 2026-05-23: every
      // CASH payment must reference a cashier drawer shift for the
      // close reconciliation to count it. The other modes (UPI etc.)
      // don't need this; CASH does. See
      // 2026-05-22-inpatient-admission-billing-8f3634b2.
      shift: 'GENERAL',
    });

    const paidAggregateSql = mockPrisma.$queryRawUnsafe.mock.calls[2][0];
    expect(paidAggregateSql).toContain('billing_payments');
    expect(paidAggregateSql).toContain('billing_advance_settlements');
    expect(mockPrisma.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE billing_invoices'), 17300, 0, 'PAID', 3,
    );
  });

  it('keeps advance settlements in amount_paid when reversing a later payment', async () => {
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([{ id: 9, invoice_id: 3, amount: '2300' }])
      .mockResolvedValueOnce([{ paid: '15000' }])
      .mockResolvedValueOnce([{ total_amount: '17300' }]);

    await reversePayment(9, { reason: 'cash entry voided' });

    const paidAggregateSql = mockPrisma.$queryRawUnsafe.mock.calls[1][0];
    expect(paidAggregateSql).toContain('billing_payments');
    expect(paidAggregateSql).toContain('billing_advance_settlements');
    expect(mockPrisma.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE billing_invoices'), 15000, 2300, 'PARTIAL', 3,
    );
  });

  it('rejects INSURANCE payment when no invoice is linked', async () => {
    await expect(
      collectPayment({
        patient_uid: '11111111-1111-4111-8111-111111111111',
        amount: 5000,
        mode: 'INSURANCE',
        reference: 'TPA-UTR-UNATTRIBUTED',
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'INSURANCE_PAYMENT_REQUIRES_INVOICE',
    });
    expect(mockPrisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('rejects INSURANCE payment when the invoice has no submitted cashless TPA claim', async () => {
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([{
        patient_uid: '11111111-1111-4111-8111-111111111111',
        status: 'ISSUED',
        amount_due: '5000',
      }])
      .mockResolvedValueOnce([]);

    await expect(
      collectPayment({
        invoice_id: 3,
        amount: 5000,
        mode: 'INSURANCE',
        reference: 'TPA-UTR-UNATTRIBUTED',
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'INSURANCE_PAYMENT_REQUIRES_TPA_CLAIM',
    });
  });

  it('rejects INSURANCE payment when the linked cashless claim has no preauth', async () => {
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([{
        patient_uid: '11111111-1111-4111-8111-111111111111',
        status: 'ISSUED',
        amount_due: '5000',
      }])
      .mockResolvedValueOnce([{
        id: 44,
        claim_number: 'CL-TEST-NO-PREAUTH',
        preauth_id: null,
        status: 'approved',
      }]);

    await expect(
      collectPayment({
        invoice_id: 3,
        amount: 5000,
        mode: 'INSURANCE',
        reference: 'TPA-UTR-NO-PREAUTH',
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'INSURANCE_PAYMENT_REQUIRES_TPA_PREAUTH',
    });
  });

  it('accepts INSURANCE payment when the invoice is anchored to a preauth-linked final claim', async () => {
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([{
        patient_uid: '11111111-1111-4111-8111-111111111111',
        status: 'PARTIAL',
        amount_due: '5000',
      }])
      .mockResolvedValueOnce([{
        id: 45,
        claim_number: 'CL-TEST-PAID',
        preauth_id: 9,
        status: 'approved',
      }])
      .mockResolvedValueOnce([{ id: 10, invoice_id: 3, amount: '5000', mode: 'INSURANCE' }])
      .mockResolvedValueOnce([{ paid: '17300' }])
      .mockResolvedValueOnce([{ total_amount: '17300' }]);

    await collectPayment({
      invoice_id: 3,
      amount: 5000,
      mode: 'INSURANCE',
      reference: 'TPA-UTR-OK',
    });

    const claimAnchorSql = mockPrisma.$queryRawUnsafe.mock.calls[1][0];
    expect(claimAnchorSql).toContain('FROM tpa_claims');
    expect(mockPrisma.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE billing_invoices'), 17300, 0, 'PAID', 3,
    );
  });
});
