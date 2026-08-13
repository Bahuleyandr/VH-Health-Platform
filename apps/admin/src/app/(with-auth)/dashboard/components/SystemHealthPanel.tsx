// src/app/(with-auth)/dashboard/components/SystemHealthPanel.tsx
// System Health panel + Infrastructure Monitor for the admin Dashboard.

"use client";

import React from "react";
import {
  UPTIME_THRESHOLDS,
  RESPONSE_TIME_THRESHOLDS,
  ERROR_RATE_THRESHOLDS,
} from "@/lib/constants";
import type {
  SystemHealth,
  InfraHealthData,
  HealthStatus,
} from "../hooks/useDashboardData.types";

// ── Helpers ────────────────────────────────────────────────────────────

function statusDotColor(s: HealthStatus) {
  return s === "healthy"
    ? "#22c55e"
    : s === "warning" || s === "stale"
      ? "#eab308"
      : s === "critical"
        ? "#ef4444"
        : "#6b7280";
}

const STATUS_PRESENTATION: Record<
  HealthStatus,
  { icon: string; label: string; classes: string }
> = {
  healthy: {
    icon: "✅",
    label: "Healthy",
    classes:
      "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  },
  warning: {
    icon: "⚠️",
    label: "Warning",
    classes:
      "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  },
  critical: {
    icon: "⛔",
    label: "Critical",
    classes:
      "bg-destructive/10 text-destructive dark:bg-destructive/40 dark:text-destructive/70",
  },
  stale: {
    icon: "⌛",
    label: "Stale",
    classes:
      "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  },
  unavailable: {
    icon: "❓",
    label: "Unavailable",
    classes:
      "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
  },
  unknown: {
    icon: "❓",
    label: "Unknown",
    classes:
      "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
  },
};

function healthBarColor(value: number, thresholds: [number, number]) {
  return value <= thresholds[0]
    ? "#22c55e"
    : value <= thresholds[1]
      ? "#eab308"
      : "#ef4444";
}

// ── GaugeBar ───────────────────────────────────────────────────────────

function GaugeBar({
  label,
  value,
  max,
  unit,
  color,
}: {
  label: string;
  value: number;
  max: number;
  unit: string;
  color: string;
}) {
  const pct = Math.min((value / max) * 100, 100);
  return (
    <div className="rounded-lg bg-muted p-3">
      <div className="flex items-center justify-between mb-1.5">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-sm font-semibold">
          {value}
          {unit}
        </p>
      </div>
      <div className="h-2 w-full rounded-full bg-background/60 overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </div>
    </div>
  );
}

// ── InfraCard ──────────────────────────────────────────────────────────

function InfraCard({
  label,
  status,
  detail,
}: {
  label: string;
  status?: string;
  detail?: string;
}) {
  const isHealthy =
    status === "healthy" || status === "configured" || status === "running";
  const isDegraded =
    status === "degraded" ||
    status === "warning" ||
    status === "dry_run" ||
    status === "not_initialized";
  const isDown = status === "down";

  const dotColor = isHealthy
    ? "#22c55e"
    : isDegraded
      ? "#eab308"
      : isDown
        ? "#ef4444"
        : "#6b7280";
  const emoji = isHealthy ? "✅" : isDegraded ? "⚠️" : isDown ? "⛔" : "❓";

  return (
    <div className="rounded-lg border border-border bg-muted/50 p-3">
      <div className="flex items-center gap-2 mb-1">
        <span
          className="h-2.5 w-2.5 rounded-full"
          style={{ backgroundColor: dotColor }}
        />
        <span className="text-sm font-medium">{label}</span>
        <span className="text-xs ml-auto">{emoji}</span>
      </div>
      <p className="text-xs text-muted-foreground">{status ?? "unknown"}</p>
      {detail && (
        <p className="text-xs text-muted-foreground/70 mt-0.5">{detail}</p>
      )}
    </div>
  );
}

// ── Exported Panels ────────────────────────────────────────────────────

interface SystemHealthProps {
  health: SystemHealth | null;
  lastUpdated: Date;
}

export function SystemHealthSection({
  health,
  lastUpdated,
}: SystemHealthProps) {
  const status = health?.status ?? "unknown";
  const presentation = STATUS_PRESENTATION[status];
  const observedAt = health?.observedAt ? new Date(health.observedAt) : null;
  const observedTime =
    observedAt && !Number.isNaN(observedAt.getTime())
      ? observedAt.toLocaleTimeString()
      : null;
  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">System Health</h2>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${presentation.classes}`}
        >
          <span className="text-base" aria-hidden>
            {presentation.icon}
          </span>
          {presentation.label}
        </span>
      </div>

      {health?.detail && (
        <p className="mb-4 text-sm text-muted-foreground" role="status">
          {health.detail}
        </p>
      )}

      {/* Gauge bars — only render real metrics. No fake fallbacks. */}
      {health?.uptime != null ||
      health?.responseTime != null ||
      health?.errorRate != null ? (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
          {health?.uptime != null && (
            <GaugeBar
              label="Uptime"
              value={parseFloat(health.uptime.replace("%", ""))}
              max={100}
              unit="%"
              color={healthBarColor(
                100 - parseFloat(health.uptime.replace("%", "")),
                UPTIME_THRESHOLDS,
              )}
            />
          )}
          {health?.responseTime != null && (
            <GaugeBar
              label="Response Time"
              value={health.responseTime}
              max={500}
              unit="ms"
              color={healthBarColor(
                health.responseTime,
                RESPONSE_TIME_THRESHOLDS,
              )}
            />
          )}
          {health?.errorRate != null && (
            <GaugeBar
              label="Error Rate"
              value={health.errorRate}
              max={10}
              unit="%"
              color={healthBarColor(health.errorRate, ERROR_RATE_THRESHOLDS)}
            />
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground mb-4">
          Live metrics unavailable. Backend must expose <code>uptime</code>,{" "}
          <code>responseTime</code>, and <code>errorRate</code> on{" "}
          <code>/admin/health/system</code> for this panel.
        </p>
      )}

      {/* Module health indicators */}
      {health?.modules && health.modules.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-muted-foreground mb-2">
            Module Health
          </h3>
          <div className="flex flex-wrap gap-2">
            {health.modules.map((m) => (
              <span
                key={m.name}
                className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs"
              >
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: statusDotColor(m.status) }}
                />
                {m.name}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="mt-3 text-xs text-muted-foreground">
        {observedTime
          ? `Health observed: ${observedTime}`
          : `Dashboard refreshed: ${lastUpdated.toLocaleTimeString()}`}{" "}
        · Auto-refresh every 30s
      </div>
    </section>
  );
}

interface InfraProps {
  infraHealth: InfraHealthData;
}

export function InfrastructureMonitor({ infraHealth }: InfraProps) {
  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">Infrastructure Monitor</h2>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${
            infraHealth.status === "healthy"
              ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
              : "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
          }`}
        >
          {infraHealth.status === "healthy"
            ? "✅ All Systems Go"
            : "⚠️ Degraded"}
        </span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        <InfraCard
          label="Database"
          status={infraHealth.checks.database?.status}
          detail={
            infraHealth.checks.database?.latency_ms != null
              ? `${infraHealth.checks.database.latency_ms}ms`
              : undefined
          }
        />
        <InfraCard
          label="R2 Storage"
          status={infraHealth.checks.r2_storage?.status}
          detail={infraHealth.checks.r2_storage?.note}
        />
        <InfraCard
          label="Push Notifications"
          status={infraHealth.checks.push_notifications?.status}
        />
        <InfraCard
          label="SMS"
          status={infraHealth.checks.sms?.status}
          detail={infraHealth.checks.sms?.provider}
        />
        <InfraCard
          label="Scheduler"
          status={infraHealth.checks.scheduler?.status}
        />
        {infraHealth.checks.notification_backlog && (
          <InfraCard
            label="Notification Backlog"
            status={
              infraHealth.checks.notification_backlog.pending == null
                ? undefined
                : infraHealth.checks.notification_backlog.pending > 10
                  ? "warning"
                  : "healthy"
            }
            detail={`${infraHealth.checks.notification_backlog.pending ?? 0} pending`}
          />
        )}
        {infraHealth.checks.stuck_orders && (
          <InfraCard
            label="Stuck Orders"
            status={
              infraHealth.checks.stuck_orders.appointments == null &&
              infraHealth.checks.stuck_orders.pharmacy == null &&
              infraHealth.checks.stuck_orders.investigations == null
                ? undefined
                : (infraHealth.checks.stuck_orders.appointments ?? 0) +
                      (infraHealth.checks.stuck_orders.pharmacy ?? 0) +
                      (infraHealth.checks.stuck_orders.investigations ?? 0) >
                    0
                  ? "warning"
                  : "healthy"
            }
            detail={`${infraHealth.checks.stuck_orders.appointments ?? 0} appt / ${infraHealth.checks.stuck_orders.pharmacy ?? 0} pharm / ${infraHealth.checks.stuck_orders.investigations ?? 0} inv`}
          />
        )}
        {infraHealth.checks.server && (
          <InfraCard
            label="Server"
            status={infraHealth.checks.server.status}
            detail={`${infraHealth.checks.server.uptime_hours}h uptime · ${infraHealth.checks.server.memory_mb}MB`}
          />
        )}
      </div>
    </section>
  );
}
