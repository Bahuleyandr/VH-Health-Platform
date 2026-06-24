"use client";

import { getCashPosition } from "@/lib/api";
import { fmt } from "../../components/shared";
import { useReport } from "./useReport";

export function CashPositionSection() {
  const { data, loading, error } = useReport(getCashPosition);

  if (loading) return <p className="text-sm text-muted-foreground">Loading cash position…</p>;
  if (error) return <p className="text-sm text-red-700">{error}</p>;
  if (!data) return <p className="text-sm text-muted-foreground">No cash position data.</p>;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-card border border-border rounded-lg p-4">
          <p className="text-sm text-muted-foreground">Cash on hand</p>
          <p className="text-2xl font-bold text-foreground">{fmt(data.cashTotal)}</p>
        </div>
        <div className="bg-card border border-border rounded-lg p-4">
          <p className="text-sm text-muted-foreground">Bank</p>
          <p className="text-2xl font-bold text-foreground">{fmt(data.bankTotal)}</p>
        </div>
      </div>
      <div>
        <p className="text-sm font-medium mb-2">By drawer session</p>
        {data.byDrawer.length === 0 ? (
          <p className="text-sm text-muted-foreground">No open drawer sessions.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left bg-muted/50">
                  <th className="py-2 px-3">Drawer session</th>
                  <th className="py-2 px-3 text-right">Net</th>
                </tr>
              </thead>
              <tbody>
                {data.byDrawer.map((d) => (
                  <tr key={d.drawerSessionId} className="border-b border-border hover:bg-muted/30">
                    <td className="py-2 px-3 font-mono text-xs">#{d.drawerSessionId}</td>
                    <td className="py-2 px-3 text-right font-medium">{fmt(d.net)}</td>
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
