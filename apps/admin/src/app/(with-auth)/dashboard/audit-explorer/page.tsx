// src/app/(with-auth)/dashboard/audit-explorer/page.tsx
//
// Audit log explorer — admin-only browser over /api/v1/admin/audit/logs.
// Filterable by user / action / module / method / status / date range +
// free-text search across path/action/user_name. Surface the audit
// records the rest of the platform writes via auditLog/phiAccessLogger.

"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchAdminAPI } from "@/lib/api";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { EmptyState } from "@/components/EmptyState";

interface AuditLog {
  id: number;
  user_id: number | null;
  user_name: string | null;
  user_role: string | null;
  ip_address: string | null;
  method: string | null;
  path: string | null;
  module: string | null;
  action: string | null;
  status_code: number | null;
  response_time_ms: number | null;
  success: boolean | null;
  request_summary: string | null;
  error_message: string | null;
  created_at: string;
}

interface AuditLogsResponse {
  logs: AuditLog[];
  total: number;
  limit: number;
  offset: number;
}

function unwrap<T>(r: unknown): T {
  return ((r as { data?: T }).data ?? r) as T;
}

function fmtTs(s: string | null): string {
  if (!s) return "—";
  return new Date(s).toLocaleString();
}

function statusColour(code: number | null, success: boolean | null): string {
  if (success === false) return "text-rose-700 font-semibold";
  if (code == null) return "text-muted-foreground";
  if (code >= 500) return "text-rose-700 font-semibold";
  if (code >= 400) return "text-amber-700";
  if (code >= 300) return "text-blue-700";
  if (code >= 200) return "text-emerald-700";
  return "text-muted-foreground";
}

function methodColour(method: string | null): string {
  switch (method) {
    case "GET":
      return "bg-slate-100 text-slate-700";
    case "POST":
      return "bg-emerald-100 text-emerald-800";
    case "PUT":
      return "bg-blue-100 text-blue-800";
    case "PATCH":
      return "bg-amber-100 text-amber-800";
    case "DELETE":
      return "bg-rose-100 text-rose-800";
    default:
      return "bg-slate-100 text-slate-600";
  }
}

const todayIso = () => new Date().toISOString().split("T")[0]!;
const weekAgoIso = () =>
  new Date(Date.now() - 7 * 86400 * 1000).toISOString().split("T")[0]!;

