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
    Object.entries(params || {}).filter(([_, v]) => v !== undefined)
  ).toString();
  
  return useQuery({
    queryKey: ["admin", "attendance", "analytics", params],
    queryFn: () => 
      fetchAdminAPI(`/admin/attendance/analytics${queryString ? `?${queryString}` : ""}`),
    staleTime: 60000,
  });
};

// Attendance Anomalies
export const useAttendanceAnomalies = () => {
  return useQuery({
    queryKey: ["admin", "attendance", "anomalies"],
    queryFn: () => fetchAdminAPI("/admin/attendance/anomalies"),
    staleTime: 30000,
  });
};

// Late Arrivals
export const useLateArrivals = (date: string, department?: string) => {
  return useQuery({
    queryKey: ["admin", "attendance", "late", { date, department }],
    queryFn: () => 
      fetchAdminAPI(
        `/admin/attendance/late-arrivals?date=${date}${department ? `&department=${department}` : ""}`
      ),
  });
};

// Absent Report
export const useAbsentReport = (date: string, department?: string) => {
  return useQuery({
    queryKey: ["admin", "attendance", "absent", { date, department }],
    queryFn: () => 
      fetchAdminAPI(
        `/admin/attendance/absent-report?date=${date}${department ? `&department=${department}` : ""}`
      ),
  });
};