// src/app/(with-auth)/dashboard/analytics/page.tsx
"use client";

import { useState, useEffect, useCallback } from "react";
import {
  getUserGrowthAnalytics,
  getAppointmentTrends,
  getDepartmentUtilization,
  getPatientSatisfaction,
  getUsageAnalytics,
} from "@/lib/api";
import { Spinner } from "@/components/ui/spinner";

/* ---------- Types ---------- */

// GET /admin/analytics/trends returns rows keyed by `period` + `count`
// (the SQL TO_CHAR period bucket). count is a bigint → arrives as string.
interface GrowthPoint {
  period: string;
  count: number | string;
}

interface TrendPoint {
  period: string;
  count: number | string;
}

// GET /admin/analytics/departments returns per-department appointment
// stats — there is no precomputed "utilization", so the card derives a
// completion ratio from real counts rather than inventing a metric.
interface DepartmentRow {
  department: string;
  total_appointments: number | string;
  completed_appointments: number | string;
}

interface SatisfactionData {
  averageRating: number;
  totalFeedback: number;
  trend: number; // % change
  distribution: Record<string, number>;
}

interface UsageData {
  totalApiCalls: number;
  activeUsers: number;
  peakHours: string[];
  avgResponseTime: number;
}

type DateRange = "7" | "30" | "90";

/* ---------- Small Helpers ---------- */

function StarRating({ rating }: { rating: number }) {
  const full = Math.floor(rating);
  const half = rating - full >= 0.5;
  return (
    <span style={{ fontSize: 24, color: "#f59e0b" }}>
      {"★".repeat(full)}
      {half ? "☆" : ""}
      {"☆".repeat(5 - full - (half ? 1 : 0))}
      <span style={{ fontSize: 14, color: "var(--text-secondary, #666)", marginLeft: 8 }}>
        {rating.toFixed(1)} / 5
      </span>
    </span>
  );
}

function SimpleBarChart({ data, labelKey, valueKey }: { data: Record<string, unknown>[]; labelKey: string; valueKey: string }) {
  if (!data?.length) return <p style={{ color: "var(--text-secondary, #888)" }}>No data</p>;
  const max = Math.max(...data.map((d) => Number(d[valueKey]) || 0), 1);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {data.map((d, i) => {
        const val = Number(d[valueKey]) || 0;
        const pct = (val / max) * 100;
        return (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ minWidth: 80, fontSize: 12, color: "var(--text-secondary, #888)" }}>
              {String(d[labelKey])}
            </span>
            <div style={{ flex: 1, background: "var(--bg-tertiary, #f1f5f9)", borderRadius: 4, height: 22, overflow: "hidden" }}>
              <div
                style={{
                  width: `${pct}%`,
                  height: "100%",
                  background: "var(--color-primary, #3b82f6)",
                  borderRadius: 4,
                  transition: "width 0.3s",
                }}
              />
            </div>
            <span style={{ minWidth: 40, fontSize: 12, textAlign: "right" }}>{val}</span>
          </div>
        );
      })}
    </div>
  );
}

/* ---------- Main Page ---------- */

