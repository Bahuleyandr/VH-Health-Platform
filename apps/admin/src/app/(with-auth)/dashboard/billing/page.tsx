// src/app/(with-auth)/dashboard/billing/page.tsx
"use client";

import { useState, Suspense } from "react";
import { RevenueSummaryTab } from "./components/RevenueSummaryTab";
import { InvoicesTab } from "./components/InvoicesTab";
import { InsuranceClaimsTab } from "./components/InsuranceClaimsTab";
import { RevenueCycleTab } from "./components/RevenueCycleTab";

function BillingContent() {
  const [tab, setTab] = useState<"revenue" | "invoices" | "claims" | "revenue-cycle">("revenue");

  return (
    <div className="p-6">
      <h1 className="text-3xl font-bold text-foreground mb-6">Billing &amp; Invoicing</h1>

      {/* Tabs */}
      <div className="flex gap-1 bg-muted rounded-lg p-1 mb-6">
        {[
          { key: "revenue" as const, label: "📊 Revenue" },
          { key: "invoices" as const, label: "🧾 Invoices" },
          { key: "claims" as const, label: "🏥 Insurance Claims" },
          { key: "revenue-cycle" as const, label: "RCM" },
        ].map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
              tab === key
                ? "bg-white text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "revenue" && <RevenueSummaryTab />}
      {tab === "invoices" && <InvoicesTab />}
      {tab === "claims" && <InsuranceClaimsTab />}
      {tab === "revenue-cycle" && <RevenueCycleTab />}
    </div>
  );
}

export default function BillingPage() {
  return (
    <Suspense fallback={<div className="p-6">Loading billing...</div>}>
      <BillingContent />
    </Suspense>
  );
}
