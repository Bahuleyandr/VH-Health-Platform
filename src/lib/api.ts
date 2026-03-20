// src/lib/api.ts
import { toast } from "react-hot-toast";
import { API_ENDPOINTS } from "./api-config";
import { apiFetch } from "./api-fetch";

/* =========================
 * Types & small helpers
 * ========================= */

type QueryValue = string | number | boolean | undefined | null;

export interface QueryParams {
  [key: string]: QueryValue;
}

export interface APIResponse<T = unknown> {
  success?: boolean;
  message?: string;
  data?: T;
  [key: string]: unknown;
}

export class APIError extends Error {
  status: number;
  data?: unknown;

  constructor(message: string, status: number, data?: unknown) {
    super(message);
    this.name = "APIError";
    this.status = status;
    this.data = data;
  }
}

function buildQueryString(params: QueryParams): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") {
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    }
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

function isBrowser() {
  return typeof window !== "undefined";
}

function getToken(): string | undefined {
  if (!isBrowser()) return undefined;
  return localStorage.getItem("adminToken") ?? undefined;
}

/* =========================
 * Core JSON fetch (via apiFetch)
 * ========================= */

async function requestJSON<T = unknown>(
  endpoint: string,
  options: RequestInit & { useAuth?: boolean } = {},
): Promise<T> {
  const { useAuth = true, headers, ...rest } = options;
  const token = useAuth ? getToken() : undefined;

  const res = await apiFetch(endpoint, {
    ...rest,
    headers: headers as HeadersInit | undefined,
    token,
  });

  const contentType = res.headers.get("content-type") ?? "";
  const isJson = contentType.includes("application/json");

  const payload = isJson
    ? ((await res.json()) as APIResponse<T>)
    : ((await res.text()) as unknown);

  if (!res.ok) {
    if (res.status === 401) {
      if (isBrowser()) {
        toast.error("Session expired. Please log in again.");
        window.location.href = "/login";
      }
      throw new APIError("Unauthorized", 401, payload);
    }
    if (res.status === 403) {
      if (isBrowser())
        toast.error("You do not have permission to perform this action.");
      throw new APIError("Forbidden", 403, payload);
    }
    const message =
      isJson && typeof (payload as APIResponse).message === "string"
        ? ((payload as APIResponse).message as string)
        : `API Error: ${res.status}`;
    throw new APIError(message, res.status, payload);
  }

  if (isJson) {
    const body = payload as APIResponse<T>;
    return (
      "data" in body && body.data !== undefined ? body.data : (body as unknown)
    ) as T;
  }
  return payload as T;
}

/* =========================
 * Thin helpers
 * ========================= */

export function getJSON<T = unknown>(
  endpoint: string,
  params?: QueryParams,
  useAuth = true,
) {
  const qs = params ? buildQueryString(params) : "";
  return requestJSON<T>(`${endpoint}${qs}`, { method: "GET", useAuth });
}

export function postJSON<T = unknown>(
  endpoint: string,
  body?: unknown,
  useAuth = true,
) {
  return requestJSON<T>(endpoint, {
    method: "POST",
    body: body !== undefined ? JSON.stringify(body) : undefined,
    headers: { "Content-Type": "application/json" },
    useAuth,
  });
}

export function putJSON<T = unknown>(
  endpoint: string,
  body?: unknown,
  useAuth = true,
) {
  return requestJSON<T>(endpoint, {
    method: "PUT",
    body: body !== undefined ? JSON.stringify(body) : undefined,
    headers: { "Content-Type": "application/json" },
    useAuth,
  });
}

export function deleteJSON<T = unknown>(endpoint: string, useAuth = true) {
  return requestJSON<T>(endpoint, { method: "DELETE", useAuth });
}

