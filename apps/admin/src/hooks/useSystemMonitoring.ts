// src/hooks/useSystemMonitoring.ts

import { useQuery } from "@tanstack/react-query";
import { fetchAdminAPI } from "@/lib/api";
import { API_ENDPOINTS } from "@/lib/api-config";

// Module Health
export const useModuleHealth = () => {
  return useQuery({
    queryKey: ["admin", "health", "modules"],
    queryFn: () => fetchAdminAPI(API_ENDPOINTS.admin.health.modules),
    refetchInterval: 30000, // Check every 30s
  });
};

// System Alerts
export const useSystemAlerts = () => {
  return useQuery({
    queryKey: ["admin", "alerts", "system"],
    queryFn: () => fetchAdminAPI(API_ENDPOINTS.admin.alerts.system),
    refetchInterval: 15000, // Check every 15s
  });
};

// Recent Activity
export const useRecentActivity = (limit = 50, offset = 0) => {
  return useQuery({
    queryKey: ["admin", "activity", "recent", { limit, offset }],
    queryFn: () => 
      fetchAdminAPI(`${API_ENDPOINTS.admin.activity.recent}?limit=${limit}&offset=${offset}`),
    refetchInterval: 10000, // Frequent updates
  });
};
