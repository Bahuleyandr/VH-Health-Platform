"use client";

import React from "react";
import {
  Activity,
  AlertTriangle,
  RadioTower,
  ShieldCheck,
  Video,
  Wifi,
} from "lucide-react";
import { useTeleconsultOpsSnapshot } from "../hooks/useTeleconsultOpsSnapshot";

type Icon = React.ComponentType<{ size?: number; className?: string }>;

function formatCount(value: number | undefined): string {
  return Number(value ?? 0).toLocaleString();
}

function formatPct(value: number | undefined): string {
  const n = Number(value ?? 0);
  return `${Number.isFinite(n) ? n.toFixed(1) : "0.0"}%`;
}

function modeValue(distribution: Record<string, number> | undefined, key: string): number {
  return Number(distribution?.[key] ?? 0);
}

function TeleconsultMetric({
  label,
  value,
  help,
  icon: IconComponent,
  tone = "text-foreground",
}: {
  label: string;
  value: string;
  help?: string;
  icon: Icon;
  tone?: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
        <IconComponent className="text-muted-foreground" size={18} />
      </div>
      <p className={`mt-2 text-2xl font-bold ${tone}`}>{value}</p>
      {help && <p className="mt-1 text-xs text-muted-foreground">{help}</p>}
    </div>
  );
}

export default function TeleconsultOpsPanel() {
  const {
    data: snapshot,
    error,
    isLoading,
    realtime,
  } = useTeleconsultOpsSnapshot();

  const liveLabel = realtime.subscribed ? "Live" : "Polling";
  const liveTitle = realtime.subscribed
    ? realtime.lastEventAt
      ? `Real-time via admin:teleconsult-ops - last update ${new Date(realtime.lastEventAt).toLocaleTimeString()}`
      : "Real-time via admin:teleconsult-ops"
    : realtime.connected
      ? "Connecting..."
      : "Polling every 30s";

  const modality = snapshot?.final_modality_distribution;

  return (
    <section className="space-y-3" data-testid="teleconsult-ops-panel">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-white">Teleconsult Operations</h3>
        <span
          data-testid="teleconsult-ops-realtime-indicator"
          role="status"
          aria-label={`${liveLabel} teleconsult operations updates`}
          title={liveTitle}
          className={
            realtime.subscribed
              ? "inline-flex items-center gap-1 text-xs font-medium text-emerald-400"
              : "inline-flex items-center gap-1 text-xs font-medium text-gray-400"
          }
        >
          <span
            className={
              realtime.subscribed
                ? "h-2 w-2 rounded-full bg-emerald-500"
                : "h-2 w-2 rounded-full bg-gray-500"
            }
          />
          {liveLabel}
        </span>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load teleconsult operations"}
        </div>
      )}

      {isLoading && !snapshot ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {["active", "waiting", "joins", "turn"].map((key) => (
            <div key={key} className="h-28 rounded-xl border border-border bg-card p-4 shadow-sm">
              <div className="h-3 w-24 rounded bg-muted" />
              <div className="mt-5 h-7 w-16 rounded bg-muted" />
            </div>
          ))}
        </div>
      ) : snapshot ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <TeleconsultMetric
            label="Active"
            value={formatCount(snapshot.active_count)}
            help={`${formatCount(snapshot.waiting_count)} waiting`}
            icon={Video}
            tone="text-emerald-400"
          />
          <TeleconsultMetric
            label="Join failures"
            value={formatCount(snapshot.join_failure_count)}
            help={`${formatCount(snapshot.teleconsult_count)} visits in window`}
            icon={AlertTriangle}
            tone={snapshot.join_failure_count > 0 ? "text-amber-400" : "text-emerald-400"}
          />
          <TeleconsultMetric
            label="TURN usage"
            value={formatPct(snapshot.turn_usage_rate_pct)}
            help={`${formatCount(snapshot.turn_session_count)} of ${formatCount(snapshot.video_session_count)} sessions`}
            icon={RadioTower}
            tone="text-sky-400"
          />
          <TeleconsultMetric
            label="Consent recorded"
            value={formatPct(snapshot.consent_recorded_rate_pct)}
            help={`${formatCount(snapshot.consent_recorded_count)} recorded`}
            icon={ShieldCheck}
            tone="text-indigo-300"
          />
          <TeleconsultMetric
            label="Final video"
            value={formatCount(modeValue(modality, "video"))}
            help="terminal consults"
            icon={Wifi}
          />
          <TeleconsultMetric
            label="Final audio"
            value={formatCount(modeValue(modality, "audio"))}
            help="terminal consults"
            icon={Activity}
          />
          <TeleconsultMetric
            label="Final chat"
            value={formatCount(modeValue(modality, "chat"))}
            help="terminal consults"
            icon={Activity}
          />
          <TeleconsultMetric
            label="Recording"
            value={snapshot.recording_enabled ? "On" : "Off"}
            help={snapshot.media_boundary}
            icon={ShieldCheck}
            tone={snapshot.recording_enabled ? "text-amber-400" : "text-emerald-400"}
          />
        </div>
      ) : null}
    </section>
  );
}
