// src/app/(with-auth)/dashboard/productivity/page.tsx
//
// Doctor productivity admin — Sprint 8. Two tabs:
//   - Smart phrases (dot phrases library)
//   - Order sets (bundle templates)
// Calculators are pure-compute and live in the staff app, not here.

"use client";

import { Suspense, useState } from "react";
import { SmartPhrasesTab } from "./components/SmartPhrasesTab";
import { OrderSetsTab } from "./components/OrderSetsTab";

type Tab = "phrases" | "order_sets";

function ProductivityContent() {
  const [tab, setTab] = useState<Tab>("phrases");
  return (
    <div className="p-6">
      <h1 className="text-3xl font-bold text-foreground mb-1">
        Doctor Productivity
      </h1>
      <p className="text-sm text-muted-foreground mb-6">
        Smart-phrase library and order-set bundle templates.
      </p>
      <div className="flex gap-1 bg-muted rounded-lg p-1 mb-6 w-fit">
        {(
          [
            { key: "phrases", label: "💬 Smart phrases" },
            { key: "order_sets", label: "📦 Order sets" },
          ] as { key: Tab; label: string }[]
        ).map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
              tab === key
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "phrases" && <SmartPhrasesTab />}
      {tab === "order_sets" && <OrderSetsTab />}
    </div>
  );
}

export default function ProductivityPage() {
  return (
    <Suspense fallback={<div className="p-6">Loading…</div>}>
      <ProductivityContent />
    </Suspense>
  );
}
