# Money Ledger — Phase 3a (advances + payment reversal) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the three patient-side money movements to the ledger (post-commit best-effort, same as Phase 2a): `collectAdvance` (debit CASH|BANK / credit PATIENT_ADVANCE), `settleAdvance` (debit PATIENT_ADVANCE / credit PATIENT_AR), and `reversePayment` (a REVERSAL entry crediting CASH|BANK / debiting PATIENT_AR).

**Architecture:** Three new helpers in `ledgerPostings.js` (`postAdvanceCollectEntry`, `postAdvanceSettleEntry`, `postPaymentReversalEntry`), each opening its own `setTenantTx` + calling `postLedgerEntry`. Wired into `collectAdvance` / `settleAdvance` / `reversePayment` as post-commit best-effort (own try/catch after the legacy write) — a ledger problem never breaks the money path. Insurance/tax/refunds remain Phase 3b.

**Tech Stack:** Node 22 / PostgreSQL 17 / Prisma raw SQL; Phase 1 engine + Phase 2a/2b helpers (all on `main`). Jest deep tests on the `postgres` QA DB.

**Spec:** `docs/superpowers/specs/2026-06-23-double-entry-money-ledger-design.md` (§7 phase 2/3). Prior phases: `b1358af7` / `dc2c5d4c` / `1eae7186`.

---

## Conventions (read first)

- Branch `feat/money-ledger-phase3a`; commit per task; merge `--no-ff` + push BOTH remotes (`origin`=Forgejo, `github`=GitHub).
- Deep test: `DATABASE_URL="postgresql://postgres@127.0.0.1:55432/vhhealth_test" NODE_ENV=test node --experimental-vm-modules node_modules/jest/bin/jest.js <pattern> --forceExit` from `apps/backend`. **If "Can't reach database server" — run `node apps/backend/scripts/qa-cluster-up.mjs` (the QA DB idle-dies) and retry.**
- Full gate before merge: `node scripts/run-ci-jest.mjs` → `All chunks passed` + zero `FAIL src/`; arm a stall monitor.
- `npm run lint && npm run lint:raw-params` before each commit. No migrations.

## File Structure

- Modify `apps/backend/src/services/billing/ledger/ledgerPostings.js` — add `postAdvanceCollectEntry`, `postAdvanceSettleEntry`, `postPaymentReversalEntry`.
- Modify `apps/backend/src/services/billing/billingV2Service.js` — `collectAdvance`, `settleAdvance`, `reversePayment` call the helpers post-commit best-effort.
- Modify `apps/backend/src/tests/unit/ledgerPostings.test.js` — unit-cover the three new helpers' line shapes.
- Create `apps/backend/src/tests/money-ledger-advances-reversal.deep.test.js` — deep proof.

---

## Task 1: Three new posting helpers

**Files:**
- Modify: `apps/backend/src/services/billing/ledger/ledgerPostings.js` (append the three exports + reuse `paymentDebitAccount`)
- Modify: `apps/backend/src/tests/unit/ledgerPostings.test.js`

- [ ] **Step 1: Add the failing unit tests** (append inside the existing test file, after the `postPaymentEntry` describe)

```js
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

  it('skips reversal for an INSURANCE payment (its original was never posted)', async () => {
    const { postPaymentReversalEntry } = await import('../../services/billing/ledger/ledgerPostings.js');
    const before = postLedgerEntry.mock.calls.length;
    await postPaymentReversalEntry({ payment: { id: 10, patient_uid: PATIENT, invoice_id: 42, amount: '400.00', mode: 'INSURANCE' }, tenantId: TENANT });
    expect(postLedgerEntry.mock.calls.length).toBe(before);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `DATABASE_URL="postgresql://postgres@127.0.0.1:55432/vhhealth_test" NODE_ENV=test node --experimental-vm-modules node_modules/jest/bin/jest.js ledgerPostings.test --forceExit`
Expected: FAIL — `postAdvanceCollectEntry is not a function` (or undefined import).

- [ ] **Step 3: Append the implementation** to `ledgerPostings.js` (before the `export default`, after `postPaymentEntry`)

```js
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
```

- [ ] **Step 4: Update the `export default`** at the bottom of `ledgerPostings.js`:

```js
export default {
  paymentDebitAccount, postInvoiceIssueEntry, postPaymentEntry,
  postAdvanceCollectEntry, postAdvanceSettleEntry, postPaymentReversalEntry,
};
```

- [ ] **Step 5: Run + lint + commit**

```bash
cd apps/backend && DATABASE_URL="postgresql://postgres@127.0.0.1:55432/vhhealth_test" NODE_ENV=test node --experimental-vm-modules node_modules/jest/bin/jest.js ledgerPostings.test --forceExit
npx eslint src/services/billing/ledger/ledgerPostings.js src/tests/unit/ledgerPostings.test.js && npm run lint:raw-params && cd ../..
git add apps/backend/src/services/billing/ledger/ledgerPostings.js apps/backend/src/tests/unit/ledgerPostings.test.js
git commit -m "feat(ledger): advance-collect/settle + payment-reversal posting helpers"
```
Expected: the new unit tests pass; lint clean.

---

## Task 2: Wire `collectAdvance` (post-commit best-effort)

**Files:**
- Modify: `apps/backend/src/services/billing/billingV2Service.js` — `collectAdvance` (the `return rows[0];` at the end, ~line 1319).

- [ ] **Step 1: Add the helpers to the existing ledger import** (the Phase-2a import line):

```js
import {
  postInvoiceIssueEntry, postPaymentEntry,
  postAdvanceCollectEntry, postAdvanceSettleEntry, postPaymentReversalEntry,
} from './ledger/ledgerPostings.js';
```

- [ ] **Step 2: Replace `return rows[0];` at the end of `collectAdvance`** with:

```js
  const advance = rows[0];
  try {
    await postAdvanceCollectEntry({ advance, tenantId: tenant });
  } catch (ledgerErr) {
    logger.error('Ledger ADVANCE_COLLECT post failed (non-blocking)', { advance_id: advance?.id, error: ledgerErr.message });
  }
  return advance;
