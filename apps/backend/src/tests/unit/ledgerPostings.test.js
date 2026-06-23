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
  it('posts debit PATIENT_AR / credit REVENUE for a no-tax invoice (unchanged)', async () => {
    await postInvoiceIssueEntry({
      invoice: { id: 42, patient_uid: PATIENT, total_amount: '1000.00', tax_amount: '0.00' }, tenantId: TENANT,
    });
    expect(postLedgerEntry).toHaveBeenCalledTimes(1);
    const arg = postLedgerEntry.mock.calls[0][1];
    expect(arg.entryType).toBe('INVOICE_ISSUE');
    expect(arg.idempotencyKey).toBe('issue-inv-42');
    expect(arg.lines).toEqual([
      { accountCode: 'PATIENT_AR', amountPaise: 100000, patient_uid: PATIENT, invoice_id: 42 },
      { accountCode: 'REVENUE', amountPaise: -100000 },
    ]);
  });

  it('splits tax into TAX_PAYABLE for a GST invoice', async () => {
    // total 1180 = subtotal 1000 + 18% GST 180
    await postInvoiceIssueEntry({
      invoice: { id: 43, patient_uid: PATIENT, total_amount: '1180.00', tax_amount: '180.00' }, tenantId: TENANT,
    });
    const arg = postLedgerEntry.mock.calls.at(-1)[1];
    expect(arg.lines).toEqual([
      { accountCode: 'PATIENT_AR', amountPaise: 118000, patient_uid: PATIENT, invoice_id: 43 },
      { accountCode: 'REVENUE', amountPaise: -100000 },   // total - tax
      { accountCode: 'TAX_PAYABLE', amountPaise: -18000 },
    ]);
  });

  it('does not post for a zero-total invoice', async () => {
    await postInvoiceIssueEntry({ invoice: { id: 7, patient_uid: PATIENT, total_amount: '0.00', tax_amount: '0.00' }, tenantId: TENANT });
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

describe('postAdvanceCollectEntry', () => {
  it('posts debit CASH / credit PATIENT_ADVANCE for a cash advance', async () => {
    const { postAdvanceCollectEntry } = await import('../../services/billing/ledger/ledgerPostings.js');
    await postAdvanceCollectEntry({ advance: { id: 3, patient_uid: PATIENT, amount: '1000.00', mode: 'CASH' }, tenantId: TENANT });
    const arg = postLedgerEntry.mock.calls.at(-1)[1];
    expect(arg.entryType).toBe('ADVANCE_COLLECT');
    expect(arg.idempotencyKey).toBe('advance-3');
    expect(arg.lines).toEqual(expect.arrayContaining([
      { accountCode: 'CASH', amountPaise: 100000 },
      { accountCode: 'PATIENT_ADVANCE', amountPaise: -100000, advance_id: 3, patient_uid: PATIENT },
    ]));
  });
});

describe('postAdvanceSettleEntry', () => {
  it('posts debit PATIENT_ADVANCE / credit PATIENT_AR', async () => {
    const { postAdvanceSettleEntry } = await import('../../services/billing/ledger/ledgerPostings.js');
    await postAdvanceSettleEntry({ settlement: { id: 8, advance_id: 3, invoice_id: 42, amount: '400.00' }, patientUid: PATIENT, tenantId: TENANT });
    const arg = postLedgerEntry.mock.calls.at(-1)[1];
    expect(arg.entryType).toBe('ADVANCE_SETTLE');
    expect(arg.idempotencyKey).toBe('advance-settle-8');
    expect(arg.lines).toEqual(expect.arrayContaining([
      { accountCode: 'PATIENT_ADVANCE', amountPaise: 40000, advance_id: 3, patient_uid: PATIENT },
      { accountCode: 'PATIENT_AR', amountPaise: -40000, patient_uid: PATIENT, invoice_id: 42 },
    ]));
  });
});

describe('postPaymentReversalEntry', () => {
  it('posts credit CASH / debit PATIENT_AR for a reversed cash payment', async () => {
    const { postPaymentReversalEntry } = await import('../../services/billing/ledger/ledgerPostings.js');
    await postPaymentReversalEntry({ payment: { id: 9, patient_uid: PATIENT, invoice_id: 42, amount: '400.00', mode: 'CASH' }, tenantId: TENANT });
    const arg = postLedgerEntry.mock.calls.at(-1)[1];
    expect(arg.entryType).toBe('PAYMENT_REVERSAL');
    expect(arg.idempotencyKey).toBe('payment-reversal-9');
    expect(arg.lines).toEqual(expect.arrayContaining([
      { accountCode: 'CASH', amountPaise: -40000 },
      { accountCode: 'PATIENT_AR', amountPaise: 40000, patient_uid: PATIENT, invoice_id: 42 },
    ]));
  });

  it('skips reversal for an INSURANCE payment (its original was never posted)', async () => {
    const { postPaymentReversalEntry } = await import('../../services/billing/ledger/ledgerPostings.js');
    const before = postLedgerEntry.mock.calls.length;
    await postPaymentReversalEntry({ payment: { id: 10, patient_uid: PATIENT, invoice_id: 42, amount: '400.00', mode: 'INSURANCE' }, tenantId: TENANT });
    expect(postLedgerEntry.mock.calls.length).toBe(before);
  });
});

describe('postRefundApproveEntry', () => {
  it('invoice refund: debit PATIENT_AR / credit REFUNDS_PAYABLE', async () => {
    const { postRefundApproveEntry } = await import('../../services/billing/ledger/ledgerPostings.js');
    await postRefundApproveEntry({ refund: { id: 5, patient_uid: PATIENT, invoice_id: 42, advance_id: null, amount: '400.00' }, tenantId: TENANT });
    const arg = postLedgerEntry.mock.calls.at(-1)[1];
    expect(arg.entryType).toBe('REFUND_APPROVE');
    expect(arg.idempotencyKey).toBe('refund-approve-5');
    expect(arg.lines).toEqual(expect.arrayContaining([
      { accountCode: 'PATIENT_AR', amountPaise: 40000, patient_uid: PATIENT, invoice_id: 42 },
      { accountCode: 'REFUNDS_PAYABLE', amountPaise: -40000, patient_uid: PATIENT },
    ]));
  });
  it('advance refund: debit PATIENT_ADVANCE / credit REFUNDS_PAYABLE', async () => {
    const { postRefundApproveEntry } = await import('../../services/billing/ledger/ledgerPostings.js');
    await postRefundApproveEntry({ refund: { id: 6, patient_uid: PATIENT, invoice_id: null, advance_id: 3, amount: '250.00' }, tenantId: TENANT });
    const arg = postLedgerEntry.mock.calls.at(-1)[1];
    expect(arg.lines).toEqual(expect.arrayContaining([
      { accountCode: 'PATIENT_ADVANCE', amountPaise: 25000, advance_id: 3, patient_uid: PATIENT },
      { accountCode: 'REFUNDS_PAYABLE', amountPaise: -25000, patient_uid: PATIENT },
    ]));
  });
});

describe('postRefundPaidEntry', () => {
  it('debit REFUNDS_PAYABLE / credit CASH|BANK', async () => {
    const { postRefundPaidEntry } = await import('../../services/billing/ledger/ledgerPostings.js');
    await postRefundPaidEntry({ refund: { id: 5, patient_uid: PATIENT, amount: '400.00', mode: 'CASH' }, tenantId: TENANT });
    const arg = postLedgerEntry.mock.calls.at(-1)[1];
    expect(arg.entryType).toBe('REFUND_PAID');
    expect(arg.idempotencyKey).toBe('refund-paid-5');
    expect(arg.lines).toEqual(expect.arrayContaining([
      { accountCode: 'REFUNDS_PAYABLE', amountPaise: 40000, patient_uid: PATIENT },
      { accountCode: 'CASH', amountPaise: -40000 },
    ]));
  });
});
