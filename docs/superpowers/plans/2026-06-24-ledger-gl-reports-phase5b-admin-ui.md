# Ledger GL Reports — Phase 5b (Admin UI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline) or superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the finance-gated "General Ledger" admin page that consumes the Phase-5a backend report endpoints (`/api/v1/admin/ledger/*`) and renders trial balance, AR/insurer aging, cash position, and daily collection as collapsible report sections.

**Architecture:** A typed API client (`src/lib/api/ledgerReports.ts`, mirroring `billing.ts`) exposes one fetch fn per endpoint via `getJSON` + `API_ENDPOINTS.ledger`. A thin page (`dashboard/billing/ledger/page.tsx`) finance-gates via `usePermissions` and renders five collapsible sections; each section is its own `"use client"` component that fetches independently through a small `useReport` hook (so one failing report shows an inline error without blocking the rest). Reuses the sibling billing components' `fmt`/`fmtDate` helpers. No charts (v1). A nav entry under "Administration" makes the page reachable.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Tailwind v4, Jest + Testing Library. Backend already on `main` (Phase 5a merged).

**Note on file location:** The spec (§5) sketched the client at `src/services/ledgerReports.ts`, but the codebase's dominant convention for API clients is `src/lib/api/<domain>.ts` (e.g. `billing.ts`), and the billing UI imports everything from the `@/lib/api` barrel. This plan follows the codebase convention (`src/lib/api/ledgerReports.ts` + barrel export) for consistency.

**Backend contract (Phase 5a, on `main`):** `GET /api/v1/admin/ledger/{trial-balance,ar-aging,insurer-aging,cash-position,daily-collection?from=&to=}`, finance-gated (FINANCE_INCHARGE/ADMIN/SUPER_ADMIN), envelope `{success,message,data}` (admin `getJSON` auto-unwraps `.data`). DTOs:
- trial-balance → `{ accounts:[{code,type,balancePaise,balance}], signedTotalPaise, balanced }`
- ar-aging / insurer-aging → `{ buckets:[{bucket,invoiceCount,totalPaise,total}], grandTotalPaise, grandTotal }`
- cash-position → `{ cashTotalPaise,cashTotal,bankTotalPaise,bankTotal, byDrawer:[{drawerSessionId,netPaise,net}] }`
- daily-collection → `{ days:[{day,collectedPaise,collected}], totalPaise, total }`

(`*Paise` are integers; `balance`/`total`/`net`/`collected`/`grandTotal` are decimal-rupee strings ready for `fmt()`.)

---

## File Structure

- Create `apps/admin/src/lib/api/ledgerReports.ts` — typed client (DTO interfaces + 5 fetch fns).
- Modify `apps/admin/src/lib/api-config.ts` — add `ledger` endpoints block (after `database`).
- Modify `apps/admin/src/lib/api/index.ts` — barrel-export the ledger fns + types (after billing block).
- Create `apps/admin/src/app/(with-auth)/dashboard/billing/ledger/components/useReport.ts` — generic fetch hook.
- Create `apps/admin/src/app/(with-auth)/dashboard/billing/ledger/components/CollapsibleSection.tsx` — collapsible card wrapper.
- Create `apps/admin/src/app/(with-auth)/dashboard/billing/ledger/components/TrialBalanceSection.tsx`
- Create `apps/admin/src/app/(with-auth)/dashboard/billing/ledger/components/AgingSection.tsx` (parameterized for patient + insurer)
- Create `apps/admin/src/app/(with-auth)/dashboard/billing/ledger/components/CashPositionSection.tsx`
- Create `apps/admin/src/app/(with-auth)/dashboard/billing/ledger/components/DailyCollectionSection.tsx`
- Create `apps/admin/src/app/(with-auth)/dashboard/billing/ledger/page.tsx` — finance-gated orchestrator.
- Modify `apps/admin/src/components/navigation/AdminNav.tsx` — add "General Ledger" nav item.
- Create `apps/admin/src/__tests__/dashboard/billing/ledgerPage.test.tsx` — component test.

---

## Task 1: Typed API client + endpoints + barrel

**Files:**
- Modify: `apps/admin/src/lib/api-config.ts` (after the `database:` block, ~line 162)
- Create: `apps/admin/src/lib/api/ledgerReports.ts`
- Modify: `apps/admin/src/lib/api/index.ts` (after the billing export block, ~line 180)

- [ ] **Step 1: Add the `ledger` endpoints block to `api-config.ts`** (immediately after the `database: { … },` block)