```

(`tenant` is the resolved `requireTenantId(normalizeTenantId(tenantId))` computed earlier in the function.)

- [ ] **Step 3: Lint + commit**

```bash
cd apps/backend && npx eslint src/services/billing/billingV2Service.js && cd ../..
git add apps/backend/src/services/billing/billingV2Service.js
git commit -m "feat(ledger): wire collectAdvance -> post-commit ADVANCE_COLLECT (best-effort)"
```

---

## Task 3: Wire `settleAdvance` (post-commit best-effort)

**Files:**
- Modify: `apps/backend/src/services/billing/billingV2Service.js` — `settleAdvance` (the `return setTenantTx(...)` block, ~lines 1337-1413).

- [ ] **Step 1: Capture patient_uid + post after the tx.** Change the function so it stores the settlement + patient_uid and posts post-commit:

Change the opening `return setTenantTx(...)` to `let settledPatientUid = null;` + `const settlement = await setTenantTx(...)`, capture `settledPatientUid = inv.patient_uid;` right after the patient-mismatch check, and replace the final `return settlement[0];` (inside the callback) so the callback returns `settlement[0]`. Then after the `setTenantTx(...)` call add:

```js
  try {
    await postAdvanceSettleEntry({
      settlement, patientUid: settledPatientUid, tenantId: requireTenantId(tenantId),
    });
  } catch (ledgerErr) {
    logger.error('Ledger ADVANCE_SETTLE post failed (non-blocking)', { settlement_id: settlement?.id, error: ledgerErr.message });
  }
  return settlement;
```

Concretely, the function becomes:
```js
export async function settleAdvance({ tenantId, advance_id, invoice_id, amount, settled_by }) {
  if (Number(amount) <= 0) throw AppError.badRequest('amount must be > 0');
  let settledPatientUid = null;
  const settlement = await setTenantTx(requireTenantId(tenantId), async (tx) => {
    // ... unchanged advance lock + checks ...
    // after the invoice lock + patient-match check:
    settledPatientUid = inv.patient_uid;
    // ... unchanged settlement INSERT + balance decrement + invoice recompute ...
    return settlementRow[0]; // (the existing `settlement[0]` — renamed local to avoid shadowing)
  });
  try {
    await postAdvanceSettleEntry({ settlement, patientUid: settledPatientUid, tenantId: requireTenantId(tenantId) });
  } catch (ledgerErr) {
    logger.error('Ledger ADVANCE_SETTLE post failed (non-blocking)', { settlement_id: settlement?.id, error: ledgerErr.message });
  }
  return settlement;
}
```
To avoid the name clash (the inner `const settlement = await tx...INSERT`), rename the INNER insert result to `settlementRow` and have the callback `return settlementRow[0];`. The OUTER `settlement` is then the row object.

- [ ] **Step 2: Lint + commit**

```bash
cd apps/backend && npx eslint src/services/billing/billingV2Service.js && cd ../..
git add apps/backend/src/services/billing/billingV2Service.js
git commit -m "feat(ledger): wire settleAdvance -> post-commit ADVANCE_SETTLE (best-effort)"
```

---

## Task 4: Wire `reversePayment` (post-commit best-effort)

**Files:**
- Modify: `apps/backend/src/services/billing/billingV2Service.js` — `reversePayment` (the `return setTenantTx(...)` block ending ~line 1295).

- [ ] **Step 1: Post after the tx.** Change `return setTenantTx(...)` to `const reversed = await setTenantTx(...)` (callback unchanged, still returns `rows[0]`), then:

```js
  try {
    await postPaymentReversalEntry({ payment: reversed, tenantId: requireTenantId(tenantId) });
  } catch (ledgerErr) {
    logger.error('Ledger PAYMENT_REVERSAL post failed (non-blocking)', { payment_id: reversed?.id, error: ledgerErr.message });
  }
  return reversed;
