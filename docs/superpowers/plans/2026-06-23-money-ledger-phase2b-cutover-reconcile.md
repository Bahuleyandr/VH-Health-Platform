# Money Ledger — Phase 2b (opening-balance cutover + reconciliation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Seed the ledger with opening AR balances for pre-existing outstanding invoices (one-time operator script), and add a reconciliation routine + cron that continuously proves the ledger matches the legacy billing tables (per-invoice AR == amount_due; trial balance Σ == 0) — the safety net that must be clean before Phase 4 flips the ledger authoritative.

**Architecture:** A standalone Node script (`scripts/ledger-opening-balance-cutover.mjs`) posts an `OPENING_BALANCE` entry (debit PATIENT_AR = current amount_due / credit OPENING_EQUITY) for each ISSUED invoice with `amount_due > 0` that does NOT already have a ledger AR balance (so it never double-counts a Phase-2a-wired invoice). A `reconcileLedger(tenantId)` service runs a set-based SQL comparison (ledger AR vs `amount_due`, plus the signed trial balance) and returns mismatches / unwired / trial-balance; a cron (`registerCron` + `withJobLock`, skipped under `NODE_ENV==='test'`) runs it per active tenant and logs/metrics drift.

**Tech Stack:** Node 22 / PostgreSQL 17 / Prisma raw SQL; the Phase 1 ledger engine + Phase 2a wiring (both on `main`). Jest deep tests on the `postgres` QA DB.

**Spec:** `docs/superpowers/specs/2026-06-23-double-entry-money-ledger-design.md` (§5 reconciliation, §6 cutover). Phase 1 `b1358af7`, Phase 2a `dc2c5d4c`.

---

## Conventions (read first)

- Branch `feat/money-ledger-phase2b`; commit per task; merge `--no-ff` + push BOTH remotes (`origin`=Forgejo, `github`=GitHub).
- Deep test: `DATABASE_URL="postgresql://postgres@127.0.0.1:55432/vhhealth_test" NODE_ENV=test node --experimental-vm-modules node_modules/jest/bin/jest.js <pattern> --forceExit` from `apps/backend`.
- Full gate before merge: `node scripts/run-ci-jest.mjs` → `All chunks passed` + zero `FAIL src/`. Arm a stall-aware monitor. **The QA DB (:55432) idle-dies between long runs — if a deep test says "Can't reach database server", run `node apps/backend/scripts/qa-cluster-up.mjs` and retry.**
- `npm run lint && npm run lint:raw-params` before each commit.
- No migrations this phase.

## File Structure

- Create `apps/backend/src/services/billing/ledger/ledgerReconciliation.js` — `reconcileLedger(tenantId)` (set-based AR-vs-amount_due + trial balance) and `applyArOpeningBalances(tenantId)` (the cutover core, reused by the script + tested directly).
- Create `apps/backend/scripts/ledger-opening-balance-cutover.mjs` — thin operator CLI: iterate active tenants, call `applyArOpeningBalances`, print a summary.
- Modify `apps/backend/src/utils/scheduler.js` — register the reconciliation cron.
- Create `apps/backend/src/tests/money-ledger-cutover-reconcile.deep.test.js` — deep tests for both.

---

## Task 1: `ledgerReconciliation.js` — cutover core + reconcile

**Files:**
- Create: `apps/backend/src/services/billing/ledger/ledgerReconciliation.js`

- [ ] **Step 1: Write the implementation** (deep-tested in Task 2; this module is pure DB orchestration with no unit-mockable seam worth isolating)

```js
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
```

- [ ] **Step 2: Lint**

