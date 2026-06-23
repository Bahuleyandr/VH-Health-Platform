# Money Ledger — Phase 3c (insurance, two-step INSURANCE_AR) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Model insurer settlements as a proper two-step in the ledger: when a TPA claim is approved, **shift** the receivable PATIENT_AR → INSURANCE_AR (the insurer now owes); when the insurer pays (collectPayment mode=INSURANCE), **settle** debit BANK / credit INSURANCE_AR. The INSURANCE payment credits INSURANCE_AR (not PATIENT_AR) so AR is never double-credited.

**Architecture:** A new `postInsuranceShiftEntry` (debit INSURANCE_AR(invoice) / credit PATIENT_AR(patient,invoice) = approved_amount) wired post-commit best-effort into `claimsService.recordClaimDecision` on approved/partially_approved. `postPaymentEntry` gains an INSURANCE branch (debit BANK / credit INSURANCE_AR(invoice), entryType INSURANCE_SETTLE). INSURANCE_AR is keyed by `invoice_id` (no patient dimension) so the shift-debit and settle-credit net on the same balance row. INSURANCE_AR is NOT in the no-negative constrained set (an over-payment by the insurer leaves a credit balance = a payable, not an error). All post-commit best-effort — the live claim/payment paths are never broken.

**Tech Stack:** Node 22 / PostgreSQL 17 / Prisma raw SQL; the Phase 1–3b ledger (all on `main`). Jest deep tests on the `postgres` QA DB.

**Spec:** `docs/superpowers/specs/2026-06-23-double-entry-money-ledger-design.md` (§3.1 INSURANCE_AR, §7 phase 3). Prior: `b1358af7`/`dc2c5d4c`/`1eae7186`/`aeab243d`/`<3b>`.

---

## Conventions (read first)

- Branch `feat/money-ledger-phase3c`; commit per task; merge `--no-ff` + push BOTH remotes (`origin`=Forgejo, `github`=GitHub).
- Deep test: `DATABASE_URL="postgresql://postgres@127.0.0.1:55432/vhhealth_test" NODE_ENV=test node --experimental-vm-modules node_modules/jest/bin/jest.js <pattern> --forceExit` from `apps/backend`. **QA DB idle-dies — revive with `node apps/backend/scripts/qa-cluster-up.mjs` and retry.**
- Full gate: `node scripts/run-ci-jest.mjs` → `All chunks passed` + zero `FAIL src/` (89+ chunks). Stall monitor pattern `Chunk [0-9]+/[0-9]+`; resume `JEST_CI_START_CHUNK=<frozen chunk>` on DB death.
- `npm run lint && npm run lint:raw-params` before each commit. No migrations.

## File Structure

- Modify `apps/backend/src/services/billing/ledger/ledgerPostings.js` — add `postInsuranceShiftEntry`; add the INSURANCE branch to `postPaymentEntry`.
- Modify `apps/backend/src/services/insurance/claimsService.js` — `recordClaimDecision` posts the shift post-commit on approval.
- Modify `apps/backend/src/tests/unit/ledgerPostings.test.js` — INSURANCE payment branch + the shift helper.
- Create `apps/backend/src/tests/money-ledger-insurance.deep.test.js`.

---

## Task 1: INSURANCE branch in `postPaymentEntry` + `postInsuranceShiftEntry`

**Files:**
- Modify: `apps/backend/src/services/billing/ledger/ledgerPostings.js`
- Modify: `apps/backend/src/tests/unit/ledgerPostings.test.js`

- [ ] **Step 1: Add the failing unit tests** (append after the existing `postPaymentEntry` describe; and change the existing "skips INSURANCE" test — INSURANCE now POSTS):

