"use client";

import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { getHousekeepingStats, type HousekeepingStats } from "@/lib/api/housekeeping";
import { Skeleton } from "@/components/ui/skeleton";
import { fmtDate, StatCard, unwrap } from "./helpers";

export function PerformanceTab() {
  const { data: raw, isLoading, refetch } = useQuery({
    queryKey: ["hk-stats-perf"],
    queryFn: () => getHousekeepingStats(),
    refetchInterval: 120000,
  });

  const stats = raw ? unwrap<HousekeepingStats>(raw) : null;

  if (isLoading) return <div className="space-y-4"><Skeleton className="h-48 w-full" /><Skeleton className="h-48 w-full" /></div>;
  if (!stats) return null;

  const { top_staff, recent_flags, logs, requests } = stats;

  // Build flag reason breakdown from recent_flags
  const flagReasons: Record<string, number> = {};
  const flagByStaff: Record<string, number> = {};
  for (const f of recent_flags) {
    const reason = f.flag_reason ?? "unspecified";
    flagReasons[reason] = (flagReasons[reason] ?? 0) + 1;
    const staff = f.staff_name ?? "Unknown";
    flagByStaff[staff] = (flagByStaff[staff] ?? 0) + 1;
  }

  const sortedFlagStaff = Object.entries(flagByStaff).sort((a, b) => b[1] - a[1]);

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-lg font-semibold text-gray-800">Staff Performance Overview (30 days)</h2>
        <button onClick={() => refetch()} className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700">
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Total Logs" value={logs.total} color="teal" />
        <StatCard label="Verified Logs" value={logs.verified} color="blue" />
        <StatCard label="Flagged Logs" value={logs.flagged} color="red" />
        <StatCard label="Tasks Completed" value={requests.completed} color="orange" />
      </div>

      <div className="bg-white rounded-xl border p-5">
        <h3 className="font-semibold text-gray-700 mb-4">🏆 Top Performers</h3>
        {top_staff.length === 0 ? (
          <p className="text-gray-400 text-sm text-center py-4">No data available yet</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  {["Rank", "Staff Name", "Tasks Completed", "Avg Completion"].map((h) => (
                    <th key={h} className="px-4 py-3 text-left font-semibold text-gray-600 text-xs">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {top_staff.map((s, i) => (
                  <tr key={s.id} className="border-t hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold ${
                        i === 0 ? "bg-yellow-100 text-yellow-700" :
                        i === 1 ? "bg-gray-100 text-gray-600" :
                        i === 2 ? "bg-orange-100 text-orange-600" : "text-gray-400"
                      }`}>{i + 1}</span>
                    </td>
                    <td className="px-4 py-3 font-medium text-gray-800">{s.name}</td>
                    <td className="px-4 py-3 text-teal-700 font-semibold">{s.completions}</td>
                    <td className="px-4 py-3 text-gray-500">
                      {s.avg_minutes ? `${Math.round(parseInt(s.avg_minutes))} min` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {recent_flags.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="bg-white rounded-xl border border-red-100 p-5">
            <h3 className="font-semibold text-red-700 mb-4">⚠️ Staff with Flags</h3>
            {sortedFlagStaff.length === 0 ? (
              <p className="text-gray-400 text-sm">No flagged staff</p>
            ) : (
              <div className="space-y-2">
                {sortedFlagStaff.map(([name, count]) => (
                  <div key={name} className="flex items-center justify-between py-1.5 border-b last:border-0">
                    <span className="text-sm text-gray-700">{name}</span>
                    <span className="text-xs font-semibold text-red-600 bg-red-50 px-2 py-0.5 rounded-full border border-red-200">
                      {count} flag{count > 1 ? "s" : ""}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="bg-white rounded-xl border border-red-100 p-5">
            <h3 className="font-semibold text-red-700 mb-4">🔍 Flag Reasons</h3>
            {Object.keys(flagReasons).length === 0 ? (
              <p className="text-gray-400 text-sm">No flag reasons</p>
            ) : (
              <div className="space-y-2">
                {Object.entries(flagReasons)
                  .sort((a, b) => b[1] - a[1])
                  .map(([reason, count]) => (
                    <div key={reason} className="flex items-start gap-2 py-1.5 border-b last:border-0">
                      <span className="flex-1 text-sm text-gray-600 break-words">{reason}</span>
                      <span className="text-xs font-semibold text-orange-600 shrink-0">{count}×</span>
                    </div>
                  ))}
              </div>
            )}
          </div>
        </div>
      )}

      {recent_flags.length > 0 && (
        <div className="bg-white rounded-xl border p-5">
          <h3 className="font-semibold text-gray-700 mb-4">Recent Flagged Logs</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  {["Log#", "Staff", "Zone", "Reason", "Date"].map((h) => (
                    <th key={h} className="px-4 py-2 text-left font-semibold text-gray-600 text-xs">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {recent_flags.map((f) => (
                  <tr key={f.id} className="border-t hover:bg-red-50">
                    <td className="px-4 py-2 font-mono text-xs text-red-700">{f.log_number}</td>
                    <td className="px-4 py-2 text-gray-700">{f.staff_name ?? "—"}</td>
                    <td className="px-4 py-2 text-gray-500">{f.zone_name ?? "—"}</td>
                    <td className="px-4 py-2 text-red-600 text-xs max-w-[200px] truncate" title={f.flag_reason ?? ""}>{f.flag_reason ?? "—"}</td>
                    <td className="px-4 py-2 text-gray-400 text-xs">{fmtDate(f.logged_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
