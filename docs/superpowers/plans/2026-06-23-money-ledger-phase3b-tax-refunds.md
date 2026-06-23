# Money Ledger — Phase 3b (GST tax split + refunds) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** (1) Split GST out of the issuance posting — debit PATIENT_AR=total / credit REVENUE=(total−tax) / credit TAX_PAYABLE=tax — so the GL separates net revenue from tax owed. (2) Wire the refund lifecycle post-commit best-effort: `approveRefund` recognises the liability (credit REFUNDS_PAYABLE / debit PATIENT_AR|PATIENT_ADVANCE) and `markRefundPaid` pays it out (debit REFUNDS_PAYABLE / credit CASH|BANK).

**Architecture:** Extend `postInvoiceIssueEntry` to take the invoice tax total and emit the 2- or 3-line split. Add `postRefundApproveEntry` + `postRefundPaidEntry` to `ledgerPostings.js`. Wire them post-commit best-effort (own try/catch after the legacy write) into `issueInvoice` (already posts; just pass tax), `approveRefund` (plain update → post after), `markRefundPaid` (setTenantTx → post after). Insurance/INSURANCE-mode deferred to Phase 3c.

**Accounting decisions (documented):**
- Tax: `REVENUE = total − tax` (absorbs discount); `TAX_PAYABLE = cgst+sgst+igst`; the TAX_PAYABLE line is omitted when tax is 0 (postLedgerEntry rejects zero lines), keeping no-GST invoices identical to Phase 2a.
- Refund = reverse-a-receipt: approve credits the REFUNDS_PAYABLE staging liability and debits the source (PATIENT_AR restores the receivable for an invoice refund; PATIENT_ADVANCE reduces the unused-advance liability for an advance refund); pay debits REFUNDS_PAYABLE and credits CASH|BANK. Net = receivable/advance restored, cash out (consistent with `reversePayment`). REFUNDS_PAYABLE is in the no-negative constrained set, so it stays ≥0 (approve precedes pay).

**Tech Stack:** Node 22 / PostgreSQL 17 / Prisma raw SQL; the Phase 1–3a ledger (all on `main`). Jest deep tests on the `postgres` QA DB.

**Spec:** `docs/superpowers/specs/2026-06-23-double-entry-money-ledger-design.md` (§3.1 accounts, §7 phase 3). Prior: `b1358af7`/`dc2c5d4c`/`1eae7186`/`aeab243d`.

---

## Conventions (read first)

- Branch `feat/money-ledger-phase3b`; commit per task; merge `--no-ff` + push BOTH remotes (`origin`=Forgejo, `github`=GitHub).
- Deep test: `DATABASE_URL="postgresql://postgres@127.0.0.1:55432/vhhealth_test" NODE_ENV=test node --experimental-vm-modules node_modules/jest/bin/jest.js <pattern> --forceExit` from `apps/backend`. **QA DB idle-dies — if "Can't reach database server", run `node apps/backend/scripts/qa-cluster-up.mjs` and retry.**
- Full gate: `node scripts/run-ci-jest.mjs` → `All chunks passed` + zero `FAIL src/` (89 chunks now). Arm a stall monitor (use `Chunk [0-9]+/89`).
- `npm run lint && npm run lint:raw-params` before each commit. No migrations.

## File Structure

- Modify `apps/backend/src/services/billing/ledger/ledgerPostings.js` — extend `postInvoiceIssueEntry` (tax split); add `postRefundApproveEntry`, `postRefundPaidEntry`.
- Modify `apps/backend/src/services/billing/billingV2Service.js` — `issueInvoice` (pass tax to the helper + extend the `meta` query), `approveRefund` (post-commit), `markRefundPaid` (post-commit).
- Modify `apps/backend/src/tests/unit/ledgerPostings.test.js` — tax split + refund helper shapes.
- Create `apps/backend/src/tests/money-ledger-tax-refunds.deep.test.js`.

---

## Task 1: Tax split in `postInvoiceIssueEntry` + the two refund helpers

**Files:**
- Modify: `apps/backend/src/services/billing/ledger/ledgerPostings.js`
- Modify: `apps/backend/src/tests/unit/ledgerPostings.test.js`

