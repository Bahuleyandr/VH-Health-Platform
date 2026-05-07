// src/app/(with-auth)/dashboard/icu/page.tsx
//
// Sprint 19 — ICU command centre.
//
// Tab orchestrator (admissions list / flowsheet / assessments / bundle).
// Lazy-loads each tab so the bundle stays small.

"use client";

import { useState } from "react";
import AdmissionsTab from "./components/AdmissionsTab";
import FlowsheetTab from "./components/FlowsheetTab";
import AssessmentsTab from "./components/AssessmentsTab";
import BundleTab from "./components/BundleTab";

type TabKey = "admissions" | "flowsheet" | "assessments" | "bundle";

export default function ICUPage() {
  const [tab, setTab] = useState<TabKey>("admissions");
  const [activeAdmissionId, setActiveAdmissionId] = useState<number | null>(null);

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-foreground">ICU Command Centre</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Hourly flowsheet, RASS / CAM-ICU / SOFA / CPOT, and the SCCM ABCDEF
          daily bundle. Active patient context flows across tabs.
        </p>
      </div>

      <div className="flex gap-2 border-b border-border">
        {([
          ["admissions", "Admissions"],
          ["flowsheet", "Flowsheet"],
          ["assessments", "Assessments"],
          ["bundle", "ABCDEF Bundle"],
        ] as Array<[TabKey, string]>).map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition ${
              tab === k
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-white"
            }`}
            disabled={k !== "admissions" && !activeAdmissionId}
            title={
              k !== "admissions" && !activeAdmissionId
                ? "Select a patient on the Admissions tab first"
                : undefined
            }
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "admissions" && (
        <AdmissionsTab
          activeAdmissionId={activeAdmissionId}
          onSelect={setActiveAdmissionId}
          onJumpToFlowsheet={(id) => {
            setActiveAdmissionId(id);
            setTab("flowsheet");
          }}
        />
      )}
      {tab === "flowsheet" && activeAdmissionId && (
        <FlowsheetTab admissionId={activeAdmissionId} />
      )}
      {tab === "assessments" && activeAdmissionId && (
        <AssessmentsTab admissionId={activeAdmissionId} />
      )}
      {tab === "bundle" && activeAdmissionId && (
        <BundleTab admissionId={activeAdmissionId} />
      )}
    </div>
  );
}
