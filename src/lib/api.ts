// src/lib/api.ts
import { cookies } from "next/headers";
import * as Sentry from "@sentry/nextjs";
import { 
  DepartmentSchema, 
  DoctorSchema, 
  AdminUserSchema,
  DashboardDataSchema 
} from './schemas';

// This file contains API functions that are ONLY for Server Components and Server Actions,
// because it uses the server-only 'cookies' function.

const API_BASE = "https://api.vhhealth.app/api/v1";

// ============================================================================
// GENERIC API HELPERS (SERVER-ONLY)
// ============================================================================

async function fetchAdminAPI(path: string, options: RequestInit = {}) {
  const token = cookies().get("auth_token")?.value;
  if (!token) throw new Error("Authentication token not found.");

  const config: RequestInit = {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
  };

  const res = await fetch(`${API_BASE}${path}`, config);
  if (!res.ok) {
    const errorData = await res.json();
    throw new Error(errorData.message || `API request failed for path: ${path}`);
  }
  return res.json();
}

async function postAdminAPI(path: string, body: object) {
  const token = cookies().get("auth_token")?.value;
  if (!token) throw new Error("Authentication token not found.");

  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorData = await res.json();
    throw new Error(errorData.message || "API POST request failed");
  }
  return res.json();
}

async function putAdminAPI(path: string, body: object) {
    const token = cookies().get("auth_token")?.value;
    if (!token) throw new Error("Authentication token not found.");

    const res = await fetch(`${API_BASE}${path}`, {
        method: 'PUT',
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.message || "API PUT request failed");
    }
    return res.json();
}

async function deleteAdminAPI(path: string) {
    const token = cookies().get("auth_token")?.value;
    if (!token) throw new Error("Authentication token not found.");

    const res = await fetch(`${API_BASE}${path}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.message || "API DELETE request failed");
    }
    if (res.status === 204) return { success: true };
    return res.json();
}

// ============================================================================
// SPECIFIC API FUNCTIONS (SERVER-ONLY)
// ============================================================================

// AUTH
export { fetchAdminAPI, postAdminAPI, putAdminAPI, deleteAdminAPI };

export const getAdminProfile = () => fetchAdminAPI('/auth/admin/profile');
export const changeAdminPassword = (data: object) => postAdminAPI('/auth/admin/change-password', data);
export const createAdminUser = (data: object) => postAdminAPI('/auth/admin/create-admin', data);
export const listAdmins = () => fetchAdminAPI('/auth/admin/list');
export const deactivateAdmin = (data: { adminId: number; reason: string }) => postAdminAPI('/auth/admin/deactivate', data);
export const reactivateAdmin = (data: { adminId: number }) => postAdminAPI('/auth/admin/reactivate', data);
export const updateAdminPermissions = (data: { adminId: number; permissions: string[] }) => putAdminAPI('/auth/admin/update-permissions', data);

// CORE
export const getDashboardData = () => fetchAdminAPI('/admin/dashboard');
export const getAnalyticsData = (days: number = 30) => fetchAdminAPI(`/admin/analytics?days=${days}`);
export const getUsers = (queryParams: URLSearchParams) => fetchAdminAPI(`/admin/users?${queryParams.toString()}`);
export const updateUserStatus = (userId: number, data: { is_active: boolean; reason?: string }) => putAdminAPI(`/admin/users/${userId}/status`, data);
export const getSystemSettings = () => fetchAdminAPI('/admin/settings');
export const updateSystemSetting = (key: string, data: object) => putAdminAPI(`/admin/settings/${key}`, data);
export const getAppointments = (queryParams: URLSearchParams) => fetchAdminAPI(`/admin/appointments?${queryParams.toString()}`);
export const getAuditLogs = (queryParams: URLSearchParams) => fetchAdminAPI(`/admin/audit/logs?${queryParams.toString()}`);
export const getSystemLogs = (queryParams: URLSearchParams) => fetchAdminAPI(`/admin/logs/list?${queryParams.toString()}`);

// DEPARTMENTS
export const getDepartments = () => fetchAdminAPI('/departments/manage');
export const getDepartmentById = (id: string | number) => fetchAdminAPI(`/departments/${id}`);
export const createDepartment = (data: { name: string; description?: string }) => postAdminAPI('/departments/create', data);
export const updateDepartment = (id: string | number, data: { name: string; description?: string }) => putAdminAPI(`/departments/${id}`, data);
export const deleteDepartment = (id: string | number) => deleteAdminAPI(`/departments/${id}`);

// DOCTORS
export const getDoctors = () => fetchAdminAPI('/doctors/manage');
export const createDoctor = (data: object) => postAdminAPI('/doctors/create', data);
export const updateDoctorProfile = (id: number, data: object) => putAdminAPI(`/doctors/${id}/profile`, data);
export const deleteDoctor = (id: number) => deleteAdminAPI(`/doctors/${id}/account`);

// NOTIFICATIONS
export const getNotifications = () => fetchAdminAPI('/notifications/admin/manage');
export const sendAnnouncement = (data: { title: string; body: string }) => postAdminAPI('/notifications/admin/announcement', data);
export const createNotificationTemplate = (data: object) => postAdminAPI('/notifications/admin/templates', data);
export const getNotificationTemplates = () => fetchAdminAPI('/notifications/admin/templates');

// PHARMACY
export const getPharmacyAnalytics = () => fetchAdminAPI('/pharmacy/analytics');
export const getPharmacyOrders = (queryParams: URLSearchParams) => fetchAdminAPI(`/pharmacy/orders?${queryParams.toString()}`);

// Add validation to existing functions
export const getDepartments = async () => {
  try {
    const response = await fetchAdminAPI('/departments/manage');
    // Validate the response
    const departments = DepartmentSchema.array().parse(response.departments || response);
    return { departments };
  } catch (error) {
    if (error instanceof z.ZodError) {
      Sentry.captureException(error, {
        extra: { validationErrors: error.errors }
      });
      throw new Error('Invalid data format received from server');
    }
    throw error;
  }
};

export const getDashboardData = async () => {
  try {
    const response = await fetchAdminAPI('/admin/dashboard');
    return DashboardDataSchema.parse(response);
  } catch (error) {
    if (error instanceof z.ZodError) {
      Sentry.captureException(error);
      throw new Error('Invalid dashboard data format');
    }
    throw error;
  }
};