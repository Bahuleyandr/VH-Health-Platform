"use client";

import { useEffect, useState, useCallback } from "react";
import { toast } from "react-hot-toast";
import {
  getInvestigationsList,
  type Investigation,
} from "@/lib/api/investigations";
import { formatDate } from "./helpers";

export function NotificationsTab() {
  const [investigations, setInvestigations] = useState<Investigation[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = {
        status: "COMPLETED",
        notified: "false",
        limit: 50,
        page: 1,
      };
      const res = await getInvestigationsList(params);
      const all = res.investigations ?? [];
      // Filter client-side to only show un-notified completed
      setInvestigations(all.filter((inv) => !inv.notified));
    } catch {
      toast.error("Failed to load un-notified investigations");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function hoursSince(dateStr: string | null) {
    if (!dateStr) return "—";
    const diff = (Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60);
    return diff.toFixed(1);
  }

  if (loading)
    return (
      <div className="py-12 text-center text-muted-foreground">Loading…</div>
    );
  if (investigations.length === 0) {
    return (
      <div className="py-12 text-center text-muted-foreground">
        All completed investigations have been notified ✅
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {investigations.length} completed investigation(s) pending patient
        notification
      </p>
      <div className="overflow-x-auto rounded border">
        <table className="w-full text-sm">
          <thead className="bg-muted text-left">
            <tr>
              <th className="px-3 py-2">Patient</th>
              <th className="px-3 py-2">Phone</th>
              <th className="px-3 py-2">Test</th>
              <th className="px-3 py-2">Completed</th>
              <th className="px-3 py-2">Hours Since</th>
            </tr>
          </thead>
          <tbody>
            {investigations.map((inv) => (
              <tr key={inv.id}>
                <td className="px-3 py-2">{inv.patient_name ?? "—"}</td>
                <td className="px-3 py-2 font-mono text-xs">
                  {inv.phone ?? "—"}
                </td>
                <td className="px-3 py-2">{inv.test_name}</td>
                <td className="px-3 py-2 text-xs">
                  {formatDate(inv.completed_date)}
                </td>
                <td className="px-3 py-2 font-mono">
                  {hoursSince(inv.completed_date)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
