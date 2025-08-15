// src/app/(with-auth)/dashboard/page.tsx
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { API_ENDPOINTS, API_BASE_URL, getHeaders } from "@/lib/api-config";
import { MetricCard } from "@/components/MetricCard";
import { ChartCard } from "@/components/ChartCard";

/* =========================
   Types
========================= */
interface ChartDataPoint {
  date: string;
  value: number;
  label?: string; // optional for categorical series
}
interface ActivityItem {
  id: string;
  action: string;
  user: string;
  timestamp: string;
  details?: string;
}
interface SystemHealth {
  status: "healthy" | "warning" | "critical";
  uptime: string;
  responseTime: number; // ms
  errorRate: number; // %
}
interface DashboardData {
  overview: {
    totalUsers: number;
    activeUsers: number;
    newUsersToday: number;
    totalDoctors: number;
    availableDoctors: number;
    totalDepartments: number;
    appointmentsToday: number;
    appointmentsUpcoming: number;
    appointmentCompletionRate: number; // %
    emergencyAlerts: number;
    totalStaff: number;
    presentStaff: number;
    onLeaveStaff: number;
    pendingHRActions: number;
  };
  charts: {
    userGrowth: ChartDataPoint[];          // {date, value}
    appointmentTrends: ChartDataPoint[];   // {date, value}
    departmentUtilization: ChartDataPoint[]; // {label, value}
  };
  recentActivity: ActivityItem[];
  systemHealth: SystemHealth;
}

type DashboardAPIResponse = { data?: DashboardData } | DashboardData;

/* =========================
   Type guards
========================= */
function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}
function isDashboardData(x: unknown): x is DashboardData {
  if (!isRecord(x)) return false;
  const overview = x["overview"];
  const charts = x["charts"];
  return (
    isRecord(overview) &&
    typeof (overview as Record<string, unknown>).totalUsers === "number" &&
    isRecord(charts)
  );
}