- [ ] **Step 1: Update the existing `postInvoiceIssueEntry` unit test + add the new-helper tests.**

Replace the existing `postInvoiceIssueEntry` describe block with:
```js
describe('postInvoiceIssueEntry', () => {
  it('posts debit PATIENT_AR / credit REVENUE for a no-tax invoice (unchanged)', async () => {
    await postInvoiceIssueEntry({
      invoice: { id: 42, patient_uid: PATIENT, total_amount: '1000.00', tax_amount: '0.00' }, tenantId: TENANT,
    });
    const arg = postLedgerEntry.mock.calls[0][1];
    expect(arg.entryType).toBe('INVOICE_ISSUE');
    expect(arg.idempotencyKey).toBe('issue-inv-42');
    expect(arg.lines).toEqual([
      { accountCode: 'PATIENT_AR', amountPaise: 100000, patient_uid: PATIENT, invoice_id: 42 },
      { accountCode: 'REVENUE', amountPaise: -100000 },
    ]);
  });

  it('splits tax into TAX_PAYABLE for a GST invoice', async () => {
    // total 1180 = subtotal 1000 + 18% GST 180
    await postInvoiceIssueEntry({
      invoice: { id: 43, patient_uid: PATIENT, total_amount: '1180.00', tax_amount: '180.00' }, tenantId: TENANT,
    });
    const arg = postLedgerEntry.mock.calls.at(-1)[1];
    expect(arg.lines).toEqual([
      { accountCode: 'PATIENT_AR', amountPaise: 118000, patient_uid: PATIENT, invoice_id: 43 },
      { accountCode: 'REVENUE', amountPaise: -100000 },   // total - tax
      { accountCode: 'TAX_PAYABLE', amountPaise: -18000 },
    ]);
  });

  it('does not post for a zero-total invoice', async () => {
    await postInvoiceIssueEntry({ invoice: { id: 7, patient_uid: PATIENT, total_amount: '0.00', tax_amount: '0.00' }, tenantId: TENANT });
    expect(postLedgerEntry).not.toHaveBeenCalled();
  });
});
```

Add after the `postPaymentReversalEntry` describe block:
```js
describe('postRefundApproveEntry', () => {
  it('invoice refund: debit PATIENT_AR / credit REFUNDS_PAYABLE', async () => {
    const { postRefundApproveEntry } = await import('../../services/billing/ledger/ledgerPostings.js');
    await postRefundApproveEntry({ refund: { id: 5, patient_uid: PATIENT, invoice_id: 42, advance_id: null, amount: '400.00' }, tenantId: TENANT });
    const arg = postLedgerEntry.mock.calls.at(-1)[1];
    expect(arg.entryType).toBe('REFUND_APPROVE');
    expect(arg.idempotencyKey).toBe('refund-approve-5');
    expect(arg.lines).toEqual(expect.arrayContaining([
      { accountCode: 'PATIENT_AR', amountPaise: 40000, patient_uid: PATIENT, invoice_id: 42 },
      { accountCode: 'REFUNDS_PAYABLE', amountPaise: -40000, patient_uid: PATIENT },
    ]));
  });
  it('advance refund: debit PATIENT_ADVANCE / credit REFUNDS_PAYABLE', async () => {
    const { postRefundApproveEntry } = await import('../../services/billing/ledger/ledgerPostings.js');
    await postRefundApproveEntry({ refund: { id: 6, patient_uid: PATIENT, invoice_id: null, advance_id: 3, amount: '250.00' }, tenantId: TENANT });
    const arg = postLedgerEntry.mock.calls.at(-1)[1];
    expect(arg.lines).toEqual(expect.arrayContaining([
      { accountCode: 'PATIENT_ADVANCE', amountPaise: 25000, advance_id: 3, patient_uid: PATIENT },
      { accountCode: 'REFUNDS_PAYABLE', amountPaise: -25000, patient_uid: PATIENT },
    ]));
  });
});

describe('postRefundPaidEntry', () => {
  it('debit REFUNDS_PAYABLE / credit CASH|BANK', async () => {
    const { postRefundPaidEntry } = await import('../../services/billing/ledger/ledgerPostings.js');
    await postRefundPaidEntry({ refund: { id: 5, patient_uid: PATIENT, amount: '400.00', mode: 'CASH' }, tenantId: TENANT });
    const arg = postLedgerEntry.mock.calls.at(-1)[1];
    expect(arg.entryType).toBe('REFUND_PAID');
    expect(arg.idempotencyKey).toBe('refund-paid-5');
    expect(arg.lines).toEqual(expect.arrayContaining([
      { accountCode: 'REFUNDS_PAYABLE', amountPaise: 40000, patient_uid: PATIENT },
      { accountCode: 'CASH', amountPaise: -40000 },
    ]));
  });
});
```

