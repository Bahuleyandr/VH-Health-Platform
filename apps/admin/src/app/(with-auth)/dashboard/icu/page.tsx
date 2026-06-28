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
import { useRealtimeInvalidation } from "@/hooks/useRealtimeInvalidation";
import { ICU_BOARD_CHANNEL } from "./realtime";

type TabKey = "admissions" | "flowsheet" | "assessments" | "bundle";

export default function ICUPage() {
  const [tab, setTab] = useState<TabKey>("admissions");
  const [activeAdmissionId, setActiveAdmissionId] = useState<number | null>(null);

  const { connected, subscribed, lastEventAt } = useRealtimeInvalidation(ICU_BOARD_CHANNEL, [["icu"]]);

  const liveLabel = subscribed ? "● Live" : "○ Polling";
  const liveTitle = subscribed
    ? lastEventAt
      ? `Real-time via staff:icu-board — last update ${new Date(lastEventAt).toLocaleTimeString()}`
      : "Real-time via staff:icu-board"
    : connected
      ? "Connecting…"
      : "Polling (real-time unavailable)";

  return (
    <div className="p-6 space-y-6">
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-3xl font-bold text-foreground">ICU Command Centre</h1>
          <span
            data-testid="icu-realtime-indicator"
            role="status"
            aria-label={
              subscribed
                ? "Live — real-time ICU board updates active"
                : "Polling — real-time updates unavailable"
            }
            title={liveTitle}
            className={subscribed ? "text-xs font-medium text-green-600" : "text-xs font-medium text-gray-400"}
          >
            {liveLabel}
          </span>
        </div>
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
          subscribed={subscribed}
        />
      )}
      {tab === "flowsheet" && activeAdmissionId && (
        <FlowsheetTab admissionId={activeAdmissionId} subscribed={subscribed} />
      )}
      {tab === "assessments" && activeAdmissionId && (
        <AssessmentsTab admissionId={activeAdmissionId} subscribed={subscribed} />
      )}
      {tab === "bundle" && activeAdmissionId && (
        <BundleTab admissionId={activeAdmissionId} />
      )}
    </div>
  );
}
