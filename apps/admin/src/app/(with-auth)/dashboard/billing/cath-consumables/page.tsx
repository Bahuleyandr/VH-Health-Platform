"use client";

import { useState } from "react";

import { BillingSettingsPanel } from "./components/BillingSettingsPanel";
import { CatalogTab } from "./components/CatalogTab";
import { UnbilledUsageTab } from "./components/UnbilledUsageTab";

type Tab = "catalog" | "unbilled";

const TABS: Array<{ key: Tab; label: string }> = [
  { key: "catalog", label: "Catalog" },
  { key: "unbilled", label: "Unbilled Usage" },
];

export default function CathConsumablesPage() {
  const [tab, setTab] = useState<Tab>("catalog");

  return (
    <div className="space-y-6 p-6">
      <header>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary">
          Cath Lab · Finance controls
        </p>
        <h1 className="mt-2 text-3xl font-bold text-foreground">
          Cath Consumables &amp; Implants
        </h1>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
          Govern per-case consumable identity, inventory links, batch
          requirements, and fail-visible billing gaps without mutating invoices
          directly.
        </p>
      </header>

      <BillingSettingsPanel />

      <div
        className="border-b border-border"
        role="tablist"
        aria-label="Cath consumables views"
      >
        <div className="flex gap-6">
          {TABS.map((item) => (
            <button
              aria-controls={`cath-consumables-${item.key}-panel`}
              aria-selected={tab === item.key}
              className={`border-b-2 px-1 pb-3 text-sm font-medium transition-colors ${
                tab === item.key
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
              id={`cath-consumables-${item.key}-tab`}
              key={item.key}
              onClick={() => setTab(item.key)}
              role="tab"
              type="button"
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div
        aria-labelledby={`cath-consumables-${tab}-tab`}
        id={`cath-consumables-${tab}-panel`}
        role="tabpanel"
      >
        {tab === "catalog" ? <CatalogTab /> : <UnbilledUsageTab />}
      </div>
    </div>
  );
}