- [ ] **Step 2: Run to verify failure** — `... jest.js ledgerPostings.test --forceExit` → the tax-split + refund tests fail.

- [ ] **Step 3: Edit `postInvoiceIssueEntry`** (replace the existing function) and **append the two refund helpers** before `export default`:

```js
/** Post INVOICE_ISSUE: debit PATIENT_AR=total / credit REVENUE=(total−tax) / credit TAX_PAYABLE=tax. */
export async function postInvoiceIssueEntry({ invoice, tenantId }) {
  const totalPaise = toPaise(invoice.total_amount);
  if (totalPaise <= 0) return null;
  const taxPaise = invoice.tax_amount != null ? toPaise(invoice.tax_amount) : 0;
  const revenuePaise = totalPaise - taxPaise;
  const lines = [
    { accountCode: 'PATIENT_AR', amountPaise: totalPaise, patient_uid: invoice.patient_uid, invoice_id: Number(invoice.id) },
    { accountCode: 'REVENUE', amountPaise: -revenuePaise },
  ];
  if (taxPaise > 0) lines.push({ accountCode: 'TAX_PAYABLE', amountPaise: -taxPaise });
  return setTenantTx(tenantId, (tx) => postLedgerEntry(tx, {
    entryType: 'INVOICE_ISSUE', idempotencyKey: `issue-inv-${invoice.id}`, lines,
  }));
}

/** Post REFUND_APPROVE: credit REFUNDS_PAYABLE / debit PATIENT_AR (invoice) | PATIENT_ADVANCE (advance). */
export async function postRefundApproveEntry({ refund, tenantId }) {
  const paise = toPaise(refund.amount);
  if (paise <= 0) return null;
  const debit = refund.advance_id != null
    ? { accountCode: 'PATIENT_ADVANCE', amountPaise: paise, advance_id: Number(refund.advance_id), patient_uid: refund.patient_uid }
    : { accountCode: 'PATIENT_AR', amountPaise: paise, patient_uid: refund.patient_uid, invoice_id: Number(refund.invoice_id) };
  return setTenantTx(tenantId, (tx) => postLedgerEntry(tx, {
    entryType: 'REFUND_APPROVE',
    idempotencyKey: `refund-approve-${refund.id}`,
    lines: [debit, { accountCode: 'REFUNDS_PAYABLE', amountPaise: -paise, patient_uid: refund.patient_uid }],
  }));
}

/** Post REFUND_PAID: debit REFUNDS_PAYABLE / credit CASH|BANK. */
export async function postRefundPaidEntry({ refund, tenantId }) {
  const credit = paymentDebitAccount(refund.mode);
  if (!credit) return null;             // INSURANCE-mode refund — Phase 3c
  const paise = toPaise(refund.amount);
  if (paise <= 0) return null;
  return setTenantTx(tenantId, (tx) => postLedgerEntry(tx, {
    entryType: 'REFUND_PAID',
    idempotencyKey: `refund-paid-${refund.id}`,
    lines: [
      { accountCode: 'REFUNDS_PAYABLE', amountPaise: paise, patient_uid: refund.patient_uid },
      { accountCode: credit, amountPaise: -paise },
    ],
  }));
}
```
Update `export default` to add `postRefundApproveEntry, postRefundPaidEntry`.

- [ ] **Step 4: Run + lint + commit**

