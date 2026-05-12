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
});
