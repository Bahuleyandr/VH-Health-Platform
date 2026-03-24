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

interface GrowthPoint {
  date: string;
  count: number;
}

interface TrendPoint {
  date: string;
  count: number;
}

interface DepartmentUtil {
  departmentId: number;
  name: string;
  utilization: number;
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
  const [departments, setDepartments] = useState<DepartmentUtil[]>([]);
  const [satisfaction, setSatisfaction] = useState<SatisfactionData | null>(null);
  const [usage, setUsage] = useState<UsageData | null>(null);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const params = { days: range };

      const [growthRes, trendsRes, deptRes, satRes, usageRes] = await Promise.all([
        getUserGrowthAnalytics<{ data: GrowthPoint[] }>(params).catch(() => ({ data: [] })),
        getAppointmentTrends<{ data: TrendPoint[] }>(params).catch(() => ({ data: [] })),
        getDepartmentUtilization<{ data: DepartmentUtil[] }>(params).catch(() => ({ data: [] })),
        getPatientSatisfaction<SatisfactionData>(params).catch(() => null),
        getUsageAnalytics<UsageData>(params).catch(() => null),
      ]);

      setGrowth(growthRes?.data ?? []);
      setTrends(trendsRes?.data ?? []);
      setDepartments(deptRes?.data ?? []);
      setSatisfaction(satRes);
      setUsage(usageRes);
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
          <SimpleBarChart data={growth as unknown as Record<string, unknown>[]} labelKey="date" valueKey="count" />
        </div>

        {/* Appointment Trends */}
        <div style={cardStyle}>
          <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 16 }}>Appointment Trends</h2>
          <SimpleBarChart data={trends as unknown as Record<string, unknown>[]} labelKey="date" valueKey="count" />
        </div>

        {/* Department Utilization */}
        <div style={cardStyle}>
          <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 16 }}>Department Utilization</h2>
          {departments.length === 0 ? (
            <p style={{ color: "var(--text-secondary, #888)" }}>No data</p>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12 }}>
              {departments.map((dept) => (
                <div
                  key={dept.departmentId}
                  style={{
                    padding: 16,
                    borderRadius: 8,
                    border: "1px solid var(--border-color, #e2e8f0)",
                    background: "var(--bg-tertiary, #f8fafc)",
                  }}
                >
                  <div style={{ fontSize: 13, color: "var(--text-secondary, #888)", marginBottom: 4 }}>{dept.name}</div>
                  <div style={{ fontSize: 28, fontWeight: 700 }}>{dept.utilization}%</div>
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
                        width: `${Math.min(dept.utilization, 100)}%`,
                        height: "100%",
                        borderRadius: 3,
                        background:
                          dept.utilization > 90
                            ? "#ef4444"
                            : dept.utilization > 70
                            ? "#f59e0b"
                            : "#22c55e",
                      }}
                    />
                  </div>
                </div>
              ))}
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
                <div style={{ fontSize: 24, fontWeight: 700 }}>{usage.totalApiCalls.toLocaleString()}</div>
              </div>
              <div>
                <div style={{ fontSize: 13, color: "var(--text-secondary, #888)" }}>Active Users</div>
                <div style={{ fontSize: 24, fontWeight: 700 }}>{usage.activeUsers.toLocaleString()}</div>
              </div>
              <div>
                <div style={{ fontSize: 13, color: "var(--text-secondary, #888)" }}>Avg Response</div>
                <div style={{ fontSize: 24, fontWeight: 700 }}>{usage.avgResponseTime}ms</div>
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
