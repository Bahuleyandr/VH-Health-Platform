// src/app/(with-auth)/dashboard/investigations/page.tsx
"use client";

// Investigations admin page — thin orchestrator.
//
// Refactored 2026-04-14 from a 961-LOC god-component into 6 files:
//   - components/helpers.tsx             — formatDate, priorityColor, statusColor, Chip, SummaryCard, SlaCard
//   - components/OverviewTab.tsx         — date-range + summary cards + urgent pending + recent completed
//   - components/AllInvestigationsTab.tsx — filter bar + paginated table + status update
//   - components/TestCatalogTab.tsx      — grouped catalog + add/edit modal (co-located CatalogForm)
//   - components/NotificationsTab.tsx    — un-notified completed investigations
//   - components/LabBookingsTab.tsx      — booking queue + SLA + lifecycle actions

import { useState } from "react";
import { OverviewTab } from "./components/OverviewTab";
import { AllInvestigationsTab } from "./components/AllInvestigationsTab";
import { TestCatalogTab } from "./components/TestCatalogTab";
import { NotificationsTab } from "./components/NotificationsTab";
import { LabBookingsTab } from "./components/LabBookingsTab";

const TABS = ["Overview", "All Investigations", "Test Catalog", "Notifications", "Lab Bookings"] as const;
type Tab = (typeof TABS)[number];

export default function InvestigationsPage() {
  const [tab, setTab] = useState<Tab>("Overview");

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Investigations</h1>

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium transition-colors ${
              tab === t
                ? "border-b-2 border-primary text-primary"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Content */}
      {tab === "Overview" && <OverviewTab />}
      {tab === "All Investigations" && <AllInvestigationsTab />}
      {tab === "Test Catalog" && <TestCatalogTab />}
      {tab === "Notifications" && <NotificationsTab />}
      {tab === "Lab Bookings" && <LabBookingsTab />}
    </div>
  );
}
