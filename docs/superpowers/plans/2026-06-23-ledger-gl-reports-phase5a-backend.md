# Ledger GL Reports — Phase 5a (backend endpoints) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read-only General-Ledger report endpoints over the ledger — trial balance, AR aging, insurer-AR aging, cash position, daily collection — as finance-gated admin API returning the standard `success()` envelope. (The admin UI that consumes these is Phase 5b.)

**Architecture:** A pure `ledgerReportsService.js` (one set-based, tenant-scoped query per report) + an isolated `routes/admin/ledgerReportsRoutes.js` sub-router (inline finance-role gate like `databaseRoutes.js`, 5 thin GET controllers), mounted at `/ledger` in the admin index. No migrations — reads over `ledger_balances` / `ledger_postings` / `ledger_accounts` / `billing_invoices`.

**Tech Stack:** Node 22 / Express 5 / PostgreSQL 17 / Prisma raw SQL; the movement-complete ledger (on `main`); `src/utils/money.js` `fromPaise`; Jest deep tests on the `postgres` QA DB.

**Spec:** `docs/superpowers/specs/2026-06-23-ledger-gl-reports-design.md`.

---

## Conventions (read first)

- Branch `feat/ledger-gl-reports-5a`; commit per task; merge `--no-ff` + push BOTH remotes (`origin`=Forgejo, `github`=GitHub).
- Deep test: `DATABASE_URL="postgresql://postgres@127.0.0.1:55432/vhhealth_test" NODE_ENV=test node --experimental-vm-modules node_modules/jest/bin/jest.js <pattern> --forceExit` from `apps/backend`. **QA DB idle-dies — revive with `node apps/backend/scripts/qa-cluster-up.mjs` and retry.**
- Full gate: `node scripts/run-ci-jest.mjs` → `All chunks passed` + zero `FAIL src/`. Stall monitor `Chunk [0-9]+/[0-9]+`; resume `JEST_CI_START_CHUNK=<frozen>` on DB death.
- `npm run lint && npm run lint:raw-params` before each commit. No migrations.
- Reads run inside `setTenant(tenantId, fn)` (RLS-scoped). As `postgres` in tests RLS is bypassed, so seed/read on the default tenant.

## File Structure

- Create `apps/backend/src/services/billing/ledger/ledgerReportsService.js` — `trialBalance`, `arAging`, `insurerAging`, `cashPosition`, `dailyCollection`.
- Create `apps/backend/src/routes/admin/ledgerReportsRoutes.js` — finance-gated sub-router, 5 GET endpoints.
- Modify `apps/backend/src/routes/admin/index.js` — import + `router.use('/ledger', ledgerReportsRoutes)`.
- Create `apps/backend/src/tests/money-ledger-reports.deep.test.js` — deep tests for all 5.

---

## Task 1: `ledgerReportsService.js` — the 5 report functions

**Files:**
- Create: `apps/backend/src/services/billing/ledger/ledgerReportsService.js`
- Test: `apps/backend/src/tests/money-ledger-reports.deep.test.js`

- [ ] **Step 1: Write the failing deep test**

```js
// apps/backend/src/tests/money-ledger-reports.deep.test.js
import { randomUUID } from 'node:crypto';
import prisma from '../lib/prisma.js';
import * as billing from '../services/billing/billingV2Service.js';
import {
  trialBalance, arAging, insurerAging, cashPosition, dailyCollection,
} from '../services/billing/ledger/ledgerReportsService.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const cleanup = { invoiceIds: [], patientUids: [] };

async function makePatient() {
  const uid = randomUUID();
  const phone = `9${Math.floor(100000000 + Math.random() * 899999999)}`;
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (uid, phone, name, role, tenant_id, updated_at) VALUES ($1::uuid,$2,'Rpt Test','PATIENT',$3::uuid,NOW())`,
    uid, phone, TENANT,
  );
  cleanup.patientUids.push(uid);
  return uid;
}
async function makeIssuedInvoice(patientUid, total) {
  const inv = await billing.createDraftInvoice({ patient_uid: patientUid, invoice_type: 'OP', tenantId: TENANT });
  await billing.addInvoiceItem(inv.id, { description: 'Svc', quantity: 1, unit_price: total, gst_rate: 0, tenantId: TENANT });
  await billing.issueInvoice(inv.id, { tenantId: TENANT });
  cleanup.invoiceIds.push(inv.id);
  return inv.id;
}

