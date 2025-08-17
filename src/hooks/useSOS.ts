// src/hooks/useSOS.ts

import { useQuery, useMutation } from "@tanstack/react-query";
import { fetchAdminAPI } from "@/lib/api";
import toast from "react-hot-toast";

// SOS Analytics
export const useSosAnalytics = () => {
  return useQuery({
    queryKey: ["admin", "sos", "analytics"],
    queryFn: () => fetchAdminAPI("/admin/sos/analytics"),
    refetchInterval: 10000, // Refresh every 10s for real-time
  });
};

// All Alerts
export const useAllAlerts = (limit = 50, offset = 0) => {
  return useQuery({
    queryKey: ["admin", "sos", "alerts", { limit, offset }],
    queryFn: () => 
      fetchAdminAPI(`/admin/sos/alerts?limit=${limit}&offset=${offset}`),
    refetchInterval: 5000, // Frequent refresh for emergency data
  });
};

// Emergency Services
export const useEmergencyServices = () => {
  return useQuery({
    queryKey: ["admin", "sos", "services"],
    queryFn: () => fetchAdminAPI("/admin/sos/services"),
    staleTime: 300000, // Cache for 5 minutes
  });
};

// Broadcast Emergency Alert
export const useBroadcastAlert = () => {
  return useMutation({
    mutationFn: ({ message, severity }: { 
      message: string; 
      severity: "HIGH" | "MEDIUM" | "LOW" 
    }) =>
      fetchAdminAPI("/admin/sos/broadcast", {
        method: "POST",
        body: JSON.stringify({ message, severity }),
      }),
    onSuccess: () => {
      toast.success("Emergency broadcast sent successfully");
    },
    onError: () => {
      toast.error("Failed to send emergency broadcast");
    },
  });
};

// Escalate Alert
export const useEscalateAlert = () => {
  return useMutation({
    mutationFn: ({ alertId, reason }: { 
      alertId: string | number; 
      reason?: string 
    }) =>
      fetchAdminAPI("/admin/sos/escalate", {
        method: "POST",
        body: JSON.stringify({ alertId, reason }),
      }),
    onSuccess: () => {
      toast.success("Alert escalated successfully");
    },
  });
};