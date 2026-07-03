"use client";

// Clinical governance admin page - thin orchestrator.
// Refactored 2026-07-02 from a 1594-LOC god page into tab components.

import { useState } from "react";
import { Activity, FlaskConical, ShieldAlert, ShieldCheck, Users } from "lucide-react";

import { AccessAuditTab } from "./components/AccessAuditTab";
import { LabGovernanceTab } from "./components/LabGovernanceTab";
import { PatientAccessTab } from "./components/PatientAccessTab";
import { ShadowDenialsTab } from "./components/ShadowDenialsTab";
import type { ClinicalGovernanceTab } from "./components/types";

const TABS: { key: ClinicalGovernanceTab; label: string; icon: typeof Users }[] = [
  { key: "access", label: "Patient access", icon: Users },
  { key: "lab", label: "Lab governance", icon: FlaskConical },
  { key: "audit", label: "Access audit", icon: Activity },
  { key: "shadow", label: "Shadow denials", icon: ShieldAlert },
];

export default function ClinicalGovernancePage() {
  const [tab, setTab] = useState<ClinicalGovernanceTab>("access");

  return (
    <div className="space-y-5 p-4 lg:p-6">
      <header className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-6 w-6 text-primary" />
            <h1 className="text-2xl font-semibold text-foreground">Clinical Governance</h1>
          </div>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Admin control point for patient-access relationships, break-glass review, lab specimen traceability, analyzer QC, and PHI audit events.
          </p>
        </div>
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          Route: /api/v1/admin/clinical-governance
        </p>
      </header>

      <div className="flex flex-wrap gap-1 rounded-md border border-border bg-muted/30 p-1">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium transition-colors ${
              tab === key
                ? "border border-primary/30 bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-card hover:text-foreground"
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </div>

      {tab === "access" ? <PatientAccessTab /> : null}
      {tab === "lab" ? <LabGovernanceTab /> : null}
      {tab === "audit" ? <AccessAuditTab /> : null}
      {tab === "shadow" ? <ShadowDenialsTab /> : null}
    </div>
  );
}
