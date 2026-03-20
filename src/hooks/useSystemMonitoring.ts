// src/hooks/useSystemMonitoring.ts

import { fetchAdminAPI } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";

// Module Health
export const useModuleHealth = () => {
  return useQuery({
    queryKey: ["admin", "health", "modules"],
    queryFn: () => fetchAdminAPI("/admin/health/modules"),
    refetchInterval: 30000, // Check every 30s
  });
};

// System Alerts
export const useSystemAlerts = () => {
  return useQuery({
    queryKey: ["admin", "alerts", "system"],
    queryFn: () => fetchAdminAPI("/admin/alerts/system"),
    refetchInterval: 15000, // Check every 15s
  });
};

// Recent Activity
export const useRecentActivity = (limit = 50, offset = 0) => {
  return useQuery({
    queryKey: ["admin", "activity", "recent", { limit, offset }],
    queryFn: () => 
      fetchAdminAPI(`/admin/activity/recent?limit=${limit}&offset=${offset}`),
    refetchInterval: 10000, // Frequent updates
  });
};