"use client";

import { Suspense, useState } from "react";
import { BadgeCheck, Bell, ClipboardList } from "lucide-react";
import { CatalogTab } from "./components/CatalogTab";
import { ExpiryAlertsTab } from "./components/ExpiryAlertsTab";
import { StaffCredentialsTab } from "./components/StaffCredentialsTab";

type Tab = "staff" | "expiry" | "catalog";

const TABS = [
  { key: "staff" as const, label: "Staff credentials", icon: BadgeCheck },
  { key: "expiry" as const, label: "Expiry board", icon: Bell },
  { key: "catalog" as const, label: "Privilege catalog", icon: ClipboardList },
];

function CredentialingContent() {
  const [tab, setTab] = useState<Tab>("staff");

  return (
    <div className="p-6">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Credentialing</h1>
        </div>
      </div>

      <div className="mb-6 flex gap-1 overflow-x-auto rounded-lg bg-muted p-1">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`inline-flex items-center gap-2 whitespace-nowrap rounded-md px-4 py-2 text-sm font-medium transition-colors ${
              tab === key
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
            {label}
          </button>
        ))}
      </div>

      {tab === "staff" && <StaffCredentialsTab />}
      {tab === "expiry" && <ExpiryAlertsTab />}
      {tab === "catalog" && <CatalogTab />}
    </div>
  );
}

export default function CredentialingPage() {
  return (
    <Suspense fallback={<div className="p-6">Loading credentialing...</div>}>
      <CredentialingContent />
    </Suspense>
  );
}
