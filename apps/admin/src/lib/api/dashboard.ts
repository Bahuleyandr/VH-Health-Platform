// src/lib/api/dashboard.ts
import { getJSON, postJSON } from "./core";
import { API_ENDPOINTS } from "../api-config";

/* =========================
 * Dashboard & Analytics
 * ========================= */

export function getDashboardData<T = unknown>() {
  return getJSON<T>(API_ENDPOINTS.users.dashboard);
}

export function getUserAnalytics<T = unknown>() {
  return getJSON<T>(API_ENDPOINTS.users.analytics);
}

export function getSystemInfo<T = unknown>() {
  return getJSON<T>(API_ENDPOINTS.users.systemInfo);
}

export function getActivityAudit<T = unknown>() {
  return getJSON<T>(API_ENDPOINTS.users.activityAudit);
}

/** Back-compat */
export function getRecentActivities<T = unknown>() {
  return getActivityAudit<T>();
}

/* =========================
 * Admin Dashboard Stats
 * ========================= */

export function getAdminDashboard<T = unknown>() {
  return getJSON<T>(API_ENDPOINTS.admin.dashboard);
}

export function getQuickStats<T = unknown>() {
  return getJSON<T>(API_ENDPOINTS.admin.stats.quick);
}

export function getUserStats<T = unknown>() {
  return getJSON<T>(API_ENDPOINTS.admin.stats.users);
}

export function getDoctorStats<T = unknown>() {
  return getJSON<T>(API_ENDPOINTS.admin.stats.doctors);
}

export function getDepartmentStats<T = unknown>() {
  return getJSON<T>(API_ENDPOINTS.admin.stats.departments);
}

export function getAppointmentStats<T = unknown>() {
  return getJSON<T>(API_ENDPOINTS.admin.stats.appointments);
}

export function getRecordStats<T = unknown>() {
  return getJSON<T>(API_ENDPOINTS.admin.stats.records);
}

export function getEmergencyStats<T = unknown>() {
  return getJSON<T>(API_ENDPOINTS.admin.stats.emergency);
}

export function getStaffStats<T = unknown>() {
  return getJSON<T>(API_ENDPOINTS.admin.stats.staff);
}

export function getAppointmentSummary<T = unknown>() {
  return getJSON<T>(API_ENDPOINTS.admin.stats.appointmentSummary);
}

/* =========================
 * Admin Activity & Monitoring
 * ========================= */

export function getRecentActivity<T = unknown>(limit = 50, offset = 0) {
  return getJSON<T>(API_ENDPOINTS.admin.activity.recent, { limit, offset });
}

export function getSystemAlerts<T = unknown>() {
  return getJSON<T>(API_ENDPOINTS.admin.alerts.system);
}

export function getModuleHealth<T = unknown>() {
  return getJSON<T>(API_ENDPOINTS.admin.health.modules);
}

export function getSystemHealth<T = unknown>() {
  return getJSON<T>(API_ENDPOINTS.admin.health.system);
}

/* =========================
 * Admin Reports
 * ========================= */

export function refreshDashboardCache<T = unknown>() {
  return postJSON<T>(API_ENDPOINTS.admin.reports.refreshCache);
}

export function generateDashboardReport<T = unknown>(
  format = 'pdf',
  dateRange?: { startDate?: string; endDate?: string }
) {
  return postJSON<T>(API_ENDPOINTS.admin.reports.generate, {
    format,
    dateRange
  });
}
