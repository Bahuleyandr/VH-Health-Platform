"use client";

import { useCallback, useState } from "react";
import { getDailyCollection } from "@/lib/api";
import { fmt, fmtDate } from "../../components/shared";
import { useReport } from "./useReport";

export function DailyCollectionSection() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [applied, setApplied] = useState<{ from?: string; to?: string }>({});

  const load = useCallback(() => getDailyCollection(applied), [applied]);
  const { data, loading, error } = useReport(load);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-sm">
          <span className="block text-muted-foreground">From</span>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="border border-border rounded px-2 py-1 text-sm bg-card"
          />
        </label>
        <label className="text-sm">
          <span className="block text-muted-foreground">To</span>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="border border-border rounded px-2 py-1 text-sm bg-card"
          />
        </label>
        <button
          type="button"
          onClick={() => setApplied({ from: from || undefined, to: to || undefined })}
          className="px-3 py-1 rounded-md text-sm font-medium bg-primary text-white hover:bg-primary/90"
        >
          Apply
        </button>
      </div>

      {loading && <p className="text-sm text-muted-foreground">Loading daily collection…</p>}
      {error && <p className="text-sm text-red-700">{error}</p>}
      {data && !loading &&
        (data.days.length === 0 ? (
          <p className="text-sm text-muted-foreground">No collections in this range.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left bg-muted/50">
                  <th className="py-2 px-3">Day</th>
                  <th className="py-2 px-3 text-right">Collected</th>
                </tr>
              </thead>
              <tbody>
                {data.days.map((d) => (
                  <tr key={d.day} className="border-b border-border hover:bg-muted/30">
                    <td className="py-2 px-3">{fmtDate(d.day)}</td>
                    <td className="py-2 px-3 text-right font-medium">{fmt(d.collected)}</td>
                  </tr>
                ))}
                <tr className="bg-muted/50 font-medium">
                  <td className="py-2 px-3">Total</td>
                  <td className="py-2 px-3 text-right">{fmt(data.total)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        ))}
    </div>
  );
}
