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

function normalizedMedicationCreditLine({
  accountCode,
  amountPaise,
  patientUid = null,
  invoiceId = null,
  advanceId = null,
  paymentId = null,
  cashDrawerSessionId = null,
}) {
  return {
    accountCode,
    amountPaise: String(amountPaise),
    patientUid: patientUid == null ? null : String(patientUid),
    invoiceId: invoiceId == null ? null : Number(invoiceId),
    advanceId: advanceId == null ? null : Number(advanceId),
    paymentId: paymentId == null ? null : Number(paymentId),
    cashDrawerSessionId: cashDrawerSessionId == null ? null : Number(cashDrawerSessionId),
  };
}

function medicationCreditLineKey(line) {
  return JSON.stringify(line);
}

function medicationCreditLinesMatch(expected, actual) {
  const expectedKeys = expected.map(medicationCreditLineKey).sort();
  const actualKeys = actual.map(medicationCreditLineKey).sort();
  return expectedKeys.length === actualKeys.length
    && expectedKeys.every((key, index) => key === actualKeys[index]);
}

function expectedMedicationCreditLines(note) {
  const amountMinor = BigInt(note.amountMinor);
  const receivableMinor = BigInt(note.receivableCreditMinor);
  const refundMinor = BigInt(note.refundObligationMinor);
  const lines = [normalizedMedicationCreditLine({
    accountCode: 'REVENUE',
    amountPaise: amountMinor,
  })];
  if (receivableMinor > 0n) {
    lines.push(normalizedMedicationCreditLine({
      accountCode: 'PATIENT_AR',
      amountPaise: -receivableMinor,
      patientUid: note.patientUid,
      invoiceId: note.invoiceId,
    }));
  }
  if (refundMinor > 0n) {
    lines.push(normalizedMedicationCreditLine({
      accountCode: 'REFUNDS_PAYABLE',
      amountPaise: -refundMinor,
      patientUid: note.patientUid,
    }));
  }
  return lines;
}