```ts
    ledger: {
      trialBalance: "/api/v1/admin/ledger/trial-balance", // GET
      arAging: "/api/v1/admin/ledger/ar-aging", // GET
      insurerAging: "/api/v1/admin/ledger/insurer-aging", // GET
      cashPosition: "/api/v1/admin/ledger/cash-position", // GET
      dailyCollection: "/api/v1/admin/ledger/daily-collection", // GET ?from=&to=
    },
```

- [ ] **Step 2: Create `src/lib/api/ledgerReports.ts`**

```ts
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
  return getJSON<TrialBalance>(API_ENDPOINTS.ledger.trialBalance);
}

/** Patient AR aging buckets. */
export function getArAging() {
  return getJSON<AgingReport>(API_ENDPOINTS.ledger.arAging);
}

/** Insurer AR aging buckets. */
export function getInsurerAging() {
  return getJSON<AgingReport>(API_ENDPOINTS.ledger.insurerAging);
}

/** Cash + bank position with per-drawer breakdown. */
export function getCashPosition() {
  return getJSON<CashPosition>(API_ENDPOINTS.ledger.cashPosition);
}

/** Daily CASH/BANK collection over an optional [from,to] date range. */
export function getDailyCollection(params?: { from?: string; to?: string }) {
  return getJSON<DailyCollection>(API_ENDPOINTS.ledger.dailyCollection, {
    from: params?.from,
    to: params?.to,
  });
}
```

- [ ] **Step 3: Barrel-export from `src/lib/api/index.ts`** (after the billing `export { … };` block, before the EMR block)

```ts
// General Ledger reports (T2 ledger Phase 5b)
import {
  getTrialBalance, getArAging, getInsurerAging, getCashPosition, getDailyCollection,
} from "./ledgerReports";
export type {
  TrialBalance, TrialBalanceAccount, LedgerAccountType,
  AgingReport, AgingBucket, AgingBucketLabel,
  CashPosition, DrawerPosition,
  DailyCollection, DailyCollectionDay,
} from "./ledgerReports";
export { getTrialBalance, getArAging, getInsurerAging, getCashPosition, getDailyCollection };
```

- [ ] **Step 4: Type-check the client compiles**

Run: `cd apps/admin && npx tsc --noEmit`
Expected: no new errors referencing `ledgerReports.ts` / `api-config.ts` / `index.ts`.

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/lib/api/ledgerReports.ts apps/admin/src/lib/api-config.ts apps/admin/src/lib/api/index.ts
git commit -m "feat(admin): ledger GL reports API client + endpoints"
```

---

## Task 2: `useReport` hook + `CollapsibleSection`

**Files:**
- Create: `apps/admin/src/app/(with-auth)/dashboard/billing/ledger/components/useReport.ts`
- Create: `apps/admin/src/app/(with-auth)/dashboard/billing/ledger/components/CollapsibleSection.tsx`

- [ ] **Step 1: Create `useReport.ts`**

`load` MUST be a stable reference (a module-level fn or `useCallback`-wrapped) or the effect loops.

```ts
"use client";

import { useCallback, useEffect, useState } from "react";

export interface ReportState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/** Fetch a report once on mount (and whenever `load` changes). `load` must be stable. */
export function useReport<T>(load: () => Promise<T>): ReportState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    load()
      .then((res) => { if (!cancelled) setData(res); })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load report");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [load]);

  useEffect(() => run(), [run]);

  return { data, loading, error, reload: () => { run(); } };
}
```

- [ ] **Step 2: Create `CollapsibleSection.tsx`**

```tsx
"use client";

import { ReactNode, useState } from "react";

