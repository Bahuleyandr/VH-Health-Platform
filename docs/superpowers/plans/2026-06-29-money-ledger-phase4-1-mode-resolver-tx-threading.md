# Money Ledger Phase 4-1 — Mode Resolver + tx-Threading — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the per-tenant `off`/`shadow`/`enforce` ledger-authoritative mode resolver, and make the 8 ledger posting wrappers able to post inside a caller-supplied transaction — the inert foundation for the Phase 4 flip, merging with zero behavior change at the default `shadow` mode.

**Architecture:** Two isolated, additive changes. (1) A new `ledgerAuthoritativeMode.js` resolver that is a near-verbatim copy of the proven `careTeamEnforcement.js` (reads `tenants.settings` JSONB, env override, fail-safe default `shadow`) — it is created but not yet consumed by any caller. (2) The posting wrappers in `ledgerPostings.js` gain an optional `tx` param via a single `runPosting` helper: when a `tx` is passed they post in that transaction (same-tx); when omitted they open their own `setTenantTx` exactly as today (post-commit best-effort). No caller passes `tx` yet, so runtime behavior is identical.

**Tech Stack:** Node.js 22 + ESM, Jest (`jest.unstable_mockModule`), Prisma raw SQL via `setTenantTx`, PostgreSQL 17.

**Spec:** `docs/superpowers/specs/2026-06-29-money-ledger-phase4-flip-authoritative-design.md` (§3 flag, §4a tx-threading).

**Conventions for every commit in this plan:** run from the repo root; stage only the files named in the step; end every commit message with the trailer line:
```
Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
```

**How to run a single test file** (from `apps/backend`):
```
node --experimental-vm-modules node_modules/jest/bin/jest.js <pattern> --forceExit
```

---

## File Structure

