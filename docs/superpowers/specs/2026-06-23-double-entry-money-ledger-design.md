# Double-Entry Money Ledger — Design Spec

- **Date:** 2026-06-23
- **Status:** Design approved (sections 1–5); pending written-spec review
- **Epic:** T2 #1 (ROADMAP §0) — "Double-entry ledger as money source-of-truth with DB-enforced invariants + integer paise."
- **Audit origin:** `docs/CODEBASE_ANALYSIS_2026-06-22.md` — money was flagged as "the biggest structural upgrade"; this kills the overpayment / lost-update / negative-balance bug classes at the DB layer.

## 1. Objective

Make money correctness **structurally enforced by the database**, and give VH Health a real **accounting general ledger** (chart of accounts + trial balance + AR aging + cash/bank reconciliation) derived from the same postings.

Two thrusts:
1. **Correctness substrate** — every money movement is a balanced double-entry; account balances are derived from immutable postings; over-payment / advance-overdraw / over-refund and lost-update become **uncommittable** at the DB layer (not app discipline); all ledger arithmetic is exact integer paise (no float).
2. **Financial GL** — a small fixed chart of accounts with posting *dimensions* (patient/invoice/advance) yields trial balance, AR aging, and cash/bank reconciliation directly from the ledger.

## 2. Decisions (from brainstorm)

| # | Decision | Rationale |
|---|---|---|
| D1 | **Correctness + financial GL** (not correctness-only) | User wants the accounting GL value too. |
| D2 | **Ledger-authoritative + synced cache** (not big-bang drop, not shadow-only) | Incremental rollout on a live money path; the existing `amount_paid/amount_due/balance` columns stay as a derived cache so the billing UI/reports are unchanged; a reconciliation job asserts `cache == Σpostings`. |
| D3 | **Ledger in BIGINT paise; legacy stays `numeric(12,2)`** | Contains the integer representation to the new ledger + posting layer; legacy display columns derive exactly (`paise/100`). No app-wide column migration. |
| D4 | **Opening-balance cutover** (not full backfill, not forward-only) | Standard accounting practice; bounded, low-risk migration; GL/trial-balance correct from t0; historical line detail stays linkable in legacy tables. |

The current money model that this backs: amounts are exact `numeric(12,2)` in Postgres but the **float risk is app-side** (`Number()` / `toFixed2`); balances are **denormalized mutable** columns recomputed by `recomputeInvoicePaymentStateTx` (invoice) and in-place decrement (advance). Money movements: `collectPayment`/`reversePayment`, `collectAdvance`/`settleAdvance`, the refund lifecycle (`raiseRefund`→approve→`markRefundPaid`), `issueInvoice`/`voidInvoice`, and insurance settlements (`tpa_claims`/`insurance_claims`). All in `apps/backend/src/services/billing/billingV2Service.js`.

## 3. Architecture — chart of accounts + posting model

**Four new tables**, all `tenant_id` + `tenant_isolation` RLS (mig-075/239 pattern) + literal-default-tenant insert default; postings/entries **append-only** (mig-324 `clinical_audit_events` pattern).

### 3.1 `ledger_accounts` — chart of accounts (small, fixed per tenant)
`type` ∈ {ASSET, LIABILITY, REVENUE, CONTRA, EQUITY} fixes the normal-balance sign.

| code | type | meaning |
|---|---|---|
| `PATIENT_AR` | ASSET | patient accounts receivable |
| `CASH` | ASSET | physical cash (dimension: drawer session) |
| `BANK` | ASSET | electronic receipts (dimension: mode UPI/CARD/NETBANKING/…) |
| `PATIENT_ADVANCE` | LIABILITY | unapplied patient advances/deposits |
| `INSURANCE_AR` | ASSET | insurer/TPA receivable |
| `TAX_PAYABLE` | LIABILITY | GST collected, owed to authority |
| `REFUNDS_PAYABLE` | LIABILITY | approved refunds not yet paid |
| `WRITE_OFF` | CONTRA | bad-debt / discount write-offs |
| `REVENUE` | REVENUE | billed services revenue |
| `OPENING_EQUITY` | EQUITY | cutover counter-account (absorbs opening balances) |

### 3.2 `ledger_entries` — journal headers (one per money event)
`id, tenant_id, entry_type, occurred_at, created_by, idempotency_key (UNIQUE per tenant), reverses_entry_id NULLABLE, metadata jsonb, created_at`.
`entry_type` ∈ {PAYMENT, PAYMENT_REVERSAL, ADVANCE_COLLECT, ADVANCE_SETTLE, REFUND_RAISE, REFUND_PAID, INVOICE_ISSUE, INVOICE_VOID, INSURANCE_SETTLE, OPENING_BALANCE, REVERSAL}.

