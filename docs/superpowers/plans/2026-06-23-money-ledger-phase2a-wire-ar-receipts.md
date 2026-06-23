# Money Ledger — Phase 2a (wire AR + cash receipts) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the two core money movements — `issueInvoice` (debit PATIENT_AR / credit REVENUE) and `collectPayment` (debit CASH|BANK / credit PATIENT_AR) — to post balanced ledger entries as **post-commit best-effort** side-effects, so the ledger mirrors the legacy billing tables without ever being able to break the live money path.

**Architecture:** The ledger post is the codebase's "Phase 1.5 post-commit best-effort" pattern (see CLAUDE.md, `markForDischarge`/`dischargePatient`/`collectAdvanceDeposit`): after the legacy `setTenantTx` commits, a separate `try/catch` opens its own `setTenantTx` and calls `postLedgerEntry` (Phase 1 chokepoint). A ledger failure is logged and dropped — the legacy write already committed. Reconciliation (Phase 2b) catches any resulting drift. The ledger is NOT yet authoritative (that's Phase 4).

**Tech Stack:** Node 22 / Express 5 / PostgreSQL 17 / Prisma raw SQL; the Phase 1 ledger engine (`src/services/billing/ledger/ledgerService.js`, `src/utils/money.js`); Jest deep tests on the `postgres`-connected QA DB.

**Spec:** `docs/superpowers/specs/2026-06-23-double-entry-money-ledger-design.md` (§5, §7 phase 2). Phase 1 substrate is on `main` (`b1358af7`).

---

## Conventions for the implementer (read first)

- Branch `feat/money-ledger-phase2a`; commit per task; merge `--no-ff` to main + push BOTH remotes (`origin`=Forgejo, `github`=GitHub) at the end.
- Targeted deep test: `DATABASE_URL="postgresql://postgres@127.0.0.1:55432/vhhealth_test" NODE_ENV=test node --experimental-vm-modules node_modules/jest/bin/jest.js <pattern> --forceExit` from `apps/backend`.
- Full gate before merge: `DATABASE_URL="postgresql://postgres@127.0.0.1:55432/vhhealth_test" NODE_ENV=test node scripts/run-ci-jest.mjs` → scan `All chunks passed` + zero `FAIL src/`. Arm a stall-aware monitor.
- `npm run lint && npm run lint:raw-params` before each commit.
- No migrations in this phase (the Phase 1 schema is sufficient).

## File Structure

- Create `apps/backend/src/services/billing/ledger/ledgerPostings.js` — the two movement-specific posting helpers (`postInvoiceIssueEntry`, `postPaymentEntry`); each opens its own `setTenantTx` and calls `postLedgerEntry`. Pure functions of their inputs; throw on failure (caller wraps in try/catch).
- Modify `apps/backend/src/services/billing/billingV2Service.js` — `issueInvoice` (after the ISSUED update) and `collectPayment` (after the tx returns) call the helpers in a best-effort `try/catch`.
- Create `apps/backend/src/tests/money-ledger-ar-receipts.deep.test.js` — deep test: issue → pay → assert ledger balances mirror the legacy AR.
- Create `apps/backend/src/tests/unit/ledgerPostings.test.js` — unit test the mode→account mapping + line construction with a mocked `postLedgerEntry`.

---

## Task 1: `ledgerPostings.js` — movement → balanced-entry mapping

**Files:**
- Create: `apps/backend/src/services/billing/ledger/ledgerPostings.js`
- Test: `apps/backend/src/tests/unit/ledgerPostings.test.js`

- [ ] **Step 1: Write the failing unit test**

