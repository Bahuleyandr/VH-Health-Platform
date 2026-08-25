"use client";

// Linen & Laundry — thin tab orchestrator (apps/admin/CLAUDE.md god-page rule).
//
// Re-audit lane L (2026-08-25): this page used to be a read-only board bound to
// GET /linen-laundry/board alone. The other ten endpoints on the router — item
// types, ward par levels, cycle creation and the collect/laundry/return/
// reconcile/cancel transitions — had no caller anywhere in the product, and no
// cron or seed writes linen_laundry_cycles, so the board was permanently empty
// in production and an operator could not even configure an item type.
//
//   components/BoardTab.tsx     — KPIs, ward par stock, laundry cycles + actions
//   components/ItemTypesTab.tsx — linen item-type master (POST /item-types)
//   components/ParLevelDialog   — PUT /par-levels
//   components/CycleDialogs     — POST /cycles + the five transitions
//   components/useWardOptions   — ward pick-list (GET /wards, different gate)
//   components/helpers.tsx      — formatters, KPI tile, modal shell

import { Shirt } from "lucide-react";
import { useState } from "react";

import { BoardTab } from "./components/BoardTab";
import { ItemTypesTab } from "./components/ItemTypesTab";

type Tab = "board" | "item-types";

const TABS: { id: Tab; label: string }[] = [
  { id: "board", label: "Board" },
  { id: "item-types", label: "Item types" },
];

export default function LinenLaundryPage() {
  const [tab, setTab] = useState<Tab>("board");

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-lg border border-border bg-card">
          <Shirt className="h-5 w-5 text-cyan-700 dark:text-cyan-300" />
        </div>
        <h1 className="text-3xl font-bold">Linen &amp; Laundry</h1>
      </div>

      <div className="flex w-fit flex-wrap gap-1 rounded-xl bg-muted p-1">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => setTab(entry.id)}
            aria-current={tab === entry.id ? "page" : undefined}
            className={`rounded-lg px-5 py-2 text-sm font-medium transition-all ${
              tab === entry.id
                ? "bg-card shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {tab === "board" && <BoardTab />}
      {tab === "item-types" && <ItemTypesTab />}
    </div>
  );
}