### 3.3 `ledger_postings` — balanced debit/credit lines
`id, entry_id (FK), tenant_id, account_id, amount_paise BIGINT (signed: +debit / −credit)`, plus indexed **dimensions** for sub-ledgers: `patient_uid, invoice_id, advance_id, payment_id, cash_drawer_session_id`.

**Modeling choice:** ONE `PATIENT_AR` account, not one per patient. A patient/invoice balance = `Σ amount_paise WHERE account=PATIENT_AR AND patient_uid=… [AND invoice_id=…]`. Tiny fixed chart; per-entity sub-ledgers via dimensions; trial balance = `GROUP BY account_id`.

### 3.4 `ledger_balances` — running balance per (account, dimension)
`tenant_id, account_id, patient_uid NULLABLE, invoice_id NULLABLE, advance_id NULLABLE, balance_paise BIGINT`, unique on the (account + dimension) key. Trigger-maintained (§4.2). Hosts the no-negative CHECK constraints and gives O(1) balance reads.

**Sign convention (load-bearing — keep these two layers distinct):**
- `ledger_postings.amount_paise` is **signed +debit / −credit**. This is what Invariant 1 sums to zero.
- `ledger_balances.balance_paise` is the **normal-direction** balance: for a debit-normal account (ASSET, CONTRA-revenue) it accumulates `+debit/−credit`; for a credit-normal account (LIABILITY, REVENUE, EQUITY) it accumulates `+credit/−debit`. So a *healthy* balance is **non-negative for every account type**, and the maintenance trigger flips the delta sign by the account's normal side. This makes Invariant 2's CHECK a uniform `balance_paise ≥ 0` regardless of account type — overpayment (AR would go credit) and advance-overdraw (advance liability would go debit) both surface as the same `< 0` violation.

**Example — ₹1000 cash payment on invoice I for patient P:**
| account | dimension | amount_paise |
|---|---|---|
| `CASH` | drawer=S | +100000 (debit) |
| `PATIENT_AR` | patient=P, invoice=I | −100000 (credit) |

Σ = 0.

## 4. DB-enforced invariants (the correctness win)

### 4.1 Invariant 1 — postings net to zero (double-entry)
`CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED` on `ledger_postings`, fires **at COMMIT** (postings insert line-by-line; the sum check must run after all lines land), raises and rolls back if any touched `entry_id` has `SUM(amount_paise) ≠ 0`. `postLedgerEntry` also validates app-side (defense in depth), but the trigger is authoritative: an unbalanced entry **cannot commit**.

### 4.2 Invariant 2 — no-negative where it matters (bug-class killers)
An immediate `AFTER INSERT` trigger on `ledger_postings` upserts the **normal-direction** delta into `ledger_balances(account, dimension)` (per the §3.4 sign convention), taking the `ledger_balances` row lock. A **`DEFERRABLE INITIALLY DEFERRED` constraint trigger** then asserts, *at commit*, that the **final** `balance_paise ≥ 0` for the constrained accounts — checking final state, not intermediate, so line insertion order within an entry never matters. (A table `CHECK` can't be used: Postgres CHECKs aren't deferrable and would fire per-row-modification.) The constrained set makes bad states uncommittable:
- `PATIENT_AR` per `(patient, invoice)` → a credit (paid > owed) would drive normal-direction balance `< 0` → **overpayment impossible**.
- `PATIENT_ADVANCE` per `advance_id` → settling more than collected would drive it `< 0` → **advance overdraw impossible**.
- `REFUNDS_PAYABLE` per refund → can't pay out more than was approved.

(`PATIENT_AR` aggregated at the *patient* level may legitimately be a credit balance from a deliberate advance/overpay-then-transfer; the CHECK is scoped to the `(patient, invoice)` dimension where over-applying to a single invoice is the actual bug. Patient-level credit balances live in `PATIENT_ADVANCE`.)

**Lost-update** is closed because the balance upsert row-lock serializes concurrent movements on the same dimension; the second sees the post-first balance and trips the CHECK if it would overpay. This replaces the current app-side `FOR UPDATE` + `>= amt` checks with a DB guarantee.

### 4.3 Invariant 3 — immutability (append-only)
`ledger_entries` / `ledger_postings` get the `clinical_audit_events` treatment: UPDATE/DELETE blocked via trigger guard + REVOKE under the sealed non-superuser prod role. Corrections are **reversal entries** (`reverses_entry_id` posts the inverse) — never edits.

### 4.4 Idempotency + tenancy
`ledger_entries.idempotency_key` UNIQUE per tenant → a replayed movement can't double-post (composes with mig-317/340 payment idempotency). All four tables: `tenant_id` + `tenant_isolation` RLS + literal-default-tenant insert default.