```bash
cd apps/backend && DATABASE_URL="postgresql://postgres@127.0.0.1:55432/vhhealth_test" NODE_ENV=test node --experimental-vm-modules node_modules/jest/bin/jest.js ledgerPostings.test --forceExit
npx eslint src/services/billing/ledger/ledgerPostings.js src/tests/unit/ledgerPostings.test.js && npm run lint:raw-params && cd ../..
git add apps/backend/src/services/billing/ledger/ledgerPostings.js apps/backend/src/tests/unit/ledgerPostings.test.js
git commit -m "feat(ledger): GST tax split in issue entry + refund approve/paid helpers"
```

---

## Task 2: Wire `issueInvoice` tax + `approveRefund` + `markRefundPaid`

**Files:**
- Modify: `apps/backend/src/services/billing/billingV2Service.js`

- [ ] **Step 1: Add the refund helpers to the ledger import** (extend the existing import):
```js
import {
  postInvoiceIssueEntry, postPaymentEntry,
  postAdvanceCollectEntry, postAdvanceSettleEntry, postPaymentReversalEntry,
  postRefundApproveEntry, postRefundPaidEntry,
} from './ledger/ledgerPostings.js';
```

- [ ] **Step 2: Extend the `issueInvoice` `meta` query + pass tax.** The `meta` query (inside `issueInvoice`) currently selects `admission_id, patient_uid, tenant_id, total_amount`. Change it to also select the GST columns and pass the tax sum:

Change the SELECT to:
```js
  const meta = await prisma.$queryRawUnsafe(
    `SELECT admission_id, patient_uid, tenant_id, total_amount,
            (COALESCE(cgst_amount,0) + COALESCE(sgst_amount,0) + COALESCE(igst_amount,0)) AS tax_amount
       FROM billing_invoices WHERE id = $1::int`,
    Number(invoiceId),
  );
```
and the existing post-commit block's `postInvoiceIssueEntry` call to pass `tax_amount`:
```js
      await postInvoiceIssueEntry({
        invoice: { id: invoiceId, patient_uid: meta[0].patient_uid, total_amount: meta[0].total_amount, tax_amount: meta[0].tax_amount },
        tenantId: meta[0].tenant_id,
      });
```

- [ ] **Step 3: Wire `approveRefund` (post-commit best-effort).** `approveRefund` is a plain `prisma.$queryRawUnsafe` UPDATE returning the row. Change its tail so it captures the row and posts:

The function currently ends `... RETURNING *`, ...params); ` then (likely) `if (!rows.length) throw ...; return rows[0];`. Replace the `return rows[0];` with:
```js
  const refund = rows[0];
  // Ledger (Phase 3b): post-commit best-effort REFUND_APPROVE (credit
  // REFUNDS_PAYABLE / debit PATIENT_AR|PATIENT_ADVANCE). Non-blocking.
  try {
    await postRefundApproveEntry({ refund, tenantId: requireTenantId(tenantId) });
  } catch (ledgerErr) {
    logger.error('Ledger REFUND_APPROVE post failed (non-blocking)', { refund_id: refund?.id, error: ledgerErr.message });
  }
  return refund;
```
(Read the actual lines around `approveRefund`'s `RETURNING *` to apply this precisely — the not-found guard and `return rows[0]` are the anchor.)

- [ ] **Step 4: Wire `markRefundPaid` (post-commit best-effort).** It is `return setTenantTx(...)`. Change to `const refund = await setTenantTx(...)` (the callback already builds `const refund = rows[0]` and returns it — keep the callback returning `refund`), then after the tx:
```js
  // Ledger (Phase 3b): post-commit best-effort REFUND_PAID (debit
  // REFUNDS_PAYABLE / credit CASH|BANK). Non-blocking.
  try {
    await postRefundPaidEntry({ refund, tenantId: requireTenantId(tenantId) });
  } catch (ledgerErr) {
    logger.error('Ledger REFUND_PAID post failed (non-blocking)', { refund_id: refund?.id, error: ledgerErr.message });
  }
  return refund;
