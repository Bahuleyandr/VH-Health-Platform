"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { fetchAdminAPI } from "@/lib/api";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { EmptyState } from "@/components/EmptyState";

interface ExpiryAlert {
  id: number;
  item_name: string;
  batch_number: string;
  expiry_date: string;
  remaining_quantity: number;
  unit: string | null;
  days_to_expiry: number;
  severity: "expired" | "critical" | "warning" | "info";
}

const SEVERITY_COLOURS: Record<string, string> = {
  expired: "bg-rose-200 text-rose-900 border border-rose-300",
  critical: "bg-rose-100 text-rose-800",
  warning: "bg-amber-100 text-amber-800",
  info: "bg-slate-100 text-slate-700",
};

function unwrap<T>(r: unknown): T {
  return ((r as { data?: T }).data ?? r) as T;
}

export function ExpiryAlertsTab() {
  const qc = useQueryClient();

  const { data: rows = [], error, isLoading } = useQuery<ExpiryAlert[]>({
    queryKey: ["pharmacy", "expiry-alerts"],
    queryFn: async () => {
      const r = await fetchAdminAPI<unknown>(
        "/pharmacy/inventory/v2/expiry-alerts?limit=300",
      );
      const data = unwrap<ExpiryAlert[]>(r);
      return Array.isArray(data) ? data : [];
    },
  });

  const scanMut = useMutation({
    mutationFn: () =>
      fetchAdminAPI("/pharmacy/inventory/v2/expiry-scan", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pharmacy", "expiry-alerts"] }),
  });

  const expired = rows.filter((r) => r.severity === "expired").length;
  const critical = rows.filter((r) => r.severity === "critical").length;
  const warning = rows.filter((r) => r.severity === "warning").length;
  const errMsg = (error ?? scanMut.error)
    ? (error ?? scanMut.error)!.toString()
    : null;

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <p className="text-sm text-muted-foreground">
            Batches expiring soon. Run a scan to refresh; severity bands:
            expired / critical (≤30d) / warning (≤90d) / info (≤180d).
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => scanMut.mutate()}
            disabled={scanMut.isPending}
            className="px-3 py-2 rounded-md border text-sm hover:bg-muted disabled:opacity-40"
          >
            {scanMut.isPending ? "Scanning…" : "Run scan"}
          </button>
          <button
            onClick={() => qc.invalidateQueries({ queryKey: ["pharmacy", "expiry-alerts"] })}
            className="px-3 py-2 rounded-md border text-sm hover:bg-muted"
          >
            Refresh
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-white rounded-lg border shadow-sm p-3">
          <p className="text-xs text-muted-foreground">Total alerts</p>
          <p className="text-xl font-semibold mt-1">{rows.length}</p>
        </div>
        <div className="bg-white rounded-lg border border-rose-300 shadow-sm p-3">
          <p className="text-xs text-muted-foreground">Expired</p>
          <p className="text-xl font-semibold mt-1 text-rose-700">{expired}</p>
        </div>
        <div className="bg-white rounded-lg border border-rose-200 shadow-sm p-3">
          <p className="text-xs text-muted-foreground">Critical (≤30d)</p>
          <p className="text-xl font-semibold mt-1 text-rose-600">{critical}</p>
        </div>
        <div className="bg-white rounded-lg border border-amber-200 shadow-sm p-3">
          <p className="text-xs text-muted-foreground">Warning (≤90d)</p>
          <p className="text-xl font-semibold mt-1 text-amber-700">{warning}</p>
        </div>
      </div>

      {errMsg && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {errMsg}
        </div>
      )}

      {isLoading ? (
        <LoadingSpinner />
      ) : rows.length === 0 ? (
        <EmptyState title="All clear" description="No batches expiring soon." />
      ) : (
        <div className="bg-white rounded-lg border shadow-sm overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-xs text-muted-foreground border-b">
              <tr className="text-left">
                <th className="px-3 py-2">Severity</th>
                <th className="px-3 py-2">Item</th>
                <th className="px-3 py-2">Batch</th>
                <th className="px-3 py-2">Expiry</th>
                <th className="px-3 py-2">Days left</th>
                <th className="px-3 py-2">Remaining qty</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className={`border-b last:border-0 ${
                    r.severity === "expired" ? "bg-rose-50" : ""
                  }`}
                >
                  <td className="px-3 py-2">
                    <span
                      className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                        SEVERITY_COLOURS[r.severity] ?? ""
                      }`}
                    >
                      {r.severity}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-medium">{r.item_name}</td>
                  <td className="px-3 py-2 font-mono text-xs">{r.batch_number}</td>
                  <td className="px-3 py-2 text-xs">{r.expiry_date}</td>
                  <td
                    className={`px-3 py-2 font-mono ${
                      r.days_to_expiry < 0
                        ? "text-rose-700"
                        : r.days_to_expiry < 30
                          ? "text-rose-600"
                          : ""
                    }`}
                  >
                    {r.days_to_expiry}
                  </td>
                  <td className="px-3 py-2 font-mono">
                    {r.remaining_quantity}
                    {r.unit ? <span className="text-muted-foreground"> {r.unit}</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
