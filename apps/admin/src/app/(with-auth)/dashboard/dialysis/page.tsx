// src/app/(with-auth)/dashboard/dialysis/page.tsx
//
// Sprint 22 — Dialysis unit. Tab orchestrator.

"use client";

import { useState } from "react";
import TodayBoardTab from "./components/TodayBoardTab";
import RosterTab from "./components/RosterTab";
import SessionTab from "./components/SessionTab";
import { useRealtimeInvalidation } from "@/hooks/useRealtimeInvalidation";
import { DIALYSIS_CHANNEL } from "./realtime";

type TabKey = "today" | "roster" | "session";

export default function DialysisPage() {
  const [tab, setTab] = useState<TabKey>("today");
  const [activeSessionId, setActiveSessionId] = useState<number | null>(null);

  const { connected, subscribed, lastEventAt } = useRealtimeInvalidation(DIALYSIS_CHANNEL, [["dialysis"]]);

  const liveLabel = subscribed ? "● Live" : connected ? "○ Connecting" : "○ Polling";
  const liveTitle = subscribed
    ? lastEventAt
      ? `Real-time via staff:dialysis-board — last update ${new Date(lastEventAt).toLocaleTimeString()}`
      : "Real-time via staff:dialysis-board"
    : connected
      ? "Connecting…"
      : "Polling every 30–60s (real-time unavailable)";

  return (
    <div className="p-6 space-y-6">
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-3xl font-bold text-foreground">Dialysis Unit</h1>
          <span
            data-testid="dialysis-realtime-indicator"
            role="status"
            aria-label={subscribed ? "Live — real-time dialysis updates active" : "Polling — real-time updates unavailable"}
            title={liveTitle}
            className={subscribed ? "text-xs font-medium text-green-600" : "text-xs font-medium text-gray-400"}
          >
            {liveLabel}
          </span>
        </div>
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
        <TodayBoardTab subscribed={subscribed} onOpenSession={(id) => {
          setActiveSessionId(id);
          setTab("session");
        }} />
      )}
      {tab === "roster" && <RosterTab subscribed={subscribed} />}
      {tab === "session" && activeSessionId && (
        <SessionTab sessionId={activeSessionId} subscribed={subscribed} />
      )}
    </div>
  );
}