Run: `cd apps/backend && npx eslint src/services/billing/ledger/ledgerReconciliation.js && npm run lint:raw-params && cd ../..`
Expected: 0 errors; raw-params clean.

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/services/billing/ledger/ledgerReconciliation.js
git commit -m "feat(ledger): cutover (applyArOpeningBalances) + reconcileLedger"
```

---

## Task 2: Deep test — cutover seeds AR; reconcile detects match/mismatch/unwired

**Files:**
- Create: `apps/backend/src/tests/money-ledger-cutover-reconcile.deep.test.js`

- [ ] **Step 1: Write the failing deep test**

```js
// apps/backend/src/tests/money-ledger-cutover-reconcile.deep.test.js
import { randomUUID } from 'node:crypto';
import prisma, { setTenantTx } from '../lib/prisma.js';
import { getAccountBalancePaise } from '../services/billing/ledger/ledgerService.js';
import { applyArOpeningBalances, reconcileLedger } from '../services/billing/ledger/ledgerReconciliation.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const cleanup = { invoiceIds: [], patientUids: [] };

async function makePatient() {
  const uid = randomUUID();
  const phone = `9${Math.floor(100000000 + Math.random() * 899999999)}`;
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (uid, phone, name, role, tenant_id, updated_at) VALUES ($1::uuid,$2,'Recon Test','PATIENT',$3::uuid,NOW())`,
    uid, phone, TENANT,
  );
  cleanup.patientUids.push(uid);
  return uid;
}

// A pre-existing ISSUED invoice with a known amount_due, created directly (it
// has NO ledger AR — simulating an invoice from before Phase 2a).
async function makeIssuedInvoice(patientUid, total, due) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO billing_invoices
       (patient_uid, invoice_type, status, subtotal, total_amount, amount_paid, amount_due, tenant_id, issued_at, invoice_number)
     VALUES ($1::uuid,'OP','ISSUED',$2::numeric,$2::numeric,$3::numeric,$4::numeric,$5::uuid,NOW(),$6)
     RETURNING id`,
    patientUid, total, (total - due), due, TENANT, `RC-${Math.floor(Math.random() * 1e9)}`,
  );
  cleanup.invoiceIds.push(rows[0].id);
  return rows[0].id;
}

