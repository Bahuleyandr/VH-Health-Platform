"use client";

import React, { useState, useEffect, useCallback } from "react";
import { Search, RefreshCw, ChevronDown, ChevronRight } from "lucide-react";
import { getJSON } from "@/lib/api/core";
import type { AuditLogRow, LogsResponse, ModulesResponse } from "../auditTypes";
import {
  methodBadge,
  statusBadge,
  moduleBadge,
  truncate,
  fmtTime,
  fmtMs,
} from "./auditHelpers";

export function LogSearchTab() {
  const [filters, setFilters] = useState({
    module: "",
    action: "",
    method: "",
    success: "",
    from: "",
    to: "",
    search: "",
  });
  const [page, setPage] = useState(0);
  const [data, setData] = useState<LogsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [modules, setModules] = useState<ModulesResponse>({ modules: [], actions: [] });
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const LIMIT = 100;

  useEffect(() => {
    getJSON<ModulesResponse>("/api/v1/admin/audit/modules")
      .then((r) => setModules(r ?? { modules: [], actions: [] }))
      .catch(() => {});
  }, []);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string | number> = {
        limit: LIMIT,
        offset: page * LIMIT,
      };
      if (filters.module) params.module = filters.module;
      if (filters.action) params.action = filters.action;
      if (filters.method) params.method = filters.method;
      if (filters.success !== "") params.success = filters.success;
      if (filters.from) params.from = filters.from;
      if (filters.to) params.to = filters.to;
      if (filters.search) params.search = filters.search;

      const res = await getJSON<LogsResponse>(
        "/api/v1/admin/audit/logs",
        params as Record<string, string | number | boolean | undefined | null>
      );
      setData(res ?? null);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [filters, page]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  const rowBorderClass = (row: AuditLogRow) => {
    if (!row.success) return "border-l-4 border-red-400";
    if (row.response_time_ms > 2000) return "border-l-4 border-yellow-400";
    return "border-l-4 border-transparent";
  };

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className="bg-white dark:bg-gray-800 rounded-lg p-4 shadow-sm">
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
          <select
            className="input-sm border rounded px-2 py-1.5 text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-200"
            value={filters.module}
            onChange={(e) => { setFilters((f) => ({ ...f, module: e.target.value })); setPage(0); }}
          >
            <option value="">All Modules</option>
            {modules.modules.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>

          <select
            className="input-sm border rounded px-2 py-1.5 text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-200"
            value={filters.action}
            onChange={(e) => { setFilters((f) => ({ ...f, action: e.target.value })); setPage(0); }}
          >
            <option value="">All Actions</option>
            {modules.actions.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>

          <select
            className="input-sm border rounded px-2 py-1.5 text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-200"
            value={filters.method}
            onChange={(e) => { setFilters((f) => ({ ...f, method: e.target.value })); setPage(0); }}
          >
            <option value="">All Methods</option>
            {["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>

          <select
            className="input-sm border rounded px-2 py-1.5 text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-200"
            value={filters.success}
            onChange={(e) => { setFilters((f) => ({ ...f, success: e.target.value })); setPage(0); }}
          >
            <option value="">All Status</option>
            <option value="true">Success</option>
            <option value="false">Failed</option>
          </select>

          <input
            type="date"
            className="input-sm border rounded px-2 py-1.5 text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-200"
            value={filters.from}
            onChange={(e) => { setFilters((f) => ({ ...f, from: e.target.value })); setPage(0); }}
            placeholder="From"
          />

          <input
            type="date"
            className="input-sm border rounded px-2 py-1.5 text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-200"
            value={filters.to}
            onChange={(e) => { setFilters((f) => ({ ...f, to: e.target.value })); setPage(0); }}
            placeholder="To"
          />

          <div className="flex items-center gap-2">
            <Search className="h-4 w-4 text-gray-400 shrink-0" />
            <input
              type="text"
              placeholder="Search..."
              className="input-sm border rounded px-2 py-1.5 text-sm w-full dark:bg-gray-700 dark:border-gray-600 dark:text-gray-200"
              value={filters.search}
              onChange={(e) => { setFilters((f) => ({ ...f, search: e.target.value })); setPage(0); }}
            />
          </div>
        </div>
      </div>

      {/* Results info */}
      {data && (
        <div className="flex items-center justify-between text-sm text-gray-500">
          <span>
            {data.total.toLocaleString()} results · showing {page * LIMIT + 1}–
            {Math.min((page + 1) * LIMIT, data.total)}
          </span>
          <div className="flex gap-2">
            <button
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              className="px-3 py-1 rounded border text-sm disabled:opacity-40 hover:bg-gray-50 dark:hover:bg-gray-700"
            >
              ← Prev
            </button>
            <button
              disabled={(page + 1) * LIMIT >= data.total}
              onClick={() => setPage((p) => p + 1)}
              className="px-3 py-1 rounded border text-sm disabled:opacity-40 hover:bg-gray-50 dark:hover:bg-gray-700"
            >
              Next →
            </button>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm overflow-x-auto">
        {loading ? (
          <div className="p-8 text-center text-gray-400">
            <RefreshCw className="h-6 w-6 animate-spin mx-auto mb-2" />
            Loading…
          </div>
        ) : !data || data.logs.length === 0 ? (
          <div className="p-8 text-center text-gray-400">No logs found</div>
        ) : (
          <table className="w-full text-sm min-w-[900px]">
            <thead className="bg-gray-50 dark:bg-gray-700 text-xs text-gray-500 dark:text-gray-400 uppercase">
              <tr>
                <th className="text-left px-3 py-2">Time</th>
                <th className="text-left px-3 py-2">User</th>
                <th className="text-left px-3 py-2">Method</th>
                <th className="text-left px-3 py-2">Module</th>
                <th className="text-left px-3 py-2">Action</th>
                <th className="text-left px-3 py-2">Path</th>
                <th className="text-left px-3 py-2">Status</th>
                <th className="text-right px-3 py-2">Time</th>
              </tr>
            </thead>
            <tbody>
              {data.logs.map((row) => (
                <React.Fragment key={row.id}>
                  <tr
                    className={`border-b dark:border-gray-700 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/50 ${rowBorderClass(row)}`}
                    onClick={() =>
                      setExpandedId(expandedId === row.id ? null : row.id)
                    }
                  >
                    <td className="px-3 py-2 whitespace-nowrap text-xs text-gray-500">
                      <div className="flex items-center gap-1">
                        {expandedId === row.id ? (
                          <ChevronDown className="h-3 w-3" />
                        ) : (
                          <ChevronRight className="h-3 w-3" />
                        )}
                        {fmtTime(row.created_at)}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="font-medium text-gray-800 dark:text-gray-200 truncate max-w-[120px]">
                        {row.user_name || "anon"}
                      </div>
                      {row.user_role && (
                        <div className="text-xs text-gray-400">{row.user_role}</div>
                      )}
                    </td>
                    <td className="px-3 py-2">{methodBadge(row.method)}</td>
                    <td className="px-3 py-2">{moduleBadge(row.module)}</td>
                    <td className="px-3 py-2">
                      <span
                        className="text-xs text-gray-600 dark:text-gray-400"
                        title={row.action ?? ""}
                      >
                        {truncate(row.action, 24)}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className="text-xs font-mono text-gray-500 dark:text-gray-400"
                        title={row.path}
                      >
                        {truncate(row.path, 40)}
                      </span>
                    </td>
                    <td className="px-3 py-2">{statusBadge(row.status_code)}</td>
                    <td className="px-3 py-2 text-right">
                      <span
                        className={
                          row.response_time_ms > 2000
                            ? "text-yellow-600 font-bold"
                            : "text-gray-500"
                        }
                      >
                        {fmtMs(row.response_time_ms)}
                      </span>
                    </td>
                  </tr>
                  {expandedId === row.id && (
                    <tr className="bg-gray-50 dark:bg-gray-900/40">
                      <td colSpan={8} className="px-4 py-3">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                          <div>
                            <span className="font-semibold text-gray-600 dark:text-gray-400">
                              IP:{" "}
                            </span>
                            <span className="font-mono">{row.ip_address || "—"}</span>
                          </div>
                          <div>
                            <span className="font-semibold text-gray-600 dark:text-gray-400">
                              Full Path:{" "}
                            </span>
                            <span className="font-mono break-all">{row.path}</span>
                          </div>
                          {row.request_summary && (
                            <div className="md:col-span-2">
                              <span className="font-semibold text-gray-600 dark:text-gray-400">
                                Request Body:{" "}
                              </span>
                              <pre className="mt-1 p-2 bg-gray-100 dark:bg-gray-800 rounded text-xs overflow-x-auto whitespace-pre-wrap break-all">
                                {row.request_summary}
                              </pre>
                            </div>
                          )}
                          {row.error_message && (
                            <div className="md:col-span-2">
                              <span className="font-semibold text-red-600">
                                Error:{" "}
                              </span>
                              <span className="text-red-500">{row.error_message}</span>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ─── Tab 3: User History ──────────────────────────────────────────────────────