```
(The callback's final `return ...;` must return the refund row object — confirm the callback returns the refund row, not a settlement-style nested value. Read the `markRefundPaid` tail before editing.)

- [ ] **Step 5: Lint + commit**

```bash
cd apps/backend && npx eslint src/services/billing/billingV2Service.js && cd ../..
git add apps/backend/src/services/billing/billingV2Service.js
git commit -m "feat(ledger): wire issueInvoice tax split + approveRefund/markRefundPaid (best-effort)"
```

---

## Task 3: Deep test — tax split + refund lifecycle

**Files:**
- Create: `apps/backend/src/tests/money-ledger-tax-refunds.deep.test.js`

- [ ] **Step 1: Write the failing deep test**

```js
// apps/backend/src/tests/money-ledger-tax-refunds.deep.test.js
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
    `INSERT INTO users (uid, phone, name, role, tenant_id, updated_at) VALUES ($1::uuid,$2,'Tax Refund Test','PATIENT',$3::uuid,NOW())`,
    uid, phone, TENANT,
  );
  cleanup.patientUids.push(uid);
  return uid;
}
async function makeDraftInvoice(patientUid, unitPrice, gstRate) {
  const inv = await billing.createDraftInvoice({ patient_uid: patientUid, invoice_type: 'OP', tenantId: TENANT });
  await billing.addInvoiceItem(inv.id, { description: 'Consult', quantity: 1, unit_price: unitPrice, gst_rate: gstRate, tenantId: TENANT });
  cleanup.invoiceIds.push(inv.id);
  return inv.id;
}
const bal = (code, dims) => setTenantTx(TENANT, (tx) => getAccountBalancePaise(tx, code, dims));

