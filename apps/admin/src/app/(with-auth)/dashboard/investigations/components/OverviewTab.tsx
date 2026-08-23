"use client";

import { useEffect, useState, useCallback } from "react";
import { toast } from "react-hot-toast";
import { getSLADashboard, type SLADashboard } from "@/lib/api/investigations";
import { Chip, SummaryCard, priorityColor, statusColor } from "./helpers";

export function OverviewTab() {
  const [dashboard, setDashboard] = useState<SLADashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [fromDate, setFromDate] = useState(() => {
    const d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    return d.toISOString().split("T")[0];
  });
  const [toDate, setToDate] = useState(() => new Date().toISOString().split("T")[0]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getSLADashboard(fromDate, toDate);
      setDashboard(res);
    } catch {
      toast.error("Failed to load SLA dashboard");
    } finally {
      setLoading(false);
    }
  }, [fromDate, toDate]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="py-12 text-center text-muted-foreground">Loading dashboard…</div>;
  if (!dashboard) return <div className="py-12 text-center text-muted-foreground">No data</div>;

  const s = dashboard.summary;

  return (
    <div className="space-y-6">
      {/* Date range */}
      <div className="flex items-end gap-4">
        <label className="text-sm">
          From
          <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)}
            className="ml-2 rounded border px-2 py-1 text-sm" />
        </label>
        <label className="text-sm">
          To
          <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)}
            className="ml-2 rounded border px-2 py-1 text-sm" />
        </label>
        <button onClick={load} className="rounded bg-primary px-3 py-1 text-sm text-primary-foreground">
          Refresh
        </button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
        <SummaryCard label="Total" value={s.total} />
        <SummaryCard label="Completed" value={s.completed} color="text-green-600" />
        <SummaryCard label="Pending" value={s.pending} color="text-yellow-600" />
        <SummaryCard label="Urgent Pending" value={s.urgent_pending} color="text-red-600" />
        <SummaryCard label="Avg TAT (hrs)" value={s.avg_tat_hours ? Number(s.avg_tat_hours).toFixed(1) : "—"} />
      </div>

      {/* Urgent pending table */}
      {dashboard.urgent_pending.length > 0 && (
        <section>
          <h3 className="mb-2 text-lg font-semibold text-red-700">⚠️ Urgent Pending</h3>
          <div className="overflow-x-auto rounded border">
            <table className="w-full text-sm">
              <thead className="bg-muted text-left">
                <tr>
                  <th className="px-3 py-2">Patient</th>
                  <th className="px-3 py-2">Test</th>
                  <th className="px-3 py-2">Doctor</th>
                  <th className="px-3 py-2">Waiting (hrs)</th>
                  <th className="px-3 py-2">Priority</th>
                </tr>
              </thead>
              <tbody>
                {dashboard.urgent_pending.map((inv) => (
                  <tr key={inv.id}
                    className={Number(inv.hours_waiting) > 2 ? "bg-red-50" : ""}>
                    <td className="px-3 py-2">{inv.patient_name ?? "—"}</td>
                    <td className="px-3 py-2">{inv.test_name}</td>
                    <td className="px-3 py-2">{inv.doctor_name ?? "—"}</td>
                    <td className="px-3 py-2 font-mono">{inv.hours_waiting ?? "—"}</td>
                    <td className="px-3 py-2">
                      <Chip label={inv.priority} className={priorityColor(inv.priority)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Recent completed */}
      {dashboard.recent_completed.length > 0 && (
        <section>
          <h3 className="mb-2 text-lg font-semibold">Recent Completed</h3>
          <div className="overflow-x-auto rounded border">
            <table className="w-full text-sm">
              <thead className="bg-muted text-left">
                <tr>
                  <th className="px-3 py-2">Patient</th>
                  <th className="px-3 py-2">Test</th>
                  <th className="px-3 py-2">TAT (hrs)</th>
                  <th className="px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {dashboard.recent_completed.map((inv) => (
                  <tr key={inv.id}>
                    <td className="px-3 py-2">{inv.patient_name ?? "—"}</td>
                    <td className="px-3 py-2">{inv.test_name}</td>
                    <td className="px-3 py-2 font-mono">{inv.tat_hours ?? "—"}</td>
                    <td className="px-3 py-2">
                      <Chip label={inv.status} className={statusColor(inv.status)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
