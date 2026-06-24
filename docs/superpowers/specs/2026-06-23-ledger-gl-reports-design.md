# Money Ledger — Phase 5 (GL Reports) Design Spec

- **Date:** 2026-06-23
- **Status:** Design approved (sections 1–4); pending written-spec review
- **Epic:** T2 #1 money ledger, Phase 5. The shadow ledger is movement-complete (Phases 1–3c + tail); this surfaces it as standard finance reports.
- **Ledger spec:** `docs/superpowers/specs/2026-06-23-double-entry-money-ledger-design.md` (§7 phase 5).

## 1. Objective

Make the (until now invisible) double-entry ledger useful: read-only **General Ledger reports** in the admin portal — trial balance, AR aging, insurer-AR aging, cash position, and a ledger-derived daily-collection. Full-stack v1: backend report endpoints + one admin page rendering them.

## 2. Scope decision

Full-stack, all five reports (user choice). Backend report functions are pure (tenant → data) and deep-tested on the `postgres` gate; the UI is a thin consumer (admin jest + `next build`). No migrations — pure reads over the existing ledger tables. Read-only — no writes, no flip of authoritative state (that's the deferred Phase 4).

## 3. The reports

All tenant-scoped (`setTenant`), amounts converted integer-paise → ₹ string at the edge (`fromPaise`).

| Report | Definition | Source |
|---|---|---|
| **Trial balance** | normal-direction balance per account + signed total (must be 0 → `balanced` boolean self-check). | `ledger_balances` GROUP BY `account_id` JOIN `ledger_accounts` |
| **AR aging** | outstanding `PATIENT_AR` per invoice, bucketed by invoice age (NOW − `issued_at`): 0–30 / 31–60 / 61–90 / 90+ days. Per bucket: invoice count + total ₹; + grand total. | `ledger_balances`(PATIENT_AR, invoice_id, balance>0) JOIN `billing_invoices`.issued_at |
| **Insurer-AR aging** | same shape for `INSURANCE_AR` (insurer receivables, aged by the invoice `issued_at`). | `ledger_balances`(INSURANCE_AR, invoice_id) JOIN `billing_invoices`.issued_at |
| **Cash position** | current `CASH` balances (by drawer session) + `BANK` balance. | `ledger_balances`(CASH/BANK) JOIN `ledger_accounts` |
| **Daily collection (ledger-derived)** | `CASH`+`BANK` debits (money received) from `PAYMENT`/`INSURANCE_SETTLE` entries grouped by `occurred_at::date` over a `[from,to]` range. | `ledger_postings`(account CASH/BANK, amount_paise>0) JOIN `ledger_entries`.occurred_at/entry_type |

Aging buckets: `width_bucket`-style CASE on `EXTRACT(DAY FROM NOW() − i.issued_at)`. Bucket boundaries are constants (`AR_AGING_BUCKETS = [30,60,90]`), not magic numbers in SQL.

## 4. Backend architecture

- **`apps/backend/src/services/billing/ledger/ledgerReportsService.js`** — one exported async function per report: `trialBalance(tenantId)`, `arAging(tenantId)`, `insurerAging(tenantId)`, `cashPosition(tenantId)`, `dailyCollection(tenantId, { from, to })`. Each opens `setTenant(tenantId, …)` and runs one set-based query; returns a plain JSON-able object with ₹ strings + paise where useful. Pure, no Express.
- **`apps/backend/src/routes/admin/ledgerReportsRoutes.js`** — a new isolated sub-router mounted at `/ledger` in `routes/admin/index.js` (one `router.use('/ledger', ledgerReportsRoutes)` line; does NOT touch the dashboard god-router). Thin controllers call the service and `success(res, data, msg)`. RBAC: `wrapAutoRBAC` gated to finance roles (FINANCE_INCHARGE / ADMIN / SUPER_ADMIN) — reuse the existing role config key pattern used by other admin financial routes; PHI-light (aggregate money, patient ids only on the aging drill rows).
- Endpoints (GET): `/api/v1/admin/ledger/trial-balance`, `/ar-aging`, `/insurer-aging`, `/cash-position`, `/daily-collection?from=&to=`.

## 5. Frontend architecture

- **`apps/admin/src/services/ledgerReports.ts`** — typed client: one fetch fn per endpoint (returns the report DTO). Uses the admin's existing API-fetch helper + auth.
- **`apps/admin/src/app/(with-auth)/dashboard/billing/ledger/page.tsx`** — the "General Ledger" page. Finance-role-gated (mirror the existing billing page's gating). Renders the 5 reports as collapsible sections / tabs top-to-bottom: trial balance (with the balanced badge) → AR aging table → insurer-AR aging table → cash position → daily-collection (date-range picker, table). Each section fetches independently (a `useLedgerReports` hook or per-section fetch) so one failing report shows an inline error without blocking the rest. Empty states for "no data."
- Tables use the admin's existing table/section components; no charting in v1 (a daily-collection bar/sparkline is a documented nice-to-have).

## 6. Testing

- **Backend deep test** `apps/backend/src/tests/money-ledger-reports.deep.test.js`: seed a known ledger state (issue 2 invoices of known totals/ages, pay one partially, approve an insurer claim), call each report fn, assert exact numbers — trial-balance `balanced === true` + per-account totals; AR-aging bucket totals + grand total; insurer-aging; cash-position CASH/BANK; daily-collection day totals. Runs on the `postgres` gate.
- **Frontend test** `apps/admin/src/__tests__/dashboard/billing/ledgerPage.test.tsx`: mock `ledgerReports.ts`, assert each section renders its rows, the balanced badge, and an empty state; `next build` clean.

## 7. Out of scope (YAGNI / future)

- Charts/visualisations (tables only in v1).
- Export to CSV/PDF (fast-follow).
- Drill-through from a report row into the underlying postings (the postings exist; a drill UI is later).
- Any write/flip of ledger-authoritative state (Phase 4, deferred).
- Period-close / fiscal-period locking.

## 8. Risks & mitigations

- **Report query perf** on a large ledger: each is a single grouped scan over `ledger_balances` (small, one row per account/dimension) or a bounded `ledger_postings` range (daily-collection by date) — indexed; fine at expected scale. If `ledger_postings` grows huge, the daily-collection query is the only full-postings scan and is date-bounded.
- **Tenant isolation:** every report function runs inside `setTenant` (RLS-scoped); the admin endpoints are finance-role-gated + tenant-context-middleware'd like the rest of the admin surface.
- **UI half-coverage:** the financial correctness lives in the backend (gate-tested); the UI is rendering only, so the lighter jest coverage is acceptable.
