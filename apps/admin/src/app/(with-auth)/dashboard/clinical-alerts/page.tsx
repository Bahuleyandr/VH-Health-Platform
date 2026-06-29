// src/app/(with-auth)/dashboard/clinical-alerts/page.tsx
//
// Clinical Alerts & Code Blue board. Live via staff:clinical-alerts +
// staff:code-blue (low-level useRealtimeChannel — no query to invalidate);
// recent history hydrated once from GET /clinical-alerts/recent.

"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchAdminAPI } from "@/lib/api";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { EmptyState } from "@/components/EmptyState";
import { useRealtimeChannel } from "@/hooks/useRealtimeChannel";
import {
  mergeAlerts,
  alertKey,
  codeBlueKey,
  CLINICAL_ALERTS_CHANNEL,
  CODE_BLUE_CHANNEL,
  ALERT_FEED_CAP,
  CODE_BLUE_WINDOW_MS,
  type AlertItem,
  type CodeBlueItem,
} from "./feed";

function unwrapList<T>(r: unknown): T[] {
  const d = (r as { data?: unknown }).data ?? r;
  return Array.isArray(d) ? (d as T[]) : [];
}

function fmtTime(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleTimeString();
}

const ROW_TONE: Record<string, string> = {
  CRITICAL: "bg-rose-50",
  WARNING: "bg-amber-50",
};

export default function ClinicalAlertsPage() {
  const [liveAlerts, setLiveAlerts] = useState<AlertItem[]>([]);
  const [codeBlues, setCodeBlues] = useState<CodeBlueItem[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const { data: history = [], isLoading } = useQuery<AlertItem[]>({
    queryKey: ["clinical-alerts", "recent"],
    queryFn: async () => {
      const r = await fetchAdminAPI<unknown>("/clinical-alerts/recent?hours=8&limit=100");
      return unwrapList<AlertItem>(r);
    },
    staleTime: Infinity, // freshness comes from the WS channels, not polling
  });

  const alertsRt = useRealtimeChannel<AlertItem>(CLINICAL_ALERTS_CHANNEL, {
    onEvent: (m) => setLiveAlerts((p) => [m.data as AlertItem, ...p].slice(0, ALERT_FEED_CAP)),
  });
  useRealtimeChannel<CodeBlueItem>(CODE_BLUE_CHANNEL, {
    onEvent: (m) => setCodeBlues((p) => [m.data as CodeBlueItem, ...p].slice(0, 50)),
  });

  const feed = mergeAlerts(history, liveAlerts);

  const now = Date.now();
  const activeCodeBlues = codeBlues.filter(
    (c) => !dismissed.has(codeBlueKey(c)) && now - new Date(c.at).getTime() < CODE_BLUE_WINDOW_MS,
  );

  const liveLabel = alertsRt.subscribed
    ? "● Live"
    : alertsRt.connected
      ? "○ Connecting"
      : "○ Offline";
  const liveTone = alertsRt.subscribed ? "text-green-600" : "text-gray-400";

  return (
    <div className="p-6 space-y-6">
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-3xl font-bold text-foreground">Clinical Alerts &amp; Code Blue</h1>
          <span
            data-testid="clinical-alerts-realtime-indicator"
            role="status"
            aria-label={
              alertsRt.subscribed
                ? "Live — real-time clinical alerts active"
                : "Connecting or offline — real-time clinical alerts not yet live"
            }
            className={`text-xs font-medium ${liveTone}`}
          >
            {liveLabel}
          </span>
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          Live vital-sign anomalies and Code Blue pushes. History seeded for the last 8 hours;
          new alerts appear in real time.
        </p>
      </div>

      {activeCodeBlues.length > 0 && (
        <div className="space-y-2">
          {activeCodeBlues.map((c) => (
            <div
              key={codeBlueKey(c)}
              role="alert"
              className="rounded-lg border-2 border-rose-500 bg-rose-600 text-white p-4 flex items-start justify-between gap-4"
            >
              <div>
                <div className="text-lg font-extrabold tracking-wide">🚨 CODE BLUE</div>
                <div className="text-sm mt-1">
                  {c.ward ? `Ward ${c.ward} · ` : ""}
                  {c.bedNumber ? `Bed ${c.bedNumber} · ` : ""}
                  Patient {c.patientId ?? "—"}
                </div>
                {c.reason && <div className="text-sm font-semibold mt-1">{c.reason}</div>}
                <div className="text-xs opacity-80 mt-1">{fmtTime(c.at)}</div>
              </div>
              <button
                type="button"
                onClick={() => setDismissed((p) => new Set(p).add(codeBlueKey(c)))}
                className="rounded bg-white/20 px-3 py-1.5 text-sm font-medium hover:bg-white/30"
              >
                Dismiss
              </button>
            </div>
          ))}
        </div>
      )}

      {isLoading && feed.length === 0 ? (
        <LoadingSpinner />
      ) : feed.length === 0 ? (
        <EmptyState
          title="No alerts yet"
          description="Live vital-sign alerts will appear here as they fire."
        />
      ) : (
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-muted-foreground">
              <tr>
                <th className="text-left p-3">Time</th>
                <th className="text-left p-3">Severity</th>
                <th className="text-left p-3">Patient</th>
                <th className="text-left p-3">Vital</th>
                <th className="text-left p-3">Value</th>
                <th className="text-left p-3">Message</th>
              </tr>
            </thead>
            <tbody>
              {feed.map((a) => (
                <tr
                  key={alertKey(a)}
                  className={`border-t border-border ${a.acknowledged ? "opacity-50" : ""} ${
                    ROW_TONE[a.severity ?? ""] ?? ""
                  }`}
                >
                  <td className="p-3 whitespace-nowrap text-xs">{fmtTime(a.at)}</td>
                  <td className="p-3">
                    <span
                      className={`px-2 py-0.5 rounded text-xs font-semibold ${
                        a.severity === "CRITICAL"
                          ? "bg-rose-200 text-rose-900"
                          : "bg-amber-200 text-amber-900"
                      }`}
                    >
                      {a.severity ?? "—"}
                    </span>
                  </td>
                  <td className="p-3 font-mono text-xs">{a.patientId ?? "—"}</td>
                  <td className="p-3">{a.vitalName ?? "—"}</td>
                  <td className="p-3">
                    {a.value ?? "—"}
                    {a.unit ? ` ${a.unit}` : ""}
                  </td>
                  <td className="p-3 text-muted-foreground">{a.message ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
