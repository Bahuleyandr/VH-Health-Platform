"use client";

/**
 * Compliance Dashboard tab — surfaces the read-only aggregate
 * snapshot that complianceDashboardService.getComplianceDashboard
 * returns at GET /api/v1/compliance/dashboard.
 *
 * Stats cards (top): Active DPAs / DPIA Pending / Erasures (30d) / Legal holds (active).
 * Sections (below):
 *   - GDPR Art. 33 72h clock — regulator-pending breaches with hours-since-
 *     discovery; red > 72h, amber > 48h, green ≤ 48h.
 *   - DPA by lawful basis — small two-column table.
 *   - DPIA pending list — small table with activity_code + display_name.
 *
 * Wiring deliberately ignores `selectedBreach` / `showReport` page state —
 * this tab is read-only and self-contained.
 */

import { useQuery } from "@tanstack/react-query";
import { ShieldAlert, FileWarning, Lock, Clock } from "lucide-react";
import { fetchAdminAPI } from "@/lib/api";
import { Skeleton } from "@/components/ui/skeleton";

import type { ComplianceDashboardResponse } from "./types";
import { fmtDate, SEVERITY_STYLES, StatCard, unwrap } from "./shared";

function clockTone(hours: number): "ok" | "warn" | "danger" {
  if (hours > 72) return "danger";
  if (hours > 48) return "warn";
  return "ok";
}

function clockClass(hours: number): string {
  const tone = clockTone(hours);
  if (tone === "danger") return "bg-red-100 text-red-800 border-red-200";
  if (tone === "warn") return "bg-amber-100 text-amber-800 border-amber-200";
  return "bg-green-100 text-green-800 border-green-200";
}

export function DashboardTab() {
  const { data, isLoading, isError, error } = useQuery<ComplianceDashboardResponse>({
    queryKey: ["compliance-dashboard"],
    queryFn: async () => {
      const res = await fetchAdminAPI<unknown>("/compliance/dashboard");
      return unwrap<ComplianceDashboardResponse>(res);
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-24 w-full rounded-lg" />
          ))}
        </div>
        <Skeleton className="h-32 w-full rounded-lg" />
        <Skeleton className="h-48 w-full rounded-lg" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm">
        {error instanceof Error ? error.message : "Failed to load compliance dashboard"}
      </div>
    );
  }

  const dpaByLawful = Array.isArray(data.data_processing_activities?.by_lawful_basis)
    ? data.data_processing_activities.by_lawful_basis
    : [];
  const activeDpas = dpaByLawful.reduce((sum, row) => sum + (Number(row.count) || 0), 0);
  const dpiaPending = Array.isArray(data.data_processing_activities?.dpia_pending)
    ? data.data_processing_activities.dpia_pending
    : [];
  const dpiaCount = data.data_processing_activities?.dpia_pending_count ?? dpiaPending.length;
  const erasures30d = data.gdpr_erasure?.last_30d ?? 0;
  const erasuresTotal = data.gdpr_erasure?.total ?? 0;
  const holdsActive = data.legal_holds?.active ?? 0;
  const holdsTotal = data.legal_holds?.total ?? 0;
  const regulatorPending = Array.isArray(data.breach_incidents?.regulator_notifications_pending)
    ? data.breach_incidents.regulator_notifications_pending
    : [];
  const regulatorOverdue = regulatorPending.filter(
    (r) => Number(r.hours_since_discovery) > 72,
  ).length;

  return (
    <div className="space-y-6">
      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Active DPAs" value={activeDpas} />
        <StatCard
          label="DPIA Pending"
          value={dpiaCount}
          emphasis={dpiaCount > 0 ? "danger" : "neutral"}
        />
        <StatCard
          label="Erasures (last 30d)"
          value={erasures30d}
          hint={`${erasuresTotal} total`}
        />
        <StatCard
          label="Legal holds (active)"
          value={holdsActive}
          hint={`${holdsTotal} total`}
          emphasis={holdsActive > 0 ? "warn" : "neutral"}
        />
      </div>

      {/* GDPR Art. 33 72h clock */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold flex items-center gap-2">
          <Clock className="h-4 w-4" />
          GDPR Art. 33 — regulator-notification clock
          {regulatorOverdue > 0 ? (
            <span className="rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-xs font-medium text-red-800">
              {regulatorOverdue} overdue
            </span>
          ) : null}
        </h2>
        {regulatorPending.length === 0 ? (
          <div className="rounded-md border border-border bg-card p-4 text-sm text-muted-foreground">
            No high/critical breaches awaiting regulator notification.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">Breach</th>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">Severity</th>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">Discovered</th>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">Hours since discovery</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {regulatorPending.map((row) => {
                  const hours = Number(row.hours_since_discovery) || 0;
                  return (
                    <tr key={String(row.breach_id)}>
                      <td className="px-3 py-2 font-mono text-xs">#{row.breach_id}</td>
                      <td className="px-3 py-2">
                        <span
                          className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                            SEVERITY_STYLES[row.severity?.toLowerCase()] ?? "bg-gray-100 text-gray-600"
                          }`}
                        >
                          {row.severity}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{fmtDate(row.discovered_at)}</td>
                      <td className="px-3 py-2">
                        <span
                          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${clockClass(hours)}`}
                        >
                          <Clock className="h-3 w-3" />
                          {hours.toFixed(1)}h
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* DPA by lawful basis + DPIA pending side-by-side on wide */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="space-y-2">
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <ShieldAlert className="h-4 w-4" />
            DPAs by lawful basis
          </h2>
          {dpaByLawful.length === 0 ? (
            <div className="rounded-md border border-border bg-card p-4 text-sm text-muted-foreground">
              No active data-processing activities registered.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">Lawful basis</th>
                    <th className="px-3 py-2 text-right font-medium text-muted-foreground">Active DPAs</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {dpaByLawful.map((row) => (
                    <tr key={`${row.lawful_basis ?? "null"}`}>
                      <td className="px-3 py-2">{row.lawful_basis ?? "—"}</td>
                      <td className="px-3 py-2 text-right font-medium">{row.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="space-y-2">
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <FileWarning className="h-4 w-4" />
            DPIA pending
          </h2>
          {dpiaPending.length === 0 ? (
            <div className="rounded-md border border-border bg-card p-4 text-sm text-muted-foreground">
              No DPAs marked as DPIA-required and pending completion.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">Activity code</th>
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">Display name</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {dpiaPending.map((row) => (
                    <tr key={String(row.id)}>
                      <td className="px-3 py-2 font-mono text-xs">{row.activity_code}</td>
                      <td className="px-3 py-2">{row.display_name}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {/* Footer: snapshot timestamp */}
      <p className="text-xs text-muted-foreground">
        <Lock className="inline h-3 w-3 mr-1" />
        Snapshot: {fmtDate(data.generated_at)}. Read-only — write actions live on the
        Breaches tab and the /compliance/processing-activities + /retention-policies
        admin endpoints. Erasure log + legal holds counts come from
        <code className="mx-1 rounded bg-muted px-1 py-0.5 text-[10px]">gdpr_erasure_log</code>
        +
        <code className="mx-1 rounded bg-muted px-1 py-0.5 text-[10px]">legal_holds</code>
        (migration 094).
      </p>

    </div>
  );
}

export default DashboardTab;
