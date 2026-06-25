// src/lib/api/ledgerReports.ts
// General Ledger report API functions for the admin portal (T2 ledger Phase 5b).
// Read-only, finance-gated reports over the double-entry ledger. Mirrors billing.ts.

import { getJSON } from "./core";
import { API_ENDPOINTS } from "../api-config";
import type { ApiData } from "@/lib/openapi-data";

// ── Types (spec-derived) ───────────────────────────────────────────
// OpenAPI Phase 5: these are derived from the canonical spec via `ApiData`
// (the unwrapped `.data` payload) instead of hand-authored, so they can no
// longer drift from the backend. Sub-types come from indexed access.

export type TrialBalance = ApiData<"/api/v1/admin/ledger/trial-balance", "get">;
export type TrialBalanceAccount = TrialBalance["accounts"][number];
export type LedgerAccountType = TrialBalanceAccount["type"];

export type AgingReport = ApiData<"/api/v1/admin/ledger/ar-aging", "get">;
export type AgingBucket = AgingReport["buckets"][number];
export type AgingBucketLabel = AgingBucket["bucket"];

export type CashPosition = ApiData<"/api/v1/admin/ledger/cash-position", "get">;
export type DrawerPosition = CashPosition["byDrawer"][number];

export type DailyCollection = ApiData<"/api/v1/admin/ledger/daily-collection", "get">;
export type DailyCollectionDay = DailyCollection["days"][number];

// ── API Functions ──────────────────────────────────────────────────

/** Trial balance: normal-direction balance per account + balanced flag. */
export function getTrialBalance() {
  return getJSON<TrialBalance>(API_ENDPOINTS.admin.ledger.trialBalance);
}

/** Patient AR aging buckets. */
export function getArAging() {
  return getJSON<AgingReport>(API_ENDPOINTS.admin.ledger.arAging);
}

/** Insurer AR aging buckets. */
export function getInsurerAging() {
  return getJSON<AgingReport>(API_ENDPOINTS.admin.ledger.insurerAging);
}

/** Cash + bank position with per-drawer breakdown. */
export function getCashPosition() {
  return getJSON<CashPosition>(API_ENDPOINTS.admin.ledger.cashPosition);
}

/** Daily CASH/BANK collection over an optional [from,to] date range. */
export function getDailyCollection(params?: { from?: string; to?: string }) {
  return getJSON<DailyCollection>(API_ENDPOINTS.admin.ledger.dailyCollection, {
    from: params?.from,
    to: params?.to,
  });
}
