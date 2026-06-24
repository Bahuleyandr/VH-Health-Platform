// apps/backend/src/services/billing/ledger/ledgerReportsService.js
//
// Read-only General-Ledger reports over the double-entry ledger. Each function
// is pure (tenantId -> report data), runs inside setTenant (RLS-scoped), and
// returns JSON-able data with integer paise (+ ₹ strings via fromPaise where a
// display value helps). No writes.
import { setTenant } from '../../../lib/prisma.js';
import { fromPaise } from '../../../utils/money.js';

const AR_AGING_BUCKETS = ['0-30', '31-60', '61-90', '90+'];

function emptyBuckets() {
  return AR_AGING_BUCKETS.map((bucket) => ({ bucket, invoiceCount: 0, totalPaise: 0, total: '0.00' }));
}

// Bucket an aging query result (rows of {bucket, invoice_count, total_paise})
// into the fixed 4-bucket shape with zero-fill + a grand total.
function shapeAging(rows) {
  const buckets = emptyBuckets();
  let grand = 0;
  for (const r of rows) {
    const b = buckets.find((x) => x.bucket === r.bucket);
    if (b) {
      b.invoiceCount = Number(r.invoice_count);
      b.totalPaise = Number(r.total_paise);
      b.total = fromPaise(b.totalPaise);
      grand += b.totalPaise;
    }
  }
  return { buckets, grandTotalPaise: grand, grandTotal: fromPaise(grand) };
}

const AGING_SQL = (accountCode) => `
  SELECT bucket, COUNT(*)::int AS invoice_count, SUM(ar_paise)::bigint AS total_paise
  FROM (
    SELECT b.invoice_id, b.balance_paise AS ar_paise,
           CASE
             WHEN EXTRACT(DAY FROM (NOW() - i.issued_at)) <= 30 THEN '0-30'
             WHEN EXTRACT(DAY FROM (NOW() - i.issued_at)) <= 60 THEN '31-60'
             WHEN EXTRACT(DAY FROM (NOW() - i.issued_at)) <= 90 THEN '61-90'
             ELSE '90+'
           END AS bucket
    FROM ledger_balances b
      JOIN ledger_accounts a ON a.id = b.account_id
      JOIN billing_invoices i ON i.id = b.invoice_id
    WHERE a.code = '${accountCode}' AND b.balance_paise > 0 AND b.invoice_id IS NOT NULL
  ) x
  GROUP BY bucket`;

/** Trial balance: normal-direction balance per account + the signed total (must be 0). */
export async function trialBalance(tenantId) {
  return setTenant(tenantId, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `SELECT a.code, a.type, COALESCE(SUM(b.balance_paise),0)::bigint AS balance_paise,
              ledger_account_normal_side(a.type) AS normal_side
         FROM ledger_accounts a
         LEFT JOIN ledger_balances b ON b.account_id = a.id
        GROUP BY a.code, a.type
        ORDER BY a.code`,
    );
    let signed = 0;
    const accounts = rows.map((r) => {
      const balancePaise = Number(r.balance_paise);
      signed += balancePaise * Number(r.normal_side);
      return { code: r.code, type: r.type, balancePaise, balance: fromPaise(balancePaise) };
    });
    return { accounts, signedTotalPaise: signed, balanced: signed === 0 };
  });
}

/** AR aging: outstanding PATIENT_AR per invoice, bucketed by invoice age. */
export async function arAging(tenantId) {
  return setTenant(tenantId, async (tx) => shapeAging(await tx.$queryRawUnsafe(AGING_SQL('PATIENT_AR'))));
}

/** Insurer-AR aging: outstanding INSURANCE_AR per invoice, bucketed by invoice age. */
export async function insurerAging(tenantId) {
  return setTenant(tenantId, async (tx) => shapeAging(await tx.$queryRawUnsafe(AGING_SQL('INSURANCE_AR'))));
}

/** Cash position: total CASH + BANK balances, plus CASH net by drawer session. */
export async function cashPosition(tenantId) {
  return setTenant(tenantId, async (tx) => {
    const totals = await tx.$queryRawUnsafe(
      `SELECT a.code, COALESCE(SUM(b.balance_paise),0)::bigint AS bal
         FROM ledger_accounts a LEFT JOIN ledger_balances b ON b.account_id = a.id
        WHERE a.code IN ('CASH','BANK') GROUP BY a.code`,
    );
    const cashTotalPaise = Number(totals.find((t) => t.code === 'CASH')?.bal || 0);
    const bankTotalPaise = Number(totals.find((t) => t.code === 'BANK')?.bal || 0);
    const drawers = await tx.$queryRawUnsafe(
      `SELECT p.cash_drawer_session_id AS drawer, SUM(p.amount_paise)::bigint AS net_paise
         FROM ledger_postings p JOIN ledger_accounts a ON a.id = p.account_id
        WHERE a.code = 'CASH' AND p.cash_drawer_session_id IS NOT NULL
        GROUP BY p.cash_drawer_session_id
        ORDER BY p.cash_drawer_session_id`,
    );
    return {
      cashTotalPaise, cashTotal: fromPaise(cashTotalPaise),
      bankTotalPaise, bankTotal: fromPaise(bankTotalPaise),
      byDrawer: drawers.map((d) => ({ drawerSessionId: Number(d.drawer), netPaise: Number(d.net_paise), net: fromPaise(Number(d.net_paise)) })),
    };
  });
}

/** Daily collection (ledger-derived): CASH/BANK receipts by day over [from,to]. */
export async function dailyCollection(tenantId, { from = null, to = null } = {}) {
  return setTenant(tenantId, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `SELECT e.occurred_at::date::text AS day, SUM(p.amount_paise)::bigint AS collected_paise
         FROM ledger_postings p
         JOIN ledger_accounts a ON a.id = p.account_id
         JOIN ledger_entries e ON e.id = p.entry_id
        WHERE a.code IN ('CASH','BANK') AND p.amount_paise > 0
          AND e.entry_type IN ('PAYMENT','INSURANCE_SETTLE')
          AND e.occurred_at::date >= COALESCE($1::date, CURRENT_DATE - INTERVAL '30 days')
          AND e.occurred_at::date <= COALESCE($2::date, CURRENT_DATE)
        GROUP BY day ORDER BY day`,
      from, to,
    );
    const days = rows.map((r) => ({ day: r.day, collectedPaise: Number(r.collected_paise), collected: fromPaise(Number(r.collected_paise)) }));
    const totalPaise = days.reduce((s, d) => s + d.collectedPaise, 0);
    return { days, totalPaise, total: fromPaise(totalPaise) };
  });
}

export default { trialBalance, arAging, insurerAging, cashPosition, dailyCollection };