afterAll(async () => {
  try {
    if (cleanup.invoiceIds.length) {
      await prisma.$executeRawUnsafe(`DELETE FROM billing_refunds WHERE invoice_id = ANY($1::int[])`, cleanup.invoiceIds);
      await prisma.$executeRawUnsafe(`DELETE FROM billing_payments WHERE invoice_id = ANY($1::int[])`, cleanup.invoiceIds);
      await prisma.$executeRawUnsafe(`DELETE FROM billing_invoice_items WHERE invoice_id = ANY($1::int[])`, cleanup.invoiceIds);
      await prisma.$executeRawUnsafe(`DELETE FROM billing_invoices WHERE id = ANY($1::int[])`, cleanup.invoiceIds);
    }
    if (cleanup.patientUids.length) await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = ANY($1::uuid[])`, cleanup.patientUids);
  } catch { /* best-effort */ }
  await prisma.$disconnect().catch(() => {});
});

describe('Phase 3b — tax split + refunds', () => {
  it('issueInvoice with GST splits REVENUE and TAX_PAYABLE', async () => {
    const patient = await makePatient();
    const invoiceId = await makeDraftInvoice(patient, 1000, 18); // 1000 + 18% = 1180
    await billing.issueInvoice(invoiceId, { tenantId: TENANT });

    // AR = total (118000); REVENUE = 100000; TAX_PAYABLE = 18000
    expect(await bal('PATIENT_AR', { patient_uid: patient, invoice_id: invoiceId })).toBe(118000);
    // REVENUE/TAX are credit-normal: normal-direction balance is positive.
    const rev = await bal('REVENUE');
    const tax = await bal('TAX_PAYABLE');
    expect(rev).toBeGreaterThanOrEqual(100000);
    expect(tax).toBeGreaterThanOrEqual(18000);
  });

  it('refund lifecycle: approve credits REFUNDS_PAYABLE, pay clears it; AR restored', async () => {
    const patient = await makePatient();
    const invoiceId = await makeDraftInvoice(patient, 500, 0); // 500, no tax
    await billing.issueInvoice(invoiceId, { tenantId: TENANT }); // AR 50000
    await billing.collectPayment({ invoice_id: invoiceId, amount: 500, mode: 'CASH', shift: 'MORNING', collected_by: patient, tenantId: TENANT });
    expect(await bal('PATIENT_AR', { patient_uid: patient, invoice_id: invoiceId })).toBe(0); // paid off

    const refund = await billing.raiseRefund({ patient_uid: patient, invoice_id: invoiceId, amount: 200, reason: 'overpay', mode: 'CASH', tenantId: TENANT });
    const rpBefore = await bal('REFUNDS_PAYABLE', { patient_uid: patient });
    await billing.approveRefund(refund.id, { tenantId: TENANT });
    // approve: REFUNDS_PAYABLE +20000, PATIENT_AR restored to 20000
    expect(await bal('REFUNDS_PAYABLE', { patient_uid: patient })).toBe(rpBefore + 20000);
    expect(await bal('PATIENT_AR', { patient_uid: patient, invoice_id: invoiceId })).toBe(20000);

    await billing.markRefundPaid(refund.id, { tenantId: TENANT });
    // pay: REFUNDS_PAYABLE back to its pre-approve level (liability cleared)
    expect(await bal('REFUNDS_PAYABLE', { patient_uid: patient })).toBe(rpBefore);
  });
});
```

- [ ] **Step 2: Run to verify it passes** — `... jest.js money-ledger-tax-refunds --forceExit`. Revive the QA DB if it idle-died. If `raiseRefund`/`approveRefund` arg names differ, adjust the fixture (test scaffolding, not the behaviour under test).

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/tests/money-ledger-tax-refunds.deep.test.js
git commit -m "test(ledger): deep proof GST tax split + refund lifecycle mirror the ledger"
```

---

## Task 4: Full gate + merge

- [ ] **Step 1: lint sweep** — `cd apps/backend && npm run lint && npm run lint:raw-params && cd ../..` → clean.
- [ ] **Step 2: Full gate** — `cd apps/backend && DATABASE_URL="postgresql://postgres@127.0.0.1:55432/vhhealth_test" NODE_ENV=test node scripts/run-ci-jest.mjs 2>&1 | tee /tmp/ledger-p3b-gate.log; cd ../..` → `All chunks passed`, zero `FAIL src/`. Arm a stall monitor (`Chunk [0-9]+/89`); revive the QA DB on idle-death and resume `JEST_CI_START_CHUNK=<frozen chunk>`. **Watch the existing billing refund/issue deep tests** — they now exercise the post-commit hooks (best-effort, must stay green).
- [ ] **Step 3: Merge + push both remotes**
```bash
git checkout main
git merge --no-ff feat/money-ledger-phase3b -m "Merge money ledger Phase 3b: GST tax split + refund lifecycle (post-commit best-effort)"
git push origin main && git push github main
git branch -d feat/money-ledger-phase3b
```
- [ ] **Step 4: Update ROADMAP + memory** — tick Phase 3b; note Phase 3c (insurance: INSURANCE payment mode + tpa/insurance settlements → INSURANCE_AR + the markPaymentLinkPaid tx-path) next.

---

## Self-review (plan-author)

- **Spec coverage:** §3.1 TAX_PAYABLE/REFUNDS_PAYABLE accounts now used; §7 phase-3 tax + refunds → Tasks 1–3. **Deferred to 3c:** insurance (INSURANCE_AR, INSURANCE-mode payments/refunds, tpa/insurance settlement), markPaymentLinkPaid tx-path. **Phase 4:** flip authoritative.
- **No placeholders:** all code complete. Tasks 3/4 note reading the exact `approveRefund`/`markRefundPaid` tails before editing (their not-found guard + `return` are the anchors) — the only spots needing on-the-spot confirmation.
- **Type consistency:** `postInvoiceIssueEntry({invoice:{id,patient_uid,total_amount,tax_amount}})`, `postRefundApproveEntry({refund:{id,patient_uid,invoice_id,advance_id,amount}})`, `postRefundPaidEntry({refund:{id,patient_uid,amount,mode}})`; idem keys `issue-inv-<id>` / `refund-approve-<id>` / `refund-paid-<id>`; reuses `paymentDebitAccount`/`toPaise`.
- **Balance sanity:** issue split sums to zero (AR total − REVENUE(total−tax) − TAX(tax) = 0); no-tax invoice omits the TAX line (identical to Phase 2a, so the Phase-2a deep test still passes). Refund approve sums to zero (debit source = credit REFUNDS_PAYABLE); pay sums to zero. REFUNDS_PAYABLE ≥0 holds (approve credits before pay debits). Invoice-refund debit PATIENT_AR keeps AR ≥0 (it only increases AR). Advance-refund debit PATIENT_ADVANCE needs advance ≥ refund — raiseRefund bounds it; if the ledger advance is unwired, the post trips no-negative → logged (graceful).
