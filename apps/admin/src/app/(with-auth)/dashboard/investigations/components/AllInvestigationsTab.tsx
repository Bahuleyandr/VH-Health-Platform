"use client";

import { useEffect, useState, useCallback } from "react";
import { toast } from "react-hot-toast";
import {
  getInvestigationsList,
  updateInvestigationStatus,
  type Investigation,
} from "@/lib/api/investigations";
import { Chip, formatDate, priorityColor, statusColor } from "./helpers";

export function AllInvestigationsTab() {
  const [investigations, setInvestigations] = useState<Investigation[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [filters, setFilters] = useState({ status: "", priority: "", from: "", to: "" });
  const limit = 20;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string | number> = { page, limit };
      if (filters.status) params.status = filters.status;
      if (filters.priority) params.priority = filters.priority;
      if (filters.from) params.from_date = filters.from;
      if (filters.to) params.to_date = filters.to;

      const res = await getInvestigationsList(params);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = res as any;
      const d = raw?.data ?? raw;
      setInvestigations((d?.investigations as Investigation[]) ?? []);
      const pag = d?.pagination;
      setTotal(Number(pag?.total ?? 0));
    } catch {
      toast.error("Failed to load investigations");
    } finally {
      setLoading(false);
    }
  }, [page, filters]);

  useEffect(() => { load(); }, [load]);

  const totalPages = Math.ceil(total / limit);

  async function handleStatusUpdate(id: number, newStatus: string) {
    try {
      await updateInvestigationStatus(id, newStatus);
      toast.success("Status updated");
      load();
    } catch {
      toast.error("Failed to update status");
    }
  }

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <select value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}
          className="rounded border px-2 py-1 text-sm">
          <option value="">All Status</option>
          {["PENDING", "SCHEDULED", "IN_PROGRESS", "COMPLETED", "CANCELLED"].map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <select value={filters.priority} onChange={(e) => setFilters((f) => ({ ...f, priority: e.target.value }))}
          className="rounded border px-2 py-1 text-sm">
          <option value="">All Priority</option>
          {["URGENT", "HIGH", "NORMAL", "LOW"].map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
        <input type="date" value={filters.from} onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))}
          className="rounded border px-2 py-1 text-sm" placeholder="From" />
        <input type="date" value={filters.to} onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))}
          className="rounded border px-2 py-1 text-sm" placeholder="To" />
        <button onClick={() => { setPage(1); load(); }}
          className="rounded bg-primary px-3 py-1 text-sm text-primary-foreground">
          Filter
        </button>
      </div>

      {loading ? (
        <div className="py-12 text-center text-muted-foreground">Loading…</div>
      ) : investigations.length === 0 ? (
        <div className="py-12 text-center text-muted-foreground">No investigations found</div>
      ) : (
        <>
          <div className="overflow-x-auto rounded border">
            <table className="w-full text-sm">
              <thead className="bg-muted text-left">
                <tr>
                  <th className="px-3 py-2">ID</th>
                  <th className="px-3 py-2">Patient</th>
                  <th className="px-3 py-2">Phone</th>
                  <th className="px-3 py-2">Test</th>
                  <th className="px-3 py-2">Priority</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Ordered</th>
                  <th className="px-3 py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {investigations.map((inv) => {
                  const isUrgent = ["URGENT", "STAT"].includes(inv.priority?.toUpperCase());
                  return (
                    <tr key={inv.id} className={isUrgent ? "bg-red-50/60" : ""}>
                      <td className="px-3 py-2 font-mono text-xs">{inv.id}</td>
                      <td className="px-3 py-2">{inv.patient_name ?? "—"}</td>
                      <td className="px-3 py-2 font-mono text-xs">{inv.phone ?? "—"}</td>
                      <td className="px-3 py-2">{inv.test_name}</td>
                      <td className="px-3 py-2">
                        <Chip label={inv.priority ?? "—"} className={priorityColor(inv.priority)} />
                      </td>
                      <td className="px-3 py-2">
                        <Chip label={inv.status ?? "—"} className={statusColor(inv.status)} />
                      </td>
                      <td className="px-3 py-2 text-xs">{formatDate(inv.ordered_date)}</td>
                      <td className="px-3 py-2">
                        <select
                          defaultValue=""
                          onChange={(e) => {
                            if (e.target.value) handleStatusUpdate(inv.id, e.target.value);
                            e.target.value = "";
                          }}
                          className="rounded border px-1 py-0.5 text-xs"
                        >
                          <option value="" disabled>Update…</option>
                          {["PENDING", "IN_PROGRESS", "COMPLETED", "CANCELLED"].map((s) => (
                            <option key={s} value={s}>{s}</option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2">
              <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}
                className="rounded border px-3 py-1 text-sm disabled:opacity-40">Prev</button>
              <span className="text-sm text-muted-foreground">
                Page {page} of {totalPages} ({total} total)
              </span>
              <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}
                className="rounded border px-3 py-1 text-sm disabled:opacity-40">Next</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