```js
// apps/backend/src/tests/unit/ledgerPostings.test.js
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
  it('posts debit PATIENT_AR / credit REVENUE for the invoice total', async () => {
    await postInvoiceIssueEntry({
      invoice: { id: 42, patient_uid: PATIENT, total_amount: '1000.00' }, tenantId: TENANT,
    });
    expect(postLedgerEntry).toHaveBeenCalledTimes(1);
    const arg = postLedgerEntry.mock.calls[0][1];
    expect(arg.entryType).toBe('INVOICE_ISSUE');
    expect(arg.idempotencyKey).toBe('issue-inv-42');
    expect(arg.lines).toEqual(expect.arrayContaining([
      { accountCode: 'PATIENT_AR', amountPaise: 100000, patient_uid: PATIENT, invoice_id: 42 },
      { accountCode: 'REVENUE', amountPaise: -100000 },
    ]));
  });

  it('does not post for a zero-total invoice', async () => {
    await postInvoiceIssueEntry({ invoice: { id: 7, patient_uid: PATIENT, total_amount: '0.00' }, tenantId: TENANT });
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `DATABASE_URL="postgresql://postgres@127.0.0.1:55432/vhhealth_test" NODE_ENV=test node --experimental-vm-modules node_modules/jest/bin/jest.js ledgerPostings.test --forceExit`
Expected: FAIL — `Cannot find module '.../ledgerPostings.js'`.

- [ ] **Step 3: Write the implementation**

```js
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

export default { paymentDebitAccount, postInvoiceIssueEntry, postPaymentEntry };
```

- [ ] **Step 4: Run to verify it passes**

Run: `DATABASE_URL="postgresql://postgres@127.0.0.1:55432/vhhealth_test" NODE_ENV=test node --experimental-vm-modules node_modules/jest/bin/jest.js ledgerPostings.test --forceExit`
Expected: PASS (all cases). Note: the `arrayContaining` on the CASH line includes `cash_drawer_session_id: 5`; the helper adds it only when present — matches.

- [ ] **Step 5: Lint + commit**

```bash
cd apps/backend && npx eslint src/services/billing/ledger/ledgerPostings.js src/tests/unit/ledgerPostings.test.js && npm run lint:raw-params && cd ../..
git add apps/backend/src/services/billing/ledger/ledgerPostings.js apps/backend/src/tests/unit/ledgerPostings.test.js
git commit -m "feat(ledger): movement->entry posting helpers (issue/payment)"
```

---

## Task 2: Wire `issueInvoice` (post-commit best-effort)

**Files:**
- Modify: `apps/backend/src/services/billing/billingV2Service.js` — `issueInvoice` (the `return getInvoice(...)` at the end of the function, ~line 747).

- [ ] **Step 1: Add the import** (top of billingV2Service.js, with the other local imports)

```js
import { postInvoiceIssueEntry, postPaymentEntry } from './ledger/ledgerPostings.js';
```

- [ ] **Step 2: Post the AR entry after the ISSUED update, before the return**

Find, near the end of `issueInvoice` (after the `maybeEmitTpaCapAlerts` block, before `return getInvoice(invoiceId, { tenantId });`):

```js
  // Ledger (Phase 2a): post-commit best-effort INVOICE_ISSUE entry (debit
  // PATIENT_AR / credit REVENUE). The legacy invoice is already ISSUED — a
  // ledger failure is logged and dropped, never blocking issuance. The ledger
  // is not yet authoritative; reconciliation (Phase 2b) catches any drift.
  if (meta.length && meta[0].patient_uid) {
    try {
      await postInvoiceIssueEntry({
        invoice: { id: invoiceId, patient_uid: meta[0].patient_uid, total_amount: meta[0].total_amount },
        tenantId: meta[0].tenant_id,
      });
    } catch (ledgerErr) {
      logger.error('Ledger INVOICE_ISSUE post failed (non-blocking)', { invoice_id: invoiceId, error: ledgerErr.message });
    }
  }

  return getInvoice(invoiceId, { tenantId });
```

(The `meta` query already selects `admission_id, patient_uid, tenant_id, total_amount` — reuse it.)

- [ ] **Step 3: Lint**

Run: `cd apps/backend && npx eslint src/services/billing/billingV2Service.js && cd ../..`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/services/billing/billingV2Service.js
git commit -m "feat(ledger): wire issueInvoice -> post-commit AR entry (best-effort)"
```

---

## Task 3: Wire `collectPayment` (post-commit best-effort)

**Files:**
- Modify: `apps/backend/src/services/billing/billingV2Service.js` — `collectPayment` (the return at ~line 1237).

- [ ] **Step 1: Capture the committed payment, then post after the tx**

Replace the tail of `collectPayment` (the `if (tx) return collectPaymentTx(tx, args); return setTenantTx(...)` block) with:

