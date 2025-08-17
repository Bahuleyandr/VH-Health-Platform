// src/hooks/useAdminStats.ts
import { useQuery } from "@tanstack/react-query";
import { fetchAdminAPI } from "@/lib/api";

// User Statistics
export const useUserStats = () => {
  return useQuery({
    queryKey: ["admin", "stats", "users"],
    queryFn: () => fetchAdminAPI("/admin/stats/users"),
    staleTime: 30_000,
  });
};

// Appointment Statistics
export const useAppointmentStats = () => {
  return useQuery({
    queryKey: ["admin", "stats", "appointments"],
    queryFn: () => fetchAdminAPI("/admin/stats/appointments"),
    staleTime: 30_000,
  });
};

// Staff Statistics
export const useStaffStats = () => {
  return useQuery({
    queryKey: ["admin", "stats", "staff"],
    queryFn: () => fetchAdminAPI("/admin/stats/staff"),
    staleTime: 30_000,
  });
};

// Quick Stats for Dashboard
export const useQuickStats = () => {
  return useQuery({
    queryKey: ["admin", "stats", "quick"],
    queryFn: () => fetchAdminAPI("/admin/stats/quick"),
    refetchInterval: 30_000, // Auto-refresh every 30s
  });
};

// Department Statistics
export const useDepartmentStats = () => {
  return useQuery({
    queryKey: ["admin", "stats", "departments"],
    queryFn: () => fetchAdminAPI("/admin/stats/departments"),
    staleTime: 60_000,
  });
};
