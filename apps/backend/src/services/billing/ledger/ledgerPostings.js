// apps/backend/src/services/billing/ledger/ledgerPostings.js
//
// Movement -> balanced-ledger-entry mapping. Each helper builds the balanced
// lines and posts them via runPosting: when the caller supplies a `tx` (Phase 4
// enforce mode) it posts SAME-TX inside that transaction; otherwise it opens its
// OWN setTenantTx and the callers invoke it POST-COMMIT best-effort (their own
// try/catch) so a ledger problem can never break the legacy money path. The
// ledger becomes authoritative only when callers pass a tx under enforce mode
// (Phase 4 — see ledgerAuthoritativeMode.js).
import { setTenantTx } from '../../../lib/prisma.js';
import { toPaise } from '../../../utils/money.js';
import { postLedgerEntry } from './ledgerService.js';

// Phase 4-1: post into a caller-supplied tx when present (same-tx, enforce mode),
// otherwise open our own setTenantTx (post-commit best-effort, shadow mode = today).
function runPosting(tx, tenantId, entryArgs) {
  const tenantEntryArgs = { ...entryArgs, tenantId };
  if (tx) return postLedgerEntry(tx, tenantEntryArgs);
  return setTenantTx(tenantId, (t) => postLedgerEntry(t, tenantEntryArgs));
}

const ELECTRONIC_MODES = new Set(['UPI', 'CARD', 'NETBANKING', 'CHEQUE', 'ONLINE', 'BANK_TRANSFER', 'DD', 'WALLET']);

/** Map a billing_payments.mode to the ledger debit account, or null to skip. */
export function paymentDebitAccount(mode) {
  const m = String(mode || '').toUpperCase();
  if (m === 'CASH') return 'CASH';
  if (m === 'INSURANCE') return null;   // insurer settlement — Phase 3
  if (ELECTRONIC_MODES.has(m)) return 'BANK';
  return 'BANK';                         // default electronic-style receipt
}

/** Post INVOICE_ISSUE: debit PATIENT_AR=total / credit REVENUE=(total−tax) / credit TAX_PAYABLE=tax. */
export async function postInvoiceIssueEntry({ invoice, tenantId, tx = null }) {
  const totalPaise = toPaise(invoice.total_amount);
  if (totalPaise <= 0) return null;     // nothing to post for a zero invoice
  const taxPaise = invoice.tax_amount != null ? toPaise(invoice.tax_amount) : 0;
  const revenuePaise = totalPaise - taxPaise;
  const lines = [
    { accountCode: 'PATIENT_AR', amountPaise: totalPaise, patient_uid: invoice.patient_uid, invoice_id: Number(invoice.id) },
    { accountCode: 'REVENUE', amountPaise: -revenuePaise },
  ];
  // Omit the tax line when there is no GST — postLedgerEntry rejects zero lines,
  // and a no-tax invoice stays identical to the Phase-2a posting.
  if (taxPaise > 0) lines.push({ accountCode: 'TAX_PAYABLE', amountPaise: -taxPaise });
  return runPosting(tx, tenantId, {
    entryType: 'INVOICE_ISSUE',
    idempotencyKey: `issue-inv-${invoice.id}`,
    lines,
  });
}

/** Post PAYMENT: non-insurance → debit CASH|BANK / credit PATIENT_AR; INSURANCE → debit BANK / credit INSURANCE_AR. */
export async function postPaymentEntry({ payment, tenantId, tx = null }) {
  if (payment.reversed) return null;
  const paise = toPaise(payment.amount);
  if (paise <= 0) return null;
  const mode = String(payment.mode || '').toUpperCase();
  if (mode === 'INSURANCE') {
    // Insurer settlement. The receivable already moved PATIENT_AR -> INSURANCE_AR
    // at claim approval (postInsuranceShiftEntry), so the payment clears
    // INSURANCE_AR, NOT PATIENT_AR (avoids double-crediting AR).
    if (payment.invoice_id == null) return null; // INSURANCE_AR is keyed by invoice
    return runPosting(tx, tenantId, {
      entryType: 'INSURANCE_SETTLE',
      idempotencyKey: `payment-${payment.id}`,
      lines: [
        { accountCode: 'BANK', amountPaise: paise },
        { accountCode: 'INSURANCE_AR', amountPaise: -paise, invoice_id: Number(payment.invoice_id) },
      ],
    });
  }
  const debit = paymentDebitAccount(mode);
  if (!debit) return null;
  const debitLine = { accountCode: debit, amountPaise: paise };
  if (debit === 'CASH' && payment.cash_drawer_session_id != null) {
    debitLine.cash_drawer_session_id = Number(payment.cash_drawer_session_id);
  }
  return runPosting(tx, tenantId, {
    entryType: 'PAYMENT',
    idempotencyKey: `payment-${payment.id}`,
    lines: [
      debitLine,
      {
        accountCode: 'PATIENT_AR',
        amountPaise: -paise,
        patient_uid: payment.patient_uid,
        ...(payment.invoice_id != null ? { invoice_id: Number(payment.invoice_id) } : {}),
      },
    ],
  });
}

