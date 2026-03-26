// src/app/(with-auth)/dashboard/system-audit/page.tsx
"use client";

import React, { useState, useCallback, useEffect, useRef } from "react";
import {
  Activity,
  AlertTriangle,
  Clock,
  User,
  Search,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  Shield,
  Zap,
} from "lucide-react";
import { getJSON } from "@/lib/api/core";

// ─── Types ────────────────────────────────────────────────────────────────────

interface AuditSummaryActivity {
  total_requests: string;
  failed_requests: string;
  write_actions: string;
  unique_users: string;
  avg_response_ms: string;
  max_response_ms: string;
}

interface TopUser {
  user_name: string;
  user_role: string;
  action_count: string;
  writes: string;
  failures: string;
}

interface TopModule {
  module: string;
  count: string;
  failures: string;
}

interface AuditError {
  id: string;
  user_name: string | null;
  method: string;
  path: string;
  status_code: number;
  error_message: string | null;
  created_at: string;
  response_time_ms: number;
}

interface SlowRequest {
  id: string;
  user_name: string | null;
  method: string;
  path: string;
  response_time_ms: number;
  created_at: string;
}

interface AuditSummary {
  period_hours: number;
  activity: AuditSummaryActivity;
  top_users: TopUser[];
  top_modules: TopModule[];
  recent_errors: AuditError[];
  slow_requests: SlowRequest[];
}

interface AuditLogRow {
  id: string;
  user_id: number | null;
  user_name: string | null;
  user_role: string | null;
  ip_address: string | null;
  method: string;
  path: string;
  module: string | null;
  action: string | null;
  status_code: number;
  response_time_ms: number;
  success: boolean;
  request_summary: string | null;
  error_message: string | null;
  created_at: string;
}

interface LogsResponse {
  logs: AuditLogRow[];
  total: number;
  limit: number;
  offset: number;
}

interface ModulesResponse {
  modules: string[];
  actions: string[];
}

interface UserHistory {
  user_id: string;
  period_days: number;
  stats: {
    total: string;
    writes: string;
    failures: string;
    modules_accessed: string[] | null;
  };
  logs: AuditLogRow[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const METHOD_COLORS: Record<string, string> = {
  GET: "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300",
  POST: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300",
  PUT: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300",
  PATCH: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300",
  DELETE: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300",
};

const MODULE_COLORS: Record<string, string> = {
  attendance: "bg-blue-100 text-blue-800",
  leave: "bg-teal-100 text-teal-800",
  incidents: "bg-orange-100 text-orange-800",
  grievances: "bg-purple-100 text-purple-800",
  auth: "bg-gray-100 text-gray-700",
  shifts: "bg-indigo-100 text-indigo-800",
  overtime: "bg-yellow-100 text-yellow-800",
  replacement: "bg-pink-100 text-pink-800",
  users: "bg-sky-100 text-sky-800",
  staff: "bg-sky-100 text-sky-800",
  doctors: "bg-emerald-100 text-emerald-800",
  patients: "bg-lime-100 text-lime-800",
  appointments: "bg-cyan-100 text-cyan-800",
  pharmacy: "bg-rose-100 text-rose-800",
  investigations: "bg-amber-100 text-amber-800",
  admin: "bg-slate-100 text-slate-800",
};

function methodBadge(method: string) {
  const cls = METHOD_COLORS[method] || "bg-gray-100 text-gray-700";
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-mono font-bold ${cls}`}>
      {method}
    </span>
  );
}

function statusBadge(code: number) {
  const cls =
    code < 300
      ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300"
      : code < 500
      ? "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300"
      : "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300";
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-bold ${cls}`}>
      {code}
    </span>
  );
}

