# Money Ledger Phase 4 — Flip Authoritative (flag-gated) — Design Spec

- **Date:** 2026-06-29
- **Status:** Design approved (brainstorm); pending written-spec review
- **Epic:** T2 #1 (ROADMAP §0) — the final phase of the double-entry money ledger.
- **Builds on:** `docs/superpowers/specs/2026-06-23-double-entry-money-ledger-design.md` (the substrate spec — §5 "cache sync", §7 item 4 "flip authoritative"). This realizes that spec's original same-tx + derived-column end-state, which Phases 1–3 deliberately deferred.
- **Precedent reuse:** `apps/backend/src/services/security/careTeamEnforcement.js` (the per-tenant `off`/`shadow`/`enforce` mode resolver) and `apps/backend/src/utils/clinical/vitalSignMonitor.js` (the `Sentry.captureException({ level: 'fatal' })` hard-alert pattern).

## 1. Objective

Make the double-entry ledger the **authoritative source of truth** for money state, replacing the legacy independent recompute — **behind a default-OFF, per-tenant feature flag**, so the change is safe to merge with zero behavior change and the flip is an operator decision gated on production reconciliation evidence.

"Authoritative" here means three concrete things, all gated by the flag:
1. **Atomic posting** — the ledger post moves from post-commit best-effort (today's "Phase 1.5" pattern) to **same-transaction** with the legacy money write. A ledger failure now *rolls back the money movement* instead of silently diverging.
2. **Ledger-derived columns** — the legacy `amount_paid` / `amount_due` / `status` (on `billing_invoices`) and `balance` (on `billing_advances`) are **materialized from `ledger_balances`** instead of from an independent `SUM(billing_payments)` recompute. The columns stay physically present and written, so **every reader is untouched** (see §6).
3. **Drift → hard alert** — the reconciliation job's drift signal becomes a `Sentry` fatal + a Prometheus counter (instead of `logger.warn`), and the reconcile gains an independent **ledger-vs-events** oracle (since "column == ledger" is now tautological).

## 2. Decisions (from brainstorm 2026-06-29)

| # | Decision | Rationale |
|---|---|---|
| P4-D1 | **Derive columns from the ledger** (substrate-spec Approach B), not keep-as-independent-cache (A). | User chose the spec's literal end-state: ledger is the real source of truth; the parallel `SUM(billing_payments)` recompute is dropped under enforce. |
| P4-D2 | **B1 — app-side materialization** (mode-aware recompute), not B2 (DB trigger). | A DB trigger is global and cannot honor a per-tenant `shadow`/`enforce` mode — it would derive from an incomplete ledger for shadow tenants. App-side keeps the flip per-tenant and testable in both modes. |
| P4-D3 | **Per-tenant 3-mode flag (`off`/`shadow`/`enforce`), default `shadow`** in `tenants.settings` JSONB + `LEDGER_AUTHORITATIVE_MODE` env override. **No migration.** | Mirrors `careTeamEnforcement.js` exactly. `shadow` == today's behavior → safe merge. Per-tenant enables staged rollout (test tenant first). |
| P4-D4 | **`amount_due = (PATIENT_AR + INSURANCE_AR)` balance for the invoice**, not `PATIENT_AR` alone. | The Phase-3c insurance two-step shifts AR from PATIENT_AR→INSURANCE_AR at *approval*; deriving from PATIENT_AR alone would wrongly drop the patient's due before the insurer pays. The sum preserves legacy semantics (due only falls on actual payment). Also fixes a latent under-report in the current PATIENT_AR-only reconcile. |
| P4-D5 | **Drift is a hard ALERT, not an API block.** | Under enforce, same-tx atomicity prevents *new* drift (ledger + event commit together). Residual drift means a code bug → alert loudly; but halting a hospital's live billing on a reconcile signal is more dangerous than the drift. No `collectPayment`-fails-on-drift behavior. |
| P4-D6 | **Drop the per-write `cache == ledger` assertion** considered for Approach A. | Under B the column *is* derived from the ledger, so the assertion is tautological. The in-tx guard is the existing DB constraints (balanced net-to-zero + no-negative, substrate §4); the systemic guard is the periodic ledger-vs-events reconcile. |
| P4-D7 | **Include 4e — close the `ipdSupportService` rogue writer** in this phase. | It is the only cache-column writer outside `billingV2Service`; under enforce it would produce permanent, hard-alerting advance drift. Enforce correctness requires it. |

## 3. The feature flag — `ledgerAuthoritativeMode`

New module `apps/backend/src/services/billing/ledger/ledgerAuthoritativeMode.js`, a near-verbatim copy of `careTeamEnforcement.js`:

```
LEDGER_AUTHORITATIVE_MODES = { OFF: 'off', SHADOW: 'shadow', ENFORCE: 'enforce' }
DEFAULT_MODE = 'shadow'
SETTINGS_KEY = 'ledger_authoritative_mode'          // on tenants.settings JSONB
env override  = process.env.LEDGER_AUTHORITATIVE_MODE
resolveLedgerModeForTenant(tenantId) -> Promise<'off'|'shadow'|'enforce'>   // fail-safe to default
```

Resolution order (fail-safe to `shadow` on any error): (1) `tenants.settings.ledger_authoritative_mode`, (2) `LEDGER_AUTHORITATIVE_MODE` env, (3) `'shadow'`. Resolved **once per money operation, before the write tx opens** (the lookup is `getTenantById`, 60s-cached), then passed down to the posting + recompute layer.

### Mode → behavior matrix

| Concern | `off` | `shadow` (default = today) | `enforce` (the flip) |
|---|---|---|---|
| Ledger post | none | post-commit best-effort (own tx, swallowed try/catch) | **same-tx** with the legacy write; failure rolls back the money movement |
| Legacy columns | legacy recompute | legacy recompute (`Σ billing_payments`) | **derived from `ledger_balances`** |
| Reconcile drift | n/a | `logger.warn` (informational) + persisted to evidence table | **`Sentry` fatal + counter** + persisted |
| Behavior change vs today | ledger goes dark | **none** | ledger authoritative |

`off` exists as an emergency kill-switch (pre-Phase-1 behavior); it is not part of the rollout path.

## 4. Same-tx posting (4a + 4b)

### 4a — thread an optional `tx` through the posting layer
- `postLedgerEntry(tx, …)` already takes a `tx` (substrate). Make the **8 posting wrappers** in `apps/backend/src/services/billing/ledger/ledgerPostings.js` accept an optional `tx`: when provided, call `postLedgerEntry(tx, …)` directly (same-tx); when absent, open their own `setTenantTx` exactly as today (post-commit best-effort). No caller changes in 4a → shadow path byte-identical.

### 4b — enforce-mode wiring in each money-write caller
The 9 callers (`issueInvoice`, `collectPayment`, `collectAdvance`, `settleAdvance`, `reversePayment`, `approveRefund`, `markRefundPaid` in `billingV2Service.js`; `markPaymentLinkPaid` in `paymentLinkService.js`; `recordClaimDecision` in `claimsService.js`) resolve `mode` and branch:

- **`shadow`/`off`:** the exact current code path is preserved (legacy write; then post-commit best-effort post or none). **Zero regression risk.**
- **`enforce`:** the legacy write **and** the ledger post run in **one `setTenantTx`**, passing `tx` down. Three callers (`issueInvoice`, `collectAdvance`, `approveRefund`) currently have no wrapping tx and gain one. The `markPaymentLinkPaid` → `collectPayment({ tx })` coordination is made explicit via a `skipLedgerPost` flag so the post happens exactly once, in-tx.

Within an enforce tx the ordering is deterministic: **insert event row → `postLedgerEntry(tx)` → `ledger_balances` maintenance trigger fires (substrate §4.2) → recompute reads `ledger_balances` → writes the derived column.**

## 5. Ledger-materialized columns (4c, mechanism B1)

`recomputeInvoicePaymentStateTx` (and the advance-balance writes in `settleAdvance` / `markRefundPaid` / the 4e IPD path) become **mode-aware**:

- **`shadow`/`off`:** unchanged — `amount_paid = Σ(billing_payments not reversed) + Σ(settlements)`, `amount_due = total_amount − amount_paid`.
- **`enforce`:** derived from the ledger (exact, integer paise → rupees `/100`, per substrate D3):
  - `amount_due_paise = COALESCE(SUM(ledger_balances.balance_paise), 0)` over accounts **`PATIENT_AR` + `INSURANCE_AR`** for `invoice_id = :id` (P4-D4).
  - `amount_due = amount_due_paise / 100`; `amount_paid = total_amount − amount_due`.
  - `status` derived from `amount_due` via the existing status thresholds (0 → `PAID`; `0 < due < total` → `PARTIALLY_PAID`; `due == total` → `ISSUED`).
  - `billing_advances.balance = PATIENT_ADVANCE balance_paise(advance_id) / 100`.

The columns are still `UPDATE`-written, so all readers (§6) are untouched. The difference from today is purely the **source** of the value.

**Derivation correctness (walkthrough, all preserve legacy semantics):** issue → AR = total, INSURANCE_AR = 0 ⇒ due = total; insurance approval → AR −= approved, INSURANCE_AR += approved ⇒ sum unchanged ⇒ due unchanged (matches legacy: no payment row, due holds); insurer pays → INSURANCE_AR −= paid ⇒ due falls; patient pays → AR −= paid ⇒ due falls; refund approve → AR += refund ⇒ due rises; payment reversal → AR += amount ⇒ due rises.

## 6. Reader blast-radius — why B is reader-safe here

Because the columns remain physically written (materialized), **every consumer of `amount_paid`/`amount_due`/`balance` is unchanged**. Verified readers (left intact):
- **Money-critical backend:** `billingV2Service` validation reads (`collectPayment` due-check, `raiseRefund` headroom, `settleAdvance`), `revenueCycleRoutes` AR-aging, `admissionService` discharge gate, `clinicalPdfGenerator` final-bill PDF, `patientPortalService`.
- **UI (cosmetic):** admin `InvoicesV2Tab.tsx`; patient `bills_screen.dart`; staff `billing_payment_dialog.dart` / `billing_desk_screen.dart` / `front_office_workbench_screen.dart`.

Under enforce, the money-critical *validation* reads (e.g. payment ≤ `amount_due`) are now validating against a ledger-derived number — that is the intended effect of B; the DB invariants (substrate §4) remain the ultimate guard against an invalid commit.

## 7. Reconciliation: events-oracle + hard alert (4d, part 1)

Under enforce, "column == ledger" is tautological, so `reconcileLedger` (`apps/backend/src/services/billing/ledger/ledgerReconciliation.js`) gains an **independent ledger-vs-events oracle**:
- **Events recompute (independent of the ledger):** per ISSUED invoice, `events_due_paise = round((total_amount − Σ(billing_payments not reversed) − Σ(billing_advance_settlements) + Σ(refunds restoring AR)) * 100)`.
- **Ledger value:** `(PATIENT_AR + INSURANCE_AR) balance_paise(invoice)` (P4-D4 — also corrects today's PATIENT_AR-only check, which under-reports on insurance invoices).
- **Drift** = any invoice where events ≠ ledger, plus the **advance dimension** (`billing_advances.balance` vs `PATIENT_ADVANCE` per advance, newly covered for 4e), plus the existing **trial balance `Σ == 0`**.

Drift handling, mode-scoped:
- **`shadow`:** `logger.warn` (as today) — informational, drives flip-readiness.
- **`enforce`:** `logger.error` **+** `Sentry.captureException(new Error('Ledger reconciliation drift'), { level: 'fatal', tags: { subsystem: 'billing_ledger', severity: 'CRITICAL' }, extra: { tenantId, … } })` **+** increment `ledger_reconciliation_drift_total` (new counter in `apps/backend/src/observability/reliabilityMetrics.js`, surfaced at `GET /metrics`). **No API block (P4-D5).**

## 8. Reconciliation evidence harness (4d, part 2)

The flip's gate is "production reconciliation runs clean for long enough." Make that **objective and queryable**:
- **Migration (next sequential — 349 at time of writing)** `reconciliation_checks` (append-only, `tenant_id` + RLS): `id, tenant_id, swept_at, invoice_mismatch_count, advance_mismatch_count, unwired_count, trial_balance_paise, events_drift_count, passed bool`. The reconcile cron writes one row per tenant per sweep.
- **Operator report** `apps/backend/scripts/ledger-reconciliation-evidence.mjs`: for a tenant, summarizes the last N sweeps — `cleanStreak`, `spanDays`, first/last drift — printing a clear **FLIP-READY / NOT-READY** verdict against thresholds (default: ≥ a configurable clean streak over ≥ a configurable span). This is the evidence an operator attaches before setting `ledger_authoritative_mode = enforce`.

## 9. Close the rogue writer (4e)

`apps/backend/src/services/ipd/ipdSupportService.js` (advance-refund, ~L441–449) decrements `billing_advances.balance` with **no ledger post**. Fix:
- Under **enforce**, post a balanced advance-refund entry in the same tx — **debit `PATIENT_ADVANCE` / credit `CASH`|`BANK`** by the refund paise (an advance refund reduces the advance liability and pays out), idempotency key `ipd-advance-refund-<refundRowId>`. The `billing_advances.balance` is then derived from `PATIENT_ADVANCE` (per §5), so the direct `UPDATE` is replaced by the derive on the enforce path.
- Under **shadow/off**, the current direct `UPDATE` is preserved.
- The reconcile advance-dimension coverage (§7) now includes this movement.

## 10. Testing strategy (authoritative chunked `postgres` gate)

New deep test files (`apps/backend/src/tests/money-ledger-phase4-*.deep.test.js`) — **the new files bump the jest chunk count; update the stall-monitor `Chunk N/M` patterns** (precedent: Phase 3a bumped 88→89):
- **Mode resolver** (unit): per-tenant settings > env > default; fail-safe to `shadow` on lookup error.
- **`shadow` unchanged:** inject a `postLedgerEntry` failure → the money movement **still commits** (legacy row present); columns from legacy recompute. (Regression guard.)
- **`enforce` atomicity:** inject a `postLedgerEntry` failure → the **whole tx rolls back** (no `billing_payments` row, `amount_due` unchanged).
- **`enforce` derivation:** after a payment, `amount_due`/`amount_paid`/`status` equal the ledger-derived values; **insurance two-step** holds `amount_due` at total through approval, drops it only on insurer payment (P4-D4).
- **`enforce` advance:** settle + IPD refund (4e) → `billing_advances.balance` matches `PATIENT_ADVANCE`; reconcile clean.
- **Reconcile oracle + alert:** seed a ledger-vs-events divergence → `enforce` fires Sentry fatal + increments the counter (both mocked); `shadow` only warns.
- **Evidence harness:** a sweep persists a `reconciliation_checks` row; the report computes `cleanStreak`/verdict.
- **Property-style:** a random sequence of valid movements keeps trial balance `== 0` and events == ledger under `enforce`.

## 11. Sub-phase sequencing (each = its own plan, `postgres` gate, both remotes; all merge with default `shadow` = zero behavior change)

1. **P4-1 (4a)** — `ledgerAuthoritativeMode.js` resolver + thread optional `tx` through the 8 posting wrappers.
2. **P4-2 (4b)** — enforce-mode same-tx wiring in the 9 callers; `skipLedgerPost` coordination for payment-links.
3. **P4-3 (4c)** — mode-aware ledger-materialized columns (invoice `(PATIENT_AR+INSURANCE_AR)`, advance `PATIENT_ADVANCE`) + status derivation.
4. **P4-4 (4d.1)** — reconcile events-oracle + advance coverage + drift→Sentry-fatal + `ledger_reconciliation_drift_total` metric.
5. **P4-5 (4d.2)** — `reconciliation_checks` migration + cron persistence + `ledger-reconciliation-evidence.mjs` report.
6. **P4-6 (4e)** — close `ipdSupportService` rogue writer (enforce-mode ledger post + derive).

## 12. Out of scope (YAGNI / future)

- **Dropping the `billing_payments`/settlement event tables** — they remain the immutable event log and the reconcile's independent oracle; the ledger derives from them at posting time, it does not replace them.
- **Migrating legacy `numeric(12,2)` columns to paise** (substrate D3 stands).
- **Computed/generated columns or a DB trigger for derivation** (P4-D2 rejected B2).
- **Blocking the API on drift** (P4-D5 — alert only).
- **The operator flip itself** — flipping any tenant to `enforce` in production is an operator action gated by the §8 evidence, not part of this code work; the platform is not yet deployed.

## 13. Risks & mitigations

- **Live money path regression:** every change merges with default `shadow` = byte-identical current behavior; the shadow path is preserved verbatim (not refactored through a shared codepath) and covered by a regression test (§10).
- **Enforce derivation bug corrupts a column:** same-tx atomicity means a posting/derive failure rolls back the movement rather than committing a wrong number; the independent events-oracle reconcile + fatal alert catch any systemic divergence; the flip is gated on the §8 evidence before any tenant goes enforce.
- **Insurance semantics:** P4-D4 derivation is walked through in §5 and pinned by an explicit insurance two-step test.
- **`ledger_balances` read-after-write within the tx:** the maintenance trigger is `AFTER INSERT` immediate (substrate §4.2), so the derived read sees the just-posted balance in the same tx.
- **Per-operation mode lookup cost:** `getTenantById` is 60s-cached; resolved once per operation before the tx opens.