- **Create** `apps/backend/src/services/billing/ledger/ledgerAuthoritativeMode.js` — the mode resolver (one responsibility: resolve a tenant's `off`/`shadow`/`enforce` mode, fail-safe).
- **Create** `apps/backend/src/tests/unit/ledgerAuthoritativeMode.test.js` — unit tests for the resolver.
- **Modify** `apps/backend/src/services/billing/ledger/ledgerPostings.js` — add `runPosting` helper; thread optional `tx` through all 8 posting wrappers.
- **Modify** `apps/backend/src/tests/unit/ledgerPostings.test.js` — upgrade the `setTenantTx` mock to a spy; add tx-threading tests.

---

## Task 1: `ledgerAuthoritativeMode` resolver

**Files:**
- Create: `apps/backend/src/services/billing/ledger/ledgerAuthoritativeMode.js`
- Test: `apps/backend/src/tests/unit/ledgerAuthoritativeMode.test.js`

- [ ] **Step 1: Write the failing test**

Create `apps/backend/src/tests/unit/ledgerAuthoritativeMode.test.js`:

```js
import { jest } from '@jest/globals';

// Mock the tenant service so we control what tenants.settings the resolver sees.
const getTenantByIdMock = jest.fn();
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  getTenantById: getTenantByIdMock,
  DEFAULT_TENANT_ID: '00000000-0000-4000-8000-000000000001',
  resolveTenantOrThrow: (req) => req?.tenantId || '00000000-0000-4000-8000-000000000001',
  requireTenantId: (tenantId) => tenantId || '00000000-0000-4000-8000-000000000001',
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const {
  LEDGER_AUTHORITATIVE_MODES,
  DEFAULT_LEDGER_MODE,
  normalizeLedgerMode,
  envLedgerMode,
  resolveLedgerModeForTenant,
} = await import('../../services/billing/ledger/ledgerAuthoritativeMode.js');

const TENANT = '11111111-1111-4111-8111-111111111111';

afterEach(() => {
  getTenantByIdMock.mockReset();
  delete process.env.LEDGER_AUTHORITATIVE_MODE;
});

describe('ledgerAuthoritativeMode.normalizeLedgerMode', () => {
  it('accepts the three valid modes case-insensitively', () => {
    expect(normalizeLedgerMode('off')).toBe('off');
    expect(normalizeLedgerMode('SHADOW')).toBe('shadow');
    expect(normalizeLedgerMode('  Enforce ')).toBe('enforce');
  });
  it('rejects unknown / empty values', () => {
    expect(normalizeLedgerMode('strict')).toBeNull();
    expect(normalizeLedgerMode('')).toBeNull();
    expect(normalizeLedgerMode(null)).toBeNull();
    expect(normalizeLedgerMode(undefined)).toBeNull();
  });
});

describe('ledgerAuthoritativeMode.resolveLedgerModeForTenant', () => {
  it('defaults to shadow when the tenant has no setting', async () => {
    getTenantByIdMock.mockResolvedValueOnce({ id: TENANT, settings: {} });
    await expect(resolveLedgerModeForTenant(TENANT)).resolves.toBe('shadow');
    expect(DEFAULT_LEDGER_MODE).toBe(LEDGER_AUTHORITATIVE_MODES.SHADOW);
  });

  it('reads enforce from tenants.settings.ledger_authoritative_mode', async () => {
    getTenantByIdMock.mockResolvedValueOnce({ id: TENANT, settings: { ledger_authoritative_mode: 'enforce' } });
    await expect(resolveLedgerModeForTenant(TENANT)).resolves.toBe('enforce');
  });

  it('reads off from tenants.settings', async () => {
    getTenantByIdMock.mockResolvedValueOnce({ id: TENANT, settings: { ledger_authoritative_mode: 'off' } });
    await expect(resolveLedgerModeForTenant(TENANT)).resolves.toBe('off');
  });

  it('tolerates settings stored as a JSON string', async () => {
    getTenantByIdMock.mockResolvedValueOnce({ id: TENANT, settings: JSON.stringify({ ledger_authoritative_mode: 'enforce' }) });
    await expect(resolveLedgerModeForTenant(TENANT)).resolves.toBe('enforce');
  });

  it('ignores an invalid per-tenant value and falls back to default', async () => {
    getTenantByIdMock.mockResolvedValueOnce({ id: TENANT, settings: { ledger_authoritative_mode: 'banana' } });
    await expect(resolveLedgerModeForTenant(TENANT)).resolves.toBe('shadow');
  });

  it('uses the LEDGER_AUTHORITATIVE_MODE env var as the fallback when no tenant setting', async () => {
    process.env.LEDGER_AUTHORITATIVE_MODE = 'enforce';
    getTenantByIdMock.mockResolvedValueOnce({ id: TENANT, settings: {} });
    await expect(resolveLedgerModeForTenant(TENANT)).resolves.toBe('enforce');
    expect(envLedgerMode()).toBe('enforce');
  });

  it('per-tenant setting overrides the env var', async () => {
    process.env.LEDGER_AUTHORITATIVE_MODE = 'off';
    getTenantByIdMock.mockResolvedValueOnce({ id: TENANT, settings: { ledger_authoritative_mode: 'enforce' } });
    await expect(resolveLedgerModeForTenant(TENANT)).resolves.toBe('enforce');
  });

  it('FAIL-SAFE: resolves to the default (shadow) when the tenant lookup throws', async () => {
    getTenantByIdMock.mockRejectedValueOnce(new Error('db down'));
    await expect(resolveLedgerModeForTenant(TENANT)).resolves.toBe('shadow');
  });

  it('FAIL-SAFE: resolves to default when the tenant row is missing', async () => {
    getTenantByIdMock.mockResolvedValueOnce(null);
    await expect(resolveLedgerModeForTenant(TENANT)).resolves.toBe('shadow');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `apps/backend`): `node --experimental-vm-modules node_modules/jest/bin/jest.js ledgerAuthoritativeMode --forceExit`
Expected: FAIL — `Cannot find module '../../services/billing/ledger/ledgerAuthoritativeMode.js'`.

- [ ] **Step 3: Write the implementation**

Create `apps/backend/src/services/billing/ledger/ledgerAuthoritativeMode.js`:

```js
// apps/backend/src/services/billing/ledger/ledgerAuthoritativeMode.js
//
// Money-ledger Phase 4 — per-tenant authoritative-mode resolver.
// Mirrors src/services/security/careTeamEnforcement.js. Modes:
//   * 'off'     — no ledger posting at all (emergency kill-switch).
//   * 'shadow'  — ledger posts POST-COMMIT best-effort; legacy amount_* columns
//                 are the independent source of truth; reconcile drift is
//                 informational. This is TODAY's behavior and the safe DEFAULT.
//   * 'enforce' — ledger post is SAME-TX atomic with the legacy write; legacy
//                 columns are DERIVED from ledger_balances; reconcile drift is a
//                 hard alert.
//
// Stored in the existing tenants.settings JSONB column (no migration). Resolution
// order (fail-safe to the default on any error — never throws into a money path):
//   1. tenants.settings.ledger_authoritative_mode  (per-tenant authority)
//   2. LEDGER_AUTHORITATIVE_MODE env var            (deployment-wide pin)
//   3. DEFAULT_LEDGER_MODE ('shadow')
import logger from '../../../logging/logger.js';
import { getTenantById, requireTenantId } from '../../tenant/tenantService.js';

export const LEDGER_AUTHORITATIVE_MODES = Object.freeze({
  OFF: 'off',
  SHADOW: 'shadow',
  ENFORCE: 'enforce',
});

const VALID_MODES = new Set(Object.values(LEDGER_AUTHORITATIVE_MODES));

// Safe default. shadow == today's behavior (post-commit best-effort, log-only drift).
export const DEFAULT_LEDGER_MODE = LEDGER_AUTHORITATIVE_MODES.SHADOW;

// The settings key on tenants.settings JSONB.
export const LEDGER_MODE_SETTINGS_KEY = 'ledger_authoritative_mode';

/** Normalize an arbitrary value to a valid mode, or null. Case-insensitive, trims. */
export function normalizeLedgerMode(value) {
  if (value == null) return null;
  const text = String(value).trim().toLowerCase();
  return VALID_MODES.has(text) ? text : null;
}

/** Deployment-wide override from the environment, if set to a valid mode; else null. */
export function envLedgerMode() {
  return normalizeLedgerMode(process.env.LEDGER_AUTHORITATIVE_MODE);
}

/**
 * Resolve the effective ledger-authoritative mode for a tenant id.
 * Fail-safe: returns the default on any error or missing tenant.
 * @param {string|null|undefined} tenantId
 * @returns {Promise<'off'|'shadow'|'enforce'>}
 */
export async function resolveLedgerModeForTenant(tenantId) {
  const fallback = envLedgerMode() || DEFAULT_LEDGER_MODE;
  const id = requireTenantId(tenantId);
  try {
    const tenant = await getTenantById(id);
    let parsed = tenant?.settings;
    if (typeof parsed === 'string') {
      try { parsed = JSON.parse(parsed); } catch { parsed = null; }
    }
    const raw = parsed && typeof parsed === 'object' ? parsed[LEDGER_MODE_SETTINGS_KEY] : null;
    return normalizeLedgerMode(raw) || fallback;
  } catch (err) {
    // Never let a tenant-settings hiccup influence the money path — fall back.
    logger.debug('ledger authoritative mode resolve fell back to default', {
      tenantId: id, mode: fallback, error: err?.message,
    });
    return fallback;
  }
}

export default {
  LEDGER_AUTHORITATIVE_MODES,
  DEFAULT_LEDGER_MODE,
  LEDGER_MODE_SETTINGS_KEY,
  normalizeLedgerMode,
  envLedgerMode,
  resolveLedgerModeForTenant,
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run (from `apps/backend`): `node --experimental-vm-modules node_modules/jest/bin/jest.js ledgerAuthoritativeMode --forceExit`
Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/services/billing/ledger/ledgerAuthoritativeMode.js apps/backend/src/tests/unit/ledgerAuthoritativeMode.test.js
git commit -m "feat(ledger): Phase 4-1 per-tenant ledger-authoritative mode resolver

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Thread an optional `tx` through the posting wrappers

**Files:**
- Modify: `apps/backend/src/services/billing/ledger/ledgerPostings.js`
- Test: `apps/backend/src/tests/unit/ledgerPostings.test.js`

**Context:** Each wrapper currently ends with `setTenantTx(tenantId, (tx) => postLedgerEntry(tx, {...}))`. We replace that tail with a `runPosting(tx, tenantId, entryArgs)` helper that uses a passed-in `tx` when present (same-tx) and otherwise opens its own `setTenantTx` (today's path). Each wrapper's destructured argument gains `tx = null`. No caller passes `tx` yet → behavior is unchanged.

- [ ] **Step 1: Upgrade the test mock to a spy and add the failing tx-threading tests**

In `apps/backend/src/tests/unit/ledgerPostings.test.js`, replace the existing `setTenantTx` mock block (lines 9-13):

```js
// setTenantTx just runs the callback with a fake tx
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {},
  setTenantTx: async (_t, fn) => fn({}),
}));
```

with a recording spy (declared above the mock so it is hoisted-safe):

```js
// setTenantTx spy — records calls and runs the callback with an "own" fake tx.
const setTenantTx = jest.fn(async (_t, fn) => fn({ __fakeTx: 'own' }));
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {},
  setTenantTx,
}));
```

Then update the `beforeEach` (line 23) to also clear the new spy:

```js
beforeEach(() => { postLedgerEntry.mockClear(); setTenantTx.mockClear(); });
```

Finally, append this new describe block to the end of the file:

```js
describe('tx-threading (Phase 4-1) — posting wrappers honor a caller-supplied tx', () => {
  it('uses the passed-in tx and does NOT open its own setTenantTx', async () => {
    const callerTx = { __fakeTx: 'caller' };
    await postPaymentEntry({
      payment: { id: 9, patient_uid: PATIENT, invoice_id: 42, amount: '400.00', mode: 'CASH' },
      tenantId: TENANT,
      tx: callerTx,
    });
    expect(setTenantTx).not.toHaveBeenCalled();
    expect(postLedgerEntry).toHaveBeenCalledTimes(1);
    expect(postLedgerEntry.mock.calls[0][0]).toBe(callerTx);
  });

  it('opens its own setTenantTx when no tx is passed (today’s post-commit path)', async () => {
    await postPaymentEntry({
      payment: { id: 9, patient_uid: PATIENT, invoice_id: 42, amount: '400.00', mode: 'CASH' },
      tenantId: TENANT,
    });
    expect(setTenantTx).toHaveBeenCalledTimes(1);
    expect(postLedgerEntry).toHaveBeenCalledTimes(1);
    expect(postLedgerEntry.mock.calls[0][0]).toEqual({ __fakeTx: 'own' });
  });

  it('threads tx through the invoice-issue wrapper too', async () => {
    const callerTx = { __fakeTx: 'caller' };
    await postInvoiceIssueEntry({
      invoice: { id: 42, patient_uid: PATIENT, total_amount: '1000.00', tax_amount: '0.00' },
      tenantId: TENANT,
      tx: callerTx,
    });
    expect(setTenantTx).not.toHaveBeenCalled();
    expect(postLedgerEntry.mock.calls.at(-1)[0]).toBe(callerTx);
  });
});
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run (from `apps/backend`): `node --experimental-vm-modules node_modules/jest/bin/jest.js ledgerPostings --forceExit`
Expected: the three new `tx-threading` tests FAIL (wrappers ignore `tx`, so `setTenantTx` is always called and `postLedgerEntry` receives the `{ __fakeTx: 'own' }` tx, not the caller's). The pre-existing tests still PASS.

- [ ] **Step 3: Add the `runPosting` helper**

In `apps/backend/src/services/billing/ledger/ledgerPostings.js`, immediately after the imports (after line 10, before `const ELECTRONIC_MODES`), add:

```js
// Phase 4-1: post into a caller-supplied tx when present (same-tx, enforce mode),
// otherwise open our own setTenantTx (post-commit best-effort, shadow mode = today).
function runPosting(tx, tenantId, entryArgs) {
  if (tx) return postLedgerEntry(tx, entryArgs);
  return setTenantTx(tenantId, (t) => postLedgerEntry(t, entryArgs));
}
```

- [ ] **Step 4: Thread `tx` through all 8 wrappers**

In the same file, for EACH wrapper: add `tx = null` to its destructured argument object, and replace its `return setTenantTx(tenantId, (tx) => postLedgerEntry(tx, { … }));` tail with `return runPosting(tx, tenantId, { … });` (the `{ … }` entry args are unchanged). Apply to all eight:

1. `postInvoiceIssueEntry({ invoice, tenantId })` → `postInvoiceIssueEntry({ invoice, tenantId, tx = null })`
2. `postPaymentEntry({ payment, tenantId })` → `postPaymentEntry({ payment, tenantId, tx = null })` (it has **two** `setTenantTx` tails — the INSURANCE branch and the default branch; convert both to `runPosting(tx, tenantId, …)`)
3. `postAdvanceCollectEntry({ advance, tenantId })` → `…, tx = null`
4. `postAdvanceSettleEntry({ settlement, patientUid, tenantId })` → `…, tx = null`
5. `postPaymentReversalEntry({ payment, tenantId })` → `…, tx = null` (also **two** tails — INSURANCE and default; convert both)
6. `postRefundApproveEntry({ refund, tenantId })` → `…, tx = null`
7. `postRefundPaidEntry({ refund, tenantId })` → `…, tx = null`
8. `postInsuranceShiftEntry({ claim, tenantId })` → `…, tx = null`

Worked example — `postPaymentEntry` after the change (both branches use `runPosting`; everything else identical):

```js
export async function postPaymentEntry({ payment, tenantId, tx = null }) {
  if (payment.reversed) return null;
  const paise = toPaise(payment.amount);
  if (paise <= 0) return null;
  const mode = String(payment.mode || '').toUpperCase();
  if (mode === 'INSURANCE') {
    if (payment.invoice_id == null) return null; // INSURANCE_AR is keyed by invoice
    return runPosting(tx, tenantId, {
      entryType: 'INSURANCE_SETTLE',
      idempotencyKey: `payment-${payment.id}`,
      lines: [
        { accountCode: 'BANK', amountPaise: paise },
        { accountCode: 'INSURANCE_AR', amountPaise: -paise, invoice_id: Number(payment.invoice_id) },
      ],
    });
  }
  const debit = paymentDebitAccount(mode);
  if (!debit) return null;
  const debitLine = { accountCode: debit, amountPaise: paise };
  if (debit === 'CASH' && payment.cash_drawer_session_id != null) {
    debitLine.cash_drawer_session_id = Number(payment.cash_drawer_session_id);
  }
  return runPosting(tx, tenantId, {
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
  });
}
```

Apply the identical mechanical transform (add `tx = null`; `setTenantTx(tenantId, (tx) => postLedgerEntry(tx, X))` → `runPosting(tx, tenantId, X)`) to the other seven wrappers. Leave all `return null` guards, line construction, idempotency keys, and entry args exactly as they are.

- [ ] **Step 5: Run the full posting test file to verify everything passes**

Run (from `apps/backend`): `node --experimental-vm-modules node_modules/jest/bin/jest.js ledgerPostings --forceExit`
Expected: PASS — all pre-existing tests AND the three new `tx-threading` tests green.

- [ ] **Step 6: Lint the two changed source files**

Run (from `apps/backend`): `npm run lint`
Expected: no new errors. (`lint:raw-params` is unaffected — no raw-SQL call sites changed.)

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/services/billing/ledger/ledgerPostings.js apps/backend/src/tests/unit/ledgerPostings.test.js
git commit -m "feat(ledger): Phase 4-1 thread optional tx through posting wrappers (runPosting)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Phase verification (full unit suite + gate note)

**Files:** none (verification only).

- [ ] **Step 1: Run the billing/ledger unit tests together**

Run (from `apps/backend`): `node --experimental-vm-modules node_modules/jest/bin/jest.js ledger --forceExit`
Expected: PASS — `ledgerAuthoritativeMode`, `ledgerPostings`, and any other `ledger*` unit suites green.

- [ ] **Step 2: Confirm zero behavior change**

Confirm by inspection that no caller of the posting wrappers passes `tx` yet (grep): `git grep -n "postPaymentEntry\|postInvoiceIssueEntry\|postAdvanceCollectEntry\|postAdvanceSettleEntry\|postPaymentReversalEntry\|postRefundApproveEntry\|postRefundPaidEntry\|postInsuranceShiftEntry" apps/backend/src --  ':!*ledgerPostings.js' ':!*test*'`
Expected: every call site still uses the old `{ …, tenantId }` shape (no `tx:`), so runtime behavior is unchanged. `resolveLedgerModeForTenant` has no callers yet (it is consumed in Phase 4-2).

- [ ] **Step 3: Gate note (no action unless running the full gate)**

The authoritative gate is the chunked `postgres` runner (`run-ci-jest.mjs`). Phase 4-1 adds **one new unit test file** (`ledgerAuthoritativeMode.test.js`). If you run the full chunked gate and it shards by file count, the chunk total may increment — update any stall-monitor `Chunk N/M` patterns accordingly (precedent: Phase 3a bumped 88→89). Phase 4-1 needs no DB and no migration, so the per-file unit runs above are sufficient verification for this phase; the full gate runs at phase-merge time.

---

## Self-Review (completed by plan author)

- **Spec coverage:** §3 flag resolver → Task 1. §4a optional-`tx` threading through the 8 wrappers → Task 2. (§4b caller wiring, §5 derivation, §7 reconcile, §8 harness, §9 rogue writer are later phases P4-2…P4-6, each its own plan.)
- **Placeholder scan:** none — all code shown in full; the only "apply the same transform" instruction (Task 2 Step 4) is accompanied by a complete worked example and an exact mechanical rule.
- **Type/name consistency:** resolver exports (`LEDGER_AUTHORITATIVE_MODES`, `DEFAULT_LEDGER_MODE`, `LEDGER_MODE_SETTINGS_KEY`, `normalizeLedgerMode`, `envLedgerMode`, `resolveLedgerModeForTenant`) are used identically in the test and impl; `runPosting(tx, tenantId, entryArgs)` signature matches its call sites; settings key `ledger_authoritative_mode` matches the spec §3.