export function CollapsibleSection({
  title,
  defaultOpen = true,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border border-border rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center justify-between bg-muted px-4 py-2 font-medium text-sm hover:bg-muted/80"
      >
        <span>{title}</span>
        <span className="text-muted-foreground" aria-hidden>{open ? "▾" : "▸"}</span>
      </button>
      {open && <div className="p-4">{children}</div>}
    </section>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add "apps/admin/src/app/(with-auth)/dashboard/billing/ledger/components/useReport.ts" "apps/admin/src/app/(with-auth)/dashboard/billing/ledger/components/CollapsibleSection.tsx"
git commit -m "feat(admin): GL ledger useReport hook + CollapsibleSection"
```

---

## Task 3: The four report section components

**Files:** all under `apps/admin/src/app/(with-auth)/dashboard/billing/ledger/components/`
- Create: `TrialBalanceSection.tsx`, `AgingSection.tsx`, `CashPositionSection.tsx`, `DailyCollectionSection.tsx`

Each reuses `fmt`/`fmtDate` from the sibling billing components (`../../components/shared`).

- [ ] **Step 1: `TrialBalanceSection.tsx`**

```tsx
"use client";

import { getTrialBalance } from "@/lib/api";
import { fmt } from "../../components/shared";
import { useReport } from "./useReport";

export function TrialBalanceSection() {
  const { data, loading, error } = useReport(getTrialBalance);

  if (loading) return <p className="text-sm text-muted-foreground">Loading trial balance…</p>;
  if (error) return <p className="text-sm text-red-700">{error}</p>;
  if (!data || data.accounts.length === 0)
    return <p className="text-sm text-muted-foreground">No ledger accounts yet.</p>;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">Status:</span>
        {data.balanced ? (
          <span className="px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-700">Balanced</span>
        ) : (
          <span className="px-2 py-1 rounded-full text-xs font-medium bg-red-100 text-red-700">
            Out of balance by {fmt(data.signedTotalPaise / 100)}
          </span>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left bg-muted/50">
              <th className="py-2 px-3">Account</th>
              <th className="py-2 px-3">Type</th>
              <th className="py-2 px-3 text-right">Balance</th>
            </tr>
          </thead>
          <tbody>
            {data.accounts.map((a) => (
              <tr key={a.code} className="border-b border-border hover:bg-muted/30">
                <td className="py-2 px-3 font-mono text-xs">{a.code}</td>
                <td className="py-2 px-3">{a.type}</td>
                <td className="py-2 px-3 text-right font-medium">{fmt(a.balance)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: `AgingSection.tsx`** (shared by patient + insurer; `load` is a stable module fn passed from the page)

```tsx
"use client";

import { fmt } from "../../components/shared";
import { useReport } from "./useReport";
import type { AgingReport } from "@/lib/api";

export function AgingSection({
  load,
  emptyLabel,
}: {
  load: () => Promise<AgingReport>;
  emptyLabel: string;
}) {
  const { data, loading, error } = useReport(load);

  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (error) return <p className="text-sm text-red-700">{error}</p>;
  if (!data || data.grandTotalPaise === 0)
    return <p className="text-sm text-muted-foreground">{emptyLabel}</p>;

  const totalInvoices = data.buckets.reduce((s, b) => s + b.invoiceCount, 0);

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left bg-muted/50">
            <th className="py-2 px-3">Bucket (days)</th>
            <th className="py-2 px-3 text-right">Invoices</th>
            <th className="py-2 px-3 text-right">Outstanding</th>
          </tr>
        </thead>
        <tbody>
          {data.buckets.map((b) => (
            <tr key={b.bucket} className="border-b border-border hover:bg-muted/30">
              <td className="py-2 px-3 font-medium">{b.bucket}</td>
              <td className="py-2 px-3 text-right">{b.invoiceCount}</td>
              <td className="py-2 px-3 text-right">{fmt(b.total)}</td>
            </tr>
          ))}
          <tr className="bg-muted/50 font-medium">
            <td className="py-2 px-3">Total</td>
            <td className="py-2 px-3 text-right">{totalInvoices}</td>
            <td className="py-2 px-3 text-right">{fmt(data.grandTotal)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 3: `CashPositionSection.tsx`**

```tsx
"use client";

import { getCashPosition } from "@/lib/api";
import { fmt } from "../../components/shared";
import { useReport } from "./useReport";

export function CashPositionSection() {
  const { data, loading, error } = useReport(getCashPosition);

  if (loading) return <p className="text-sm text-muted-foreground">Loading cash position…</p>;
  if (error) return <p className="text-sm text-red-700">{error}</p>;
  if (!data) return <p className="text-sm text-muted-foreground">No cash position data.</p>;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-card border border-border rounded-lg p-4">
          <p className="text-sm text-muted-foreground">Cash on hand</p>
          <p className="text-2xl font-bold text-foreground">{fmt(data.cashTotal)}</p>
        </div>
        <div className="bg-card border border-border rounded-lg p-4">
          <p className="text-sm text-muted-foreground">Bank</p>
          <p className="text-2xl font-bold text-foreground">{fmt(data.bankTotal)}</p>
        </div>
      </div>
      <div>
        <p className="text-sm font-medium mb-2">By drawer session</p>
        {data.byDrawer.length === 0 ? (
          <p className="text-sm text-muted-foreground">No open drawer sessions.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left bg-muted/50">
                  <th className="py-2 px-3">Drawer session</th>
                  <th className="py-2 px-3 text-right">Net</th>
                </tr>
              </thead>
              <tbody>
                {data.byDrawer.map((d) => (
                  <tr key={d.drawerSessionId} className="border-b border-border hover:bg-muted/30">
                    <td className="py-2 px-3 font-mono text-xs">#{d.drawerSessionId}</td>
                    <td className="py-2 px-3 text-right font-medium">{fmt(d.net)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: `DailyCollectionSection.tsx`** (own date-range state; `load` memoized on `applied`)

```tsx
"use client";

import { useCallback, useState } from "react";
import { getDailyCollection } from "@/lib/api";
import { fmt, fmtDate } from "../../components/shared";
import { useReport } from "./useReport";

export function DailyCollectionSection() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [applied, setApplied] = useState<{ from?: string; to?: string }>({});

  const load = useCallback(() => getDailyCollection(applied), [applied]);
  const { data, loading, error } = useReport(load);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-sm">
          <span className="block text-muted-foreground">From</span>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="border border-border rounded px-2 py-1 text-sm bg-card"
          />
        </label>
        <label className="text-sm">
          <span className="block text-muted-foreground">To</span>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="border border-border rounded px-2 py-1 text-sm bg-card"
          />
        </label>
        <button
          type="button"
          onClick={() => setApplied({ from: from || undefined, to: to || undefined })}
          className="px-3 py-1 rounded-md text-sm font-medium bg-primary text-white hover:bg-primary/90"
        >
          Apply
        </button>
      </div>

      {loading && <p className="text-sm text-muted-foreground">Loading daily collection…</p>}
      {error && <p className="text-sm text-red-700">{error}</p>}
      {data && !loading &&
        (data.days.length === 0 ? (
          <p className="text-sm text-muted-foreground">No collections in this range.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left bg-muted/50">
                  <th className="py-2 px-3">Day</th>
                  <th className="py-2 px-3 text-right">Collected</th>
                </tr>
              </thead>
              <tbody>
                {data.days.map((d) => (
                  <tr key={d.day} className="border-b border-border hover:bg-muted/30">
                    <td className="py-2 px-3">{fmtDate(d.day)}</td>
                    <td className="py-2 px-3 text-right font-medium">{fmt(d.collected)}</td>
                  </tr>
                ))}
                <tr className="bg-muted/50 font-medium">
                  <td className="py-2 px-3">Total</td>
                  <td className="py-2 px-3 text-right">{fmt(data.total)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        ))}
    </div>
  );
}
```

- [ ] **Step 5: Commit**

```bash
git add "apps/admin/src/app/(with-auth)/dashboard/billing/ledger/components/"
git commit -m "feat(admin): GL ledger report section components"
```

---

## Task 4: The page + nav entry

**Files:**
- Create: `apps/admin/src/app/(with-auth)/dashboard/billing/ledger/page.tsx`
- Modify: `apps/admin/src/components/navigation/AdminNav.tsx` (Administration group, after "Day-care Packages")

- [ ] **Step 1: `page.tsx`** (finance-gated orchestrator)

```tsx
// src/app/(with-auth)/dashboard/billing/ledger/page.tsx
"use client";

import Link from "next/link";
import { usePermissions } from "@/hooks/usePermissions";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { EmptyState } from "@/components/EmptyState";
import { getArAging, getInsurerAging } from "@/lib/api";
import { CollapsibleSection } from "./components/CollapsibleSection";
import { TrialBalanceSection } from "./components/TrialBalanceSection";
import { AgingSection } from "./components/AgingSection";
import { CashPositionSection } from "./components/CashPositionSection";
import { DailyCollectionSection } from "./components/DailyCollectionSection";

export default function GeneralLedgerPage() {
  const { user, isAdmin, loading } = usePermissions();
  const canView = isAdmin || String(user?.role ?? "").toUpperCase() === "FINANCE_INCHARGE";

  if (loading) return <LoadingSpinner fullHeight label="Loading…" />;

  if (!canView) {
    return (
      <div className="p-6">
        <EmptyState
          title="Finance access required"
          description="The General Ledger is restricted to finance and administrator roles."
        />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold text-foreground">General Ledger</h1>
        <Link href="/dashboard/billing" className="text-sm text-primary hover:underline">
          ← Billing
        </Link>
      </div>
      <p className="text-sm text-muted-foreground">
        Read-only financial reports derived from the double-entry ledger.
      </p>

      <CollapsibleSection title="Trial Balance">
        <TrialBalanceSection />
      </CollapsibleSection>

      <CollapsibleSection title="Patient AR Aging">
        <AgingSection load={getArAging} emptyLabel="No outstanding patient receivables." />
      </CollapsibleSection>

      <CollapsibleSection title="Insurer AR Aging">
        <AgingSection load={getInsurerAging} emptyLabel="No outstanding insurer receivables." />
      </CollapsibleSection>

      <CollapsibleSection title="Cash Position">
        <CashPositionSection />
      </CollapsibleSection>

      <CollapsibleSection title="Daily Collection">
        <DailyCollectionSection />
      </CollapsibleSection>
    </div>
  );
}
```

- [ ] **Step 2: Add nav entry** in `AdminNav.tsx` Administration group, immediately after the "Day-care Packages" line:

```tsx
      { name: "General Ledger", href: "/dashboard/billing/ledger" },
```

- [ ] **Step 3: Type-check + build compile the page**

Run: `cd apps/admin && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add "apps/admin/src/app/(with-auth)/dashboard/billing/ledger/page.tsx" apps/admin/src/components/navigation/AdminNav.tsx
git commit -m "feat(admin): General Ledger page + nav entry"
```

---

## Task 5: Component test

**Files:**
- Create: `apps/admin/src/__tests__/dashboard/billing/ledgerPage.test.tsx`

- [ ] **Step 1: Write the test** (mock `@/lib/api` ledger fns + `@/hooks/usePermissions`)

```tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import GeneralLedgerPage from "@/app/(with-auth)/dashboard/billing/ledger/page";
import {
  getTrialBalance, getArAging, getInsurerAging, getCashPosition, getDailyCollection,
} from "@/lib/api";
import { usePermissions } from "@/hooks/usePermissions";

jest.mock("@/lib/api", () => ({
  getTrialBalance: jest.fn(),
  getArAging: jest.fn(),
  getInsurerAging: jest.fn(),
  getCashPosition: jest.fn(),
  getDailyCollection: jest.fn(),
}));

jest.mock("@/hooks/usePermissions", () => ({ usePermissions: jest.fn() }));

const mockedUsePermissions = usePermissions as jest.MockedFunction<typeof usePermissions>;

function setPermissions(over: Record<string, unknown> = {}) {
  mockedUsePermissions.mockReturnValue({
    user: { role: "ADMIN" }, role: "ADMIN", permissions: [],
    isSuperAdmin: false, isAdmin: true, isHR: false, isDoctor: false, isStaff: false,
    isHROrAbove: true, isStaffOrAbove: true, loading: false,
    hasPermission: () => true, hasAnyPermission: () => true, hasAllPermissions: () => true,
    allowed: true, roleAllowed: true, permsAllowed: true,
    ...over,
  } as unknown as ReturnType<typeof usePermissions>);
}

function seedReports() {
  (getTrialBalance as jest.Mock).mockResolvedValue({
    accounts: [
      { code: "PATIENT_AR", type: "ASSET", balancePaise: 750000, balance: "7500.00" },
      { code: "REVENUE", type: "REVENUE", balancePaise: 750000, balance: "7500.00" },
    ],
    signedTotalPaise: 0, balanced: true,
  });
  (getArAging as jest.Mock).mockResolvedValue({
    buckets: [
      { bucket: "0-30", invoiceCount: 1, totalPaise: 250000, total: "2500.00" },
      { bucket: "31-60", invoiceCount: 0, totalPaise: 0, total: "0.00" },
      { bucket: "61-90", invoiceCount: 0, totalPaise: 0, total: "0.00" },
      { bucket: "90+", invoiceCount: 1, totalPaise: 500000, total: "5000.00" },
    ],
    grandTotalPaise: 750000, grandTotal: "7500.00",
  });
  (getInsurerAging as jest.Mock).mockResolvedValue({
    buckets: [
      { bucket: "0-30", invoiceCount: 0, totalPaise: 0, total: "0.00" },
      { bucket: "31-60", invoiceCount: 0, totalPaise: 0, total: "0.00" },
      { bucket: "61-90", invoiceCount: 0, totalPaise: 0, total: "0.00" },
      { bucket: "90+", invoiceCount: 0, totalPaise: 0, total: "0.00" },
    ],
    grandTotalPaise: 0, grandTotal: "0.00",
  });
  (getCashPosition as jest.Mock).mockResolvedValue({
    cashTotalPaise: 100000, cashTotal: "1000.00",
    bankTotalPaise: 500000, bankTotal: "5000.00",
    byDrawer: [{ drawerSessionId: 7, netPaise: 100000, net: "1000.00" }],
  });
  (getDailyCollection as jest.Mock).mockResolvedValue({
    days: [{ day: "2026-06-20", collectedPaise: 100000, collected: "1000.00" }],
    totalPaise: 100000, total: "1000.00",
  });
}

describe("<GeneralLedgerPage />", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    seedReports();
    setPermissions();
  });

  it("renders all five report sections with data for a finance/admin user", async () => {
    render(<GeneralLedgerPage />);
    expect(screen.getByRole("heading", { name: "General Ledger" })).toBeInTheDocument();

    await waitFor(() => expect(screen.getByText("Balanced")).toBeInTheDocument());
    expect(screen.getByText("PATIENT_AR")).toBeInTheDocument();
    expect(screen.getAllByText("₹7,500.00").length).toBeGreaterThan(0);
    expect(screen.getByText("No outstanding insurer receivables.")).toBeInTheDocument();
    expect(screen.getByText("Cash on hand")).toBeInTheDocument();
    expect(screen.getByText("#7")).toBeInTheDocument();
    expect(getDailyCollection).toHaveBeenCalled();
  });

  it("collapses a section when its header is clicked", async () => {
    render(<GeneralLedgerPage />);
    await waitFor(() => expect(screen.getByText("Balanced")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Trial Balance/ }));
    await waitFor(() => expect(screen.queryByText("Balanced")).not.toBeInTheDocument());
  });

  it("blocks non-finance users with a finance-access empty state", () => {
    setPermissions({ isAdmin: false, isSuperAdmin: false, role: "STAFF", user: { role: "STAFF" } });
    render(<GeneralLedgerPage />);
    expect(screen.getByText("Finance access required")).toBeInTheDocument();
    expect(getTrialBalance).not.toHaveBeenCalled();
  });

  it("re-fetches daily collection with the chosen date range on Apply", async () => {
    render(<GeneralLedgerPage />);
    await waitFor(() => expect(getDailyCollection).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-06-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() =>
      expect(getDailyCollection).toHaveBeenLastCalledWith({ from: "2026-06-01", to: undefined }),
    );
  });
});
```

- [ ] **Step 2: Run the test**

Run: `cd apps/admin && npx jest src/__tests__/dashboard/billing/ledgerPage.test.tsx`
Expected: 4 tests pass.

- [ ] **Step 3: Commit**

```bash
git add "apps/admin/src/__tests__/dashboard/billing/ledgerPage.test.tsx"
git commit -m "test(admin): General Ledger page component test"
```

---

## Task 6: Full verification + finish

- [ ] **Step 1: Type-check** — `cd apps/admin && npx tsc --noEmit` → clean.
- [ ] **Step 2: Lint** — `cd apps/admin && npm run lint` → no new warnings/errors in the new files.
- [ ] **Step 3: Full admin jest** — `cd apps/admin && npm test` → all suites pass (the new suite + no regressions).
- [ ] **Step 4: Production build** — `cd apps/admin && npm run build` → succeeds, `/dashboard/billing/ledger` in the route manifest.
- [ ] **Step 5: Finish the branch** — merge `feat/ledger-gl-reports-5b` `--no-ff` → `main`, push `origin` + `github`, delete branch. Tick ROADMAP §0 + update memory.

---

## Self-Review

- **Spec coverage (§5):** client `ledgerReports.ts` ✓ (Task 1); finance-gated page mirroring billing gating ✓ (Task 4 — `usePermissions`); 5 collapsible sections top-to-bottom (trial balance + balanced badge → AR aging → insurer aging → cash position → daily collection w/ date range) ✓ (Tasks 3-4); independent per-section fetch with inline errors ✓ (`useReport` + per-section error render); empty states ✓; reuse existing table/section style, no charts ✓.
- **Spec coverage (§6):** frontend test mocks the client, asserts each section renders rows + balanced badge + an empty state ✓ (Task 5); `next build` clean ✓ (Task 6).
- **Placeholder scan:** none — all code complete.
- **Type consistency:** DTO names (`TrialBalance`/`AgingReport`/`CashPosition`/`DailyCollection`) defined in Task 1 and consumed verbatim in Tasks 3-5; section component names match imports in `page.tsx`; `fmt`/`fmtDate` signatures match `../../components/shared`.
- **Reachability:** nav entry added (Task 4) so the page isn't orphaned.
