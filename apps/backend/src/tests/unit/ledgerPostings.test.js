import { jest } from '@jest/globals';

const postLedgerEntry = jest.fn(async () => ({ entryId: 1 }));
jest.unstable_mockModule('../../services/billing/ledger/ledgerService.js', () => ({
  postLedgerEntry,
  getAccountBalancePaise: jest.fn(),
  default: { postLedgerEntry },
}));
// setTenantTx just runs the callback with a fake tx
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {},
  setTenantTx: async (_t, fn) => fn({}),
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { postInvoiceIssueEntry, postPaymentEntry, paymentDebitAccount } = await import('../../services/billing/ledger/ledgerPostings.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT = '11111111-1111-4111-8111-111111111111';

beforeEach(() => { postLedgerEntry.mockClear(); });

describe('paymentDebitAccount — mode → ledger account', () => {
  it('maps CASH to CASH, electronic modes to BANK, and returns null for INSURANCE', () => {
    expect(paymentDebitAccount('CASH')).toBe('CASH');
    expect(paymentDebitAccount('cash')).toBe('CASH');
    expect(paymentDebitAccount('UPI')).toBe('BANK');
    expect(paymentDebitAccount('CARD')).toBe('BANK');
    expect(paymentDebitAccount('NETBANKING')).toBe('BANK');
    expect(paymentDebitAccount('INSURANCE')).toBeNull(); // deferred to Phase 3
  });
});

describe('postInvoiceIssueEntry', () => {
  it('posts debit PATIENT_AR / credit REVENUE for the invoice total', async () => {
    await postInvoiceIssueEntry({
      invoice: { id: 42, patient_uid: PATIENT, total_amount: '1000.00' }, tenantId: TENANT,
    });
    expect(postLedgerEntry).toHaveBeenCalledTimes(1);
    const arg = postLedgerEntry.mock.calls[0][1];
    expect(arg.entryType).toBe('INVOICE_ISSUE');
    expect(arg.idempotencyKey).toBe('issue-inv-42');
    expect(arg.lines).toEqual(expect.arrayContaining([
      { accountCode: 'PATIENT_AR', amountPaise: 100000, patient_uid: PATIENT, invoice_id: 42 },
      { accountCode: 'REVENUE', amountPaise: -100000 },
    ]));
  });

  it('does not post for a zero-total invoice', async () => {
    await postInvoiceIssueEntry({ invoice: { id: 7, patient_uid: PATIENT, total_amount: '0.00' }, tenantId: TENANT });
    expect(postLedgerEntry).not.toHaveBeenCalled();
  });
});

describe('postPaymentEntry', () => {
  it('posts debit CASH / credit PATIENT_AR for a cash invoice payment', async () => {
    await postPaymentEntry({
      payment: { id: 9, patient_uid: PATIENT, invoice_id: 42, amount: '400.00', mode: 'CASH', cash_drawer_session_id: 5 },
      tenantId: TENANT,
    });
    const arg = postLedgerEntry.mock.calls[0][1];
    expect(arg.entryType).toBe('PAYMENT');
    expect(arg.idempotencyKey).toBe('payment-9');
    expect(arg.lines).toEqual(expect.arrayContaining([
      { accountCode: 'CASH', amountPaise: 40000, cash_drawer_session_id: 5 },
      { accountCode: 'PATIENT_AR', amountPaise: -40000, patient_uid: PATIENT, invoice_id: 42 },
    ]));
  });

  it('skips (no post) for an INSURANCE payment (Phase 3)', async () => {
    await postPaymentEntry({ payment: { id: 10, patient_uid: PATIENT, invoice_id: 42, amount: '400.00', mode: 'INSURANCE' }, tenantId: TENANT });
    expect(postLedgerEntry).not.toHaveBeenCalled();
  });

  it('skips a reversed payment', async () => {
    await postPaymentEntry({ payment: { id: 11, patient_uid: PATIENT, invoice_id: 42, amount: '400.00', mode: 'CASH', reversed: true }, tenantId: TENANT });
    expect(postLedgerEntry).not.toHaveBeenCalled();
  });
});