/** Back-compat helper used widely across pages */
export async function fetchAdminAPI<T = unknown>(
  endpoint: string,
  init?: { method?: string; body?: unknown; token?: string },
): Promise<T> {
  const { method = "GET", body, token } = init ?? {};
  const res = await apiFetch(endpoint, {
    method,
    token: token ?? getToken(),
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const msg = `HTTP ${res.status} calling ${method} ${endpoint}`;
    throw new APIError(msg, res.status, await safeReadJson(res));
  }
  return (await res.json()) as T;
}

async function safeReadJson(res: Response) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/* =========================
 * Auth (OTP + admin)
 * ========================= */

export function generateOTP(phoneNumber: string) {
  return postJSON(
    API_ENDPOINTS.auth.generateOtp,
    { phone: phoneNumber },
    false,
  );
}

export function verifyOTP(phoneNumber: string, otp: string) {
  return postJSON(
    API_ENDPOINTS.auth.verifyOtp,
    { phone: phoneNumber, otp },
    false,
  );
}

export function loginAdmin(username: string, password: string) {
  return postJSON(
    API_ENDPOINTS.auth.admin.login,
    { username, password },
    false,
  );
}

export function getAuthStats() {
  return getJSON(API_ENDPOINTS.auth.stats);
}

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

/* =========================
 * Attendance Management
 * ========================= */

export function getAttendanceAnalytics<T = unknown>(params?: {
  department?: string;
  startDate?: string;
  endDate?: string;
  groupBy?: 'day' | 'week' | 'month';
}) {
  return getJSON<T>(API_ENDPOINTS.admin.attendance.analytics, params);
}

export function getAttendanceAnomalies<T = unknown>() {
  return getJSON<T>(API_ENDPOINTS.admin.attendance.anomalies);
}

export function getLateArrivals<T = unknown>(date: string, department?: string) {
  return getJSON<T>(API_ENDPOINTS.admin.attendance.lateArrivals, { 
    date, 
    department 
  });
}

export function getEarlyDepartures<T = unknown>(date: string, department?: string) {
  return getJSON<T>(API_ENDPOINTS.admin.attendance.earlyDepartures, { 
    date, 
    department 
  });
}

export function getAbsentReport<T = unknown>(date: string, department?: string) {
  return getJSON<T>(API_ENDPOINTS.admin.attendance.absentReport, { 
    date, 
    department 
  });
}

/* =========================
 * SOS/Emergency Management
 * ========================= */

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

/* =========================
 * Upload/File Management
 * ========================= */

export function getUploadSummary<T = unknown>() {
  return getJSON<T>(API_ENDPOINTS.admin.uploads.summary);
}

export function getQuarantinedFiles<T = unknown>(limit = 50, offset = 0) {
  return getJSON<T>(API_ENDPOINTS.admin.uploads.quarantined, { limit, offset });
}

export function getHipaaAuditReport<T = unknown>(params?: {
  limit?: number;
  offset?: number;
  startDate?: string | null;
  endDate?: string | null;
}) {
  return postJSON<T>(API_ENDPOINTS.admin.uploads.hipaaAudit, params || {});
}

export function rescanFile<T = unknown>(fileId: string) {
  return postJSON<T>(API_ENDPOINTS.admin.uploads.rescan, { fileId });
}

export function cleanupExpiredFiles<T = unknown>(dryRun = true) {
  return postJSON<T>(API_ENDPOINTS.admin.uploads.cleanup, { dryRun });
}

export function bulkUpdateHipaaProtection<T = unknown>(
  ids: string[], 
  protect: boolean
) {
  return postJSON<T>(API_ENDPOINTS.admin.uploads.bulkHipaa, { 
    ids, 
    protect 
  });
}

export function purgeQuarantinedFiles<T = unknown>(dryRun = true) {
  return postJSON<T>(API_ENDPOINTS.admin.uploads.purgeQuarantine, { dryRun });
}

/* =========================
 * Users
 * ========================= */

export function getUsers<T = unknown>(params?: {
  page?: number;
  limit?: number;
  search?: string;
  role?: string;
}) {
  return getJSON<T>(API_ENDPOINTS.users.list, params);
}

export function getUsersByRole<T = unknown>(role: string) {
  return getJSON<T>(API_ENDPOINTS.users.byRole.replace(":role", role));
}

export function updateUserStatus<T = unknown>(userId: string, status: string) {
  return putJSON<T>(API_ENDPOINTS.users.status.replace(":identifier", userId), {
    status,
  });
}

export function getInactiveUsers<T = unknown>() {
  return getJSON<T>(API_ENDPOINTS.users.inactiveUsers);
}

export function reactivateUser<T = unknown>(userId: string) {
  return postJSON<T>(API_ENDPOINTS.users.reactivate.replace(":userId", userId));
}

/* =========================
 * Departments
 * ========================= */

export function getDepartments<T = unknown>() {
  return getJSON<T>(API_ENDPOINTS.departments.list);
}

export function createDepartment<T = unknown>(data: {
  name: string;
  description?: string;
}) {
  return postJSON<T>(API_ENDPOINTS.departments.create, data);
}

export function updateDepartment<T = unknown>(
  id: string,
  data: { name?: string; description?: string }
) {
  return putJSON<T>(API_ENDPOINTS.departments.update.replace(":id", id), data);
}

export function deleteDepartment<T = unknown>(id: string) {
  return deleteJSON<T>(API_ENDPOINTS.departments.delete.replace(":departmentId", id));
}

/* =========================
 * Doctors
 * ========================= */

export function getDoctors<T = unknown>() {
  return getJSON<T>(API_ENDPOINTS.doctors.list);
}

function hasDeleteAccountEndpoint(x: unknown): x is { deleteAccount: string } {
  return (
    typeof x === "object" &&
    x !== null &&
    typeof (x as Record<string, unknown>).deleteAccount === "string"
  );
}

export function deleteDoctor<T = unknown>(id: number) {
  const endpoint = hasDeleteAccountEndpoint(API_ENDPOINTS.doctors)
    ? API_ENDPOINTS.doctors.deleteAccount.replace(":id", String(id))
    : `/doctors/${id}`; // fallback
  return deleteJSON<T>(endpoint);
}

export function getDoctorProfile<T = unknown>(id: string) {
  return getJSON<T>(API_ENDPOINTS.doctors.profileById.replace(":id", id));
}

export function updateDoctorAvailability<T = unknown>(
  id: string,
  availability: boolean
) {
  return putJSON<T>(API_ENDPOINTS.doctors.availability.replace(":id", id), {
    is_available: availability
  });
}

/* =========================
 * Appointments
 * ========================= */

export function getAppointments<T = unknown>(params?: QueryParams) {
  return getJSON<T>(API_ENDPOINTS.appointments.list, params);
}

export function getAppointmentAnalytics<T = unknown>() {
  return getJSON<T>(API_ENDPOINTS.appointments.admin.analytics);
}

export function getAppointmentConflicts<T = unknown>() {
  return getJSON<T>(API_ENDPOINTS.appointments.admin.conflicts);
}

export function getAppointmentCapacity<T = unknown>() {
  return getJSON<T>(API_ENDPOINTS.appointments.admin.capacity);
}

export function getNoShows<T = unknown>() {
  return getJSON<T>(API_ENDPOINTS.appointments.admin.noShows);
}

/* =========================
 * Notifications
 * ========================= */

export function getNotificationTemplates<T = unknown>() {
  return getJSON<T>(API_ENDPOINTS.notifications.templates);
}

export function sendAnnouncement<T = unknown>(data: {
  title: string;
  message: string;
  priority?: string;
}) {
  return postJSON<T>(API_ENDPOINTS.notifications.announcement, data);
}

export function sendTargetedNotification<T = unknown>(data: {
  recipients: string[];
  title: string;
  message: string;
}) {
  return postJSON<T>(API_ENDPOINTS.notifications.targeted, data);
}

export function getNotificationStats<T = unknown>() {
  return getJSON<T>(API_ENDPOINTS.notifications.statsSummary);
}

/* =========================
 * Admin Management
 * ========================= */

export function createAdminUser<T = unknown>(payload: {
  email: string;
  password: string;
  role: string;
  permissions?: string[];
}) {
  return postJSON<T>("/api/v1/auth/admin/create-admin", payload);
}

export function deactivateAdmin<T = unknown>(id: number): Promise<T>;
export function deactivateAdmin<T = unknown>(payload: {
  adminId: number;
  reason?: string;
}): Promise<T>;
export function deactivateAdmin<T = unknown>(
  arg: number | { adminId: number; reason?: string },
) {
  const id = typeof arg === "number" ? arg : arg.adminId;
  const reason = typeof arg === "object" ? arg.reason : undefined;
  return postJSON<T>(`/api/v1/admin/users/${id}/deactivate`, { reason });
}

export function reactivateAdmin<T = unknown>(id: number): Promise<T>;
export function reactivateAdmin<T = unknown>(payload: {
  adminId: number;
}): Promise<T>;
export function reactivateAdmin<T = unknown>(
  arg: number | { adminId: number },
) {
  const id = typeof arg === "number" ? arg : arg.adminId;
  return postJSON<T>(`/api/v1/admin/users/${id}/reactivate`);
}

export function updateAdminPermissions<T = unknown>(
  id: number,
  perms: string[],
): Promise<T>;
export function updateAdminPermissions<T = unknown>(payload: {
  adminId: number;
  permissions: string[];
}): Promise<T>;
export function updateAdminPermissions<T = unknown>(
  a: number | { adminId: number; permissions: string[] },
  perms?: string[],
) {
  const id = typeof a === "number" ? a : a.adminId;
  const permissions = typeof a === "number" ? (perms ?? []) : a.permissions;
  return putJSON<T>(`/api/v1/admin/users/${id}/permissions`, { permissions });
}

/* =========================
 * Settings
 * ========================= */

export function updateSystemSetting<T = unknown>(key: string, value: unknown) {
  return putJSON<T>(`/api/v1/settings/${encodeURIComponent(key)}`, { value });
}

export function getSystemSettings<T = unknown>() {
  return getJSON<T>("/api/v1/settings");
}

/* =========================
 * Infrastructure & Logs
 * ========================= */

export function getAuditLogs<T = unknown>(params?: {
  page?: number;
  limit?: number;
  userId?: string;
  action?: string;
  startDate?: string;
  endDate?: string;
}) {
  return getJSON<T>(API_ENDPOINTS.infrastructure.auditLog, params);
}

export function toggleUserStatus<T = unknown>(userId: string, active: boolean) {
  return postJSON<T>(API_ENDPOINTS.infrastructure.toggleUserStatus, {
    userId,
    active
  });
}

/* =========================
 * Named export for convenience + back-compat bucket
 * ========================= */

export const api = {
  // Auth
  loginAdmin,
  generateOTP,
  verifyOTP,
  
  // Dashboard
  getDashboardData,
  getQuickStats,
  getUserStats,
  getDoctorStats,
  getDepartmentStats,
  getAppointmentStats,
  getStaffStats,
  
  // Activity & Monitoring
  getRecentActivity,
  getRecentActivities, // back-compat alias
  getSystemAlerts,
  getModuleHealth,
  
  // Attendance
  getAttendanceAnalytics,
  getAttendanceAnomalies,
  getLateArrivals,
  getEarlyDepartures,
  getAbsentReport,
  
  // SOS/Emergency
  getSosAnalytics,
  getSosAlerts,
  getEmergencyServices,
  broadcastEmergencyAlert,
  escalateAlert,
  
  // Uploads
  getUploadSummary,
  getQuarantinedFiles,
  getHipaaAuditReport,
  cleanupExpiredFiles,
  
  // Users
  getUsers,
  updateUserStatus,
  reactivateUser,
  
  // Departments
  getDepartments,
  createDepartment,
  updateDepartment,
  deleteDepartment,
  
  // Doctors
  getDoctors,
  deleteDoctor,
  getDoctorProfile,
  updateDoctorAvailability,
  
  // Appointments
  getAppointments,
  getAppointmentAnalytics,
  getAppointmentConflicts,
  
  // Notifications
  getNotificationTemplates,
  sendAnnouncement,
  sendTargetedNotification,
  
  // Admin Management
  createAdminUser,
  deactivateAdmin,
  reactivateAdmin,
  updateAdminPermissions,
};

export { API_ENDPOINTS };