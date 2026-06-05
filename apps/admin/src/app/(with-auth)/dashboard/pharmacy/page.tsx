// src/app/(with-auth)/dashboard/pharmacy/page.tsx
"use client";

// Pharmacy admin page — thin orchestrator.
//
// Refactored 2026-04-15 from an 889-LOC god-component into 7 files:
//   - components/types.ts             — PharmacyOrderLifecycle, SLAData, CatalogItem
//   - components/shared.tsx           — StatCard, StatusBadge, ActionButton, STATUS_COLORS
//   - components/OverviewTab.tsx      — SLA dashboard tiles + avg-time blocks
//   - components/OrdersTab.tsx        — order queue + status filter + lifecycle action buttons
//   - components/OrderDetailModal.tsx — order detail modal (items, prescription photo, tracking)
//   - components/CatalogTab.tsx       — medicine catalog grouped by category
//   - components/CatalogForm.tsx      — add/edit medicine modal

import { Suspense, useState } from "react";
import { OverviewTab } from "./components/OverviewTab";
import { OrdersTab } from "./components/OrdersTab";
import { CatalogTab } from "./components/CatalogTab";
import { ScheduleRegisterTab } from "./components/ScheduleRegisterTab";
import { ExpiryAlertsTab } from "./components/ExpiryAlertsTab";

type Tab = "overview" | "orders" | "catalog" | "schedule" | "expiry";

function PharmacyContent() {
  const [tab, setTab] = useState<Tab>("overview");

  return (
    <div className="p-6">
      <h1 className="text-3xl font-bold text-foreground mb-6">
        Pharmacy Management
      </h1>

      <div className="flex gap-1 bg-muted rounded-lg p-1 mb-6 overflow-x-auto">
        {[
          { key: "overview" as const, label: "📊 Overview" },
          { key: "orders" as const, label: "📦 Orders" },
          { key: "catalog" as const, label: "💊 Catalog" },
          { key: "schedule" as const, label: "📋 Schedule register" },
          { key: "expiry" as const, label: "⏰ Expiry alerts" },
        ].map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors whitespace-nowrap ${
              tab === key
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "overview" && <OverviewTab />}
      {tab === "orders" && <OrdersTab />}
      {tab === "catalog" && <CatalogTab />}
      {tab === "schedule" && <ScheduleRegisterTab />}
      {tab === "expiry" && <ExpiryAlertsTab />}
    </div>
  );
}

export default function PharmacyPage() {
  return (
    <Suspense fallback={<div className="p-6">Loading pharmacy...</div>}>
      <PharmacyContent />
    </Suspense>
  );
}
