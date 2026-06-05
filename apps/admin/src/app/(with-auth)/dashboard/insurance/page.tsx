// src/app/(with-auth)/dashboard/insurance/page.tsx
//
// Insurance / TPA coordinator desk — Sprint 5.
//   - Admission intake (policy capture + admission-linked pre-auth creation)
//   - Pre-auth (worklist + submit + record-response inline actions)
//   - Claims (filterable by status / aging, decision + payment actions)
//   - Policies (per-patient lookup)

"use client";

import { Suspense, useState } from "react";
import { PreauthTab } from "./components/PreauthTab";
import { ClaimsTab } from "./components/ClaimsTab";
import { PoliciesTab } from "./components/PoliciesTab";
import { AdmissionIntakeTab } from "./components/AdmissionIntakeTab";

type Tab = "admission" | "preauth" | "claims" | "policies";

function InsuranceContent() {
  const [tab, setTab] = useState<Tab>("admission");
  return (
    <div className="p-6">
      <h1 className="text-3xl font-bold text-foreground mb-1">
        Insurance Coordinator
      </h1>
      <p className="text-sm text-muted-foreground mb-6">
        TPA pre-authorisation, cashless claim filing, and reimbursement
        tracking.
      </p>

      <div className="flex gap-1 bg-muted rounded-lg p-1 mb-6 w-fit">
        {(
          [
            { key: "admission", label: "Admission intake" },
            { key: "preauth", label: "📨 Pre-auth" },
            { key: "claims", label: "📑 Claims" },
            { key: "policies", label: "🪪 Policies" },
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

      {tab === "admission" && <AdmissionIntakeTab />}
      {tab === "preauth" && <PreauthTab />}
      {tab === "claims" && <ClaimsTab />}
      {tab === "policies" && <PoliciesTab />}
    </div>
  );
}

export default function InsurancePage() {
  return (
    <Suspense fallback={<div className="p-6">Loading…</div>}>
      <InsuranceContent />
    </Suspense>
  );
}