async function findMedicationCreditDrift(tx, tenantId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT note.id::text AS credit_note_id,
            note.credit_note_number,
            note.invoice_id,
            invoice.status AS invoice_status,
            note.patient_uid,
            note.source_financial_event_id::text AS source_financial_event_id,
            note.amount_minor::text AS amount_minor,
            note.receivable_credit_minor::text AS receivable_credit_minor,
            note.refund_obligation_minor::text AS refund_obligation_minor,
            EXISTS (
              SELECT 1
                FROM billing_credit_note_events raised
               WHERE raised.tenant_id = note.tenant_id
                 AND raised.credit_note_id = note.id
                 AND raised.event_type = 'raised'
                 AND raised.details->>'auto_applied_draft' = 'true'
            ) AS auto_applied_draft,
            entry.id::text AS entry_id,
            entry.entry_type,
            entry.idempotency_key,
            entry.metadata,
            posting.id::text AS posting_id,
            account.code AS account_code,
            posting.amount_paise::text AS amount_paise,
            posting.patient_uid AS posting_patient_uid,
            posting.invoice_id AS posting_invoice_id,
            posting.advance_id AS posting_advance_id,
            posting.payment_id AS posting_payment_id,
            posting.cash_drawer_session_id AS posting_cash_drawer_session_id
       FROM billing_credit_notes note
       JOIN billing_invoices invoice
         ON invoice.tenant_id = note.tenant_id
        AND invoice.id = note.invoice_id
       LEFT JOIN ledger_entries entry
         ON entry.tenant_id = note.tenant_id
        AND entry.idempotency_key = 'ward-medication-credit-' || note.id::text
       LEFT JOIN ledger_postings posting
         ON posting.tenant_id = note.tenant_id
        AND posting.entry_id = entry.id
       LEFT JOIN ledger_accounts account ON account.id = posting.account_id
      WHERE note.tenant_id = $1::uuid
        AND note.status = 'applied'
        AND invoice.status IN ('ISSUED', 'PARTIAL', 'PAID')
      ORDER BY note.id, posting.id`,
    tenantId,
  );

  const notes = new Map();
  for (const row of rows) {
    let note = notes.get(row.credit_note_id);
    if (!note) {
      note = {
        creditNoteId: String(row.credit_note_id),
        creditNoteNumber: row.credit_note_number,
        invoiceId: Number(row.invoice_id),
        invoiceStatus: row.invoice_status,
        patientUid: String(row.patient_uid),
        sourceFinancialEventId: String(row.source_financial_event_id),
        amountMinor: String(row.amount_minor),
        receivableCreditMinor: String(row.receivable_credit_minor),
        refundObligationMinor: String(row.refund_obligation_minor),
        autoAppliedDraft: Boolean(row.auto_applied_draft),
        entryId: row.entry_id == null ? null : String(row.entry_id),
        entryType: row.entry_type,
        idempotencyKey: row.idempotency_key,
        metadata: row.metadata || {},
        actualLines: [],
      };
      notes.set(row.credit_note_id, note);
    }
    if (row.posting_id != null) {
      note.actualLines.push(normalizedMedicationCreditLine({
        accountCode: row.account_code,
        amountPaise: row.amount_paise,
        patientUid: row.posting_patient_uid,
        invoiceId: row.posting_invoice_id,
        advanceId: row.posting_advance_id,
        paymentId: row.posting_payment_id,
        cashDrawerSessionId: row.posting_cash_drawer_session_id,
      }));
    }
  }

  const drift = [];
  for (const note of notes.values()) {
    const expectedIdempotencyKey = `ward-medication-credit-${note.creditNoteId}`;
    const expectedLines = expectedMedicationCreditLines(note);
    const reasons = [];
    if (note.autoAppliedDraft) {
      if (note.entryId != null) reasons.push('unexpected_draft_credit_entry');
    } else if (note.entryId == null) {
      reasons.push('missing_entry');
    } else {
      if (note.entryType !== 'WARD_MEDICATION_CREDIT') reasons.push('entry_type_mismatch');
      if (note.idempotencyKey !== expectedIdempotencyKey) reasons.push('idempotency_key_mismatch');
      if (String(note.metadata?.credit_note_id || '') !== note.creditNoteId) {
        reasons.push('credit_note_metadata_mismatch');
      }
      if (String(note.metadata?.source_financial_event_id || '') !== note.sourceFinancialEventId) {
        reasons.push('source_event_metadata_mismatch');
      }
      if (!medicationCreditLinesMatch(expectedLines, note.actualLines)) {
        reasons.push('posting_split_mismatch');
      }
    }
    if (reasons.length) {
      drift.push({
        kind: 'WARD_MEDICATION_CREDIT',
        creditNoteId: note.creditNoteId,
        creditNoteNumber: note.creditNoteNumber,
        invoiceId: note.invoiceId,
        invoiceStatus: note.invoiceStatus,
        autoAppliedDraft: note.autoAppliedDraft,
        entryId: note.entryId,
        reasons,
        expectedEntryType: note.autoAppliedDraft ? null : 'WARD_MEDICATION_CREDIT',
        expectedIdempotencyKey: note.autoAppliedDraft ? null : expectedIdempotencyKey,
        expectedLines: note.autoAppliedDraft ? [] : expectedLines,
        actualEntryType: note.entryType || null,
        actualIdempotencyKey: note.idempotencyKey || null,
        actualLines: note.actualLines,
      });
    }
  }
  return drift;
}

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
 * - mismatches:  active invoices WITH a ledger receivable that != the legacy
 *                amount_due column (meaningful in shadow; tautological-but-
 *                harmless once the column is ledger-derived under enforce).
 * - unwired:     active invoices with amount_due > 0 or applied medication
 *                credits and NO ledger receivable
 *                (need a cutover / a post that never landed / a bypass writer).
 * - eventsDrift: INDEPENDENT ledger-vs-events oracle — for fully ledger-era
 *                invoices (those with an INVOICE_ISSUE entry), the ledger
 *                receivable must equal the amount recomputed from the raw event
 *                tables (total − Σpayments − Σsettlements − Σapplied
 *                receivable credits + Σapproved standalone invoice refunds).
 *                Credit-note-linked refunds are excluded because the medication
 *                credit posting already established their payable. This is the
 *                meaningful cross-check under enforce,
 *                where the column comparison is tautological. Cutover /
 *                opening-balance invoices have no event baseline, so they are
 *                excluded. Applied post-issue medication credits are also
 *                checked one-by-one for their exact WARD_MEDICATION_CREDIT
 *                entry, metadata, and posting split. Draft-applied credits are
 *                expected in the net INVOICE_ISSUE amount instead; a separate
 *                credit entry for one is reported as drift.
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
              EXISTS (
                SELECT 1 FROM ledger_entries e
                 WHERE e.tenant_id = i.tenant_id
                   AND e.idempotency_key = 'issue-inv-' || i.id
              ) AS ledger_era,
              ROUND((
                 i.total_amount
                 - COALESCE((
                     SELECT SUM(p.amount) FROM billing_payments p
                      WHERE p.tenant_id = i.tenant_id
                        AND p.invoice_id = i.id
                        AND p.reversed = false
                   ), 0)
                 - COALESCE((
                     SELECT SUM(s.amount) FROM billing_advance_settlements s
                      WHERE s.tenant_id = i.tenant_id
                        AND s.invoice_id = i.id
                   ), 0)
                 - COALESCE((
                     SELECT SUM(note.receivable_credit_minor)::numeric / 100
                       FROM billing_credit_notes note
                      WHERE note.invoice_id = i.id
                        AND note.tenant_id = i.tenant_id
                        AND note.status = 'applied'
                   ), 0)
                 + COALESCE((
                     SELECT SUM(r.amount)
                       FROM billing_refunds r
                      WHERE r.invoice_id = i.id
                        AND r.tenant_id = i.tenant_id
                        AND r.approval_status IN ('APPROVED','PAID')
                        AND NOT EXISTS (
                          SELECT 1
                            FROM billing_credit_notes note
                           WHERE note.tenant_id = r.tenant_id
                             AND note.refund_id = r.id
                             AND note.status = 'applied'
                        )
                   ), 0)
               ) * 100)::bigint AS events_due_paise
         FROM billing_invoices i
         LEFT JOIN (
           SELECT b.tenant_id, b.invoice_id, SUM(b.balance_paise)::bigint AS ledger_paise
             FROM ledger_balances b JOIN ledger_accounts a ON a.id = b.account_id
            WHERE b.tenant_id = $1::uuid
              AND a.code IN ('PATIENT_AR','INSURANCE_AR')
              AND b.invoice_id IS NOT NULL
            GROUP BY b.tenant_id, b.invoice_id
         ) bal ON bal.tenant_id = i.tenant_id AND bal.invoice_id = i.id
        WHERE i.tenant_id = $1::uuid
          AND i.status IN ('ISSUED', 'PARTIAL', 'PAID')
          AND (
            i.amount_due > 0
            OR EXISTS (
              SELECT 1
                FROM billing_credit_notes note
               WHERE note.tenant_id = i.tenant_id
                 AND note.invoice_id = i.id
                 AND note.status = 'applied'
            )
          )`,
      tenantId,
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
    eventsDrift.push(...await findMedicationCreditDrift(tx, tenantId));
    const tb = await tx.$queryRawUnsafe(
      `SELECT COALESCE(SUM(b.balance_paise * ledger_account_normal_side(a.type)), 0)::bigint AS tb
         FROM ledger_balances b JOIN ledger_accounts a ON a.id = b.account_id
        WHERE b.tenant_id = $1::uuid`,
      tenantId,
    );
    return { mismatches, unwired, eventsDrift, trialBalancePaise: Number(tb[0].tb) };
  });

  const { mismatches, unwired, eventsDrift, trialBalancePaise } = result;
  const hasDrift = mismatches.length || unwired.length || eventsDrift.length || trialBalancePaise !== 0;
  if (hasDrift) {
    const medicationCreditDrift = eventsDrift
      .filter((item) => item.kind === 'WARD_MEDICATION_CREDIT')
      .map((item) => ({
        creditNoteId: item.creditNoteId,
        invoiceId: item.invoiceId,
        invoiceStatus: item.invoiceStatus,
        entryId: item.entryId,
        reasons: item.reasons,
      }));
    const detail = {
      tenantId,
      mismatches: mismatches.length,
      unwired: unwired.length,
      eventsDrift: eventsDrift.length,
      trialBalancePaise,
      medicationCreditDrift: medicationCreditDrift.slice(0, 50),
      medicationCreditDriftTruncated: Math.max(0, medicationCreditDrift.length - 50),
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