Replace the existing `postPaymentEntry` "skips (no post) for an INSURANCE payment (Phase 3)" test with:
```js
  it('INSURANCE payment posts debit BANK / credit INSURANCE_AR (not PATIENT_AR)', async () => {
    await postPaymentEntry({ payment: { id: 12, patient_uid: PATIENT, invoice_id: 42, amount: '800.00', mode: 'INSURANCE' }, tenantId: TENANT });
    const arg = postLedgerEntry.mock.calls.at(-1)[1];
    expect(arg.entryType).toBe('INSURANCE_SETTLE');
    expect(arg.idempotencyKey).toBe('payment-12');
    expect(arg.lines).toEqual([
      { accountCode: 'BANK', amountPaise: 80000 },
      { accountCode: 'INSURANCE_AR', amountPaise: -80000, invoice_id: 42 },
    ]);
  });

  it('INSURANCE payment with no invoice is skipped (needs the invoice dimension)', async () => {
    const before = postLedgerEntry.mock.calls.length;
    await postPaymentEntry({ payment: { id: 13, patient_uid: PATIENT, invoice_id: null, amount: '800.00', mode: 'INSURANCE' }, tenantId: TENANT });
    expect(postLedgerEntry.mock.calls.length).toBe(before);
  });
```

Add a new describe block:
```js
describe('postInsuranceShiftEntry', () => {
  it('debit INSURANCE_AR(invoice) / credit PATIENT_AR(patient,invoice) for the approved amount', async () => {
    const { postInsuranceShiftEntry } = await import('../../services/billing/ledger/ledgerPostings.js');
    await postInsuranceShiftEntry({ claim: { id: 4, invoice_id: 42, patient_uid: PATIENT, approved_amount: '800.00' }, tenantId: TENANT });
    const arg = postLedgerEntry.mock.calls.at(-1)[1];
    expect(arg.entryType).toBe('INSURANCE_SHIFT');
    expect(arg.idempotencyKey).toBe('claim-shift-4');
    expect(arg.lines).toEqual([
      { accountCode: 'INSURANCE_AR', amountPaise: 80000, invoice_id: 42 },
      { accountCode: 'PATIENT_AR', amountPaise: -80000, patient_uid: PATIENT, invoice_id: 42 },
    ]);
  });
  it('skips when approved_amount is 0 or invoice missing', async () => {
    const { postInsuranceShiftEntry } = await import('../../services/billing/ledger/ledgerPostings.js');
    const before = postLedgerEntry.mock.calls.length;
    await postInsuranceShiftEntry({ claim: { id: 5, invoice_id: 42, patient_uid: PATIENT, approved_amount: '0.00' }, tenantId: TENANT });
    await postInsuranceShiftEntry({ claim: { id: 6, invoice_id: null, patient_uid: PATIENT, approved_amount: '800.00' }, tenantId: TENANT });
    expect(postLedgerEntry.mock.calls.length).toBe(before);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `... jest.js ledgerPostings.test --forceExit`.

- [ ] **Step 3: Edit `postPaymentEntry`** to branch on INSURANCE, and **append `postInsuranceShiftEntry`** before `export default`. Replace `postPaymentEntry` with:

```js
/** Post PAYMENT: non-insurance → debit CASH|BANK / credit PATIENT_AR; INSURANCE → debit BANK / credit INSURANCE_AR. */
export async function postPaymentEntry({ payment, tenantId }) {
  if (payment.reversed) return null;
  const paise = toPaise(payment.amount);
  if (paise <= 0) return null;
  const mode = String(payment.mode || '').toUpperCase();
  if (mode === 'INSURANCE') {
    // Insurer settlement. The receivable already moved PATIENT_AR -> INSURANCE_AR
    // at claim approval (postInsuranceShiftEntry), so the payment clears
    // INSURANCE_AR, NOT PATIENT_AR (avoids double-crediting AR).
    if (payment.invoice_id == null) return null; // INSURANCE_AR is keyed by invoice
    return setTenantTx(tenantId, (tx) => postLedgerEntry(tx, {
      entryType: 'INSURANCE_SETTLE',
      idempotencyKey: `payment-${payment.id}`,
      lines: [
        { accountCode: 'BANK', amountPaise: paise },
        { accountCode: 'INSURANCE_AR', amountPaise: -paise, invoice_id: Number(payment.invoice_id) },
      ],
    }));
  }
  const debit = paymentDebitAccount(mode);
  if (!debit) return null;
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
```

Append before `export default`:
```js
/** Post INSURANCE_SHIFT: on claim approval move the receivable PATIENT_AR -> INSURANCE_AR. */
export async function postInsuranceShiftEntry({ claim, tenantId }) {
  if (claim.invoice_id == null) return null;
  const paise = claim.approved_amount != null ? toPaise(claim.approved_amount) : 0;
  if (paise <= 0) return null;
  return setTenantTx(tenantId, (tx) => postLedgerEntry(tx, {
    entryType: 'INSURANCE_SHIFT',
    idempotencyKey: `claim-shift-${claim.id}`,
    lines: [
      { accountCode: 'INSURANCE_AR', amountPaise: paise, invoice_id: Number(claim.invoice_id) },
      { accountCode: 'PATIENT_AR', amountPaise: -paise, patient_uid: claim.patient_uid, invoice_id: Number(claim.invoice_id) },
    ],
  }));
}
```
Update `export default` to add `postInsuranceShiftEntry`.

- [ ] **Step 4: Run + lint + commit**

```bash
cd apps/backend && DATABASE_URL="postgresql://postgres@127.0.0.1:55432/vhhealth_test" NODE_ENV=test node --experimental-vm-modules node_modules/jest/bin/jest.js ledgerPostings.test --forceExit
npx eslint src/services/billing/ledger/ledgerPostings.js src/tests/unit/ledgerPostings.test.js && npm run lint:raw-params && cd ../..
git add apps/backend/src/services/billing/ledger/ledgerPostings.js apps/backend/src/tests/unit/ledgerPostings.test.js
git commit -m "feat(ledger): INSURANCE settle (BANK<-INSURANCE_AR) + claim-approval AR->INSURANCE_AR shift helpers"
```

---

## Task 2: Wire `recordClaimDecision` (post-commit shift on approval)

**Files:**
- Modify: `apps/backend/src/services/insurance/claimsService.js` — `recordClaimDecision` (the `return getClaim({ tenantId, id });` at the end, ~line 1977).

- [ ] **Step 1: Add the import** (with the other claimsService imports near the top):
```js
import { postInsuranceShiftEntry } from '../billing/ledger/ledgerPostings.js';
```

- [ ] **Step 2: Post the shift after the tx, before the final return.** Replace the final `return getClaim({ tenantId, id });` with:
```js
  const updated = await getClaim({ tenantId, id });
  // Ledger (Phase 3c): on insurer approval, shift the receivable
  // PATIENT_AR -> INSURANCE_AR for the approved amount. Post-commit best-effort;
  // a ledger problem never blocks the claim decision. Only meaningful when the
  // claim is invoice-linked and the insurer committed an amount.
  if ((decision === 'approved' || decision === 'partially_approved') && updated && updated.invoice_id) {
    try {
      await postInsuranceShiftEntry({
        claim: { id: updated.id, invoice_id: updated.invoice_id, patient_uid: updated.patient_uid, approved_amount: updated.approved_amount },
        tenantId: requireTenantId(tenantId),
      });
    } catch (ledgerErr) {
      logger.error('Ledger INSURANCE_SHIFT post failed (non-blocking)', { claim_id: updated.id, error: ledgerErr.message });
    }
  }
  return updated;
```
(Confirm `getClaim` returns the row with `invoice_id`, `patient_uid`, `approved_amount` — read its SELECT before editing. Confirm `logger` + `requireTenantId` are imported in claimsService; if not, add them.)

- [ ] **Step 3: Lint + commit**

```bash
cd apps/backend && npx eslint src/services/insurance/claimsService.js && cd ../..
git add apps/backend/src/services/insurance/claimsService.js
git commit -m "feat(ledger): wire recordClaimDecision -> post-commit AR->INSURANCE_AR shift (best-effort)"
```

---

## Task 3: Deep test — approve shifts AR→INSURANCE_AR; insurer payment clears INSURANCE_AR

**Files:**
- Create: `apps/backend/src/tests/money-ledger-insurance.deep.test.js`

- [ ] **Step 1: Write the failing deep test**

```js
// apps/backend/src/tests/money-ledger-insurance.deep.test.js
import { randomUUID } from 'node:crypto';
import prisma, { setTenantTx } from '../lib/prisma.js';
import * as billing from '../services/billing/billingV2Service.js';
import * as claims from '../services/insurance/claimsService.js';
import { getAccountBalancePaise } from '../services/billing/ledger/ledgerService.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const cleanup = { invoiceIds: [], claimIds: [], policyIds: [], patientUids: [] };

async function makePatient() {
  const uid = randomUUID();
  const phone = `9${Math.floor(100000000 + Math.random() * 899999999)}`;
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (uid, phone, name, role, tenant_id, updated_at) VALUES ($1::uuid,$2,'Ins Test','PATIENT',$3::uuid,NOW())`,
    uid, phone, TENANT,
  );
  cleanup.patientUids.push(uid);
  return uid;
}
async function makeIssuedInvoice(patientUid, total) {
  const inv = await billing.createDraftInvoice({ patient_uid: patientUid, invoice_type: 'OP', tenantId: TENANT });
  await billing.addInvoiceItem(inv.id, { description: 'Procedure', quantity: 1, unit_price: total, gst_rate: 0, tenantId: TENANT });
  await billing.issueInvoice(inv.id, { tenantId: TENANT });
  cleanup.invoiceIds.push(inv.id);
  return inv.id;
}
async function makePolicy(patientUid) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO insurance_policies (patient_uid, policy_number) VALUES ($1::uuid, $2) RETURNING id`,
    patientUid, `POL-${Math.floor(Math.random() * 1e9)}`,
  );
  cleanup.policyIds.push(rows[0].id);
  return rows[0].id;
}
async function makeSubmittedClaim(patientUid, policyId, invoiceId, claimed) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO tpa_claims (claim_number, policy_id, patient_uid, invoice_id, total_billed, claimed_amount, claim_type, status, tenant_id)
     VALUES ($1, $2::int, $3::uuid, $4::int, $5::numeric, $5::numeric, 'cashless', 'submitted', $6::uuid)
     RETURNING id`,
    `CLM-${Math.floor(Math.random() * 1e9)}`, policyId, patientUid, invoiceId, claimed, TENANT,
  );
  cleanup.claimIds.push(rows[0].id);
  return rows[0].id;
}
const bal = (code, dims) => setTenantTx(TENANT, (tx) => getAccountBalancePaise(tx, code, dims));

afterAll(async () => {
  try {
    if (cleanup.claimIds.length) {
      await prisma.$executeRawUnsafe(`DELETE FROM tpa_claim_correspondence WHERE claim_id = ANY($1::int[])`, cleanup.claimIds).catch(() => {});
      await prisma.$executeRawUnsafe(`DELETE FROM tpa_claims WHERE id = ANY($1::int[])`, cleanup.claimIds);
    }
    if (cleanup.invoiceIds.length) {
      await prisma.$executeRawUnsafe(`DELETE FROM billing_payments WHERE invoice_id = ANY($1::int[])`, cleanup.invoiceIds);
      await prisma.$executeRawUnsafe(`DELETE FROM billing_invoice_items WHERE invoice_id = ANY($1::int[])`, cleanup.invoiceIds);
      await prisma.$executeRawUnsafe(`DELETE FROM billing_invoices WHERE id = ANY($1::int[])`, cleanup.invoiceIds);
    }
    if (cleanup.policyIds.length) await prisma.$executeRawUnsafe(`DELETE FROM insurance_policies WHERE id = ANY($1::int[])`, cleanup.policyIds);
    if (cleanup.patientUids.length) await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = ANY($1::uuid[])`, cleanup.patientUids);
  } catch { /* best-effort */ }
  await prisma.$disconnect().catch(() => {});
});

