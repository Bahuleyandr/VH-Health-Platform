// src/app/(with-auth)/dashboard/clinical-alerts/page.tsx
//
// Clinical Alerts & Code Blue board. Live via staff:clinical-alerts +
// staff:code-blue (low-level useRealtimeChannel — no query to invalidate);
// recent history hydrated once from GET /clinical-alerts/recent.
//
// NL-14 P2: code-blue history is hydrated from PERSISTED resuscitation
// events (GET /resuscitation/events/recent) — with ward/bed/reason context —
// and re-hydrated whenever the WS channel reconnects. The live banner is a
// notification surface only; the durable events are the source of truth.

"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchAdminAPI } from "@/lib/api";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { EmptyState } from "@/components/EmptyState";
import { useRealtimeChannel } from "@/hooks/useRealtimeChannel";
import {
  mergeAlerts,
  alertKey,
  codeBlueKey,
  resusEventKey,
  CLINICAL_ALERTS_CHANNEL,
  CODE_BLUE_CHANNEL,
  CODE_STEMI_CHANNEL,
  ALERT_FEED_CAP,
  CODE_BLUE_WINDOW_MS,
  stemiSlaClockStartPending,
  stemiSlaTargetPending,
  stemiTimerName,
  validateStemiActivationPayload,
  type AlertItem,
  type CodeBlueItem,
  type ResusEventItem,
  type StemiActivationItem,
  type StemiActivationPayload,
  type StemiSlaInstance,
} from "./feed";

const EMPTY_STEMI_ACTIVATIONS: StemiActivationItem[] = [];

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

function displayStatus(value: string): string {
  return value.replaceAll("_", " ");
}

function stemiStatusTone(value: string): string {
  switch (value.toLowerCase()) {
    case "activated":
    case "breached":
      return "border-rose-200 bg-rose-50 text-rose-800";
    case "lab_notified":
    case "targets_pending":
    case "door_time_pending":
      return "border-amber-200 bg-amber-50 text-amber-800";
    case "in_lab":
      return "border-blue-200 bg-blue-50 text-blue-800";
    case "device_deployed":
    case "completed":
      return "border-emerald-200 bg-emerald-50 text-emerald-800";
    default:
      return "border-slate-200 bg-slate-50 text-slate-700";
  }
}

