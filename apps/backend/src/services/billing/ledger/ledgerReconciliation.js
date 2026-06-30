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
import Sentry from '../../../utils/sentry.js';
import { recordLedgerReconciliationDrift } from '../../../observability/reliabilityMetrics.js';
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
 * Signals:
 * - mismatches:  ISSUED invoices WITH a ledger receivable that != the legacy
 *                amount_due column (meaningful in shadow; tautological-but-
 *                harmless once the column is ledger-derived under enforce).
 * - unwired:     ISSUED invoices with amount_due > 0 and NO ledger receivable
 *                (need a cutover / a post that never landed / a bypass writer).
 * - eventsDrift: INDEPENDENT ledger-vs-events oracle — for fully ledger-era
 *                invoices (those with an INVOICE_ISSUE entry), the ledger
 *                receivable must equal the amount recomputed from the raw event
 *                tables (total − Σpayments − Σsettlements + Σapproved invoice
 *                refunds). This is the meaningful cross-check under enforce,
 *                where the column comparison is tautological. Cutover /
 *                opening-balance invoices have no event baseline, so they are
 *                excluded.
 * - trialBalancePaise: Σ(signed balances) across all accounts; must be 0.
 *
 * The receivable uses PATIENT_AR + INSURANCE_AR so the insurance two-step
 * (approval shifts AR -> INSURANCE_AR) does not register as drift.
 *
 * Drift handling is mode-scoped: 'shadow'/'off' log an informational warning
 * (the strangler default); 'enforce' raises a HARD ALERT (Sentry fatal + the
 * ledger_reconciliation_drift_total metric + an error log) because, once the
 * ledger is authoritative, any drift is a financial-integrity incident. It does
 * NOT block the API — same-tx atomicity already prevents new drift.
 *
 * @param {string} tenantId
 * @param {{mode?: 'off'|'shadow'|'enforce'}} [opts]
 * @returns {Promise<{mismatches:Array, unwired:Array, eventsDrift:Array, trialBalancePaise:number}>}
 */
