// apps/backend/src/services/billing/ledger/ledgerPostings.js
//
// Movement -> balanced-ledger-entry mapping for Phase 2a (AR + cash receipts).
// Each helper opens its OWN setTenantTx and calls postLedgerEntry. They throw on
// failure; callers (issueInvoice / collectPayment) invoke them as POST-COMMIT
// best-effort (their own try/catch) so a ledger problem can never break the
// legacy money path. The ledger is not yet authoritative (Phase 4).
import { setTenantTx } from '../../../lib/prisma.js';
import { toPaise } from '../../../utils/money.js';
import { postLedgerEntry } from './ledgerService.js';

const ELECTRONIC_MODES = new Set(['UPI', 'CARD', 'NETBANKING', 'CHEQUE', 'ONLINE', 'BANK_TRANSFER', 'DD', 'WALLET']);

/** Map a billing_payments.mode to the ledger debit account, or null to skip. */
export function paymentDebitAccount(mode) {
  const m = String(mode || '').toUpperCase();
  if (m === 'CASH') return 'CASH';
  if (m === 'INSURANCE') return null;   // insurer settlement — Phase 3
  if (ELECTRONIC_MODES.has(m)) return 'BANK';
  return 'BANK';                         // default electronic-style receipt
}

/** Post INVOICE_ISSUE: debit PATIENT_AR (receivable up) / credit REVENUE. */
export async function postInvoiceIssueEntry({ invoice, tenantId }) {
  const paise = toPaise(invoice.total_amount);
  if (paise <= 0) return null;          // nothing to post for a zero invoice
  return setTenantTx(tenantId, (tx) => postLedgerEntry(tx, {
    entryType: 'INVOICE_ISSUE',
    idempotencyKey: `issue-inv-${invoice.id}`,
    lines: [
      { accountCode: 'PATIENT_AR', amountPaise: paise, patient_uid: invoice.patient_uid, invoice_id: Number(invoice.id) },
      { accountCode: 'REVENUE', amountPaise: -paise },
    ],
  }));
}

/** Post PAYMENT: debit CASH|BANK / credit PATIENT_AR. */
export async function postPaymentEntry({ payment, tenantId }) {
  if (payment.reversed) return null;
  const debit = paymentDebitAccount(payment.mode);
  if (!debit) return null;              // INSURANCE etc. deferred
  const paise = toPaise(payment.amount);
  if (paise <= 0) return null;
  const debitLine = { accountCode: debit, amountPaise: paise };
  if (debit === 'CASH' && payment.cash_drawer_session_id != null) {
    debitLine.cash_drawer_session_id = Number(payment.cash_drawer_session_id);
  }
  return setTenantTx(tenantId, (tx) => postLedgerEntry(tx, {
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
  }));
}

/** Post ADVANCE_COLLECT: debit CASH|BANK / credit PATIENT_ADVANCE. */
export async function postAdvanceCollectEntry({ advance, tenantId }) {
  const debit = paymentDebitAccount(advance.mode);
  if (!debit) return null;              // INSURANCE-mode advance — skip
  const paise = toPaise(advance.amount);
  if (paise <= 0) return null;
  return setTenantTx(tenantId, (tx) => postLedgerEntry(tx, {
    entryType: 'ADVANCE_COLLECT',
    idempotencyKey: `advance-${advance.id}`,
    lines: [
      { accountCode: debit, amountPaise: paise },
      { accountCode: 'PATIENT_ADVANCE', amountPaise: -paise, advance_id: Number(advance.id), patient_uid: advance.patient_uid },
    ],
  }));
}

/** Post ADVANCE_SETTLE: debit PATIENT_ADVANCE / credit PATIENT_AR. */
export async function postAdvanceSettleEntry({ settlement, patientUid, tenantId }) {
  const paise = toPaise(settlement.amount);
  if (paise <= 0) return null;
  return setTenantTx(tenantId, (tx) => postLedgerEntry(tx, {
    entryType: 'ADVANCE_SETTLE',
    idempotencyKey: `advance-settle-${settlement.id}`,
    lines: [
      { accountCode: 'PATIENT_ADVANCE', amountPaise: paise, advance_id: Number(settlement.advance_id), patient_uid: patientUid },
      { accountCode: 'PATIENT_AR', amountPaise: -paise, patient_uid: patientUid, invoice_id: Number(settlement.invoice_id) },
    ],
  }));
}

/** Post PAYMENT_REVERSAL: the inverse of the original payment — credit CASH|BANK / debit PATIENT_AR. */
export async function postPaymentReversalEntry({ payment, tenantId }) {
  const credit = paymentDebitAccount(payment.mode); // the account the original debited
  if (!credit) return null;             // INSURANCE — original was never posted
  const paise = toPaise(payment.amount);
  if (paise <= 0) return null;
  return setTenantTx(tenantId, (tx) => postLedgerEntry(tx, {
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
  }));
}

export default {
  paymentDebitAccount, postInvoiceIssueEntry, postPaymentEntry,
  postAdvanceCollectEntry, postAdvanceSettleEntry, postPaymentReversalEntry,
};
