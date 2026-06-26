# Weekly Error-Pattern Scan — 2026-06-26

**Scan window:** last 14 days (2026-06-12 → 2026-06-26)  
**MCP status:** `vh-mcp-postgres` connector unavailable — fallback to git diff review  
**Commits scanned:** 8 (all touching `apps/backend/src/services/` or `apps/backend/src/middleware/`)

---

## Summary

No live production error-log data was available (MCP unreachable). The code-review
path surfaced **3 recently fixed production bugs** and **2 new best-effort error
suppression patterns** that carry ongoing observability risk.

---

## Fixed this week (already resolved)

### 1. `payrollService.js` — three silent-catch return-type bugs (commits `19612fa`, `a02877a`)

**Severity: High (production impact)**

Three `.catch()` callbacks on `$queryRawUnsafe` calls were returning an object
(`{ rows: [] }` or `{ rows: [{ leave_days: 0 }] }`) instead of a plain array.
Prisma's `$queryRawUnsafe` always yields a plain row array, so the downstream
code (`for (const adv of advanceRes)`, `attRes[0]?.days_present`, etc.) saw an
object. This caused:

- Attendance query: `attRes[0]?.days_present` evaluated to `undefined` → 0 days present on every payslip.
- Advance deduction loop: `for (const adv of advanceRes)` threw `TypeError: advanceRes is not iterable` → 0 deductions on every payslip.
- Leave deduction: `leaveRes[0]?.leave_days` evaluated to `undefined` → 0 leave days deducted.

Net effect: **every payroll run silently produced ₹0-adjusted payslips for all staff**.
No error was thrown or surfaced to admins.

**Fix applied:** all three `.catch(() => ...)` now return arrays (`[]` or
`[{ leave_days: 0 }]`). Also corrected wrong column names that caused
`42703` PostgreSQL errors that the catches were swallowing.

**Lingering risk:** the original bugs were swallowed silently for an unknown
duration before the fix. There is no indication that a historical payslip audit
has been run to detect affected records.

---

### 2. `staffAccessDecisionService.js` — UUID regex rejected every valid UUID (commit `19612fa`)

**Severity: High (production impact)**

`UUID_RE` was missing the third hex group (`[0-9a-f]{3}-`), causing `cleanUuid`
to return `null` for every RFC-4122 UUID. All by-staffUid payroll targets
(salary, advances, revisions, FnF, leave-encashment) returned `403`.

**Fix applied:** corrected UUID regex.

---

## New patterns introduced this week (ongoing risk)

### 3. `paymentLinkService.js` — best-effort ledger post after payment-link paid (commit `5e1fedf`)

**File:** `apps/backend/src/services/billing/paymentLinkService.js`  
**Pattern:** post-commit `try/catch` that silently swallows ledger failures.

```js
try {
  await postPaymentEntry({ payment, tenantId: requireTenantId(tenantId) });
} catch (ledgerErr) {
  logger.error('Ledger PAYMENT post (payment-link) failed (non-blocking)',
    { payment_id: payment?.id, error: ledgerErr.message });
}
```

**Risk:**
- If `postPaymentEntry` fails, the payment is recorded but the GL BANK debit entry
  is silently skipped. The logger emits an error-level line, but there is no
  Sentry capture, no dead-letter queue, and no retry mechanism.
- `payment?.id` uses optional chaining — if `payment` is undefined at catch time,
  the logged `payment_id` will be `undefined`, making the log hard to trace.

**Recommendation:** add `Sentry.captureException(ledgerErr)` inside the catch, or
route to a dedicated ledger reconciliation alert. Consider a periodic reconciliation
job that compares `payments` rows against `gl_journal_entries` to surface any gaps.

---

### 4. `claimsService.js` — best-effort AR shift on insurer approval (commit `ae751ed`)

**File:** `apps/backend/src/services/insurance/claimsService.js`  
**Pattern:** same post-commit best-effort pattern.

```js
try {
  await postInsuranceShiftEntry({ claim: { ... }, tenantId });
} catch (ledgerErr) {
  logger.error('Ledger INSURANCE_SHIFT post failed (non-blocking)',
    { claim_id: updated.id, error: ledgerErr.message });
}
```

**Risk:**
- On insurer approval, the PATIENT_AR → INSURANCE_AR receivable shift is
  silently skipped if `postInsuranceShiftEntry` throws. This would leave
  PATIENT_AR overstated and INSURANCE_AR understated in the GL, with no
  automated alert.
- Like pattern 3, there is no Sentry capture or retry.

**Recommendation:** same as pattern 3 — add Sentry capture inside the catch and/or
a reconciliation check between `claims` (approved/partially_approved) and
`gl_journal_entries` (INSURANCE_AR entries).

---

## No changes found

- `errorHandlerMiddleware.js` — no changes in window.
- All other middleware files — no changes in window.
- No `AppError` calls were removed in any commit.
- No `console.error` calls were added (all new logging uses `logger.error`).

---

## Recommendations (priority order)

1. **Audit historical payslips** for the period when the three catch-return-type
   bugs were live. If payroll ran and produced ₹0 adjustments, affected staff
   need corrected payslips.

2. **Add Sentry captures** to the two new best-effort ledger catch blocks
   (`paymentLinkService.js`, `claimsService.js`). Silent GL gaps are hard to
   detect until month-end reconciliation.

3. **Add a GL reconciliation check** (periodic job or admin dashboard widget)
   that flags `payments` rows with no matching BANK `gl_journal_entry` and
   `claims` rows with `approved_amount > 0` and no INSURANCE_AR entry.

4. **Fix `payment?.id`** in the `paymentLinkService` catch — `payment` is
   always in scope there (it's returned from `$transaction`), so the `?` is
   misleading and will log `undefined` if the variable is somehow unset. Use
   `payment.id` and let the outer catch surface a clear error if `payment` is
   unexpectedly null.

5. **Install a test** that exercises the payroll `.catch()` fallback paths
   (simulate a DB error mid-query) to prevent regression to the silent-zero bug.