export default function AuditExplorerPage() {
  const qc = useQueryClient();
  const [filters, setFilters] = useState({
    search: "",
    module: "",
    method: "",
    status_code: "",
    success: "",
    from: weekAgoIso(),
    to: todayIso(),
    user_id: "",
    limit: 100,
    offset: 0,
  });
  const [appliedFilters, setAppliedFilters] = useState(filters);
  const [openLog, setOpenLog] = useState<AuditLog | null>(null);

  const { data: modules = [] } = useQuery<string[]>({
    queryKey: ["audit", "modules"],
    queryFn: async () => {
      const r = await fetchAdminAPI<unknown>("/admin/audit/modules");
      const data = unwrap<{ modules?: string[] } | string[]>(r);
      if (Array.isArray(data)) return data;
      return Array.isArray(data?.modules) ? data.modules : [];
    },
    staleTime: 5 * 60 * 1000,
  });

  const {
    data: result,
    isLoading,
    error: queryError,
  } = useQuery<AuditLogsResponse>({
    queryKey: ["audit", "logs", appliedFilters],
    queryFn: async () => {
      const params = new URLSearchParams();
      const f = appliedFilters;
      if (f.search) params.set("search", f.search);
      if (f.module) params.set("module", f.module);
      if (f.method) params.set("method", f.method);
      if (f.status_code) params.set("status_code", f.status_code);
      if (f.success) params.set("success", f.success);
      if (f.from) params.set("from", f.from);
      if (f.to) params.set("to", `${f.to}T23:59:59`);
      if (f.user_id) params.set("user_id", f.user_id);
      params.set("limit", String(f.limit));
      params.set("offset", String(f.offset));
      const r = await fetchAdminAPI<unknown>(
        `/admin/audit/logs?${params.toString()}`,
      );
      return unwrap<AuditLogsResponse>(r);
    },
  });

  function applyFilters() {
    setAppliedFilters({ ...filters, offset: 0 });
  }

  function pageNext() {
    if (!result) return;
    if (appliedFilters.offset + appliedFilters.limit >= result.total) return;
    setAppliedFilters({
      ...appliedFilters,
      offset: appliedFilters.offset + appliedFilters.limit,
    });
  }

  function pagePrev() {
    if (appliedFilters.offset === 0) return;
    setAppliedFilters({
      ...appliedFilters,
      offset: Math.max(0, appliedFilters.offset - appliedFilters.limit),
    });
  }

  const errMsg = queryError instanceof Error ? queryError.message : null;
  const logs = result?.logs ?? [];
  const total = result?.total ?? 0;

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-foreground">
          Audit Log Explorer
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Browse the audit trail across every authenticated request. Backed by{" "}
          <code>audit_log</code> + the audit middleware.
        </p>
      </div>

      {/* Filters */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          applyFilters();
        }}
        className="bg-card rounded-lg border shadow-sm p-4 space-y-3"
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div>
            <label className="text-xs text-muted-foreground block mb-1">
              Search (path / action / user)
            </label>
            <input
              value={filters.search}
              onChange={(e) =>
                setFilters({ ...filters, search: e.target.value })
              }
              placeholder="users / login / patient name"
              className="w-full border border-border rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground block mb-1">
              Module
            </label>
            <select
              value={filters.module}
              onChange={(e) =>
                setFilters({ ...filters, module: e.target.value })
              }
              className="w-full border border-border rounded-lg px-3 py-2 text-sm"
            >
              <option value="">All modules</option>
              {modules.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground block mb-1">
              Method
            </label>
            <select
              value={filters.method}
              onChange={(e) =>
                setFilters({ ...filters, method: e.target.value })
              }
              className="w-full border border-border rounded-lg px-3 py-2 text-sm"
            >
              <option value="">Any</option>
              {["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground block mb-1">
              Status
            </label>
            <select
              value={filters.success}
              onChange={(e) =>
                setFilters({ ...filters, success: e.target.value })
              }
              className="w-full border border-border rounded-lg px-3 py-2 text-sm"
            >
              <option value="">Any</option>
              <option value="true">Success only</option>
              <option value="false">Failures only</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground block mb-1">
              Status code (exact)
            </label>
            <input
              type="number"
              value={filters.status_code}
              onChange={(e) =>
                setFilters({ ...filters, status_code: e.target.value })
              }
              placeholder="200 / 401 / 500"
              className="w-full border border-border rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground block mb-1">
              User ID
            </label>
            <input
              value={filters.user_id}
              onChange={(e) =>
                setFilters({ ...filters, user_id: e.target.value })
              }
              className="w-full border border-border rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground block mb-1">
              From
            </label>
            <input
              type="date"
              value={filters.from}
              onChange={(e) => setFilters({ ...filters, from: e.target.value })}
              className="w-full border border-border rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground block mb-1">
              To
            </label>
            <input
              type="date"
              value={filters.to}
              onChange={(e) => setFilters({ ...filters, to: e.target.value })}
              className="w-full border border-border rounded-lg px-3 py-2 text-sm"
            />
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() =>
              setFilters({
                search: "",
                module: "",
                method: "",
                status_code: "",
                success: "",
                from: weekAgoIso(),
                to: todayIso(),
                user_id: "",
                limit: 100,
                offset: 0,
              })
            }
            className="px-3 py-2 rounded-md border text-sm hover:bg-muted"
          >
            Reset
          </button>
          <button
            type="submit"
            className="px-3 py-2 rounded-md bg-foreground text-background text-sm"
          >
            Apply
          </button>
          <button
            type="button"
            onClick={() =>
              qc.invalidateQueries({ queryKey: ["audit", "logs"] })
            }
            className="px-3 py-2 rounded-md border text-sm hover:bg-muted"
          >
            Refresh
          </button>
        </div>
      </form>

      {errMsg && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {errMsg}
        </div>
      )}

      {/* Results */}
      {isLoading ? (
        <LoadingSpinner />
      ) : logs.length === 0 ? (
        <EmptyState
          title="No matches"
          description="No audit entries match these filters."
        />
      ) : (
        <>
          <div className="bg-card rounded-lg border shadow-sm overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="text-xs text-muted-foreground border-b">
                <tr className="text-left">
                  <th className="px-3 py-2">When</th>
                  <th className="px-3 py-2">User</th>
                  <th className="px-3 py-2">Method</th>
                  <th className="px-3 py-2">Path</th>
                  <th className="px-3 py-2">Module / Action</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2 text-right">Time</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {logs.map((l) => (
                  <tr
                    key={l.id}
                    className={`border-b last:border-0 ${
                      l.success === false
                        ? "bg-rose-50/50"
                        : "hover:bg-muted/30"
                    }`}
                  >
                    <td className="px-3 py-2 text-xs">{fmtTs(l.created_at)}</td>
                    <td className="px-3 py-2 text-xs">
                      {l.user_name ??
                        (l.user_id != null ? `#${l.user_id}` : "—")}
                      {l.user_role && (
                        <div className="text-muted-foreground">
                          {l.user_role}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-block px-2 py-0.5 rounded text-xs font-mono ${methodColour(
                          l.method,
                        )}`}
                      >
                        {l.method ?? "—"}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs font-mono max-w-md truncate">
                      {l.path ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <div className="font-medium">{l.module ?? "—"}</div>
                      <div className="text-muted-foreground">
                        {l.action ?? ""}
                      </div>
                    </td>
                    <td
                      className={`px-3 py-2 font-mono text-xs ${statusColour(l.status_code, l.success)}`}
                    >
                      {l.status_code ?? "—"}
                      {l.success === false && " ✗"}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-right">
                      {l.response_time_ms != null
                        ? `${l.response_time_ms}ms`
                        : "—"}
                    </td>
                    <td className="px-3 py-2">
                      <button
                        onClick={() => setOpenLog(l)}
                        className="px-2 py-1 rounded border text-xs hover:bg-muted"
                      >
                        Details
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between text-sm">
            <p className="text-muted-foreground">
              {appliedFilters.offset + 1}–
              {Math.min(appliedFilters.offset + logs.length, total)} of{" "}
              {total.toLocaleString()}
            </p>
            <div className="flex gap-2">
              <button
                onClick={pagePrev}
                disabled={appliedFilters.offset === 0}
                className="px-3 py-1.5 rounded-md border text-sm hover:bg-muted disabled:opacity-40"
              >
                ← Prev
              </button>
              <button
                onClick={pageNext}
                disabled={appliedFilters.offset + appliedFilters.limit >= total}
                className="px-3 py-1.5 rounded-md border text-sm hover:bg-muted disabled:opacity-40"
              >
                Next →
              </button>
            </div>
          </div>
        </>
      )}

      {/* Detail modal */}
      {openLog && (
        <div className="fixed inset-0 bg-black/40 flex items-start justify-center z-50 p-4 overflow-y-auto">
          <div className="bg-card rounded-lg shadow-lg w-full max-w-3xl">
            <div className="p-4 border-b flex items-center justify-between">
              <h2 className="text-lg font-semibold">
                Audit entry #{openLog.id}
              </h2>
              <button
                onClick={() => setOpenLog(null)}
                className="text-muted-foreground hover:text-foreground"
              >
                ✕
              </button>
            </div>
            <div className="p-4 space-y-3 text-sm">
              <DetailRow label="When" value={fmtTs(openLog.created_at)} />
              <DetailRow
                label="User"
                value={`${openLog.user_name ?? "—"}${openLog.user_role ? ` (${openLog.user_role})` : ""}${openLog.user_id != null ? ` #${openLog.user_id}` : ""}`}
              />
              <DetailRow label="IP" value={openLog.ip_address ?? "—"} />
              <DetailRow
                label="Request"
                value={`${openLog.method ?? "—"} ${openLog.path ?? "—"}`}
              />
              <DetailRow label="Module" value={openLog.module ?? "—"} />
              <DetailRow label="Action" value={openLog.action ?? "—"} />
              <DetailRow
                label="Status"
                value={`${openLog.status_code ?? "—"}${openLog.success === false ? " (failed)" : ""}`}
              />
              <DetailRow
                label="Time"
                value={
                  openLog.response_time_ms != null
                    ? `${openLog.response_time_ms} ms`
                    : "—"
                }
              />
              {openLog.request_summary && (
                <DetailRow
                  label="Summary"
                  value={openLog.request_summary}
                  pre
                />
              )}
              {openLog.error_message && (
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Error</p>
                  <pre className="bg-rose-50 text-rose-900 p-2 rounded text-xs whitespace-pre-wrap font-mono">
                    {openLog.error_message}
                  </pre>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function DetailRow({
  label,
  value,
  pre = false,
}: {
  label: string;
  value: string;
  pre?: boolean;
}) {
  return (
    <div>
      <p className="text-xs text-muted-foreground mb-0.5">{label}</p>
      {pre ? (
        <pre className="bg-muted/40 p-2 rounded text-xs whitespace-pre-wrap font-mono">
          {value}
        </pre>
      ) : (
        <p className="text-sm font-mono">{value}</p>
      )}
    </div>
  );
}
