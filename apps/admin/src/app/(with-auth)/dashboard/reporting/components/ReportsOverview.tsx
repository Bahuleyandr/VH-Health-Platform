// src/app/(with-auth)/dashboard/reporting/components/ReportsOverview.tsx
"use client";

import { useState, useEffect, useCallback } from "react";
import { fetchAdminAPI } from "@/lib/api";
import { Spinner } from "@/components/ui/spinner";
import { CalendarIcon, DollarSign, Users, Star } from "lucide-react";

interface OverviewStats {
  totalAppointments: number;
  totalRevenue: number;
  totalPatients: number;
  averageRating: number;
  appointmentsTrend: Array<{ date: string; count: number }>;
  revenueByDepartment: Array<{ department: string; revenue: number }>;
  topDoctors: Array<{ name: string; appointments: number; rating: number }>;
}

interface AnalyticsDashboardResponse {
  appointmentAnalytics?: {
    total_appointments?: number;
    unique_patients?: number;
  };
  pharmacyAnalytics?: {
    total_revenue?: number;
  };
  feedbackAnalytics?: {
    average_rating?: number;
  };
}

export function ReportsOverview() {
  const [stats, setStats] = useState<OverviewStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dateRange, setDateRange] = useState({
    from: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0], // 30 days ago
    to: new Date().toISOString().split("T")[0], // today
  });

  const fetchReportData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const days = Math.max(
        1,
        Math.round(
          (new Date(dateRange.to).getTime() -
            new Date(dateRange.from).getTime()) /
            (24 * 60 * 60 * 1000),
        ),
      );
      const timeframe =
        days <= 7 ? "7d" : days <= 30 ? "30d" : days <= 90 ? "90d" : "1y";

      const data = await fetchAdminAPI<AnalyticsDashboardResponse>(
        `/admin/analytics/dashboard?timeframe=${timeframe}`,
        { method: "GET" },
      );

      setStats({
        totalAppointments: Number(
          data.appointmentAnalytics?.total_appointments ?? 0,
        ),
        totalRevenue: Number(data.pharmacyAnalytics?.total_revenue ?? 0),
        totalPatients: Number(data.appointmentAnalytics?.unique_patients ?? 0),
        averageRating: Number(data.feedbackAnalytics?.average_rating ?? 0),
        appointmentsTrend: [],
        revenueByDepartment: [],
        topDoctors: [],
      });
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Failed to load report data";
      setError(msg);
      setStats(null);
    } finally {
      setLoading(false);
    }
  }, [dateRange.from, dateRange.to]);

  useEffect(() => {
    fetchReportData();
  }, [fetchReportData]);

  const handleDateChange = (field: "from" | "to", value: string) => {
    setDateRange((prev) => ({ ...prev, [field]: value }));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner />
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-destructive/10 border border-destructive/30 text-destructive rounded-lg p-4">
        <h3 className="font-semibold mb-1">Error Loading Reports</h3>
        <p>{error}</p>
        <button
          onClick={fetchReportData}
          className="mt-2 px-4 py-2 bg-destructive text-white rounded hover:bg-destructive/90"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!stats) return null;

  return (
    <div className="space-y-6">
      {/* Date Range Selector */}
      <div className="bg-card p-4 rounded-lg shadow">
        <div className="flex items-center gap-4">
          <div>
            <label
              htmlFor="overview-date-from"
              className="block text-sm font-medium text-foreground mb-1"
            >
              From Date
            </label>
            <input
              type="date"
              id="overview-date-from"
              value={dateRange.from}
              onChange={(e) => handleDateChange("from", e.target.value)}
              className="px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <div>
            <label
              htmlFor="overview-date-to"
              className="block text-sm font-medium text-foreground mb-1"
            >
              To Date
            </label>
            <input
              type="date"
              id="overview-date-to"
              value={dateRange.to}
              onChange={(e) => handleDateChange("to", e.target.value)}
              className="px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <div className="flex items-end">
            <button
              onClick={fetchReportData}
              className="px-4 py-2 bg-primary text-white rounded-md hover:bg-primary/90"
            >
              Update Report
            </button>
          </div>
        </div>
      </div>

      {/* Key Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-card p-6 rounded-lg shadow">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-medium text-muted-foreground">
              Total Appointments
            </h3>
            <CalendarIcon className="w-5 h-5 text-primary" />
          </div>
          <p className="text-2xl font-bold text-foreground">
            {stats.totalAppointments.toLocaleString()}
          </p>
          <p className="text-sm text-muted-foreground mt-1">
            In selected period
          </p>
        </div>

        <div className="bg-card p-6 rounded-lg shadow">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-medium text-muted-foreground">
              Total Revenue
            </h3>
            <DollarSign className="w-5 h-5 text-success" />
          </div>
          <p className="text-2xl font-bold text-foreground">
            ₹{stats.totalRevenue.toLocaleString()}
          </p>
          <p className="text-sm text-muted-foreground mt-1">Total earnings</p>
        </div>

        <div className="bg-card p-6 rounded-lg shadow">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-medium text-muted-foreground">
              Active Patients
            </h3>
            <Users className="w-5 h-5 text-purple-500" />
          </div>
          <p className="text-2xl font-bold text-foreground">
            {stats.totalPatients.toLocaleString()}
          </p>
          <p className="text-sm text-muted-foreground mt-1">Unique patients</p>
        </div>

        <div className="bg-card p-6 rounded-lg shadow">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-medium text-muted-foreground">
              Average Rating
            </h3>
            <Star className="w-5 h-5 text-warning" />
          </div>
          <p className="text-2xl font-bold text-foreground">
            {stats.averageRating.toFixed(1)}
          </p>
          <p className="text-sm text-muted-foreground mt-1">Out of 5.0</p>
        </div>
      </div>

      {/* Charts Section */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Appointments Trend */}
        <div className="bg-card p-6 rounded-lg shadow">
          <h3 className="text-lg font-semibold mb-4">Appointments Trend</h3>
          <div className="h-64 flex items-end justify-between gap-1">
            {stats.appointmentsTrend.map((day) => {
              const maxCount = Math.max(
                ...stats.appointmentsTrend.map((d) => d.count),
              );
              const height = maxCount > 0 ? (day.count / maxCount) * 100 : 0;
              return (
                <div
                  key={day.date}
                  className="flex-1 bg-primary hover:bg-primary/90 rounded-t transition-colors relative group"
                  style={{ height: `${height}%` }}
                >
                  <div className="absolute bottom-full mb-2 left-1/2 transform -translate-x-1/2 bg-popover text-popover-foreground text-xs rounded px-2 py-1 opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">
                    {day.count} appointments
                    <br />
                    {new Date(day.date).toLocaleDateString()}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-2 text-xs text-muted-foreground text-center">
            Daily appointments
          </div>
        </div>

        {/* Revenue by Department */}
        <div className="bg-card p-6 rounded-lg shadow">
          <h3 className="text-lg font-semibold mb-4">Revenue by Department</h3>
          <div className="space-y-3">
            {stats.revenueByDepartment.slice(0, 5).map((dept) => {
              const maxRevenue = Math.max(
                ...stats.revenueByDepartment.map((d) => d.revenue),
              );
              const percentage =
                maxRevenue > 0 ? (dept.revenue / maxRevenue) * 100 : 0;
              return (
                <div key={dept.department}>
                  <div className="flex justify-between mb-1">
                    <span className="text-sm font-medium">
                      {dept.department}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      ₹{dept.revenue.toLocaleString()}
                    </span>
                  </div>
                  <div className="w-full bg-muted rounded-full h-2">
                    <div
                      className="h-2 rounded-full transition-all duration-300"
                      style={{
                        width: `${percentage}%`,
                        backgroundColor: "rgb(34 197 94)",
                      }} // green-500
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Top Performing Doctors */}
      <div className="bg-card p-6 rounded-lg shadow">
        <h3 className="text-lg font-semibold mb-4">Top Performing Doctors</h3>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-border">
            <thead>
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Doctor Name
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Total Appointments
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Average Rating
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Performance
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {stats.topDoctors.map((doctor) => (
                <tr key={doctor.name} className="hover:bg-muted">
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm font-medium text-foreground">
                      Dr. {doctor.name}
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm text-foreground">
                      {doctor.appointments}
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="flex items-center">
                      <span className="text-sm text-foreground">
                        {doctor.rating.toFixed(1)}
                      </span>
                      <Star className="w-4 h-4 text-yellow-400 ml-1" />
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span
                      className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${
                        doctor.rating >= 4.5
                          ? "bg-success/10 text-success"
                          : doctor.rating >= 4.0
                            ? "bg-warning/10 text-warning"
                            : "bg-destructive/10 text-destructive"
                      }`}
                    >
                      {doctor.rating >= 4.5
                        ? "Excellent"
                        : doctor.rating >= 4.0
                          ? "Good"
                          : "Needs Improvement"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
