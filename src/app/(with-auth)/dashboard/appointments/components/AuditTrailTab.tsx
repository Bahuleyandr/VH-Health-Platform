"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "react-hot-toast";
import { Skeleton } from "@/components/ui/skeleton";
import {
  getAppointmentAuditTrail,
  type AuditEntry,
} from "@/lib/api/appointments";
import { fmtDateTime, StatusBadge } from "./helpers";

export function AuditTrailTab() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = {};
      if (fromDate) params.from_date = fromDate;
      if (toDate) params.to_date = toDate;
      const res = await getAppointmentAuditTrail(params);
      setEntries(Array.isArray(res) ? res : []);
    } catch {
      toast.error("Failed to load audit trail");
    } finally {
      setLoading(false);
    }
  }, [fromDate, toDate]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex gap-3 items-center">
        <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className="border rounded px-3 py-1.5 text-sm" />
        <input type="date" value={toDate} onChange={e => setToDate(e.target.value)} className="border rounded px-3 py-1.5 text-sm" />
        <button onClick={load} className="bg-primary text-white text-sm px-4 py-1.5 rounded">Filter</button>
      </div>

      {loading ? <Skeleton className="h-48 w-full" /> : entries.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">No audit entries found</div>
      ) : (
        <div className="border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead><tr className="border-b bg-muted/50"><th className="px-4 py-2 text-left">Appt ID</th><th className="px-4 py-2 text-left">Patient</th><th className="px-4 py-2 text-left">Status Change</th><th className="px-4 py-2 text-left">Changed By</th><th className="px-4 py-2 text-left">Role</th><th className="px-4 py-2 text-left">Reason</th><th className="px-4 py-2 text-left">Time</th></tr></thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className="border-b hover:bg-muted/20">
                  <td className="px-4 py-2 font-mono text-xs">#{e.appointment_id}</td>
                  <td className="px-4 py-2">{e.patient_name ?? "—"}</td>
                  <td className="px-4 py-2">
                    <span className="flex items-center gap-1">
                      {e.from_status && <StatusBadge status={e.from_status} />}
                      {e.from_status && <span className="text-gray-400">→</span>}
                      <StatusBadge status={e.to_status} />
                    </span>
                  </td>
                  <td className="px-4 py-2">{e.changed_by_name ?? `User #${e.changed_by}`}</td>
                  <td className="px-4 py-2 capitalize">{e.changed_by_role ?? "—"}</td>
                  <td className="px-4 py-2 max-w-xs truncate text-gray-600">{e.reason ?? "—"}</td>
                  <td className="px-4 py-2 text-xs text-gray-500">{fmtDateTime(e.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