describe('Phase 3c — insurance two-step', () => {
  it('approve shifts AR→INSURANCE_AR; insurer payment clears INSURANCE_AR', async () => {
    const patient = await makePatient();
    const invoiceId = await makeIssuedInvoice(patient, 1000);   // AR 100000
    const policyId = await makePolicy(patient);
    const claimId = await makeSubmittedClaim(patient, policyId, invoiceId, 1000);

    // insurer approves ₹800 of the ₹1000 bill
    await claims.recordClaimDecision({ tenantId: TENANT, id: claimId, decision: 'approved', approved_amount: 800 });
    expect(await bal('INSURANCE_AR', { invoice_id: invoiceId })).toBe(80000); // insurer owes 800
    expect(await bal('PATIENT_AR', { patient_uid: patient, invoice_id: invoiceId })).toBe(20000); // patient owes the rest

    // insurer pays the ₹800 against the invoice
    await billing.collectPayment({ invoice_id: invoiceId, patient_uid: patient, amount: 800, mode: 'INSURANCE', tenantId: TENANT });
    expect(await bal('INSURANCE_AR', { invoice_id: invoiceId })).toBe(0);     // insurer debt cleared
    expect(await bal('PATIENT_AR', { patient_uid: patient, invoice_id: invoiceId })).toBe(20000); // unchanged (not double-credited)
    expect(await bal('BANK')).toBeGreaterThanOrEqual(80000);
  });
});
```

- [ ] **Step 2: Run to verify it passes.** Revive the QA DB if it idle-died. If `recordClaimDecision`/`collectPayment(INSURANCE)` reject due to a missing claim field (the anchor query, `assertInsurancePaymentHasClaimAnchor`, or a payer-match check), adjust the `makeSubmittedClaim` insert to satisfy them (add the columns the guards read) — that is test scaffolding. The behaviour under test is the ledger balances.

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/tests/money-ledger-insurance.deep.test.js
git commit -m "test(ledger): deep proof insurance two-step (approve shift + insurer settle)"
```

