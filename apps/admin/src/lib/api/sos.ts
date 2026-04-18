// src/lib/api/sos.ts
import { getJSON, postJSON } from "./core";
import { API_ENDPOINTS } from "../api-config";

export function getSosAnalytics<T = unknown>() {
  return getJSON<T>(API_ENDPOINTS.admin.sos.analytics);
}

export function getSosAlerts<T = unknown>(limit = 50, offset = 0) {
  return getJSON<T>(API_ENDPOINTS.admin.sos.alerts, { limit, offset });
}

export function getEmergencyServices<T = unknown>() {
  return getJSON<T>(API_ENDPOINTS.admin.sos.emergencyServices);
}

export function getSosPerformanceReport<T = unknown>() {
  return getJSON<T>(API_ENDPOINTS.admin.sos.performanceReport);
}

export function updateSosConfig<T = unknown>(config: Record<string, unknown>) {
  return postJSON<T>(API_ENDPOINTS.admin.sos.updateConfig, config);
}

export function broadcastEmergencyAlert<T = unknown>(
  message: string, 
  severity: 'HIGH' | 'MEDIUM' | 'LOW' = 'HIGH'
) {
  return postJSON<T>(API_ENDPOINTS.admin.sos.broadcast, { message, severity });
}

export function escalateAlert<T = unknown>(
  alertId: string | number, 
  reason?: string
) {
  return postJSON<T>(API_ENDPOINTS.admin.sos.escalate, { 
    alertId, 
    reason 
  });
}