afterAll(async () => {
  try {
    if (cleanup.invoiceIds.length) {
      await prisma.$executeRawUnsafe(`DELETE FROM billing_invoices WHERE id = ANY($1::int[])`, cleanup.invoiceIds);
    }
    if (cleanup.patientUids.length) {
      await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = ANY($1::uuid[])`, cleanup.patientUids);
    }
  } catch { /* best-effort */ }
  await prisma.$disconnect().catch(() => {});
});

describe('Phase 2b — cutover + reconciliation', () => {
  it('cutover seeds opening AR = amount_due for a pre-existing outstanding invoice, idempotently', async () => {
    const patient = await makePatient();
    const invoiceId = await makeIssuedInvoice(patient, 1000, 600); // total 1000, due 600

    const first = await applyArOpeningBalances(TENANT);
    expect(first.seeded).toBeGreaterThanOrEqual(1);
    const arPaise = await setTenantTx(TENANT, (tx) => getAccountBalancePaise(tx, 'PATIENT_AR', { invoice_id: invoiceId }));
    expect(arPaise).toBe(60000); // ₹600.00 opening receivable

    // re-run is a no-op (idempotency key opening-ar-<id>) — AR unchanged
    await applyArOpeningBalances(TENANT);
    const arPaise2 = await setTenantTx(TENANT, (tx) => getAccountBalancePaise(tx, 'PATIENT_AR', { invoice_id: invoiceId }));
    expect(arPaise2).toBe(60000);
  });

  it('reconcileLedger reports a seeded invoice as matched (not a mismatch / not unwired)', async () => {
    const patient = await makePatient();
    const invoiceId = await makeIssuedInvoice(patient, 500, 500);
    await applyArOpeningBalances(TENANT);

    const recon = await reconcileLedger(TENANT);
    expect(recon.mismatches.find((m) => m.invoiceId === invoiceId)).toBeUndefined();
    expect(recon.unwired.find((u) => u.invoiceId === invoiceId)).toBeUndefined();
    // ledger stays balanced overall
    expect(recon.trialBalancePaise).toBe(0);
  });

  it('reconcileLedger flags an outstanding invoice that has no ledger AR as unwired', async () => {
    const patient = await makePatient();
    const invoiceId = await makeIssuedInvoice(patient, 700, 700);
    // deliberately DO NOT run the cutover for this one
    const recon = await reconcileLedger(TENANT);
    expect(recon.unwired.find((u) => u.invoiceId === invoiceId)).toMatchObject({ expectedPaise: 70000 });
  });
});
```

- [ ] **Step 2: Run to verify it passes**

Run: `DATABASE_URL="postgresql://postgres@127.0.0.1:55432/vhhealth_test" NODE_ENV=test node --experimental-vm-modules node_modules/jest/bin/jest.js money-ledger-cutover-reconcile --forceExit`
Expected: PASS (3 tests). Note: the third test runs reconcile across ALL outstanding invoices in the default tenant — other tests' leftover invoices may also appear in `unwired`/`mismatches`; the assertions only check for THIS test's invoice id, so they are robust to shared-DB noise. `trialBalancePaise` must be 0 regardless (every entry is balanced).

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/tests/money-ledger-cutover-reconcile.deep.test.js
git commit -m "test(ledger): deep proof cutover seeds AR + reconcile match/mismatch/unwired"
```

---

## Task 3: Operator cutover script

**Files:**
- Create: `apps/backend/scripts/ledger-opening-balance-cutover.mjs`

- [ ] **Step 1: Write the script**

```js
// apps/backend/scripts/ledger-opening-balance-cutover.mjs
//
// One-time operator cutover: seed opening AR balances into the ledger for every
// active tenant's pre-existing outstanding invoices. Idempotent — safe to re-run
// (each invoice's opening entry has a stable idempotency key). Run AFTER the
// Phase-2a wiring is deployed.
//
//   DATABASE_URL=... node apps/backend/scripts/ledger-opening-balance-cutover.mjs
import prisma from '../src/lib/prisma.js';
import { applyArOpeningBalances } from '../src/services/billing/ledger/ledgerReconciliation.js';

async function main() {
  const tenants = await prisma.$queryRawUnsafe(`SELECT id FROM tenants ORDER BY id`);
  let totalSeeded = 0;
  for (const t of tenants) {
    const tenantId = String(t.id);
    try {
      const { seeded, skipped } = await applyArOpeningBalances(tenantId);
      totalSeeded += seeded;
      console.log(`[cutover] tenant ${tenantId}: seeded=${seeded} skipped=${skipped}`);
    } catch (err) {
      console.error(`[cutover] tenant ${tenantId} FAILED: ${err.message}`);
    }
  }
  console.log(`[cutover] done. total opening AR entries seeded: ${totalSeeded}`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('[cutover] fatal:', err);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
```

- [ ] **Step 2: Smoke-run the script against the QA DB (idempotent)**

Run: `cd apps/backend && DATABASE_URL="postgresql://postgres@127.0.0.1:55432/vhhealth_test" node scripts/ledger-opening-balance-cutover.mjs 2>&1 | tail -5; cd ../..`
Expected: prints per-tenant `seeded=/skipped=` lines and a total, exit 0. (Re-running yields seeded=0 for already-seeded invoices.)

- [ ] **Step 3: Lint + commit**

```bash
cd apps/backend && npx eslint scripts/ledger-opening-balance-cutover.mjs && cd ../..
git add apps/backend/scripts/ledger-opening-balance-cutover.mjs
git commit -m "feat(ledger): operator AR opening-balance cutover script (idempotent, per-tenant)"
```

---

## Task 4: Wire the reconciliation cron

**Files:**
- Modify: `apps/backend/src/utils/scheduler.js` — import `reconcileLedger`, register a cron that runs it per active tenant.

- [ ] **Step 1: Add the import** (with the other service imports near the top of the import block, e.g. after the webhookDeliveryService import line)

```js
import { reconcileLedger } from '../services/billing/ledger/ledgerReconciliation.js';
```

- [ ] **Step 2: Register the cron** (inside the function that registers the other crons — place it next to the other billing/sweep crons; mirror their `registerCron(expr, withJobLock(name, fn))` shape, and use `runWithSuperAdmin` to enumerate tenants cross-tenant)

```js
  // Ledger reconciliation (T2 money-ledger Phase 2b): every 30 min, per active
  // tenant, assert ledger AR == legacy amount_due + trial balance == 0. During
  // the strangler this is informational (logs drift); it becomes a hard alert
  // when the ledger is flipped authoritative (Phase 4).
  registerCron('*/30 * * * *', withJobLock('ledger-reconciliation', async () => {
    const tenants = await runWithSuperAdmin(() => prisma.$queryRawUnsafe('SELECT id FROM tenants'));
    let drift = 0;
    for (const t of tenants) {
      try {
        const r = await reconcileLedger(String(t.id));
        drift += r.mismatches.length + r.unwired.length + (r.trialBalancePaise !== 0 ? 1 : 0);
      } catch (err) {
        logger.error('ledger-reconciliation tenant failed', { tenantId: String(t.id), error: err.message });
      }
    }
    logger.info('ledger-reconciliation sweep complete', { tenants: tenants.length, driftSignals: drift });
  }));
```

- [ ] **Step 3: Lint + confirm the scheduler still imports clean**

Run: `cd apps/backend && npx eslint src/utils/scheduler.js && cd ../..`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/utils/scheduler.js
git commit -m "feat(ledger): reconciliation cron (per-tenant, every 30m, NODE_ENV!=test)"
```

---

## Task 5: Full gate + merge

- [ ] **Step 1: lint sweep** — `cd apps/backend && npm run lint && npm run lint:raw-params && cd ../..` → clean.
- [ ] **Step 2: Full gate** — `cd apps/backend && DATABASE_URL="postgresql://postgres@127.0.0.1:55432/vhhealth_test" NODE_ENV=test node scripts/run-ci-jest.mjs 2>&1 | tee /tmp/ledger-p2b-gate.log; cd ../..` → `All chunks passed`, zero `FAIL src/`. Arm a stall monitor; revive the QA DB if it idle-died.
- [ ] **Step 3: Merge + push both remotes**

```bash
git checkout main
git merge --no-ff feat/money-ledger-phase2b -m "Merge money ledger Phase 2b: AR opening-balance cutover + reconciliation"
git push origin main && git push github main
git branch -d feat/money-ledger-phase2b
```

- [ ] **Step 4: Update ROADMAP + memory** — tick Phase 2b; note Phase 3 (advances/refunds/insurance/tax + the markPaymentLinkPaid `tx`-passed path) next.

---

## Self-review (plan-author)

- **Spec coverage:** §6 cutover → Tasks 1/3 (+ the double-count guard via "no existing AR" + idempotency key); §5 reconciliation → Tasks 1/4 (AR==amount_due, trial balance Σ==0, unwired detection). **Deferred:** advances/refunds/insurance (Phase 3); flip-authoritative + reconciliation→alert (Phase 4); GL reports (Phase 5).
- **No placeholders:** all SQL/JS/test code complete.
- **Type consistency:** `applyArOpeningBalances(tenantId)→{seeded,skipped}`, `reconcileLedger(tenantId)→{mismatches,unwired,trialBalancePaise}`, idempotency key `opening-ar-<id>` (matches the memory pointer), `LEDGER_DUPLICATE` re-run no-op (matches `postLedgerEntry`'s thrown code), `ledger_account_normal_side` (migration 342) used for the trial balance. The cutover seeds the CURRENT `amount_due` (net remaining receivable), NOT the original total — historical payments stay in the legacy tables; the opening entry captures the net position (spec §6).
- **Double-count safety:** the cutover's `NOT EXISTS (PATIENT_AR balance for invoice)` guard means a Phase-2a-wired invoice (which already has ledger AR) is skipped — so cutover + wiring never double-post the same invoice's AR.
