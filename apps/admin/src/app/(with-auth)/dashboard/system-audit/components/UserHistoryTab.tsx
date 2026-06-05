"use client";

import { useState } from "react";
import { RefreshCw, Shield } from "lucide-react";
import { getJSON } from "@/lib/api/core";
import type { UserHistory } from "../auditTypes";
import {
  StatCard,
  methodBadge,
  statusBadge,
  moduleBadge,
  fmtTime,
  fmtMs,
} from "./auditHelpers";

export function UserHistoryTab() {
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
      const res = await getJSON<UserHistory>(
        `/api/v1/admin/audit/user/${encodeURIComponent(userId.trim())}`,
        { days },
      );
      setData(res ?? null);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* User lookup */}
      <div className="bg-card dark:bg-gray-800 rounded-lg p-4 shadow-sm">
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
            {loading ? (
              <RefreshCw className="h-4 w-4 animate-spin" />
            ) : (
              <Shield className="h-4 w-4" />
            )}
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
        <div className="p-8 text-center text-gray-400">
          No data found for this user
        </div>
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
            <div className="bg-card dark:bg-gray-800 rounded-lg p-4 border-l-4 border-green-500 shadow-sm">
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Modules Accessed
              </p>
              <div className="flex flex-wrap gap-1 mt-2">
                {(data.stats.modules_accessed ?? []).map((m) => (
                  <span
                    key={m}
                    className="text-xs bg-green-100 text-green-800 rounded px-2 py-0.5"
                  >
                    {m}
                  </span>
                ))}
              </div>
            </div>
          </div>

          {/* Timeline */}
          <div className="bg-card dark:bg-gray-800 rounded-lg shadow-sm overflow-hidden">
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
                      <td className="px-3 py-2">
                        {statusBadge(row.status_code)}
                      </td>
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
