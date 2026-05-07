// src/app/(with-auth)/dashboard/dialysis/page.tsx
//
// Sprint 22 — Dialysis unit. Tab orchestrator.

"use client";

import { useState } from "react";
import TodayBoardTab from "./components/TodayBoardTab";
import RosterTab from "./components/RosterTab";
import SessionTab from "./components/SessionTab";

type TabKey = "today" | "roster" | "session";

export default function DialysisPage() {
  const [tab, setTab] = useState<TabKey>("today");
  const [activeSessionId, setActiveSessionId] = useState<number | null>(null);

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-foreground">Dialysis Unit</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Today&apos;s stations, patient roster with vascular access + serology,
          and per-session run charts (intra-dialysis observations + Kt/V).
        </p>
      </div>

      <div className="flex gap-2 border-b border-border">
        {([
          ["today", "Today's Board"],
          ["roster", "Patient Roster"],
          ["session", "Session"],
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
            disabled={k === "session" && !activeSessionId}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "today" && (
        <TodayBoardTab onOpenSession={(id) => {
          setActiveSessionId(id);
          setTab("session");
        }} />
      )}
      {tab === "roster" && <RosterTab />}
      {tab === "session" && activeSessionId && (
        <SessionTab sessionId={activeSessionId} />
      )}
    </div>
  );
}
