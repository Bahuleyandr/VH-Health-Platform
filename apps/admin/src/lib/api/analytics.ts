// src/lib/api/analytics.ts
import { getJSON } from "./core";
import type { QueryParams } from "./core";
import { API_ENDPOINTS } from "../api-config";

export function getAnalyticsDashboard<T = unknown>(params?: QueryParams) {
  return getJSON<T>(API_ENDPOINTS.analytics.dashboard, params);
}

export function getUserGrowthAnalytics<T = unknown>(params?: QueryParams) {
  return getJSON<T>(API_ENDPOINTS.analytics.userGrowth, params);
}

export function getAppointmentTrends<T = unknown>(params?: QueryParams) {
  return getJSON<T>(API_ENDPOINTS.analytics.appointmentTrends, params);
}

export function getDepartmentUtilization<T = unknown>(params?: QueryParams) {
  return getJSON<T>(API_ENDPOINTS.analytics.departmentUtilization, params);
}

export function getPatientSatisfaction<T = unknown>(params?: QueryParams) {
  return getJSON<T>(API_ENDPOINTS.analytics.satisfaction, params);
}

export function getUsageAnalytics<T = unknown>(params?: QueryParams) {
  return getJSON<T>(API_ENDPOINTS.analytics.usage, params);
}
