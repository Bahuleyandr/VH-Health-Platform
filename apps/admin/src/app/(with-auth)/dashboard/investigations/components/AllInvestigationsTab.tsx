"use client";

import { useEffect, useState, useCallback } from "react";
import { toast } from "react-hot-toast";
import {
  ClientTablePagination,
  ManagedTableToolbar,
  SortableTableHeader,
  type SortDirection,
} from "@/components/table";
import {
  getInvestigationsList,
  updateInvestigationStatus,
  type Investigation,
} from "@/lib/api/investigations";
import { Chip, formatDate, priorityColor, statusColor } from "./helpers";

type InvestigationSortKey = "id" | "test_name" | "priority" | "status" | "requested_at";
const INVESTIGATION_SORT_KEYS: InvestigationSortKey[] = ["id", "test_name", "priority", "status", "requested_at"];
const PAGE_SIZE_OPTIONS = [10, 50, 100];

export function AllInvestigationsTab() {
  const [investigations, setInvestigations] = useState<Investigation[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<InvestigationSortKey>("requested_at");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [filters, setFilters] = useState({ status: "", priority: "", from: "", to: "" });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string | number> = {
        page,
        limit: pageSize,
        sortBy: sortKey,
        sortOrder: sortDirection,
      };
      if (search.trim()) params.search = search.trim();
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
  }, [filters, page, pageSize, search, sortDirection, sortKey]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [filters, pageSize, search, sortDirection, sortKey]);

  const handleSort = (key: InvestigationSortKey) => {
    setSortDirection((current) => (sortKey === key && current === "asc" ? "desc" : "asc"));
    setSortKey(key);
  };

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
      <ManagedTableToolbar
        search={search}
        onSearchChange={setSearch}
        placeholder="Search test name, type, or notes"
        countLabel={`${investigations.length} shown of ${total} investigations`}
        savedViewScope="all-investigations"
        savedViewState={{
          search,
          sortKey,
          sortDirection,
          pageSize,
          status: filters.status,
          priority: filters.priority,
          from: filters.from,
          to: filters.to,
        }}
        onApplySavedView={(view) => {
          setSearch(String(view.search ?? ""));
          if (INVESTIGATION_SORT_KEYS.includes(view.sortKey as InvestigationSortKey)) {
            setSortKey(view.sortKey as InvestigationSortKey);
          }
          setSortDirection(view.sortDirection === "asc" ? "asc" : "desc");
          const nextPageSize = Number(view.pageSize);
          if (PAGE_SIZE_OPTIONS.includes(nextPageSize)) setPageSize(nextPageSize);
          setFilters({
            status: String(view.status ?? ""),
            priority: String(view.priority ?? ""),
            from: String(view.from ?? ""),
            to: String(view.to ?? ""),
          });
          setPage(1);
        }}
      />

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
            <table className="min-w-[980px] w-full text-sm">
              <thead className="bg-muted text-left">
                <tr>
                  <SortableTableHeader label="ID" sortKey="id" activeSort={sortKey} direction={sortDirection} onSort={handleSort} className="px-3 py-2" />
                  <th className="px-3 py-2">Patient</th>
                  <th className="px-3 py-2">Phone</th>
                  <SortableTableHeader label="Test" sortKey="test_name" activeSort={sortKey} direction={sortDirection} onSort={handleSort} className="px-3 py-2" />
                  <SortableTableHeader label="Priority" sortKey="priority" activeSort={sortKey} direction={sortDirection} onSort={handleSort} className="px-3 py-2" />
                  <SortableTableHeader label="Status" sortKey="status" activeSort={sortKey} direction={sortDirection} onSort={handleSort} className="px-3 py-2" />
                  <SortableTableHeader label="Ordered" sortKey="requested_at" activeSort={sortKey} direction={sortDirection} onSort={handleSort} className="px-3 py-2" />
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

          <ClientTablePagination
            page={page}
            pageSize={pageSize}
            total={total}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
            itemLabel="investigations"
          />
        </>
      )}
    </div>
  );
}