---

## Task 4: Full gate + merge

- [ ] **Step 1: lint sweep** — `cd apps/backend && npm run lint && npm run lint:raw-params && cd ../..` → clean.
- [ ] **Step 2: Full gate** — `cd apps/backend && DATABASE_URL="postgresql://postgres@127.0.0.1:55432/vhhealth_test" NODE_ENV=test node scripts/run-ci-jest.mjs 2>&1 | tee /tmp/ledger-p3c-gate.log; cd ../..` → `All chunks passed`, zero `FAIL src/`. Arm a stall monitor; revive the QA DB + resume `JEST_CI_START_CHUNK=<frozen chunk>` on idle-death. **Watch the existing TPA/claims + billing deep tests** (`billing-money-path-concurrency-deep`, `tpa-claim-*`) — they now exercise the post-commit shift/INSURANCE hooks (best-effort, must stay green).
- [ ] **Step 3: Merge + push both remotes**
```bash
git checkout main
git merge --no-ff feat/money-ledger-phase3c -m "Merge money ledger Phase 3c: insurance two-step (AR->INSURANCE_AR shift + insurer settle)"
git push origin main && git push github main
git branch -d feat/money-ledger-phase3c
```
- [ ] **Step 4: Update ROADMAP + memory** — tick Phase 3c; note the remaining gap (markPaymentLinkPaid tx-path; INSURANCE refund/reversal) + Phase 4 (flip authoritative — gated on production reconciliation evidence).