/* =========================
   Page Component
========================= */
export default function DashboardPage() {
  const [dashboardData, setDashboardData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const fetchDashboardData = useCallback(async () => {
    try {
      setLoading(true);
      setError("");

      const token = (localStorage.getItem("adminToken") ?? undefined) as string | undefined;

      const response = await fetch(`${API_BASE_URL}${API_ENDPOINTS.admin.dashboard}`, {
        headers: getHeaders(token),
      });
      if (!response.ok) throw new Error("Failed to fetch dashboard data");

      const json = (await response.json()) as DashboardAPIResponse;
      const maybePayload = "data" in json && json.data ? json.data : json;
      if (!isDashboardData(maybePayload)) throw new Error("Malformed dashboard response");

      setDashboardData(maybePayload);
      setLastUpdated(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDashboardData();
  }, [fetchDashboardData]);

  const appointmentTrends = dashboardData?.charts?.appointmentTrends ?? [];
  const userGrowth = dashboardData?.charts?.userGrowth ?? [];
  const deptUtil = dashboardData?.charts?.departmentUtilization ?? [];

  const maxDeptUtil = useMemo(
    () => (deptUtil.length ? Math.max(...deptUtil.map((d) => d.value)) : 0),
    [deptUtil]
  );

  if (loading) {
    return (
      <div className="space-y-6 p-6">
        <div className="h-7 w-56 rounded bg-muted animate-pulse" />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-28 rounded-lg bg-muted animate-pulse" />
          ))}
        </div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
          <div className="h-44 rounded-lg bg-muted animate-pulse lg:col-span-5" />
          <div className="h-56 rounded-lg bg-muted animate-pulse lg:col-span-7" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6 space-y-4">
        <h1 className="text-xl font-semibold">Dashboard</h1>
        <div className="rounded-lg border bg-card p-4">
          <p className="text-sm text-red-600">Error: {error}</p>
          <button
            onClick={fetchDashboardData}
            className="mt-3 inline-flex items-center rounded-md bg-blue-600 px-3 py-1.5 text-white hover:opacity-90"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (!dashboardData) {
    return (
      <div className="p-6 space-y-2">
        <h1 className="text-xl font-semibold">Dashboard</h1>
        <p className="text-sm text-muted-foreground">No data available.</p>
      </div>
    );
  }

  const o = dashboardData.overview;

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-xl font-semibold text-balance">Admin Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Today’s overview {lastUpdated && <>• Updated {lastUpdated.toLocaleString()}</>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchDashboardData}
            className="inline-flex items-center rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
            title="Refresh data"
          >
            ↻ Refresh
          </button>
        </div>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Total Users" value={o.totalUsers} help="+ All time" />
        <MetricCard label="Active Users" value={o.activeUsers} help="Last 24h" />
        <MetricCard label="Appointments Today" value={o.appointmentsToday} />
        <MetricCard label="Available Doctors" value={o.availableDoctors} />
      </div>

      {/* Middle: Queues & Trends */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        {/* Work Queues / Quick Ops */}
        <section className="space-y-4 lg:col-span-5">
          <div className="rounded-lg border bg-card p-4">
            <h3 className="text-sm font-medium text-muted-foreground">Work Queues</h3>
            <ul className="mt-3 space-y-2 text-sm">
              <QueueRow label="Pending HR Actions" value={o.pendingHRActions} />
              <QueueRow label="Upcoming Appointments" value={o.appointmentsUpcoming} />
              <QueueRow label="Emergency Alerts" value={o.emergencyAlerts} />
              <QueueRow label="Staff on Leave" value={o.onLeaveStaff} />
            </ul>
          </div>

          {/* Department Utilization (categorical) */}
          <div className="rounded-lg border bg-card p-4">
            <h3 className="text-sm font-medium text-muted-foreground">Department Utilization</h3>
            {deptUtil.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">No data.</p>
            ) : (
              <ul className="mt-3 space-y-3">
                {deptUtil.map((d) => {
                  const pct = maxDeptUtil ? Math.round((d.value / maxDeptUtil) * 100) : 0;
                  return (
                    <li key={(d.label ?? d.date) + String(d.value)}>
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">{d.label ?? d.date}</span>
                        <span className="font-medium">{d.value}</span>
                      </div>
                      <div className="mt-1 h-2 w-full rounded-full bg-muted">
                        <div
                          className="h-2 rounded-full"
                          style={{
                            width: `${pct}%`,
                            background: "var(--chart-2)",
                          }}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={pct}
                          role="progressbar"
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </section>

        {/* Trends */}
        <section className="space-y-4 lg:col-span-7">
          <ChartCard title="Appointments (last 14 days)" data={appointmentTrends} />
          <ChartCard title="User Growth (last 30 days)" data={userGrowth} />
        </section>
      </div>

      {/* Bottom: Activity + System Health */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Recent Activity */}
        <div className="rounded-lg border bg-card p-4 lg:col-span-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-muted-foreground">Recent Activity</h3>
          </div>
          {dashboardData.recentActivity?.length ? (
            <ul className="mt-3 divide-y">
              {dashboardData.recentActivity.slice(0, 8).map((item) => (
                <li key={item.id} className="py-3 text-sm">
                  <div className="flex items-center justify-between">
                    <div className="min-w-0">
                      <p className="truncate">
                        <span className="font-medium">{item.user}</span>{" "}
                        <span className="text-muted-foreground">{item.action}</span>
                      </p>
                      {item.details && (
                        <p className="truncate text-muted-foreground">{item.details}</p>
                      )}
                    </div>
                    <time className="ml-4 shrink-0 text-xs text-muted-foreground">
                      {new Date(item.timestamp).toLocaleString()}
                    </time>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">No recent activity.</p>
          )}
        </div>

        {/* System Health */}
        <div className="rounded-lg border bg-card p-4">
          <h3 className="text-sm font-medium text-muted-foreground">System Health</h3>
          <div className="mt-4 space-y-3 text-sm">
            <div className="flex items-center justify-between">
              <span>Status</span>
              <StatusPill status={dashboardData.systemHealth.status} />
            </div>
            <div className="flex items-center justify-between">
              <span>Uptime</span>
              <span className="font-medium">{dashboardData.systemHealth.uptime}</span>
            </div>
            <div className="flex items-center justify-between">
              <span>Response Time</span>
              <span className="font-medium">{dashboardData.systemHealth.responseTime} ms</span>
            </div>
            <div className="flex items-center justify-between">
              <span>Error Rate</span>
              <span className="font-medium">{dashboardData.systemHealth.errorRate}%</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* =========================
   Small UI helpers
========================= */

function QueueRow({ label, value }: { label: string; value: number }) {
  return (
    <li className="flex items-center justify-between">
      <span>{label}</span>
      <span className="font-semibold">{value}</span>
    </li>
  );
}

function StatusPill({ status }: { status: SystemHealth["status"] }) {
  const map: Record<SystemHealth["status"], { text: string; className: string }> = {
    healthy: { text: "Healthy", className: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400" },
    warning: { text: "Warning", className: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400" },
    critical: { text: "Critical", className: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-400" },
  };
  const meta = map[status];
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${meta.className}`}>
      {meta.text}
    </span>
  );
}