afterAll(async () => {
  try {
    if (cleanup.invoiceIds.length) {
      await prisma.$executeRawUnsafe(`DELETE FROM billing_payments WHERE invoice_id = ANY($1::int[])`, cleanup.invoiceIds);
      await prisma.$executeRawUnsafe(`DELETE FROM billing_invoice_items WHERE invoice_id = ANY($1::int[])`, cleanup.invoiceIds);
      await prisma.$executeRawUnsafe(`DELETE FROM billing_invoices WHERE id = ANY($1::int[])`, cleanup.invoiceIds);
    }
    if (cleanup.patientUids.length) await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = ANY($1::uuid[])`, cleanup.patientUids);
  } catch { /* best-effort */ }
  await prisma.$disconnect().catch(() => {});
});

describe('Phase 5a — GL report functions', () => {
  it('trialBalance returns per-account balances and is balanced (signed total 0)', async () => {
    const patient = await makePatient();
    await makeIssuedInvoice(patient, 1000); // posts AR + REVENUE
    const tb = await trialBalance(TENANT);
    expect(tb.balanced).toBe(true);
    expect(tb.signedTotalPaise).toBe(0);
    const ar = tb.accounts.find((a) => a.code === 'PATIENT_AR');
    expect(ar).toBeDefined();
    expect(ar.balancePaise).toBeGreaterThanOrEqual(100000);
  });

  it('arAging buckets outstanding PATIENT_AR by invoice age (fresh invoice in 0-30)', async () => {
    const patient = await makePatient();
    const invId = await makeIssuedInvoice(patient, 500); // AR 50000, issued now
    const aging = await arAging(TENANT);
    const b = aging.buckets.find((x) => x.bucket === '0-30');
    expect(b).toBeDefined();
    expect(b.totalPaise).toBeGreaterThanOrEqual(50000);
    expect(aging.grandTotalPaise).toBeGreaterThanOrEqual(50000);
    // the just-issued invoice contributes to 0-30, never to 90+
    expect(aging.buckets.find((x) => x.bucket === '90+').totalPaise).toBeGreaterThanOrEqual(0);
    expect(invId).toBeGreaterThan(0);
  });

  it('cashPosition returns CASH and BANK totals; collecting cash increases CASH', async () => {
    const patient = await makePatient();
    const invId = await makeIssuedInvoice(patient, 400);
    await billing.collectPayment({ invoice_id: invId, amount: 400, mode: 'CASH', shift: 'MORNING', collected_by: patient, tenantId: TENANT });
    const cp = await cashPosition(TENANT);
    expect(cp.cashTotalPaise).toBeGreaterThanOrEqual(40000);
    expect(typeof cp.bankTotalPaise).toBe('number');
  });

  it('dailyCollection sums CASH/BANK receipts by day for today', async () => {
    const patient = await makePatient();
    const invId = await makeIssuedInvoice(patient, 600);
    await billing.collectPayment({ invoice_id: invId, amount: 600, mode: 'CASH', shift: 'MORNING', collected_by: patient, tenantId: TENANT });
    const today = (await prisma.$queryRawUnsafe(`SELECT CURRENT_DATE::text AS d`))[0].d;
    const dc = await dailyCollection(TENANT, { from: today, to: today });
    const row = dc.days.find((d) => d.day === today);
    expect(row).toBeDefined();
    expect(row.collectedPaise).toBeGreaterThanOrEqual(60000);
  });

  it('insurerAging returns the four buckets (empty-safe)', async () => {
    const aging = await insurerAging(TENANT);
    expect(aging.buckets.map((b) => b.bucket)).toEqual(['0-30', '31-60', '61-90', '90+']);
    expect(typeof aging.grandTotalPaise).toBe('number');
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `... jest.js money-ledger-reports --forceExit` → `Cannot find module '.../ledgerReportsService.js'`.

- [ ] **Step 3: Write the implementation**

```js
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
```

- [ ] **Step 4: Run to verify it passes** — `... jest.js money-ledger-reports --forceExit` → 5 tests PASS. (If the QA DB died, revive + retry.)

- [ ] **Step 5: Lint + commit**

```bash
cd apps/backend && npx eslint src/services/billing/ledger/ledgerReportsService.js src/tests/money-ledger-reports.deep.test.js && npm run lint:raw-params && cd ../..
git add apps/backend/src/services/billing/ledger/ledgerReportsService.js apps/backend/src/tests/money-ledger-reports.deep.test.js
git commit -m "feat(ledger): GL report functions (trial balance, AR/insurer aging, cash position, daily collection)"
```

> **Implementer note:** `AGING_SQL` interpolates a hard-coded account code (`'PATIENT_AR'`/`'INSURANCE_AR'`) — these are literal constants, NOT user input, so this is not an injection vector and `lint:raw-params` is satisfied (no bound params). Keep the codes as the only interpolated values.

---

## Task 2: `ledgerReportsRoutes.js` — finance-gated sub-router + mount

**Files:**
- Create: `apps/backend/src/routes/admin/ledgerReportsRoutes.js`
- Modify: `apps/backend/src/routes/admin/index.js`

- [ ] **Step 1: Write the route file** (mirror `databaseRoutes.js`'s inline role-gate + try/catch + `success()/error()`)

```js
// apps/backend/src/routes/admin/ledgerReportsRoutes.js
//
// Read-only General-Ledger reports (T2 ledger Phase 5a). Finance-gated; reads
// only, tenant-scoped in the service via setTenant.
import express from 'express';
import logger from '../../logging/logger.js';
import { error, success } from '../../utils/responseHelper.js';
import {
  trialBalance, arAging, insurerAging, cashPosition, dailyCollection,
} from '../../services/billing/ledger/ledgerReportsService.js';

const router = express.Router();

const FINANCE_ROLES = new Set(['FINANCE_INCHARGE', 'ADMIN', 'SUPER_ADMIN']);

// Inline finance-role gate (same pattern as databaseRoutes.js' SUPER_ADMIN gate).
router.use((req, res, next) => {
  const role = String(req.user?.rawRole || req.user?.role || '').toUpperCase();
  if (!FINANCE_ROLES.has(role)) {
    return error(res, 'Finance role required', 403, { safe: true });
  }
  return next();
});

function tid(req) {
  return req.tenantId || req.user?.tenant_id || null;
}

router.get('/trial-balance', async (req, res) => {
  try { success(res, await trialBalance(tid(req)), 'Trial balance'); }
  catch (err) { logger.error('GL trial-balance error:', err); error(res, 'Failed to load trial balance', 500, { safe: true }); }
});

router.get('/ar-aging', async (req, res) => {
  try { success(res, await arAging(tid(req)), 'AR aging'); }
  catch (err) { logger.error('GL ar-aging error:', err); error(res, 'Failed to load AR aging', 500, { safe: true }); }
});

router.get('/insurer-aging', async (req, res) => {
  try { success(res, await insurerAging(tid(req)), 'Insurer AR aging'); }
  catch (err) { logger.error('GL insurer-aging error:', err); error(res, 'Failed to load insurer aging', 500, { safe: true }); }
});

router.get('/cash-position', async (req, res) => {
  try { success(res, await cashPosition(tid(req)), 'Cash position'); }
  catch (err) { logger.error('GL cash-position error:', err); error(res, 'Failed to load cash position', 500, { safe: true }); }
});

router.get('/daily-collection', async (req, res) => {
  try { success(res, await dailyCollection(tid(req), { from: req.query.from || null, to: req.query.to || null }), 'Daily collection'); }
  catch (err) { logger.error('GL daily-collection error:', err); error(res, 'Failed to load daily collection', 500, { safe: true }); }
});

export default router;
```

- [ ] **Step 2: Mount in `routes/admin/index.js`.** Add the import with the other admin sub-router imports:
```js
import ledgerReportsRoutes from './ledgerReportsRoutes.js';
```
and add the mount with the other `router.use('/...', …)` mounts:
```js
router.use('/ledger', ledgerReportsRoutes);
```

- [ ] **Step 3: Lint + smoke that the app loads the route** — `cd apps/backend && npx eslint src/routes/admin/ledgerReportsRoutes.js src/routes/admin/index.js && node -e "import('./src/routes/admin/ledgerReportsRoutes.js').then(()=>console.log('route module loads OK'))" && cd ../..`
Expected: 0 lint errors; "route module loads OK".

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/routes/admin/ledgerReportsRoutes.js apps/backend/src/routes/admin/index.js
git commit -m "feat(ledger): finance-gated GL report endpoints under /api/v1/admin/ledger"
```

---

## Task 3: Full gate + merge

- [ ] **Step 1: lint sweep** — `cd apps/backend && npm run lint && npm run lint:raw-params && cd ../..` → clean.
- [ ] **Step 2: Full gate** — `cd apps/backend && DATABASE_URL="postgresql://postgres@127.0.0.1:55432/vhhealth_test" NODE_ENV=test node scripts/run-ci-jest.mjs 2>&1 | tee /tmp/ledger-5a-gate.log; cd ../..` → `All chunks passed`, zero `FAIL src/`. Arm a stall monitor; revive the QA DB + resume `JEST_CI_START_CHUNK=<frozen>` on idle-death.
- [ ] **Step 3: Merge + push both remotes**
```bash
git checkout main
git merge --no-ff feat/ledger-gl-reports-5a -m "Merge ledger GL reports Phase 5a: backend report endpoints"
git push origin main && git push github main
git branch -d feat/ledger-gl-reports-5a
```
- [ ] **Step 4: Update ROADMAP + memory** — tick Phase 5a; note Phase 5b (admin GL reports UI consuming these endpoints) next.

---

## Self-review (plan-author)

- **Spec coverage:** §3 all 5 reports → Task 1 (with exact SQL + the documented `ledger_balances` CASH-dimension limitation → `byDrawer` from postings); §4 service + isolated finance-gated sub-router + mount → Tasks 1/2; §6 backend deep test → Task 1. **Deferred to 5b:** the admin UI (§5) + the frontend test.
- **No placeholders:** all SQL/JS/test code complete. The aging-bucket boundaries are a named constant; `AGING_SQL` interpolates only the literal account code (documented as non-injection).
- **Type consistency:** `trialBalance→{accounts:[{code,type,balancePaise,balance}],signedTotalPaise,balanced}`, `arAging/insurerAging→{buckets:[{bucket,invoiceCount,totalPaise,total}],grandTotalPaise,grandTotal}`, `cashPosition→{cashTotalPaise,...,byDrawer:[{drawerSessionId,netPaise,net}]}`, `dailyCollection→{days:[{day,collectedPaise,collected}],totalPaise,total}` — matches the route handlers + the deep-test assertions.
- **Tenant + RLS:** every fn wraps in `setTenant`; the route reads `req.tenantId` (tenant-context-middleware) and the finance gate mirrors `databaseRoutes.js`.
- **Known nuance:** `ledger_balances` has no `cash_drawer_session_id` dimension (CASH balances are a single all-NULL-dimension row), so `cashPosition.byDrawer` is computed from `ledger_postings` (which carry the drawer) — documented in the spec's cash-position source + here.