function moduleBadge(mod: string | null) {
  if (!mod) return null;
  const cls = MODULE_COLORS[mod] || "bg-gray-100 text-gray-700";
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs ${cls}`}>{mod}</span>
  );
}

function truncate(str: string | null, n: number) {
  if (!str) return "-";
  return str.length > n ? str.substring(0, n) + "…" : str;
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function fmtMs(ms: number) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

// ─── Component: StatCard ─────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  sub,
  color = "blue",
}: {
  label: string;
  value: string | number;
  sub?: string;
  color?: string;
}) {
  const colorMap: Record<string, string> = {
    blue: "border-blue-500",
    red: "border-red-500",
    green: "border-green-500",
    yellow: "border-yellow-500",
    purple: "border-purple-500",
  };
  return (
    <div
      className={`bg-white dark:bg-gray-800 rounded-lg p-4 border-l-4 shadow-sm ${colorMap[color] || colorMap.blue}`}
    >
      <p className="text-sm text-gray-500 dark:text-gray-400">{label}</p>
      <p className="text-2xl font-bold text-gray-900 dark:text-white mt-1">{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
    </div>
  );
}

// ─── Tab 1: Live Feed ─────────────────────────────────────────────────────────

function LiveFeedTab() {
  const [hours, setHours] = useState(24);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [data, setData] = useState<AuditSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  const fetch = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getJSON<{ data: AuditSummary }>(
        "/api/v1/admin/audit/summary",
        { hours }
      );
      setData(res.data ?? null);
      setLastRefresh(new Date());
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [hours]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (autoRefresh) {
      timerRef.current = setInterval(fetch, 30000);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [autoRefresh, fetch]);

  const maxModuleCount = data?.top_modules.reduce(
    (m, t) => Math.max(m, parseInt(t.count)),
    1
  ) ?? 1;

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="flex flex-wrap gap-3 items-center justify-between">
        <div className="flex gap-2">
          {[1, 6, 24, 168].map((h) => (
            <button
              key={h}
              onClick={() => setHours(h)}
              className={`px-3 py-1 rounded text-sm font-medium transition ${
                hours === h
                  ? "bg-blue-600 text-white"
                  : "bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300"
              }`}
            >
              {h === 168 ? "7d" : h === 24 ? "24h" : h === 6 ? "6h" : "1h"}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          {lastRefresh && (
            <span className="text-xs text-gray-400">
              Updated {lastRefresh.toLocaleTimeString()}
            </span>
          )}
          <button
            onClick={() => setAutoRefresh((v) => !v)}
            className={`flex items-center gap-1 px-3 py-1 rounded text-sm ${
              autoRefresh
                ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300"
                : "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400"
            }`}
          >
            <RefreshCw className={`h-3 w-3 ${autoRefresh ? "animate-spin" : ""}`} />
            {autoRefresh ? "Auto ON" : "Auto OFF"}
          </button>
          <button
            onClick={fetch}
            className="flex items-center gap-1 px-3 py-1 rounded text-sm bg-blue-600 text-white hover:bg-blue-700"
          >
            <RefreshCw className="h-3 w-3" />
            Refresh
          </button>
        </div>
      </div>

      {loading && !data ? (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-24 bg-gray-200 dark:bg-gray-700 rounded animate-pulse" />
          ))}
        </div>
      ) : data ? (
        <>
          {/* Stats bar */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            <StatCard
              label="Total Requests"
              value={parseInt(data.activity.total_requests).toLocaleString()}
              color="blue"
            />
            <StatCard
              label="Failed"
              value={parseInt(data.activity.failed_requests).toLocaleString()}
              color="red"
            />
            <StatCard
              label="Write Actions"
              value={parseInt(data.activity.write_actions).toLocaleString()}
              color="purple"
            />
            <StatCard
              label="Unique Users"
              value={parseInt(data.activity.unique_users).toLocaleString()}
              color="green"
            />
            <StatCard
              label="Avg Response"
              value={fmtMs(parseInt(data.activity.avg_response_ms || "0"))}
              color="yellow"
            />
            <StatCard
              label="Max Response"
              value={fmtMs(parseInt(data.activity.max_response_ms || "0"))}
              color="red"
            />
          </div>

          {/* Module usage bars */}
          {data.top_modules.length > 0 && (
            <div className="bg-white dark:bg-gray-800 rounded-lg p-4 shadow-sm">
              <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
                Module Activity
              </h3>
              <div className="space-y-2">
                {data.top_modules.map((m) => (
                  <div key={m.module} className="flex items-center gap-2">
                    <div className="w-24 text-xs text-gray-600 dark:text-gray-400 truncate">
                      {m.module}
                    </div>
                    <div className="flex-1 bg-gray-100 dark:bg-gray-700 rounded-full h-4 relative overflow-hidden">
                      <div
                        className="h-4 rounded-full bg-blue-500 transition-all"
                        style={{
                          width: `${Math.max(
                            2,
                            (parseInt(m.count) / maxModuleCount) * 100
                          )}%`,
                        }}
                      />
                    </div>
                    <div className="w-12 text-xs text-right text-gray-600 dark:text-gray-400">
                      {parseInt(m.count).toLocaleString()}
                    </div>
                    {parseInt(m.failures) > 0 && (
                      <div className="w-16 text-xs text-right text-red-500">
                        {m.failures} err
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Top users */}
            <div className="bg-white dark:bg-gray-800 rounded-lg p-4 shadow-sm">
              <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3 flex items-center gap-2">
                <User className="h-4 w-4" /> Top Users
              </h3>
              {data.top_users.length === 0 ? (
                <p className="text-sm text-gray-400">No user activity</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-gray-400 border-b dark:border-gray-600">
                      <th className="text-left pb-2">User</th>
                      <th className="text-right pb-2">Actions</th>
                      <th className="text-right pb-2">Writes</th>
                      <th className="text-right pb-2">Fails</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.top_users.map((u, i) => (
                      <tr
                        key={i}
                        className="border-b dark:border-gray-700 last:border-0"
                      >
                        <td className="py-1.5">
                          <div className="font-medium text-gray-800 dark:text-gray-200 truncate max-w-[140px]">
                            {u.user_name || "—"}
                          </div>
                          <div className="text-xs text-gray-400">{u.user_role}</div>
                        </td>
                        <td className="text-right text-gray-700 dark:text-gray-300">
                          {u.action_count}
                        </td>
                        <td className="text-right text-blue-600">{u.writes}</td>
                        <td className="text-right text-red-500">{u.failures}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Recent errors */}
            <div className="bg-white dark:bg-gray-800 rounded-lg p-4 shadow-sm">
              <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3 flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-red-500" /> Recent Errors
              </h3>
              {data.recent_errors.length === 0 ? (
                <p className="text-sm text-green-600 dark:text-green-400">
                  ✓ No errors in this period
                </p>
              ) : (
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {data.recent_errors.map((e) => (
                    <div
                      key={e.id}
                      className="border-l-4 border-red-400 bg-red-50 dark:bg-red-900/20 pl-3 py-1.5 rounded-r"
                    >
                      <div className="flex items-center gap-2 flex-wrap">
                        {methodBadge(e.method)}
                        {statusBadge(e.status_code)}
                        <span
                          className="text-xs text-gray-600 dark:text-gray-400 truncate max-w-[160px]"
                          title={e.path}
                        >
                          {e.path}
                        </span>
                      </div>
                      <div className="text-xs text-gray-400 mt-0.5">
                        {e.user_name || "anon"} · {fmtTime(e.created_at)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Slow requests */}
          {data.slow_requests.length > 0 && (
            <div className="bg-white dark:bg-gray-800 rounded-lg p-4 shadow-sm">
              <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3 flex items-center gap-2">
                <Clock className="h-4 w-4 text-yellow-500" /> Slow Requests (&gt;2s)
              </h3>
              <div className="space-y-2">
                {data.slow_requests.map((s) => (
                  <div
                    key={s.id}
                    className="border-l-4 border-yellow-400 bg-yellow-50 dark:bg-yellow-900/20 pl-3 py-1.5 rounded-r flex items-center justify-between"
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      {methodBadge(s.method)}
                      <span
                        className="text-xs text-gray-600 dark:text-gray-400 truncate max-w-[200px]"
                        title={s.path}
                      >
                        {s.path}
                      </span>
                      <span className="text-xs text-gray-400">
                        {s.user_name || "anon"}
                      </span>
                    </div>
                    <span className="text-sm font-bold text-yellow-700 dark:text-yellow-400 ml-2 shrink-0">
                      {fmtMs(s.response_time_ms)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}

// ─── Tab 2: Log Search ────────────────────────────────────────────────────────

function LogSearchTab() {
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
    getJSON<{ data: ModulesResponse }>("/api/v1/admin/audit/modules")
      .then((r) => setModules(r.data ?? { modules: [], actions: [] }))
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

      const res = await getJSON<{ data: LogsResponse }>(
        "/api/v1/admin/audit/logs",
        params as Record<string, string | number | boolean | undefined | null>
      );
      setData(res.data ?? null);
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

function UserHistoryTab() {
  const [userId, setUserId] = useState("");
  const [days, setDays] = useState(30);
  const [data, setData] = useState<UserHistory | null>(null);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  const fetchHistory = async () => {
    if (!userId.trim()) return;
    setLoading(true);
    setSearched(true);
    try {
      const res = await getJSON<{ data: UserHistory }>(
        `/api/v1/admin/audit/user/${encodeURIComponent(userId.trim())}`,
        { days }
      );
      setData(res.data ?? null);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* User lookup */}
      <div className="bg-white dark:bg-gray-800 rounded-lg p-4 shadow-sm">
        <div className="flex flex-wrap gap-3 items-end">
          <div className="flex-1 min-w-[200px]">
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
              User ID
            </label>
            <input
              type="text"
              placeholder="Enter numeric user ID…"
              className="w-full border rounded px-3 py-2 text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-200"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && fetchHistory()}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
              Period
            </label>
            <select
              className="border rounded px-3 py-2 text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-200"
              value={days}
              onChange={(e) => setDays(parseInt(e.target.value))}
            >
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
            </select>
          </div>
          <button
            onClick={fetchHistory}
            disabled={!userId.trim() || loading}
            className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
          >
            {loading ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Shield className="h-4 w-4" />}
            Investigate
          </button>
        </div>
      </div>

      {loading && (
        <div className="p-8 text-center text-gray-400">
          <RefreshCw className="h-6 w-6 animate-spin mx-auto mb-2" />
          Loading history…
        </div>
      )}

      {!loading && searched && !data && (
        <div className="p-8 text-center text-gray-400">No data found for this user</div>
      )}

      {!loading && data && (
        <>
          {/* Stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatCard
              label="Total Actions"
              value={parseInt(data.stats.total).toLocaleString()}
              color="blue"
            />
            <StatCard
              label="Write Actions"
              value={parseInt(data.stats.writes).toLocaleString()}
              color="purple"
            />
            <StatCard
              label="Failures"
              value={parseInt(data.stats.failures).toLocaleString()}
              color="red"
            />
            <div className="bg-white dark:bg-gray-800 rounded-lg p-4 border-l-4 border-green-500 shadow-sm">
              <p className="text-sm text-gray-500 dark:text-gray-400">Modules Accessed</p>
              <div className="flex flex-wrap gap-1 mt-2">
                {(data.stats.modules_accessed ?? []).map((m) => (
                  <span key={m} className="text-xs bg-green-100 text-green-800 rounded px-2 py-0.5">
                    {m}
                  </span>
                ))}
              </div>
            </div>
          </div>

          {/* Timeline */}
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm overflow-hidden">
            <div className="px-4 py-3 border-b dark:border-gray-700">
              <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
                Activity Timeline — {data.logs.length} entries
              </h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[700px]">
                <thead className="bg-gray-50 dark:bg-gray-700 text-xs text-gray-500 uppercase">
                  <tr>
                    <th className="text-left px-3 py-2">Time</th>
                    <th className="text-left px-3 py-2">Method</th>
                    <th className="text-left px-3 py-2">Module</th>
                    <th className="text-left px-3 py-2">Action</th>
                    <th className="text-left px-3 py-2">Path</th>
                    <th className="text-left px-3 py-2">Status</th>
                    <th className="text-right px-3 py-2">Resp</th>
                  </tr>
                </thead>
                <tbody>
                  {data.logs.map((row) => (
                    <tr
                      key={row.id}
                      className={`border-b dark:border-gray-700 ${
                        !row.success
                          ? "border-l-4 border-red-400 bg-red-50/30 dark:bg-red-900/10"
                          : row.response_time_ms > 2000
                          ? "border-l-4 border-yellow-400 bg-yellow-50/30 dark:bg-yellow-900/10"
                          : ""
                      }`}
                    >
                      <td className="px-3 py-2 text-xs text-gray-500 whitespace-nowrap">
                        {fmtTime(row.created_at)}
                      </td>
                      <td className="px-3 py-2">{methodBadge(row.method)}</td>
                      <td className="px-3 py-2">{moduleBadge(row.module)}</td>
                      <td className="px-3 py-2 text-xs text-gray-600 dark:text-gray-400">
                        {row.action || "—"}
                      </td>
                      <td
                        className="px-3 py-2 text-xs font-mono text-gray-500 dark:text-gray-400 truncate max-w-[200px]"
                        title={row.path}
                      >
                        {row.path}
                      </td>
                      <td className="px-3 py-2">{statusBadge(row.status_code)}</td>
                      <td className="px-3 py-2 text-right text-xs">
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
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

const TABS = [
  { id: "live", label: "Live Feed", icon: <Activity className="h-4 w-4" /> },
  { id: "search", label: "Log Search", icon: <Search className="h-4 w-4" /> },
  { id: "user", label: "User History", icon: <User className="h-4 w-4" /> },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default function SystemAuditPage() {
  const [activeTab, setActiveTab] = useState<TabId>("live");

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 p-4 md:p-6">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-1">
          <Shield className="h-6 w-6 text-blue-600" />
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
            System Audit Log
          </h1>
          <span className="px-2 py-0.5 bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300 text-xs rounded font-medium">
            ADMIN
          </span>
        </div>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Every API request captured automatically — search, filter, and investigate user activity
        </p>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 mb-6 border-b dark:border-gray-700">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition -mb-px ${
              activeTab === tab.id
                ? "border-blue-600 text-blue-600"
                : "border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
            }`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === "live" && <LiveFeedTab />}
      {activeTab === "search" && <LogSearchTab />}
      {activeTab === "user" && <UserHistoryTab />}
    </div>
  );
}
