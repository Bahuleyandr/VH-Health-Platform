"use client";

import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { EmptyState } from "@/components/EmptyState";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import {
  acknowledgeExpiryAlert,
  listExpiryAlerts,
  scanExpiryAlerts,
} from "./api";
import { formatDate, humanize, SeverityBadge, StatCard } from "./shared";

export function ExpiryAlertsTab() {
  const qc = useQueryClient();
  const { data, error, isLoading } = useQuery({
    queryKey: ["credentialing", "expiry-alerts"],
    queryFn: listExpiryAlerts,
  });
  const rows = useMemo(() => data?.alerts ?? [], [data?.alerts]);

  const scanMut = useMutation({
    mutationFn: scanExpiryAlerts,
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: ["credentialing", "expiry-alerts"] }),
  });
  const ackMut = useMutation({
    mutationFn: acknowledgeExpiryAlert,
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: ["credentialing", "expiry-alerts"] }),
  });

  const stats = useMemo(
    () => ({
      total: rows.length,
      critical: rows.filter((row) => row.severity === "critical").length,
      high: rows.filter((row) => row.severity === "high").length,
      overdue: rows.filter((row) => row.days_remaining < 0).length,
    }),
    [rows],
  );

  const errMsg = (error ?? scanMut.error ?? ackMut.error)?.toString() ?? null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="grid min-w-0 flex-1 grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard label="Open alerts" value={stats.total} />
          <StatCard label="Critical" value={stats.critical} tone="rose" />
          <StatCard label="High" value={stats.high} tone="amber" />
          <StatCard label="Overdue" value={stats.overdue} tone="rose" />
        </div>
        <button
          type="button"
          onClick={() => scanMut.mutate()}
          disabled={scanMut.isPending}
          className="rounded-md border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"
        >
          {scanMut.isPending ? "Scanning..." : "Run scan"}
        </button>
      </div>

      {errMsg && (
        <div className="rounded border border-destructive/30 bg-destructive/5 p-2 text-sm text-destructive">
          {errMsg}
        </div>
      )}

      <div className="rounded-lg border bg-card shadow-sm">
        <div className="border-b px-4 py-3">
          <h2 className="text-lg font-semibold">Expiry alerts</h2>
        </div>
        {isLoading ? (
          <LoadingSpinner label="Loading alerts" />
        ) : rows.length === 0 ? (
          <EmptyState title="No open alerts" compact />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="border-b text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Severity</th>
                  <th className="px-3 py-2">Staff</th>
                  <th className="px-3 py-2">Credential</th>
                  <th className="px-3 py-2">Kind</th>
                  <th className="px-3 py-2">Due</th>
                  <th className="px-3 py-2">Days</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-b last:border-0">
                    <td className="px-3 py-2">
                      <SeverityBadge severity={row.severity} />
                    </td>
                    <td className="px-3 py-2">
                      <div className="font-medium">{row.staff_name ?? row.staff_uid}</div>
                      <div className="text-xs text-muted-foreground">{row.staff_role ?? "-"}</div>
                    </td>
                    <td className="px-3 py-2">{row.credential_name ?? "-"}</td>
                    <td className="px-3 py-2">{humanize(row.alert_kind)}</td>
                    <td className="px-3 py-2">{formatDate(row.due_date)}</td>
                    <td className={row.days_remaining < 0 ? "px-3 py-2 text-rose-700" : "px-3 py-2"}>
                      {row.days_remaining}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        disabled={ackMut.isPending}
                        onClick={() => ackMut.mutate(row.id)}
                        className="rounded border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
                      >
                        Acknowledge
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
