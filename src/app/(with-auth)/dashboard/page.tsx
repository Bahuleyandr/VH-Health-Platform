// src/app/(with-auth)/dashboard/page.tsx
"use client";

import { useEffect, useState, useCallback } from "react";
import { API_ENDPOINTS, API_BASE_URL, getHeaders } from "@/lib/api-config";

// Types
interface ChartDataPoint {
  date: string;
  value: number;
  label?: string;
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
  responseTime: number;
  errorRate: number;
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
    appointmentCompletionRate: number;
    emergencyAlerts: number;
    totalStaff: number;
    presentStaff: number;
    onLeaveStaff: number;
    pendingHRActions: number;
  };
  charts: {
    userGrowth: ChartDataPoint[];
    appointmentTrends: ChartDataPoint[];
    departmentUtilization: ChartDataPoint[];
  };
  recentActivity: ActivityItem[];
  systemHealth: SystemHealth;
}

type DashboardAPIResponse = { data?: DashboardData } | DashboardData;

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}
function isDashboardData(x: unknown): x is DashboardData {
  if (!isRecord(x)) return false;
  const overview = x["overview"] as unknown;
  const charts = x["charts"] as unknown;
  return (
    isRecord(overview) &&
    typeof (overview as Record<string, unknown>).totalUsers === "number" &&
    isRecord(charts)
  );
}

export default function DashboardPage() {
  const [dashboardData, setDashboardData] = useState<DashboardData | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const fetchDashboardData = useCallback(async () => {
    try {
      setLoading(true);
      setError("");

      const token = (localStorage.getItem("adminToken") ?? undefined) as
        | string
        | undefined;

      const response = await fetch(
        `${API_BASE_URL}${API_ENDPOINTS.admin.dashboard}`,
        {
          headers: getHeaders(token),
        },
      );
      if (!response.ok) throw new Error("Failed to fetch dashboard data");

      const json = (await response.json()) as DashboardAPIResponse;

      const maybePayload = "data" in json && json.data ? json.data : json;
      if (!isDashboardData(maybePayload))
        throw new Error("Malformed dashboard response");

      setDashboardData(maybePayload);
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDashboardData();
  }, [fetchDashboardData]);

  if (loading) return <div>Loading dashboard...</div>;
  if (error) return <div>Error: {error}</div>;
  if (!dashboardData) return <div>No data available</div>;

  return (
    <div className="p-6">
      <h1 className="text-3xl font-bold mb-6">Admin Dashboard</h1>

      {/* Quick Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard
          title="Total Users"
          value={dashboardData.overview.totalUsers}
        />
        <StatCard
          title="Active Users"
          value={dashboardData.overview.activeUsers}
        />
        <StatCard
          title="Today's Appointments"
          value={dashboardData.overview.appointmentsToday}
        />
        <StatCard
          title="Available Doctors"
          value={dashboardData.overview.availableDoctors}
        />
      </div>

      {/* Add more sections for charts, activity feed, alerts, etc. */}
    </div>
  );
}

function StatCard({ title, value }: { title: string; value: number }) {
  return (
    <div className="bg-white rounded-lg shadow p-6">
      <h3 className="text-sm font-medium text-gray-500">{title}</h3>
      <p className="text-2xl font-bold text-gray-900">{value}</p>
    </div>
  );
}