function StemiStatusPill({ value }: { value: string }) {
  return (
    <span
      className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-semibold ${stemiStatusTone(value)}`}
    >
      {displayStatus(value)}
    </span>
  );
}

function StemiClock({ sla }: { sla: StemiSlaInstance }) {
  const targetPending = stemiSlaTargetPending(sla);
  const clockStartPending = stemiSlaClockStartPending(sla);
  const pendingDetail = [
    targetPending ? "Target pending" : null,
    clockStartPending ? "Door time pending" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const detail =
    pendingDetail ||
    (sla.completed_at
      ? `Completed ${fmtTime(sla.completed_at)}`
      : sla.due_at
        ? `Due ${fmtTime(sla.due_at)}`
        : sla.started_at
          ? `Started ${fmtTime(sla.started_at)}`
          : "Clock started");
  const displayState = targetPending
    ? "targets_pending"
    : clockStartPending
      ? "door_time_pending"
      : sla.status;

  return (
    <div className="rounded-md border border-border bg-background p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-semibold">
          {stemiTimerName(sla.rule_code)}
        </span>
        <StemiStatusPill value={displayState} />
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

function ActiveStemiPathways({
  activations,
  isLoading,
  isError,
}: {
  activations: StemiActivationItem[];
  isLoading: boolean;
  isError: boolean;
}) {
  return (
    <section
      data-testid="active-stemi-pathways"
      className="rounded-lg border border-border overflow-hidden"
    >
      <div className="bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-900">
        Active Code STEMI pathways
      </div>
      {isLoading ? (
        <div className="p-4 text-sm text-muted-foreground">
          Loading active pathways…
        </div>
      ) : isError ? (
        <div className="bg-amber-50 p-4 text-sm font-medium text-amber-900">
          Code STEMI pathway status is unavailable. Do not treat this as an
          all-clear.
        </div>
      ) : activations.length === 0 ? (
        <div className="p-4 text-sm text-muted-foreground">
          No active Code STEMI pathways
        </div>
      ) : (
        <div className="divide-y divide-border">
          {activations.map((activation) => {
            const slas = activation.sla_instances;
            const targetsPending =
              activation.targets_pending === true ||
              slas.some(stemiSlaTargetPending);
            const clockStartPending = slas.some(stemiSlaClockStartPending);
            return (
              <article key={activation.id} className="space-y-3 p-4">
                <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="font-semibold">
                        Code STEMI #{activation.id}
                      </h2>
                      <StemiStatusPill value={activation.status} />
                      {targetsPending && (
                        <StemiStatusPill value="targets_pending" />
                      )}
                      {clockStartPending && (
                        <StemiStatusPill value="door_time_pending" />
                      )}
                    </div>
                    <p className="mt-1 font-mono text-xs text-muted-foreground">
                      Patient {activation.patient_uid ?? "—"}
                    </p>
                  </div>
                  {activation.cath_case_id != null && (
                    <span className="text-xs font-medium text-muted-foreground">
                      Cath case #{activation.cath_case_id}
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
                  <span>Activated {fmtTime(activation.activated_at)}</span>
                  <span>Door {fmtTime(activation.door_time_at ?? "")}</span>
                  <span>ECG {fmtTime(activation.ecg_at ?? "")}</span>
                  <span>
                    Source{" "}
                    {displayStatus(activation.activation_source ?? "unknown")}
                  </span>
                </div>
                {slas.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No pathway clocks recorded
                  </p>
                ) : (
                  <div className="grid gap-2 md:grid-cols-3">
                    {slas.map((sla) => (
                      <StemiClock key={sla.id} sla={sla} />
                    ))}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

export default function ClinicalAlertsPage() {
  const [liveAlerts, setLiveAlerts] = useState<AlertItem[]>([]);
  const [codeBlues, setCodeBlues] = useState<CodeBlueItem[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const { data: history = [], isLoading } = useQuery<AlertItem[]>({
    queryKey: ["clinical-alerts", "recent"],
    queryFn: async () => {
      const r = await fetchAdminAPI<unknown>(
        "/clinical-alerts/recent?hours=8&limit=100",
      );
      return unwrapList<AlertItem>(r);
    },
    staleTime: Infinity, // freshness comes from the WS channels, not polling
  });

  // Persisted code-blue/resus history (durable rows with ward/bed/reason).
  const { data: resusHistory = [], refetch: refetchResusHistory } = useQuery<
    ResusEventItem[]
  >({
    queryKey: ["resuscitation", "recent"],
    queryFn: async () => {
      const r = await fetchAdminAPI<unknown>(
        "/resuscitation/events/recent?hours=8&limit=50",
      );
      return unwrapList<ResusEventItem>(r);
    },
    staleTime: Infinity, // re-hydrated on WS reconnect below, not by polling
  });

  // STEMI pushes are notification-only. The rendered board always comes from
  // the durable activation list, hydrated on load and on realtime reconnect.
  const {
    data: stemiPayload,
    isLoading: isStemiLoading,
    isError: isStemiError,
    refetch: refetchStemiHistory,
  } = useQuery<StemiActivationPayload>({
    queryKey: ["stemi-pathway", "active"],
    queryFn: async () => {
      const payload = await fetchAdminAPI<unknown>(
        "/stemi-pathway/activations?active_only=true&limit=50",
      );
      return validateStemiActivationPayload(payload);
    },
    staleTime: Infinity,
  });
  const stemiActivations = stemiPayload?.activations ?? EMPTY_STEMI_ACTIVATIONS;

  const alertsRt = useRealtimeChannel<AlertItem>(CLINICAL_ALERTS_CHANNEL, {
    onEvent: (m) =>
      setLiveAlerts((p) =>
        [m.data as AlertItem, ...p].slice(0, ALERT_FEED_CAP),
      ),
  });
  useRealtimeChannel<CodeBlueItem>(CODE_BLUE_CHANNEL, {
    onEvent: (m) =>
      setCodeBlues((p) => [m.data as CodeBlueItem, ...p].slice(0, 50)),
  });
  const stemiRt = useRealtimeChannel(CODE_STEMI_CHANNEL, {
    onEvent: () => {
      void refetchStemiHistory();
    },
  });

  // Reconnect hydration: whenever the realtime channel (re)subscribes, pull
  // the persisted events — anything broadcast while offline is recovered from
  // the durable table, never from the live-only banner.
  const wasSubscribed = useRef(false);
  useEffect(() => {
    if (alertsRt.subscribed && !wasSubscribed.current) {
      void refetchResusHistory();
    }
    wasSubscribed.current = alertsRt.subscribed;
  }, [alertsRt.subscribed, refetchResusHistory]);

  const wasStemiSubscribed = useRef(false);
  useEffect(() => {
    if (stemiRt.subscribed && !wasStemiSubscribed.current) {
      void refetchStemiHistory();
    }
    wasStemiSubscribed.current = stemiRt.subscribed;
  }, [stemiRt.subscribed, refetchStemiHistory]);

  const feed = mergeAlerts(history, liveAlerts);

  const now = Date.now();
  const activeCodeBlues = codeBlues.filter(
    (c) =>
      !dismissed.has(codeBlueKey(c)) &&
      now - new Date(c.at).getTime() < CODE_BLUE_WINDOW_MS,
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
          <h1 className="text-3xl font-bold text-foreground">
            Clinical Alerts, Code Blue &amp; Code STEMI
          </h1>
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
          Live vital-sign anomalies and emergency pushes. Persisted Code STEMI
          pathways and recent history are re-hydrated after reconnects.
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
                <div className="text-lg font-extrabold tracking-wide">
                  🚨 CODE BLUE
                </div>
                <div className="text-sm mt-1">
                  {c.ward ? `Ward ${c.ward} · ` : ""}
                  {c.bedNumber ? `Bed ${c.bedNumber} · ` : ""}
                  Patient {c.patientId ?? "—"}
                </div>
                {c.reason && (
                  <div className="text-sm font-semibold mt-1">{c.reason}</div>
                )}
                <div className="text-xs opacity-80 mt-1">{fmtTime(c.at)}</div>
              </div>
              <button
                type="button"
                onClick={() =>
                  setDismissed((p) => new Set(p).add(codeBlueKey(c)))
                }
                className="rounded bg-white/20 px-3 py-1.5 text-sm font-medium hover:bg-white/30"
              >
                Dismiss
              </button>
            </div>
          ))}
        </div>
      )}

      <ActiveStemiPathways
        activations={stemiActivations}
        isLoading={isStemiLoading}
        isError={isStemiError}
      />

      {resusHistory.length > 0 && (
        <div
          data-testid="code-blue-history"
          className="rounded-lg border border-border overflow-hidden"
        >
          <div className="bg-muted/40 px-3 py-2 text-sm font-semibold text-muted-foreground">
            Code Blue history (persisted events)
          </div>
          <table className="w-full text-sm">
            <thead className="bg-muted/20 text-muted-foreground">
              <tr>
                <th className="text-left p-3">Started</th>
                <th className="text-left p-3">Kind</th>
                <th className="text-left p-3">Ward</th>
                <th className="text-left p-3">Bed</th>
                <th className="text-left p-3">Reason</th>
                <th className="text-left p-3">Trigger</th>
                <th className="text-left p-3">Status</th>
                <th className="text-left p-3">Outcome</th>
              </tr>
            </thead>
            <tbody>
              {resusHistory.map((e) => (
                <tr key={resusEventKey(e)} className="border-t border-border">
                  <td className="p-3 whitespace-nowrap text-xs">
                    {fmtTime(e.started_at)}
                  </td>
                  <td className="p-3">
                    {(e.event_kind ?? "—").replace(/_/g, " ")}
                  </td>
                  <td className="p-3">{e.ward_snapshot ?? "—"}</td>
                  <td className="p-3">{e.bed_snapshot ?? "—"}</td>
                  <td className="p-3 text-muted-foreground">
                    {e.reason ?? "—"}
                  </td>
                  <td className="p-3">
                    {(e.trigger_source ?? "—").replace(/_/g, " ")}
                  </td>
                  <td className="p-3">
                    <span
                      className={`px-2 py-0.5 rounded text-xs font-semibold ${
                        e.status === "active"
                          ? "bg-rose-200 text-rose-900"
                          : "bg-slate-200 text-slate-800"
                      }`}
                    >
                      {(e.status ?? "—").replace(/_/g, " ")}
                    </span>
                  </td>
                  <td className="p-3">
                    {(e.outcome ?? "—").replace(/_/g, " ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
                  <td className="p-3 whitespace-nowrap text-xs">
                    {fmtTime(a.at)}
                  </td>
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
                  <td className="p-3 font-mono text-xs">
                    {a.patientId ?? "—"}
                  </td>
                  <td className="p-3">{a.vitalName ?? "—"}</td>
                  <td className="p-3">
                    {a.value ?? "—"}
                    {a.unit ? ` ${a.unit}` : ""}
                  </td>
                  <td className="p-3 text-muted-foreground">
                    {a.message ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