```

- [ ] **Step 2: Lint + commit**

```bash
cd apps/backend && npx eslint src/services/billing/billingV2Service.js && cd ../..
git add apps/backend/src/services/billing/billingV2Service.js
git commit -m "feat(ledger): wire reversePayment -> post-commit PAYMENT_REVERSAL (best-effort)"
```

---

## Task 5: Deep test — advance lifecycle + reversal mirror the ledger

**Files:**
- Create: `apps/backend/src/tests/money-ledger-advances-reversal.deep.test.js`

- [ ] **Step 1: Write the failing deep test**

```js
// apps/backend/src/tests/money-ledger-advances-reversal.deep.test.js
import { randomUUID } from 'node:crypto';
import prisma, { setTenantTx } from '../lib/prisma.js';
import * as billing from '../services/billing/billingV2Service.js';
import { getAccountBalancePaise } from '../services/billing/ledger/ledgerService.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const cleanup = { invoiceIds: [], advanceIds: [], patientUids: [] };

async function makePatient() {
  const uid = randomUUID();
  const phone = `9${Math.floor(100000000 + Math.random() * 899999999)}`;
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (uid, phone, name, role, tenant_id, updated_at) VALUES ($1::uuid,$2,'Adv Test','PATIENT',$3::uuid,NOW())`,
    uid, phone, TENANT,
  );
  cleanup.patientUids.push(uid);
  return uid;
}
async function makeDraftInvoice(patientUid, total) {
  const inv = await billing.createDraftInvoice({ patient_uid: patientUid, invoice_type: 'OP', tenantId: TENANT });
  await billing.addInvoiceItem(inv.id, { description: 'Consult', quantity: 1, unit_price: total, gst_rate: 0, tenantId: TENANT });
  cleanup.invoiceIds.push(inv.id);
  return inv.id;
}
const bal = (code, dims) => setTenantTx(TENANT, (tx) => getAccountBalancePaise(tx, code, dims));

afterAll(async () => {
  try {
    if (cleanup.invoiceIds.length) {
      await prisma.$executeRawUnsafe(`DELETE FROM billing_advance_settlements WHERE invoice_id = ANY($1::int[])`, cleanup.invoiceIds);
      await prisma.$executeRawUnsafe(`DELETE FROM billing_payments WHERE invoice_id = ANY($1::int[])`, cleanup.invoiceIds);
      await prisma.$executeRawUnsafe(`DELETE FROM billing_invoice_items WHERE invoice_id = ANY($1::int[])`, cleanup.invoiceIds);
      await prisma.$executeRawUnsafe(`DELETE FROM billing_invoices WHERE id = ANY($1::int[])`, cleanup.invoiceIds);
    }
    if (cleanup.advanceIds.length) await prisma.$executeRawUnsafe(`DELETE FROM billing_advances WHERE id = ANY($1::int[])`, cleanup.advanceIds);
    if (cleanup.patientUids.length) await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = ANY($1::uuid[])`, cleanup.patientUids);
  } catch { /* best-effort */ }
  await prisma.$disconnect().catch(() => {});
});

