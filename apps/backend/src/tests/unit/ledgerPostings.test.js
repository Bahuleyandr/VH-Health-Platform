import { jest } from '@jest/globals';

const postLedgerEntry = jest.fn(async () => ({ entryId: 1 }));
jest.unstable_mockModule('../../services/billing/ledger/ledgerService.js', () => ({
  postLedgerEntry,
  getAccountBalancePaise: jest.fn(),
  default: { postLedgerEntry },
}));
// setTenantTx spy — records calls and runs the callback with an "own" fake tx.
const setTenantTx = jest.fn(async (_t, fn) => fn({ __fakeTx: 'own' }));
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {},
  setTenantTx,
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const {
  postInvoiceIssueEntry,
  postPaymentEntry,
  postWardMedicationCreditEntry,
  paymentDebitAccount,
} = await import('../../services/billing/ledger/ledgerPostings.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT = '11111111-1111-4111-8111-111111111111';

beforeEach(() => { postLedgerEntry.mockClear(); setTenantTx.mockClear(); });

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
    expect(arg.tenantId).toBe(TENANT);
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

  it('INSURANCE payment posts debit BANK / credit INSURANCE_AR (not PATIENT_AR)', async () => {
    await postPaymentEntry({ payment: { id: 12, patient_uid: PATIENT, invoice_id: 42, amount: '800.00', mode: 'INSURANCE' }, tenantId: TENANT });
    const arg = postLedgerEntry.mock.calls.at(-1)[1];
    expect(arg.entryType).toBe('INSURANCE_SETTLE');
    expect(arg.idempotencyKey).toBe('payment-12');
    expect(arg.lines).toEqual([
      { accountCode: 'BANK', amountPaise: 80000 },
      { accountCode: 'INSURANCE_AR', amountPaise: -80000, invoice_id: 42 },
    ]);
  });

  it('INSURANCE payment with no invoice is skipped (needs the invoice dimension)', async () => {
    const before = postLedgerEntry.mock.calls.length;
    await postPaymentEntry({ payment: { id: 13, patient_uid: PATIENT, invoice_id: null, amount: '800.00', mode: 'INSURANCE' }, tenantId: TENANT });
    expect(postLedgerEntry.mock.calls.length).toBe(before);
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

describe('postAdvanceRefundEntry', () => {
  it('posts debit PATIENT_ADVANCE / credit CASH for a cash advance refund', async () => {
    const { postAdvanceRefundEntry } = await import('../../services/billing/ledger/ledgerPostings.js');
    await postAdvanceRefundEntry({ advance: { id: 3, patient_uid: PATIENT }, amount: '250.00', mode: 'cash', idempotencyKey: 'ipd-advance-refund-9', tenantId: TENANT });
    const arg = postLedgerEntry.mock.calls.at(-1)[1];
    expect(arg.entryType).toBe('ADVANCE_REFUND');
    expect(arg.idempotencyKey).toBe('ipd-advance-refund-9');
    expect(arg.lines).toEqual(expect.arrayContaining([
      { accountCode: 'PATIENT_ADVANCE', amountPaise: 25000, advance_id: 3, patient_uid: PATIENT },
      { accountCode: 'CASH', amountPaise: -25000 },
    ]));
  });
  it('threads a caller tx (same-tx) and maps electronic modes to BANK', async () => {
    const { postAdvanceRefundEntry } = await import('../../services/billing/ledger/ledgerPostings.js');
    const callerTx = { __fakeTx: 'caller' };
    await postAdvanceRefundEntry({ advance: { id: 4, patient_uid: PATIENT }, amount: '100.00', mode: 'upi', idempotencyKey: 'ipd-advance-refund-10', tenantId: TENANT, tx: callerTx });
    expect(setTenantTx).not.toHaveBeenCalled();
    expect(postLedgerEntry.mock.calls.at(-1)[0]).toBe(callerTx);
    const arg = postLedgerEntry.mock.calls.at(-1)[1];
    expect(arg.lines).toEqual(expect.arrayContaining([
      { accountCode: 'PATIENT_ADVANCE', amountPaise: 10000, advance_id: 4, patient_uid: PATIENT },
      { accountCode: 'BANK', amountPaise: -10000 },
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

  it('reverses an INSURANCE payment by crediting BANK / debiting INSURANCE_AR (the settle inverse)', async () => {
    const { postPaymentReversalEntry } = await import('../../services/billing/ledger/ledgerPostings.js');
    await postPaymentReversalEntry({ payment: { id: 10, patient_uid: PATIENT, invoice_id: 42, amount: '800.00', mode: 'INSURANCE' }, tenantId: TENANT });
    const arg = postLedgerEntry.mock.calls.at(-1)[1];
    expect(arg.entryType).toBe('PAYMENT_REVERSAL');
    expect(arg.idempotencyKey).toBe('payment-reversal-10');
    expect(arg.lines).toEqual([
      { accountCode: 'BANK', amountPaise: -80000 },
      { accountCode: 'INSURANCE_AR', amountPaise: 80000, invoice_id: 42 },
    ]);
  });

  it('skips an INSURANCE reversal with no invoice (needs the invoice dimension)', async () => {
    const { postPaymentReversalEntry } = await import('../../services/billing/ledger/ledgerPostings.js');
    const before = postLedgerEntry.mock.calls.length;
    await postPaymentReversalEntry({ payment: { id: 11, patient_uid: PATIENT, invoice_id: null, amount: '800.00', mode: 'INSURANCE' }, tenantId: TENANT });
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

describe('postWardMedicationCreditEntry', () => {
  const baseCreditNote = {
    id: 71,
    invoice_id: 42,
    patient_uid: PATIENT,
    source_financial_event_id: 901,
    amount_minor: 1250,
  };

  it('posts a receivable-only medication credit', async () => {
    await postWardMedicationCreditEntry({
      creditNote: {
        ...baseCreditNote,
        receivable_credit_minor: 1250,
        refund_obligation_minor: 0,
      },
      tenantId: TENANT,
    });

    expect(postLedgerEntry.mock.calls.at(-1)[1].lines).toEqual([
      { accountCode: 'REVENUE', amountPaise: 1250 },
      { accountCode: 'PATIENT_AR', amountPaise: -1250, patient_uid: PATIENT, invoice_id: 42 },
    ]);
  });

  it('posts a refund-only medication credit', async () => {
    await postWardMedicationCreditEntry({
      creditNote: {
        ...baseCreditNote,
        receivable_credit_minor: 0,
        refund_obligation_minor: 1250,
      },
      tenantId: TENANT,
    });

    expect(postLedgerEntry.mock.calls.at(-1)[1].lines).toEqual([
      { accountCode: 'REVENUE', amountPaise: 1250 },
      { accountCode: 'REFUNDS_PAYABLE', amountPaise: -1250, patient_uid: PATIENT },
    ]);
  });

  it('posts the exact receivable/refund mixed split', async () => {
    await postWardMedicationCreditEntry({
      creditNote: {
        ...baseCreditNote,
        receivable_credit_minor: 900,
        refund_obligation_minor: 350,
      },
      tenantId: TENANT,
    });

    expect(postLedgerEntry.mock.calls.at(-1)[1].lines).toEqual([
      { accountCode: 'REVENUE', amountPaise: 1250 },
      { accountCode: 'PATIENT_AR', amountPaise: -900, patient_uid: PATIENT, invoice_id: 42 },
      { accountCode: 'REFUNDS_PAYABLE', amountPaise: -350, patient_uid: PATIENT },
    ]);
  });

  it('rejects a split that does not equal the credit-note amount', async () => {
    await expect(postWardMedicationCreditEntry({
      creditNote: {
        ...baseCreditNote,
        receivable_credit_minor: 900,
        refund_obligation_minor: 300,
      },
      tenantId: TENANT,
    })).rejects.toThrow('Ward medication credit split must equal its credit-note amount');
    expect(postLedgerEntry).not.toHaveBeenCalled();
  });

  it('uses the credit-note identity for idempotency and immutable lineage metadata', async () => {
    await postWardMedicationCreditEntry({
      creditNote: {
        ...baseCreditNote,
        receivable_credit_minor: 1250,
        refund_obligation_minor: 0,
      },
      tenantId: TENANT,
    });

    expect(postLedgerEntry.mock.calls.at(-1)[1]).toMatchObject({
      entryType: 'WARD_MEDICATION_CREDIT',
      idempotencyKey: 'ward-medication-credit-71',
      metadata: {
        credit_note_id: '71',
        source_financial_event_id: '901',
      },
    });
  });

  it('threads the caller transaction instead of opening a new tenant transaction', async () => {
    const callerTx = { __fakeTx: 'medication-credit-caller' };
    await postWardMedicationCreditEntry({
      creditNote: {
        ...baseCreditNote,
        receivable_credit_minor: 1250,
        refund_obligation_minor: 0,
      },
      tenantId: TENANT,
      tx: callerTx,
    });

    expect(setTenantTx).not.toHaveBeenCalled();
    expect(postLedgerEntry.mock.calls.at(-1)[0]).toBe(callerTx);
  });
});

describe('postInsuranceShiftEntry', () => {
  it('debit INSURANCE_AR(invoice) / credit PATIENT_AR(patient,invoice) for the approved amount', async () => {
    const { postInsuranceShiftEntry } = await import('../../services/billing/ledger/ledgerPostings.js');
    await postInsuranceShiftEntry({ claim: { id: 4, invoice_id: 42, patient_uid: PATIENT, approved_amount: '800.00' }, tenantId: TENANT });
    const arg = postLedgerEntry.mock.calls.at(-1)[1];
    expect(arg.entryType).toBe('INSURANCE_SHIFT');
    expect(arg.idempotencyKey).toBe('claim-shift-4');
    expect(arg.lines).toEqual([
      { accountCode: 'INSURANCE_AR', amountPaise: 80000, invoice_id: 42 },
      { accountCode: 'PATIENT_AR', amountPaise: -80000, patient_uid: PATIENT, invoice_id: 42 },
    ]);
  });
  it('skips when approved_amount is 0 or invoice missing', async () => {
    const { postInsuranceShiftEntry } = await import('../../services/billing/ledger/ledgerPostings.js');
    const before = postLedgerEntry.mock.calls.length;
    await postInsuranceShiftEntry({ claim: { id: 5, invoice_id: 42, patient_uid: PATIENT, approved_amount: '0.00' }, tenantId: TENANT });
    await postInsuranceShiftEntry({ claim: { id: 6, invoice_id: null, patient_uid: PATIENT, approved_amount: '800.00' }, tenantId: TENANT });
    expect(postLedgerEntry.mock.calls.length).toBe(before);
  });
});

describe('tx-threading (Phase 4-1) — posting wrappers honor a caller-supplied tx', () => {
  it('uses the passed-in tx and does NOT open its own setTenantTx', async () => {
    const callerTx = { __fakeTx: 'caller' };
    await postPaymentEntry({
      payment: { id: 9, patient_uid: PATIENT, invoice_id: 42, amount: '400.00', mode: 'CASH' },
      tenantId: TENANT,
      tx: callerTx,
    });
    expect(setTenantTx).not.toHaveBeenCalled();
    expect(postLedgerEntry).toHaveBeenCalledTimes(1);
    expect(postLedgerEntry.mock.calls[0][0]).toBe(callerTx);
    expect(postLedgerEntry.mock.calls[0][1].tenantId).toBe(TENANT);
  });

  it('opens its own setTenantTx when no tx is passed (today’s post-commit path)', async () => {
    await postPaymentEntry({
      payment: { id: 9, patient_uid: PATIENT, invoice_id: 42, amount: '400.00', mode: 'CASH' },
      tenantId: TENANT,
    });
    expect(setTenantTx).toHaveBeenCalledTimes(1);
    expect(postLedgerEntry).toHaveBeenCalledTimes(1);
    expect(postLedgerEntry.mock.calls[0][0]).toEqual({ __fakeTx: 'own' });
    expect(postLedgerEntry.mock.calls[0][1].tenantId).toBe(TENANT);
  });

  it('threads tx through the invoice-issue wrapper too', async () => {
    const callerTx = { __fakeTx: 'caller' };
    await postInvoiceIssueEntry({
      invoice: { id: 42, patient_uid: PATIENT, total_amount: '1000.00', tax_amount: '0.00' },
      tenantId: TENANT,
      tx: callerTx,
    });
    expect(setTenantTx).not.toHaveBeenCalled();
    expect(postLedgerEntry.mock.calls.at(-1)[0]).toBe(callerTx);
  });
});