## 5. Posting service, cache sync, reconciliation

**Chokepoint:** `postLedgerEntry(tx, { entryType, occurredAt, idempotencyKey, createdBy, lines, metadata })`, lines = `[{ accountCode, amountPaise, patientUid?, invoiceId?, advanceId?, paymentId?, drawerSessionId? }]`. Validates `Σ === 0`, inserts entry + postings **inside the caller's `setTenantTx`** so the ledger posting and the legacy billing write are atomic together. No ledger write occurs outside a money mutation.

**Cache sync — strangler pattern:**
- **Phases 1–3 (dual-write + verify):** each mutation keeps its current legacy write **and** calls `postLedgerEntry` in the same tx. The ledger runs alongside, validated by reconciliation, not yet authoritative.
- **Phase 4 (flip authoritative):** once reconciliation is clean for a movement type, its legacy column is *derived from* `ledger_balances` (drop the parallel recompute).

**Reconciliation job** (`registerCron` + `withJobLock`, per tenant, `NODE_ENV !== 'test'`): asserts `invoice.amount_paid == −AR(invoice)`, `advance.balance == PATIENT_ADVANCE(advance)`, drawer total == `CASH` postings, and the **global trial balance `Σ all account balances == 0`**. Drift → existing alert tier. This catches any code path that mutates a column without posting.

## 6. Cutover (opening balances)

One-time idempotent migration: for each active account post a balanced `OPENING_BALANCE` entry against `OPENING_EQUITY` — per outstanding invoice: debit `PATIENT_AR` = `amount_due`(paise), credit `OPENING_EQUITY`; per active advance: credit `PATIENT_ADVANCE` = `balance`, debit `OPENING_EQUITY`; cash drawer floats likewise. Result: `ledger_balances` exactly equals today's cache; trial balance == 0 from t0. Idempotent via per-account `idempotency_key`.

## 7. Phasing (each phase = its own plan + `postgres` gate + merge both remotes)

1. **Substrate** — 4 tables + the 3 invariants + `postLedgerEntry` + wire `collectPayment` (dual-write) + reconciliation job + AR opening-balance cutover. Proves end-to-end on one path.
2. **Core movements** — advances (collect/settle), refund lifecycle, invoice issue/void.
3. **Insurance + tax** — TPA/insurance settlements → `INSURANCE_AR`; GST split → `TAX_PAYABLE`.
4. **Flip authoritative** — derive legacy columns from the ledger; no-negative CHECKs as the primary guard.
5. **Finance GL reports** — trial balance, AR aging, cash/bank reconciliation, ledger-derived daily-collection (replaces the app-side float sums in `dailyCollection`).

## 8. Testing strategy (authoritative `postgres` gate)

- **Balanced trigger:** an unbalanced entry (Σ≠0) fails to commit.
- **Overpayment:** a payment exceeding due trips `PATIENT_AR ≥ 0` → rejected (class is uncommittable, proven).
- **Concurrency:** `Promise.allSettled` of two full-due payments → exactly one succeeds, balance never negative (via the `ledger_balances` row-lock).
- **Advance overdraw / over-refund:** CHECK rejects.
- **Append-only:** UPDATE/DELETE on postings blocked.
- **Reconciliation:** legacy column == ledger balance after each movement; trial balance == 0 over a random sequence of valid movements (property-style).
- **Cutover:** after the opening-balance migration on a seeded dataset, `ledger_balances == cache` and trial balance == 0.

## 9. Out of scope (YAGNI / future)

- Multi-currency (single-currency INR; the `paise` minor-unit is INR-specific).
- Accrual revenue recognition beyond billed (no deferred-revenue schedules).
- Migrating the legacy `numeric(12,2)` columns to paise (D3 keeps them; revisit only if a column-level float bug surfaces).
- Replacing `tpa_claims`/`insurance_claims` workflow tables (the ledger *posts from* insurance settlement events; it does not subsume the TPA workflow).

## 10. Risks & mitigations

- **Live money path:** mitigated by the strangler dual-write + continuous reconciliation; the ledger is shadow-validated before it becomes authoritative (Phase 4).
- **Deferred-trigger performance:** the balance check is per-entry at commit; entries have ≤ a handful of postings, so it's O(postings-in-tx), negligible.
- **`ledger_balances` hot-row contention** on a busy invoice/drawer: same contention the current `FOR UPDATE` already has; bounded by per-dimension granularity.
- **Opening-balance correctness:** the cutover migration is reconciled immediately (trial balance == 0 + `ledger_balances == cache` assertion) before Phase-1 go-live.