---

## Self-review (plan-author)

- **Spec coverage:** §3.1 INSURANCE_AR now used; §7 phase-3 insurance two-step → Tasks 1–3. **Deferred:** the `markPaymentLinkPaid` `tx`-passed path; INSURANCE-payment reversal/refund (paymentDebitAccount still returns null for those callers, so they skip — documented gap, reconciliation flags). **Phase 4:** flip authoritative (production-evidence-gated).
- **No placeholders:** all code complete. Tasks 2/3 note confirming `getClaim`'s SELECT fields + the claim-anchor/payer guards before editing — the only on-the-spot confirmations.
- **Type consistency:** `postInsuranceShiftEntry({claim:{id,invoice_id,patient_uid,approved_amount}})`, `postPaymentEntry` INSURANCE branch keyed by `invoice_id`; idem `claim-shift-<id>` / `payment-<id>`; INSURANCE_AR dimension = `invoice_id` only in BOTH shift-debit and settle-credit (so they net on one balance row).
- **Double-count + balance sanity:** shift credits PATIENT_AR once (at approval); the INSURANCE payment credits INSURANCE_AR (not PATIENT_AR) → AR not double-credited. Shift sums to zero (INSURANCE_AR +x, PATIENT_AR −x); settle sums to zero (BANK +x, INSURANCE_AR −x). INSURANCE_AR nets shift(+approved) − settle(paid) → 0 when paid == approved; unconstrained so a paid>approved leaves a small credit (insurer overpay = payable), not a hard error. PATIENT_AR credit at shift ≤ amount_due keeps AR ≥0 (approved ≤ claimed ≤ bill); if approved exceeds the ledger AR (edge) the shift trips no-negative → logged (graceful).
