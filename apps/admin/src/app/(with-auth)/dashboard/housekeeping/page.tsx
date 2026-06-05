"use client";

// Housekeeping admin page — thin orchestrator.
//
// Refactored 2026-04-14 from a 1268-LOC god-component into 7 files:
//   - components/helpers.tsx        — fmtDate, fmtSLA, Badge, StatCard, InfoRow, unwrap
//   - components/DashboardTab.tsx   — KPI tiles + SLA + top staff + recent flags
//   - components/LogsTab.tsx        — filterable log table + FlagModal
//   - components/RequestsTab.tsx    — filterable request table + Assign/NewRequest modals
//   - components/DetailPanel.tsx    — right-drawer detail for a request
//   - components/ZonesTab.tsx       — CRUD for housekeeping zones
//   - components/PerformanceTab.tsx — 30-day staff performance rollup
//
// This page stays thin (< 60 LOC) and is purely responsible for tab routing.
// Each tab component fetches its own data with TanStack Query and is testable
// in isolation.

import { useState } from "react";
import { DashboardTab } from "./components/DashboardTab";
import { LogsTab } from "./components/LogsTab";
import { RequestsTab } from "./components/RequestsTab";
import { ZonesTab } from "./components/ZonesTab";
import { PerformanceTab } from "./components/PerformanceTab";

type Tab = "dashboard" | "logs" | "requests" | "zones" | "performance";

const TABS: { id: Tab; label: string }[] = [
  { id: "dashboard", label: "Dashboard" },
  { id: "logs", label: "Logs" },
  { id: "requests", label: "Requests" },
  { id: "zones", label: "Zones" },
  { id: "performance", label: "Staff Performance" },
];

export default function HousekeepingPage() {
  const [tab, setTab] = useState<Tab>("dashboard");

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <h1 className="text-2xl font-bold text-gray-800 mb-6">
        🧹 Housekeeping Management
      </h1>

      <div className="flex gap-1 bg-gray-100 p-1 rounded-xl mb-6 w-fit flex-wrap">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-5 py-2 rounded-lg text-sm font-medium transition-all ${
              tab === t.id
                ? "bg-card text-gray-800 shadow-sm"
                : "text-gray-600 hover:text-gray-800"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "dashboard" && <DashboardTab />}
      {tab === "logs" && <LogsTab />}
      {tab === "requests" && <RequestsTab />}
      {tab === "zones" && <ZonesTab />}
      {tab === "performance" && <PerformanceTab />}
    </div>
  );
}
