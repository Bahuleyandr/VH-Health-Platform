"use client";

import { useQuery } from "@tanstack/react-query";
import { Flag, RefreshCw } from "lucide-react";
import {
  getHousekeepingStats,
  type HousekeepingStats,
} from "@/lib/api/housekeeping";
import { Skeleton } from "@/components/ui/skeleton";
import { fmtDate, StatCard, unwrap } from "./helpers";

export function DashboardTab() {
  const {
    data: raw,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ["hk-stats"],
    queryFn: () => getHousekeepingStats(),
    refetchInterval: 60000,
  });

  const stats = raw ? unwrap<HousekeepingStats>(raw) : null;

  if (isLoading)
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  if (isError || !stats)
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700 flex items-center justify-between gap-3">
        <span>
          {error instanceof Error
            ? error.message
            : "Failed to load housekeeping stats"}
        </span>
        <button
          onClick={() => refetch()}
          className="flex items-center gap-1 shrink-0 font-medium text-red-700 hover:text-red-900"
        >
          <RefreshCw size={14} /> Retry
        </button>
      </div>
    );

  const { logs, requests, sla, top_staff, recent_flags } = stats;

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <button
          onClick={() => refetch()}
          className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700"
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Logs Today" value={logs.today} color="teal" />
        <StatCard label="Open Requests" value={requests.open} color="blue" />
        <StatCard
          label="Urgent Open"
          value={requests.urgent_open}
          color="red"
        />
        <StatCard
          label="SLA Breached"
          value={requests.sla_breached}
          color="orange"
        />
      </div>

      <div className="bg-card rounded-xl border p-5">
        <h3 className="font-semibold text-gray-700 mb-4">
          SLA Performance (30 days)
        </h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
          <div>
            <div className="text-2xl font-bold text-green-600">
              {sla.completed_within_sla}
            </div>
            <div className="text-xs text-gray-500">Within SLA</div>
          </div>
          <div>
            <div className="text-2xl font-bold text-red-500">
              {sla.completed_over_sla}
            </div>
            <div className="text-xs text-gray-500">Over SLA</div>
          </div>
          <div>
            <div className="text-2xl font-bold text-orange-500">
              {sla.currently_breached}
            </div>
            <div className="text-xs text-gray-500">Currently Breached</div>
          </div>
          <div>
            <div className="text-2xl font-bold text-gray-700">
              {sla.avg_completion_minutes
                ? `${Math.round(parseInt(sla.avg_completion_minutes) / 60)}h`
                : "—"}
            </div>
            <div className="text-xs text-gray-500">Avg Completion</div>
          </div>
        </div>
      </div>

      {top_staff.length > 0 && (
        <div className="bg-card rounded-xl border p-5">
          <h3 className="font-semibold text-gray-700 mb-4">
            🏆 Top Performing HK Staff (30 days)
          </h3>
          <div className="space-y-2">
            {top_staff.map((s, i) => (
              <div
                key={s.id}
                className="flex items-center gap-3 py-2 border-b last:border-0"
              >
                <span className="w-6 text-center text-gray-400 text-sm font-bold">
                  {i + 1}
                </span>
                <span className="flex-1 font-medium text-gray-800">
                  {s.name}
                </span>
                <span className="text-sm text-teal-700 font-semibold">
                  {s.completions} tasks
                </span>
                {s.avg_minutes && (
                  <span className="text-xs text-gray-500">
                    avg {Math.round(parseInt(s.avg_minutes))} min
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {recent_flags.length > 0 && (
        <div className="bg-card rounded-xl border border-red-200 p-5">
          <h3 className="font-semibold text-red-700 mb-4">⚠️ Flagged Logs</h3>
          <div className="space-y-3">
            {recent_flags.map((f) => (
              <div
                key={f.id}
                className="flex items-start gap-3 p-3 bg-red-50 rounded-lg"
              >
                <Flag size={16} className="text-red-500 mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm text-red-700">
                      {f.log_number}
                    </span>
                    <span className="text-xs text-gray-500">
                      {f.staff_name}
                    </span>
                    <span className="text-xs text-gray-400">
                      {fmtDate(f.logged_at)}
                    </span>
                  </div>
                  {f.flag_reason && (
                    <p className="text-xs text-red-600 mt-1">{f.flag_reason}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