```js
  // Reuse the caller's transaction when given (e.g. markPaymentLinkPaid). When
  // we own the tx, post the ledger entry AFTER it commits (post-commit
  // best-effort) so a ledger problem can't roll back the real payment.
  if (tx) return collectPaymentTx(tx, args);
  const payment = await setTenantTx(requireTenantId(tenantId), (innerTx) => collectPaymentTx(innerTx, args));
  try {
    await postPaymentEntry({ payment, tenantId: requireTenantId(tenantId) });
  } catch (ledgerErr) {
    logger.error('Ledger PAYMENT post failed (non-blocking)', { payment_id: payment?.id, error: ledgerErr.message });
  }
  return payment;
```

(When `tx` is passed in by a caller that owns the transaction, that caller is responsible for its own ledger posting in a later phase; Phase 2a only wires the self-owned-tx path. The `markPaymentLinkPaid` path is covered when we wire it in Phase 2b/3.)

- [ ] **Step 2: Lint**

Run: `cd apps/backend && npx eslint src/services/billing/billingV2Service.js && cd ../..`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/services/billing/billingV2Service.js
git commit -m "feat(ledger): wire collectPayment -> post-commit PAYMENT entry (best-effort)"
```

---

## Task 4: Deep test — the ledger mirrors legacy AR through issue → pay

**Files:**
- Create: `apps/backend/src/tests/money-ledger-ar-receipts.deep.test.js`

- [ ] **Step 1: Write the failing deep test**

```js
// apps/backend/src/tests/money-ledger-ar-receipts.deep.test.js
//
// Phase 2a: prove issueInvoice + collectPayment post-commit ledger entries that
// mirror the legacy billing_invoices AR. Real DB (no mocks).
import { randomUUID } from 'node:crypto';
import prisma, { setTenantTx } from '../lib/prisma.js';
import * as billing from '../services/billing/billingV2Service.js';
import { getAccountBalancePaise } from '../services/billing/ledger/ledgerService.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const cleanup = { invoiceIds: [], patientUids: [] };

async function makePatient() {
  const uid = randomUUID();
  const phone = `9${Math.floor(100000000 + Math.random() * 899999999)}`;
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (uid, phone, name, role, tenant_id, updated_at) VALUES ($1::uuid,$2,'Ledger AR Test','PATIENT',$3::uuid,NOW())`,
    uid, phone, TENANT,
  );
  cleanup.patientUids.push(uid);
  return uid;
}

// Create a DRAFT invoice with one item so issueInvoice can transition it.
async function makeDraftInvoice(patientUid, total) {
  const inv = await billing.createDraftInvoice({ patient_uid: patientUid, invoice_type: 'OP', tenantId: TENANT });
  await billing.addInvoiceItem(inv.id, { description: 'Consult', quantity: 1, unit_price: total, gst_rate: 0, tenantId: TENANT });
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
    if (cleanup.patientUids.length) {
      await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = ANY($1::uuid[])`, cleanup.patientUids);
    }
  } catch { /* best-effort teardown */ }
  await prisma.$disconnect().catch(() => {});
});

const arBalance = (invoiceId, patientUid) =>
  setTenantTx(TENANT, (tx) => getAccountBalancePaise(tx, 'PATIENT_AR', { patient_uid: patientUid, invoice_id: invoiceId }));

describe('Phase 2a — ledger mirrors legacy AR', () => {
  it('issueInvoice posts AR; collectPayment reduces it; ledger == legacy amount_due', async () => {
    const patient = await makePatient();
    const invoiceId = await makeDraftInvoice(patient, 1000); // ₹1000

    await billing.issueInvoice(invoiceId, { tenantId: TENANT });
    // ledger AR for this invoice = 100000 paise (debit)
    expect(await arBalance(invoiceId, patient)).toBe(100000);

    // pay ₹400 cash
    await billing.collectPayment({
      invoice_id: invoiceId, amount: 400, mode: 'CASH', shift: 'MORNING', collected_by: patient, tenantId: TENANT,
    });
    expect(await arBalance(invoiceId, patient)).toBe(60000); // 100000 - 40000

    // ledger CASH debit = 40000
    const cash = await setTenantTx(TENANT, (tx) => getAccountBalancePaise(tx, 'CASH'));
    expect(cash).toBeGreaterThanOrEqual(40000);

    // ledger AR (60000 paise = ₹600.00) matches the legacy invoice amount_due
    const inv = await prisma.$queryRawUnsafe(`SELECT amount_due FROM billing_invoices WHERE id=$1::int`, invoiceId);
    expect(Math.round(Number(inv[0].amount_due) * 100)).toBe(60000);
  });
});
```

- [ ] **Step 2: Run to verify it passes**

Run: `DATABASE_URL="postgresql://postgres@127.0.0.1:55432/vhhealth_test" NODE_ENV=test node --experimental-vm-modules node_modules/jest/bin/jest.js money-ledger-ar-receipts --forceExit`
Expected: PASS. If AR balance is 0 after issue, the post-commit hook didn't fire — verify Task 2's block runs (the `meta` row has `patient_uid`). If `collectPayment` signature differs (e.g. `createDraftInvoice`/`addInvoiceItem` param names), adjust the test's fixture calls to match the real signatures (read them in billingV2Service.js) — the fixture is test scaffolding, not the behaviour under test.

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/tests/money-ledger-ar-receipts.deep.test.js
git commit -m "test(ledger): deep proof issueInvoice+collectPayment mirror legacy AR"
```

