// apps/backend/src/services/billing/ledger/ledgerReconciliation.js
//
// Phase 2b: (1) applyArOpeningBalances — one-time cutover seeding opening AR for
// pre-existing outstanding invoices that the Phase-2a wiring never posted; (2)
// reconcileLedger — continuous proof that the ledger matches the legacy billing
// tables. Both are tenant-scoped (run inside setTenantTx).
//
// Spec: docs/superpowers/specs/2026-06-23-double-entry-money-ledger-design.md §5/§6
import { setTenantTx } from '../../../lib/prisma.js';
import logger from '../../../logging/logger.js';
import { postLedgerEntry } from './ledgerService.js';

/**
 * Cutover: for each ISSUED invoice with amount_due > 0 in this tenant that has
 * NO existing PATIENT_AR ledger balance, post a balanced OPENING_BALANCE entry
 * (debit PATIENT_AR = amount_due / credit OPENING_EQUITY). The "no existing AR"
 * guard means a Phase-2a-wired invoice is never double-counted; the idempotency
 * key makes re-running the cutover a no-op.
 * @returns {Promise<{seeded:number, skipped:number}>}
 */
export async function applyArOpeningBalances(tenantId) {
  return setTenantTx(tenantId, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `SELECT i.id, i.patient_uid, ROUND(i.amount_due * 100)::bigint AS due_paise
         FROM billing_invoices i
        WHERE i.status = 'ISSUED'
          AND i.amount_due > 0
          AND i.patient_uid IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM ledger_balances b
              JOIN ledger_accounts a ON a.id = b.account_id
             WHERE a.code = 'PATIENT_AR' AND b.invoice_id = i.id
          )`,
    );
    let seeded = 0;
    for (const r of rows) {
      const paise = Number(r.due_paise);
      if (paise <= 0) continue;
      try {
        await postLedgerEntry(tx, {
          entryType: 'OPENING_BALANCE',
          idempotencyKey: `opening-ar-${r.id}`,
          metadata: { invoice_id: Number(r.id) },
          lines: [
            { accountCode: 'PATIENT_AR', amountPaise: paise, patient_uid: r.patient_uid, invoice_id: Number(r.id) },
            { accountCode: 'OPENING_EQUITY', amountPaise: -paise },
          ],
        });
        seeded += 1;
      } catch (err) {
        // LEDGER_DUPLICATE (idempotency) is an expected no-op on re-run.
        if (err?.code === 'LEDGER_DUPLICATE') continue;
        throw err;
      }
    }
    return { seeded, skipped: rows.length - seeded };
  });
}

/**
 * Reconcile the ledger against the legacy billing tables for one tenant.
 * - mismatches: ISSUED invoices WITH a ledger AR balance that != amount_due.
 * - unwired:    ISSUED invoices with amount_due > 0 and NO ledger AR balance
 *               (need a cutover / a Phase-2a post that never landed).
 * - trialBalancePaise: Σ(signed balances) across all accounts; must be 0.
 * @returns {Promise<{mismatches:Array, unwired:Array, trialBalancePaise:number}>}
 */
export async function reconcileLedger(tenantId) {
  return setTenantTx(tenantId, async (tx) => {
    const ar = await tx.$queryRawUnsafe(
      `SELECT i.id AS invoice_id,
              ROUND(i.amount_due * 100)::bigint AS expected_paise,
              bal.ledger_paise
         FROM billing_invoices i
         LEFT JOIN (
           SELECT b.invoice_id, SUM(b.balance_paise)::bigint AS ledger_paise
             FROM ledger_balances b JOIN ledger_accounts a ON a.id = b.account_id
            WHERE a.code = 'PATIENT_AR' AND b.invoice_id IS NOT NULL
            GROUP BY b.invoice_id
         ) bal ON bal.invoice_id = i.id
        WHERE i.status = 'ISSUED' AND i.amount_due > 0`,
    );
    const mismatches = [];
    const unwired = [];
    for (const r of ar) {
      if (r.ledger_paise === null || r.ledger_paise === undefined) {
        unwired.push({ invoiceId: Number(r.invoice_id), expectedPaise: Number(r.expected_paise) });
      } else if (Number(r.ledger_paise) !== Number(r.expected_paise)) {
        mismatches.push({ invoiceId: Number(r.invoice_id), ledgerPaise: Number(r.ledger_paise), expectedPaise: Number(r.expected_paise) });
      }
    }
    const tb = await tx.$queryRawUnsafe(
      `SELECT COALESCE(SUM(b.balance_paise * ledger_account_normal_side(a.type)), 0)::bigint AS tb
         FROM ledger_balances b JOIN ledger_accounts a ON a.id = b.account_id`,
    );
    const trialBalancePaise = Number(tb[0].tb);
    if (mismatches.length || unwired.length || trialBalancePaise !== 0) {
      logger.warn('Ledger reconciliation drift', {
        tenantId, mismatches: mismatches.length, unwired: unwired.length, trialBalancePaise,
      });
    }
    return { mismatches, unwired, trialBalancePaise };
  });
}

export default { applyArOpeningBalances, reconcileLedger };