describe('Phase 3a — advances + reversal', () => {
  it('collectAdvance credits PATIENT_ADVANCE; settleAdvance moves it to PATIENT_AR', async () => {
    const patient = await makePatient();
    const invoiceId = await makeDraftInvoice(patient, 1000);
    await billing.issueInvoice(invoiceId, { tenantId: TENANT }); // AR = 100000

    const adv = await billing.collectAdvance({ patient_uid: patient, amount: 1000, mode: 'CASH', tenantId: TENANT });
    cleanup.advanceIds.push(adv.id);
    expect(await bal('PATIENT_ADVANCE', { advance_id: adv.id })).toBe(100000); // liability +₹1000

    await billing.settleAdvance({ tenantId: TENANT, advance_id: adv.id, invoice_id: invoiceId, amount: 400 });
    expect(await bal('PATIENT_ADVANCE', { advance_id: adv.id })).toBe(60000); // ₹600 left
    expect(await bal('PATIENT_AR', { patient_uid: patient, invoice_id: invoiceId })).toBe(60000); // AR 100000-40000
  });

  it('reversePayment restores PATIENT_AR (credits CASH back)', async () => {
    const patient = await makePatient();
    const invoiceId = await makeDraftInvoice(patient, 500);
    await billing.issueInvoice(invoiceId, { tenantId: TENANT }); // AR 50000
    const pay = await billing.collectPayment({ invoice_id: invoiceId, amount: 200, mode: 'CASH', shift: 'MORNING', collected_by: patient, tenantId: TENANT });
    expect(await bal('PATIENT_AR', { patient_uid: patient, invoice_id: invoiceId })).toBe(30000); // 50000-20000

    await billing.reversePayment(pay.id, { reversed_by: patient, reason: 'test reversal', tenantId: TENANT });
    expect(await bal('PATIENT_AR', { patient_uid: patient, invoice_id: invoiceId })).toBe(50000); // restored
  });
});
```

- [ ] **Step 2: Run to verify it passes**

Run: `DATABASE_URL="postgresql://postgres@127.0.0.1:55432/vhhealth_test" NODE_ENV=test node --experimental-vm-modules node_modules/jest/bin/jest.js money-ledger-advances-reversal --forceExit`
Expected: PASS. If a balance is off, check the wiring captured the right ids; if "Can't reach database server", revive the QA DB and retry.

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/tests/money-ledger-advances-reversal.deep.test.js
git commit -m "test(ledger): deep proof advance collect/settle + payment reversal mirror the ledger"
```

---

## Task 6: Full gate + merge

- [ ] **Step 1: lint sweep** — `cd apps/backend && npm run lint && npm run lint:raw-params && cd ../..` → clean.
- [ ] **Step 2: Full gate** — `cd apps/backend && DATABASE_URL="postgresql://postgres@127.0.0.1:55432/vhhealth_test" NODE_ENV=test node scripts/run-ci-jest.mjs 2>&1 | tee /tmp/ledger-p3a-gate.log; cd ../..` → `All chunks passed`, zero `FAIL src/`. Arm a stall monitor; revive the QA DB if it idle-died. **Watch the existing advance/refund billing deep tests** — they now exercise the post-commit hooks (best-effort, so they must stay green).
- [ ] **Step 3: Merge + push both remotes**

```bash
git checkout main
git merge --no-ff feat/money-ledger-phase3a -m "Merge money ledger Phase 3a: wire advances + payment reversal (post-commit best-effort)"
git push origin main && git push github main
git branch -d feat/money-ledger-phase3a
```

- [ ] **Step 4: Update ROADMAP + memory** — tick Phase 3a; note Phase 3b (refunds + insurance + tax + markPaymentLinkPaid tx-path) next.

---

## Self-review (plan-author)

- **Spec coverage:** §7 phase-3 advances + reversal → Tasks 1–5. **Deferred to Phase 3b:** refunds (REFUNDS_PAYABLE counter-account design), insurance settlements (INSURANCE_AR), GST/tax (TAX_PAYABLE at issuance), the `markPaymentLinkPaid` `tx`-passed `collectPayment` path. **Phase 4:** flip authoritative.
- **No placeholders:** all code complete. (Task 3 describes the rename `settlement`→`settlementRow` to avoid shadowing — the only structural edit; the executor must apply it carefully and keep the existing advance-lock/decrement/recompute logic byte-identical.)
- **Type consistency:** `postAdvanceCollectEntry({advance:{id,patient_uid,amount,mode}, tenantId})`, `postAdvanceSettleEntry({settlement:{id,advance_id,invoice_id,amount}, patientUid, tenantId})`, `postPaymentReversalEntry({payment:{id,patient_uid,invoice_id,amount,mode}, tenantId})`; idempotency keys `advance-<id>` / `advance-settle-<id>` / `payment-reversal-<id>`; reuses `paymentDebitAccount` + `toPaise`.
- **Accounting sanity:** advance is a credit-normal liability — collect credits it (normal balance +), settle debits it (normal balance −, ≥0 since settle ≤ balance). reversal restores AR (debit, ≥0) and credits CASH (CASH is unconstrained so it may legitimately go negative if the drawer was already emptied). settle credits PATIENT_AR ≤ amount_due ⇒ AR stays ≥0 (when the invoice AR is present).
- **Graceful degradation:** settling against an unwired invoice (no ledger AR) or an unwired advance (no ledger PATIENT_ADVANCE) trips the no-negative trigger on the best-effort post → logged, reconciliation flags. Legacy path unaffected.