export default function AnalyticsPage() {
  const [range, setRange] = useState<DateRange>("30");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [growth, setGrowth] = useState<GrowthPoint[]>([]);
  const [trends, setTrends] = useState<TrendPoint[]>([]);
  const [departments, setDepartments] = useState<DepartmentRow[]>([]);
  const [satisfaction, setSatisfaction] = useState<SatisfactionData | null>(null);
  const [usage, setUsage] = useState<UsageData | null>(null);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const params = { days: range };

      const [growthRes, trendsRes, deptRes, satRes, usageRes] = await Promise.all([
        // /trends differentiates by ?metric (users vs appointments). The
        // payload key is `trends` — requestJSON already unwrapped the
        // success envelope's `.data`, so reading `.data` here double-unwrapped
        // and always yielded "No data".
        getUserGrowthAnalytics<{ trends: GrowthPoint[] }>({ ...params, metric: "users" }).catch(() => ({ trends: [] })),
        getAppointmentTrends<{ trends: TrendPoint[] }>({ ...params, metric: "appointments" }).catch(() => ({ trends: [] })),
        // /departments reads `timeframe` ("30d"), not `days`; payload key is `departments`.
        getDepartmentUtilization<{ departments: DepartmentRow[] }>({ timeframe: `${range}d` }).catch(() => ({ departments: [] })),
        getPatientSatisfaction<SatisfactionData>(params).catch(() => null),
        getUsageAnalytics<UsageData>(params).catch(() => null),
      ]);

      setGrowth(growthRes?.trends ?? []);
      setTrends(trendsRes?.trends ?? []);
      setDepartments(deptRes?.departments ?? []);
      // Normalize satisfaction — backend may return { overallSatisfaction: { average_rating, total_feedback, ... } }
      const satRaw = satRes as Record<string, unknown> | null;
      const satInner = (satRaw?.overallSatisfaction ?? satRaw) as Record<string, unknown> | null;
      setSatisfaction(
        satInner
          ? {
              averageRating: Number(satInner.averageRating ?? satInner.average_rating ?? 0),
              totalFeedback: Number(satInner.totalFeedback ?? satInner.total_feedback ?? 0),
              trend: Number(satInner.trend ?? 0),
              distribution: (satInner.distribution as Record<string, number>) ?? {},
            }
          : null
      );

      // Normalize usage — backend may return { featureUsage, peakUsageHours, deviceStatistics }
      const usageRaw = usageRes as Record<string, unknown> | null;
      setUsage(
        usageRaw
          ? {
              totalApiCalls: Number(usageRaw.totalApiCalls ?? usageRaw.total_api_calls ?? 0),
              activeUsers: Number(usageRaw.activeUsers ?? usageRaw.active_users ?? 0),
              avgResponseTime: Number(usageRaw.avgResponseTime ?? usageRaw.avg_response_time ?? 0),
              peakHours: Array.isArray(usageRaw.peakHours)
                ? (usageRaw.peakHours as string[])
                : Array.isArray(usageRaw.peakUsageHours)
                ? (usageRaw.peakUsageHours as Array<{ hour_of_day: number }>)
                    .sort((a, b) => b.hour_of_day - a.hour_of_day)
                    .slice(0, 3)
                    .map(h => `${h.hour_of_day}:00`)
                : [],
            }
          : null
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load analytics");
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const cardStyle: React.CSSProperties = {
    background: "var(--bg-secondary, #fff)",
    borderRadius: 12,
    padding: 24,
    border: "1px solid var(--border-color, #e2e8f0)",
  };

  if (loading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", height: 256 }}>
        <Spinner />
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: 24, textAlign: "center" }}>
        <p style={{ color: "var(--color-error, #ef4444)" }}>{error}</p>
        <button onClick={fetchData} style={{ marginTop: 12, padding: "8px 16px", cursor: "pointer" }}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <div style={{ padding: "0 0 32px" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700 }}>Analytics</h1>
        <div style={{ display: "flex", gap: 8 }}>
          {(["7", "30", "90"] as DateRange[]).map((d) => (
            <button
              key={d}
              onClick={() => setRange(d)}
              style={{
                padding: "6px 14px",
                borderRadius: 6,
                border: "1px solid var(--border-color, #e2e8f0)",
                background: range === d ? "var(--color-primary, #3b82f6)" : "transparent",
                color: range === d ? "#fff" : "inherit",
                cursor: "pointer",
                fontSize: 13,
                fontWeight: 500,
              }}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: "grid", gap: 24 }}>
        {/* User Growth */}
        <div style={cardStyle}>
          <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 16 }}>User Growth</h2>
          <SimpleBarChart data={growth as unknown as Record<string, unknown>[]} labelKey="period" valueKey="count" />
        </div>

        {/* Appointment Trends */}
        <div style={cardStyle}>
          <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 16 }}>Appointment Trends</h2>
          <SimpleBarChart data={trends as unknown as Record<string, unknown>[]} labelKey="period" valueKey="count" />
        </div>

        {/* Department Utilization */}
        <div style={cardStyle}>
          <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 16 }}>Department Utilization</h2>
          {departments.length === 0 ? (
            <p style={{ color: "var(--text-secondary, #888)" }}>No data</p>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12 }}>
              {departments.map((dept, i) => {
                // The backend has no precomputed utilization figure — derive a
                // completion ratio from the real appointment counts it returns.
                const total = Number(dept.total_appointments) || 0;
                const completed = Number(dept.completed_appointments) || 0;
                const completionPct = total > 0 ? Math.round((completed / total) * 100) : 0;
                return (
                  <div
                    key={dept.department ?? i}
                    style={{
                      padding: 16,
                      borderRadius: 8,
                      border: "1px solid var(--border-color, #e2e8f0)",
                      background: "var(--bg-tertiary, #f8fafc)",
                    }}
                  >
                    <div style={{ fontSize: 13, color: "var(--text-secondary, #888)", marginBottom: 4 }}>{dept.department}</div>
                    <div style={{ fontSize: 28, fontWeight: 700 }}>{total}</div>
                    <div style={{ fontSize: 12, color: "var(--text-secondary, #888)", marginTop: 2 }}>
                      {completed} of {total} appointments completed ({completionPct}%)
                    </div>
                    <div
                      style={{
                        marginTop: 8,
                        height: 6,
                        borderRadius: 3,
                        background: "var(--border-color, #e2e8f0)",
                        overflow: "hidden",
                      }}
                    >
                      <div
                        style={{
                          width: `${Math.min(completionPct, 100)}%`,
                          height: "100%",
                          borderRadius: 3,
                          background:
                            completionPct >= 70
                              ? "#22c55e"
                              : completionPct >= 40
                              ? "#f59e0b"
                              : "#ef4444",
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Patient Satisfaction */}
        <div style={cardStyle}>
          <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 16 }}>Patient Satisfaction</h2>
          {satisfaction ? (
            <div style={{ display: "flex", gap: 32, flexWrap: "wrap", alignItems: "center" }}>
              <div>
                <StarRating rating={satisfaction.averageRating} />
                <div style={{ fontSize: 13, color: "var(--text-secondary, #888)", marginTop: 4 }}>
                  {satisfaction.totalFeedback} feedback submissions
                </div>
              </div>
              <div
                style={{
                  padding: "8px 16px",
                  borderRadius: 8,
                  background: satisfaction.trend >= 0 ? "#dcfce7" : "#fef2f2",
                  color: satisfaction.trend >= 0 ? "#16a34a" : "#dc2626",
                  fontWeight: 600,
                  fontSize: 14,
                }}
              >
                {satisfaction.trend >= 0 ? "↑" : "↓"} {Math.abs(satisfaction.trend)}%
              </div>
            </div>
          ) : (
            <p style={{ color: "var(--text-secondary, #888)" }}>No satisfaction data</p>
          )}
        </div>

        {/* Usage Stats */}
        <div style={cardStyle}>
          <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 16 }}>Usage Statistics</h2>
          {usage ? (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 16 }}>
              <div>
                <div style={{ fontSize: 13, color: "var(--text-secondary, #888)" }}>API Calls</div>
                <div style={{ fontSize: 24, fontWeight: 700 }}>{(usage.totalApiCalls ?? 0).toLocaleString()}</div>
              </div>
              <div>
                <div style={{ fontSize: 13, color: "var(--text-secondary, #888)" }}>Active Users</div>
                <div style={{ fontSize: 24, fontWeight: 700 }}>{(usage.activeUsers ?? 0).toLocaleString()}</div>
              </div>
              <div>
                <div style={{ fontSize: 13, color: "var(--text-secondary, #888)" }}>Avg Response</div>
                <div style={{ fontSize: 24, fontWeight: 700 }}>{usage.avgResponseTime ?? 0}ms</div>
              </div>
              <div>
                <div style={{ fontSize: 13, color: "var(--text-secondary, #888)" }}>Peak Hours</div>
                <div style={{ fontSize: 16, fontWeight: 600 }}>{usage.peakHours?.join(", ") || "—"}</div>
              </div>
            </div>
          ) : (
            <p style={{ color: "var(--text-secondary, #888)" }}>No usage data</p>
          )}
        </div>
      </div>
    </div>
  );
}