export async function reconcileLedger(tenantId, { mode = 'shadow' } = {}) {
  const result = await setTenantTx(tenantId, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `SELECT i.id AS invoice_id,
              ROUND(i.amount_due * 100)::bigint AS legacy_due_paise,
              bal.ledger_paise,
              EXISTS (SELECT 1 FROM ledger_entries e WHERE e.idempotency_key = 'issue-inv-' || i.id) AS ledger_era,
              ROUND((
                i.total_amount
                - COALESCE((SELECT SUM(p.amount) FROM billing_payments p WHERE p.invoice_id = i.id AND p.reversed = false), 0)
                - COALESCE((SELECT SUM(s.amount) FROM billing_advance_settlements s WHERE s.invoice_id = i.id), 0)
                + COALESCE((SELECT SUM(r.amount) FROM billing_refunds r WHERE r.invoice_id = i.id AND r.approval_status IN ('APPROVED','PAID')), 0)
              ) * 100)::bigint AS events_due_paise
         FROM billing_invoices i
         LEFT JOIN (
           SELECT b.invoice_id, SUM(b.balance_paise)::bigint AS ledger_paise
             FROM ledger_balances b JOIN ledger_accounts a ON a.id = b.account_id
            WHERE a.code IN ('PATIENT_AR','INSURANCE_AR') AND b.invoice_id IS NOT NULL
            GROUP BY b.invoice_id
         ) bal ON bal.invoice_id = i.id
        WHERE i.status = 'ISSUED' AND i.amount_due > 0`,
    );
    const mismatches = [];
    const unwired = [];
    const eventsDrift = [];
    for (const r of rows) {
      const ledgerPaise = r.ledger_paise === null || r.ledger_paise === undefined ? null : Number(r.ledger_paise);
      if (ledgerPaise === null) {
        unwired.push({ invoiceId: Number(r.invoice_id), expectedPaise: Number(r.legacy_due_paise) });
        continue;
      }
      if (ledgerPaise !== Number(r.legacy_due_paise)) {
        mismatches.push({ invoiceId: Number(r.invoice_id), ledgerPaise, expectedPaise: Number(r.legacy_due_paise) });
      }
      // Independent oracle — only for fully ledger-era invoices (cutover /
      // opening-balance invoices have no INVOICE_ISSUE event baseline).
      if (r.ledger_era && ledgerPaise !== Number(r.events_due_paise)) {
        eventsDrift.push({ invoiceId: Number(r.invoice_id), ledgerPaise, eventsPaise: Number(r.events_due_paise) });
      }
    }
    const tb = await tx.$queryRawUnsafe(
      `SELECT COALESCE(SUM(b.balance_paise * ledger_account_normal_side(a.type)), 0)::bigint AS tb
         FROM ledger_balances b JOIN ledger_accounts a ON a.id = b.account_id`,
    );
    return { mismatches, unwired, eventsDrift, trialBalancePaise: Number(tb[0].tb) };
  });

  const { mismatches, unwired, eventsDrift, trialBalancePaise } = result;
  const hasDrift = mismatches.length || unwired.length || eventsDrift.length || trialBalancePaise !== 0;
  if (hasDrift) {
    const detail = {
      tenantId,
      mismatches: mismatches.length,
      unwired: unwired.length,
      eventsDrift: eventsDrift.length,
      trialBalancePaise,
    };
    if (mode === 'enforce') {
      // Ledger is authoritative — drift is a financial-integrity incident.
      mismatches.forEach(() => recordLedgerReconciliationDrift('mismatch'));
      unwired.forEach(() => recordLedgerReconciliationDrift('unwired'));
      eventsDrift.forEach(() => recordLedgerReconciliationDrift('events'));
      if (trialBalancePaise !== 0) recordLedgerReconciliationDrift('trial_balance');
      logger.error('CRITICAL Ledger reconciliation drift (enforce)', detail);
      Sentry.captureException(new Error('Ledger reconciliation drift detected'), {
        level: 'fatal',
        tags: { subsystem: 'billing_ledger', severity: 'CRITICAL' },
        extra: detail,
      });
    } else {
      logger.warn('Ledger reconciliation drift', detail);
    }
  }
  return result;
}

/**
 * Phase 4-5: append a durable evidence row for one tenant's reconcile sweep.
 * Best-effort — a persistence failure must never break the sweep. `passed` is
 * true iff there was zero drift of any kind. The accumulation of clean rows over
 * time is the operator's flip-readiness evidence (see
 * scripts/ledger-reconciliation-evidence.mjs).
 * @param {string} tenantId
 * @param {{mismatches:Array, unwired:Array, eventsDrift:Array, trialBalancePaise:number}} result
 * @param {'off'|'shadow'|'enforce'} [mode]
 */
export async function persistReconciliationCheck(tenantId, result, mode = 'shadow') {
  const passed = !(result.mismatches.length || result.unwired.length
    || result.eventsDrift.length || result.trialBalancePaise !== 0);
  try {
    await setTenantTx(tenantId, (tx) => tx.$executeRawUnsafe(
      `INSERT INTO reconciliation_checks
         (tenant_id, mode, mismatch_count, unwired_count, events_drift_count, trial_balance_paise, passed)
       VALUES ($1::uuid, $2, $3::int, $4::int, $5::int, $6::bigint, $7::boolean)`,
      tenantId, mode, result.mismatches.length, result.unwired.length,
      result.eventsDrift.length, result.trialBalancePaise, passed,
    ));
  } catch (err) {
    logger.warn('persistReconciliationCheck failed (non-blocking)', { tenantId, error: err?.message });
  }
  return { passed };
}

export default { applyArOpeningBalances, reconcileLedger, persistReconciliationCheck };
