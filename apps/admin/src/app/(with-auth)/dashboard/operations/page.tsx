// src/app/(with-auth)/dashboard/operations/page.tsx
//
// Daily Operations Snapshot — Sprint 9. Single-screen morning-huddle
// view that hits the bi_daily_ops_snapshot view via
// GET /api/v1/dashboards/snapshot/daily-ops. Auto-refreshes every 60s.

"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchAdminAPI } from "@/lib/api";
import { MetricCard } from "@/components/MetricCard";
import { LoadingSpinner } from "@/components/LoadingSpinner";

interface DailyOpsSnapshot {
  d: string;
  opd_today: number;
  opd_completed_today: number;
  ip_in_house: number;
  or_cases_today: number;
  open_critical_alerts: number;
  collections_today: number | string;
  preauth_pending: number;
  claims_outstanding: number;
}

function fmtINR(n: number | string | null | undefined): string {
  const num = Number(n ?? 0);
  if (!Number.isFinite(num)) return "₹0";
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(num);
}

export default function OperationsPage() {
  const [snapshot, setSnapshot] = useState<DailyOpsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const fetchSnapshot = useCallback(async () => {
    setError(null);
    try {
      const r = await fetchAdminAPI<{ data: DailyOpsSnapshot } | DailyOpsSnapshot>(
        "/dashboards/snapshot/daily-ops",
      );
      const data = (r as { data?: DailyOpsSnapshot }).data ?? (r as DailyOpsSnapshot);
      setSnapshot(data);
      setLastUpdated(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load snapshot");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSnapshot();
    const interval = setInterval(fetchSnapshot, 60_000);
    return () => clearInterval(interval);
  }, [fetchSnapshot]);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Daily Operations Snapshot</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Morning-huddle headline numbers. Auto-refreshes every 60s.
          </p>
        </div>
        <div className="text-xs text-muted-foreground">
          {lastUpdated ? (
            <>Updated {lastUpdated.toLocaleTimeString()}</>
          ) : (
            <>—</>
          )}
          <button
            onClick={fetchSnapshot}
            className="ml-3 px-3 py-1.5 rounded-md border text-foreground hover:bg-muted text-xs"
          >
            Refresh now
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading && !snapshot ? (
        <LoadingSpinner />
      ) : snapshot ? (
        <>
          <section>
            <h2 className="text-xs uppercase tracking-wider text-muted-foreground mb-2">
              Outpatient
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <MetricCard
                label="OPD appointments today"
                value={snapshot.opd_today}
              />
              <MetricCard
                label="Completed"
                value={snapshot.opd_completed_today}
                help={
                  snapshot.opd_today > 0
                    ? `${Math.round(
                        (snapshot.opd_completed_today / snapshot.opd_today) * 100,
                      )}% done`
                    : undefined
                }
              />
              <MetricCard label="IP patients in-house" value={snapshot.ip_in_house} />
              <MetricCard label="OR cases today" value={snapshot.or_cases_today} />
            </div>
          </section>

          <section>
            <h2 className="text-xs uppercase tracking-wider text-muted-foreground mb-2">
              Money
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              <MetricCard
                label="Collections today"
                value={fmtINR(snapshot.collections_today)}
              />
              <MetricCard
                label="Pre-auths pending TPA reply"
                value={snapshot.preauth_pending}
                help="needs follow-up"
              />
              <MetricCard
                label="Claims outstanding"
                value={snapshot.claims_outstanding}
                help="submitted or queried"
              />
            </div>
          </section>

          <section>
            <h2 className="text-xs uppercase tracking-wider text-muted-foreground mb-2">
              Safety
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              <MetricCard
                label="Open critical lab alerts"
                value={snapshot.open_critical_alerts}
                help={snapshot.open_critical_alerts > 0 ? "needs read-back" : "all clear"}
              />
            </div>
          </section>

          <p className="text-xs text-muted-foreground pt-4">
            Source: <code>bi_daily_ops_snapshot</code> view. Snapshot for{" "}
            <strong>{snapshot.d}</strong>.
          </p>
        </>
      ) : null}
    </div>
  );
}
