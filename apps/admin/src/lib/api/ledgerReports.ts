// src/lib/api/ledgerReports.ts
// General Ledger report API functions for the admin portal (T2 ledger Phase 5b).
// Read-only, finance-gated reports over the double-entry ledger. Mirrors billing.ts.

import { getJSON } from "./core";
import { API_ENDPOINTS } from "../api-config";

// ── Types ──────────────────────────────────────────────────────────

export type LedgerAccountType =
  | "ASSET" | "LIABILITY" | "REVENUE" | "EQUITY" | "CONTRA";

export interface TrialBalanceAccount {
  code: string;
  type: LedgerAccountType | string;
  balancePaise: number;
  balance: string;
}

export interface TrialBalance {
  accounts: TrialBalanceAccount[];
  signedTotalPaise: number;
  balanced: boolean;
}

export type AgingBucketLabel = "0-30" | "31-60" | "61-90" | "90+";

export interface AgingBucket {
  bucket: AgingBucketLabel | string;
  invoiceCount: number;
  totalPaise: number;
  total: string;
}

export interface AgingReport {
  buckets: AgingBucket[];
  grandTotalPaise: number;
  grandTotal: string;
}

export interface DrawerPosition {
  drawerSessionId: number;
  netPaise: number;
  net: string;
}

export interface CashPosition {
  cashTotalPaise: number;
  cashTotal: string;
  bankTotalPaise: number;
  bankTotal: string;
  byDrawer: DrawerPosition[];
}

export interface DailyCollectionDay {
  day: string;
  collectedPaise: number;
  collected: string;
}

export interface DailyCollection {
  days: DailyCollectionDay[];
  totalPaise: number;
  total: string;
}

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