---

## Task 5: Full gate + merge

- [ ] **Step 1: lint sweep**

Run: `cd apps/backend && npm run lint && npm run lint:raw-params && cd ../..`
Expected: clean.

- [ ] **Step 2: Full authoritative gate**

Run: `cd apps/backend && DATABASE_URL="postgresql://postgres@127.0.0.1:55432/vhhealth_test" NODE_ENV=test node scripts/run-ci-jest.mjs 2>&1 | tee /tmp/ledger-p2a-gate.log; cd ../..`
Expected: `All chunks passed`, zero `FAIL src/`. Arm a stall-aware monitor. **Watch especially** the existing billing deep tests (`billing-money-path-concurrency-deep`, `billing-ward-indent-itemize-d58`) — they exercise `collectPayment`/`issueInvoice` and will now also exercise the post-commit ledger hook; they must stay green (the hook is best-effort, so even a ledger issue shouldn't fail them — but a thrown error escaping the try/catch would).

- [ ] **Step 3: Merge + push both remotes**

```bash
git checkout main
git merge --no-ff feat/money-ledger-phase2a -m "Merge money ledger Phase 2a: wire issueInvoice + collectPayment to the ledger (post-commit best-effort)"
git push origin main && git push github main
git branch -d feat/money-ledger-phase2a
```

- [ ] **Step 4: Update ROADMAP + memory**

Tick Phase 2a in `docs/ROADMAP.md §0` (ledger epic) and update `project_vh_health_money_ledger` memory; note Phase 2b (opening-balance cutover script + reconciliation cron) as next.

---

## Self-review (plan-author)

- **Spec coverage:** §5 dual-write (post-commit best-effort variant, justified by the live-money-path safety argument + CLAUDE.md Phase-1.5 precedent) → Tasks 2/3; movement→entry mapping → Task 1; the mirror proof → Task 4. **Deferred to Phase 2b (explicitly):** opening-balance cutover (§6), reconciliation job (§5). **Deferred to Phase 3:** advances/refunds/insurance/tax movements; the `tx`-passed-in `collectPayment` path (markPaymentLinkPaid). **Deferred to Phase 4:** flip to same-tx atomic + authoritative.
- **Deviation from spec, called out:** spec §5 said "same tx"; this phase posts post-commit best-effort during the strangler so a ledger gap/bug cannot break the live money path (the spec's same-tx is the Phase-4 end state). Documented in the architecture header + the code comments.
- **No placeholders:** all code complete.
- **Type consistency:** `postInvoiceIssueEntry({invoice:{id,patient_uid,total_amount}, tenantId})`, `postPaymentEntry({payment:{id,patient_uid,invoice_id,amount,mode,cash_drawer_session_id,reversed}, tenantId})`, `paymentDebitAccount(mode)`, idempotency keys `issue-inv-<id>` / `payment-<id>` — consistent across Task 1 impl, the wiring in Tasks 2/3, and the Task 4 assertions.
- **Known edge:** a payment whose invoice's AR was never posted (issue hook failed, or pre-cutover invoice) will trip the no-negative trigger on the best-effort post → logged, reconciliation flags it. The legacy path is unaffected. This is the intended graceful-degradation during the strangler.
