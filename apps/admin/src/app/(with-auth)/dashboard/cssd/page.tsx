"use client";

// CSSD — thin tab orchestrator (apps/admin/CLAUDE.md god-page rule).
//
// Re-audit lane L (2026-08-25): this page used to be a read-only board bound to
// GET /cssd/board alone. Sets, sterilization loads and the issue /
// theatre-use / return / decontaminate transitions had no caller anywhere in
// the product, and nothing else writes instrument_sets, sterilization_loads or
// set_issue_log — so the sterilization board was permanently empty and the
// theatre page's `cssd_warnings`, which getOtSterilityWarnings derives from
// set_issue_log, could never show anything.
//
//   components/BoardTab.tsx   — KPIs, sets in circulation, recent loads
//   components/SetsTab.tsx    — instrument-set master + label
//   components/LoadsTab.tsx   — sterilization loads + release decision
//   components/IssuesTab.tsx  — issue register + transitions
//   components/SetActions     — POST /cssd/sets, GET /cssd/sets/{id}/label
//   components/LoadActions    — POST /cssd/loads, PATCH /cssd/loads/{id}/status
//   components/IssueActions   — POST /cssd/issues + the four transitions
//   components/DevicesTab.tsx — reprocessable cath-device queue
//   components/DeviceActions  — the five POST /cssd/devices/{id} transitions
//   components/helpers.tsx    — formatters, status pill, KPI tile, modal shell

import { useState } from "react";

import { BoardTab } from "./components/BoardTab";
import { DevicesTab } from "./components/DevicesTab";
import { IssuesTab } from "./components/IssuesTab";
import { LoadsTab } from "./components/LoadsTab";
import { SetsTab } from "./components/SetsTab";

type Tab = "board" | "sets" | "loads" | "issues" | "devices";

const TABS: { id: Tab; label: string }[] = [
  { id: "board", label: "Board" },
  { id: "sets", label: "Sets" },
  { id: "loads", label: "Loads" },
  { id: "issues", label: "Issues" },
  { id: "devices", label: "Devices" },
];

export default function CssdPage() {
  const [tab, setTab] = useState<Tab>("board");

  return (
    <div className="space-y-6 p-6">
      <h1 className="text-3xl font-bold">CSSD</h1>

      <div className="flex w-fit flex-wrap gap-1 rounded-xl bg-muted p-1">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => setTab(entry.id)}
            aria-current={tab === entry.id ? "page" : undefined}
            className={`rounded-lg px-5 py-2 text-sm font-medium transition-all ${
              tab === entry.id
                ? "bg-card shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {tab === "board" && <BoardTab />}
      {tab === "sets" && <SetsTab />}
      {tab === "loads" && <LoadsTab />}
      {tab === "issues" && <IssuesTab />}
      {tab === "devices" && <DevicesTab />}
    </div>
  );
}