/** Post ADVANCE_COLLECT: debit CASH|BANK / credit PATIENT_ADVANCE. */
export async function postAdvanceCollectEntry({ advance, tenantId, tx = null }) {
  const debit = paymentDebitAccount(advance.mode);
  if (!debit) return null;              // INSURANCE-mode advance — skip
  const paise = toPaise(advance.amount);
  if (paise <= 0) return null;
  return runPosting(tx, tenantId, {
    entryType: 'ADVANCE_COLLECT',
    idempotencyKey: `advance-${advance.id}`,
    lines: [
      { accountCode: debit, amountPaise: paise },
      { accountCode: 'PATIENT_ADVANCE', amountPaise: -paise, advance_id: Number(advance.id), patient_uid: advance.patient_uid },
    ],
  });
}

/** Post ADVANCE_REFUND: debit PATIENT_ADVANCE / credit CASH|BANK — pay an advance
 * deposit back (the inverse of ADVANCE_COLLECT). Used by the IPD deposit-refund
 * path under enforce so the mirrored billing_advances balance stays ledger-backed. */
export async function postAdvanceRefundEntry({ advance, amount, mode, idempotencyKey, tenantId, tx = null }) {
  const credit = paymentDebitAccount(mode);
  if (!credit) return null;
  const paise = toPaise(amount);
  if (paise <= 0) return null;
  return runPosting(tx, tenantId, {
    entryType: 'ADVANCE_REFUND',
    idempotencyKey,
    lines: [
      { accountCode: 'PATIENT_ADVANCE', amountPaise: paise, advance_id: Number(advance.id), patient_uid: advance.patient_uid },
      { accountCode: credit, amountPaise: -paise },
    ],
  });
}

/** Post ADVANCE_SETTLE: debit PATIENT_ADVANCE / credit PATIENT_AR. */
export async function postAdvanceSettleEntry({ settlement, patientUid, tenantId, tx = null }) {
  const paise = toPaise(settlement.amount);
  if (paise <= 0) return null;
  return runPosting(tx, tenantId, {
    entryType: 'ADVANCE_SETTLE',
    idempotencyKey: `advance-settle-${settlement.id}`,
    lines: [
      { accountCode: 'PATIENT_ADVANCE', amountPaise: paise, advance_id: Number(settlement.advance_id), patient_uid: patientUid },
      { accountCode: 'PATIENT_AR', amountPaise: -paise, patient_uid: patientUid, invoice_id: Number(settlement.invoice_id) },
    ],
  });
}

/** Post PAYMENT_REVERSAL: the inverse of the original payment. Non-insurance →
 * credit CASH|BANK / debit PATIENT_AR; INSURANCE → credit BANK / debit
 * INSURANCE_AR (inverse of the INSURANCE_SETTLE). */
export async function postPaymentReversalEntry({ payment, tenantId, tx = null }) {
  const paise = toPaise(payment.amount);
  if (paise <= 0) return null;
  const mode = String(payment.mode || '').toUpperCase();
  if (mode === 'INSURANCE') {
    if (payment.invoice_id == null) return null; // INSURANCE_AR is keyed by invoice
    return runPosting(tx, tenantId, {
      entryType: 'PAYMENT_REVERSAL',
      idempotencyKey: `payment-reversal-${payment.id}`,
      metadata: { payment_id: Number(payment.id) },
      lines: [
        { accountCode: 'BANK', amountPaise: -paise },
        { accountCode: 'INSURANCE_AR', amountPaise: paise, invoice_id: Number(payment.invoice_id) },
      ],
    });
  }
  const credit = paymentDebitAccount(mode); // the account the original debited
  if (!credit) return null;
  return runPosting(tx, tenantId, {
    entryType: 'PAYMENT_REVERSAL',
    idempotencyKey: `payment-reversal-${payment.id}`,
    metadata: { payment_id: Number(payment.id) },
    lines: [
      { accountCode: credit, amountPaise: -paise },
      {
        accountCode: 'PATIENT_AR',
        amountPaise: paise,
        patient_uid: payment.patient_uid,
        ...(payment.invoice_id != null ? { invoice_id: Number(payment.invoice_id) } : {}),
      },
    ],
  });
}

