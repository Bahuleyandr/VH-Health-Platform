"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { AlertTriangle, Clock, User, RefreshCw } from "lucide-react";
import { getJSON } from "@/lib/api/core";
import type { AuditSummary } from "../auditTypes";
import {
  StatCard,
  methodBadge,
  statusBadge,
  fmtTime,
  fmtMs,
} from "./auditHelpers";

export function LiveFeedTab() {
  const [hours, setHours] = useState(24);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [data, setData] = useState<AuditSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  const fetch = useCallback(async () => {
    setLoading(true);
    try {
      // getJSON already unwraps the success envelope's `.data` — reading
      // `res.data` again double-unwrapped to undefined, leaving the whole
      // Live Feed blank even when the backend returned a full summary.
      const res = await getJSON<AuditSummary>(
        "/api/v1/admin/audit/summary",
        { hours }
      );
      setData(res ?? null);
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
