// src/hooks/useAttendance.ts
import { useQuery } from "@tanstack/react-query";
import { fetchAdminAPI } from "@/lib/api";

// Attendance Analytics
export const useAttendanceAnalytics = (params?: {
  department?: string;
  startDate?: string;
  endDate?: string;
  groupBy?: "day" | "week" | "month";
}) => {
  const queryString = new URLSearchParams(
    Object.entries(params || {}).filter(([, v]) => v !== undefined)
  ).toString();

  return useQuery({
    // use queryString for a stable key instead of the params object reference
    queryKey: ["admin", "attendance", "analytics", queryString],
    queryFn: () =>
      fetchAdminAPI(
        `/admin/staff/attendance/analytics${queryString ? `?${queryString}` : ""}`
      ),
    staleTime: 60_000,
  });
};

// Attendance Anomalies
export const useAttendanceAnomalies = () => {
  return useQuery({
    queryKey: ["admin", "attendance", "anomalies"],
    queryFn: () => fetchAdminAPI("/admin/staff/attendance/anomalies"),
    staleTime: 30_000,
  });
};

// Late Arrivals
export const useLateArrivals = (date: string, department?: string) => {
  return useQuery({
    queryKey: ["admin", "attendance", "late", { date, department }],
    queryFn: () =>
      fetchAdminAPI(
        `/admin/staff/attendance/late-arrivals?date=${date}${
          department ? `&department=${department}` : ""
        }`
      ),
  });
};

// Absent Report
export const useAbsentReport = (date: string, department?: string) => {
  return useQuery({
    queryKey: ["admin", "attendance", "absent", { date, department }],
    queryFn: () =>
      fetchAdminAPI(
        `/admin/staff/attendance/absent-report?date=${date}${
          department ? `&department=${department}` : ""
        }`
      ),
  });
};