/** Post REFUND_APPROVE: credit REFUNDS_PAYABLE / debit PATIENT_AR (invoice) | PATIENT_ADVANCE (advance). */
export async function postRefundApproveEntry({ refund, tenantId, tx = null }) {
  const paise = toPaise(refund.amount);
  if (paise <= 0) return null;
  const debit = refund.advance_id != null
    ? { accountCode: 'PATIENT_ADVANCE', amountPaise: paise, advance_id: Number(refund.advance_id), patient_uid: refund.patient_uid }
    : { accountCode: 'PATIENT_AR', amountPaise: paise, patient_uid: refund.patient_uid, invoice_id: Number(refund.invoice_id) };
  return runPosting(tx, tenantId, {
    entryType: 'REFUND_APPROVE',
    idempotencyKey: `refund-approve-${refund.id}`,
    lines: [debit, { accountCode: 'REFUNDS_PAYABLE', amountPaise: -paise, patient_uid: refund.patient_uid }],
  });
}

/** Post REFUND_PAID: debit REFUNDS_PAYABLE / credit CASH|BANK. */
export async function postRefundPaidEntry({ refund, tenantId, tx = null }) {
  const credit = paymentDebitAccount(refund.mode);
  if (!credit) return null;             // INSURANCE-mode refund — Phase 3c
  const paise = toPaise(refund.amount);
  if (paise <= 0) return null;
  return runPosting(tx, tenantId, {
    entryType: 'REFUND_PAID',
    idempotencyKey: `refund-paid-${refund.id}`,
    lines: [
      { accountCode: 'REFUNDS_PAYABLE', amountPaise: paise, patient_uid: refund.patient_uid },
      { accountCode: credit, amountPaise: -paise },
    ],
  });
}

/** Post WARD_MEDICATION_CREDIT: reverse earned medication revenue and reduce
 * the open receivable and/or establish a refund payable. Approval creates the
 * accounting obligation; a later authorized refund payout uses REFUND_PAID. */
export async function postWardMedicationCreditEntry({ creditNote, tenantId, tx = null }) {
  const totalPaise = Number(creditNote.amount_minor);
  const receivablePaise = Number(creditNote.receivable_credit_minor || 0);
  const refundPaise = Number(creditNote.refund_obligation_minor || 0);
  if (!Number.isSafeInteger(totalPaise) || totalPaise <= 0) return null;
  if (
    !Number.isSafeInteger(receivablePaise)
    || !Number.isSafeInteger(refundPaise)
    || receivablePaise < 0
    || refundPaise < 0
    || receivablePaise + refundPaise !== totalPaise
  ) {
    throw new TypeError('Ward medication credit split must equal its credit-note amount');
  }
  const lines = [
    { accountCode: 'REVENUE', amountPaise: totalPaise },
  ];
  if (receivablePaise > 0) {
    lines.push({
      accountCode: 'PATIENT_AR',
      amountPaise: -receivablePaise,
      patient_uid: creditNote.patient_uid,
      invoice_id: Number(creditNote.invoice_id),
    });
  }
  if (refundPaise > 0) {
    lines.push({
      accountCode: 'REFUNDS_PAYABLE',
      amountPaise: -refundPaise,
      patient_uid: creditNote.patient_uid,
    });
  }
  return runPosting(tx, tenantId, {
    entryType: 'WARD_MEDICATION_CREDIT',
    idempotencyKey: `ward-medication-credit-${creditNote.id}`,
    metadata: {
      credit_note_id: String(creditNote.id),
      source_financial_event_id: String(creditNote.source_financial_event_id),
    },
    lines,
  });
}

/** Post INSURANCE_SHIFT: on claim approval move the receivable PATIENT_AR -> INSURANCE_AR. */
export async function postInsuranceShiftEntry({ claim, tenantId, tx = null }) {
  if (claim.invoice_id == null) return null;
  const paise = claim.approved_amount != null ? toPaise(claim.approved_amount) : 0;
  if (paise <= 0) return null;
  return runPosting(tx, tenantId, {
    entryType: 'INSURANCE_SHIFT',
    idempotencyKey: `claim-shift-${claim.id}`,
    lines: [
      { accountCode: 'INSURANCE_AR', amountPaise: paise, invoice_id: Number(claim.invoice_id) },
      { accountCode: 'PATIENT_AR', amountPaise: -paise, patient_uid: claim.patient_uid, invoice_id: Number(claim.invoice_id) },
    ],
  });
}

export default {
  paymentDebitAccount, postInvoiceIssueEntry, postPaymentEntry,
  postAdvanceCollectEntry, postAdvanceRefundEntry, postAdvanceSettleEntry, postPaymentReversalEntry,
  postRefundApproveEntry, postRefundPaidEntry, postWardMedicationCreditEntry,
  postInsuranceShiftEntry,
};
