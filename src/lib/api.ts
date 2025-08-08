// src/lib/api.ts
import { toast } from 'react-hot-toast';
import { API_ENDPOINTS } from './api-config';
import { apiFetch } from './api-fetch';

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
    this.name = 'APIError';
    this.status = status;
    this.data = data;
  }
}

function buildQueryString(params: QueryParams): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') {
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    }
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

function isBrowser() {
  return typeof window !== 'undefined';
}

function getToken(): string | undefined {
  if (!isBrowser()) return undefined;
  return localStorage.getItem('adminToken') ?? undefined;
}

/** Back-compat export used by some components */
export function getAuthToken(): string | null {
  if (!isBrowser()) return null;
  return localStorage.getItem('adminToken');
}

/* =========================
 * Core JSON fetch (via apiFetch)
 * ========================= */

async function requestJSON<T = unknown>(
  endpoint: string,
  options: RequestInit & { useAuth?: boolean } = {}
): Promise<T> {
  const { useAuth = true, headers, ...rest } = options;
  const token = useAuth ? getToken() : undefined;

  // apiFetch adds Origin/x-api-key and Authorization (when token provided)
  const res = await apiFetch(endpoint, {
    ...rest,
    headers: headers as HeadersInit | undefined,
    token,
  });

  const contentType = res.headers.get('content-type') ?? '';
  const isJson = contentType.includes('application/json');

  const payload = isJson
    ? ((await res.json()) as APIResponse<T>)
    : ((await res.text()) as unknown);

  if (!res.ok) {
    if (res.status === 401) {
      if (isBrowser()) {
        toast.error('Session expired. Please log in again.');
        window.location.href = '/login';
      }
      throw new APIError('Unauthorized', 401, payload);
    }
    if (res.status === 403) {
      if (isBrowser()) toast.error('You do not have permission to perform this action.');
      throw new APIError('Forbidden', 403, payload);
    }
    const message =
      isJson && (payload as APIResponse)?.message
        ? (payload as APIResponse).message!
        : `API Error: ${res.status}`;
    throw new APIError(message, res.status, payload);
  }

  // If backend wraps { data }, return it; otherwise return payload as-is
  if (isJson) {
    const body = payload as APIResponse<T>;
    return (('data' in body && body.data !== undefined ? body.data : (body as unknown)) as T);
  }
  // Non-JSON (rare): return the raw text
  return payload as T;
}

/* =========================
 * Thin helpers
 * ========================= */

export function getJSON<T = unknown>(endpoint: string, params?: QueryParams, useAuth = true) {
  const qs = params ? buildQueryString(params) : '';
  return requestJSON<T>(`${endpoint}${qs}`, { method: 'GET', useAuth });
}

export function postJSON<T = unknown>(endpoint: string, body?: unknown, useAuth = true) {
  return requestJSON<T>(endpoint, {
    method: 'POST',
    body: body !== undefined ? JSON.stringify(body) : undefined,
    headers: { 'Content-Type': 'application/json' },
    useAuth,
  });
}

export function putJSON<T = unknown>(endpoint: string, body?: unknown, useAuth = true) {
  return requestJSON<T>(endpoint, {
    method: 'PUT',
    body: body !== undefined ? JSON.stringify(body) : undefined,
    headers: { 'Content-Type': 'application/json' },
    useAuth,
  });
}

export function deleteJSON<T = unknown>(endpoint: string, useAuth = true) {
  return requestJSON<T>(endpoint, { method: 'DELETE', useAuth });
}

/** Back-compat helper used widely across pages */
export async function fetchAdminAPI<T = unknown>(
  endpoint: string,
  init?: { method?: string; body?: unknown; token?: string }
): Promise<T> {
  const { method = 'GET', body, token } = init ?? {};
  const res = await apiFetch(endpoint, {
    method,
    token: token ?? getToken(),
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
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
  return postJSON(API_ENDPOINTS.auth.generateOtp, { phone: phoneNumber }, false);
}

export function verifyOTP(phoneNumber: string, otp: string) {
  return postJSON(API_ENDPOINTS.auth.verifyOtp, { phone: phoneNumber, otp }, false);
}

export function loginAdmin(username: string, password: string) {
  // no auth token yet
  return postJSON(API_ENDPOINTS.auth.admin.login, { username, password }, false);
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

/** Back-compat: some components call `api.getRecentActivities` */
export function getRecentActivities<T = unknown>() {
  return getActivityAudit<T>();
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
  return getJSON<T>(API_ENDPOINTS.users.byRole.replace(':role', role));
}

export function updateUserStatus<T = unknown>(userId: string, status: string) {
  return putJSON<T>(API_ENDPOINTS.users.status.replace(':identifier', userId), { status });
}

export function getInactiveUsers<T = unknown>() {
  return getJSON<T>(API_ENDPOINTS.users.inactiveUsers);
}

export function reactivateUser<T = unknown>(userId: string) {
  return postJSON<T>(API_ENDPOINTS.users.reactivate.replace(':userId', userId));
}

/* =========================
 * Departments
 * ========================= */

export function getDepartments<T = unknown>() {
  return getJSON<T>(API_ENDPOINTS.departments.list);
}

export function createDepartment<T = unknown>(data: { name: string; description?: string }) {
  return postJSON<T>(API_ENDPOINTS.departments.create, data);
}

/* =========================
 * Doctors
 * ========================= */

export function getDoctors<T = unknown>() {
  return getJSON<T>(API_ENDPOINTS.doctors.list);
}

export function deleteDoctor<T = unknown>(id: number) {
  return deleteJSON<T>(`${API_ENDPOINTS.doctors.base}/${id}`);
}

/* =========================
 * Admin Management
 * ========================= */

export function createAdminUser<T = unknown>(payload: {
  email: string;
  password: string;
  role: string;
}) {
  return postJSON<T>(API_ENDPOINTS.admin.create, payload);
}

export function deactivateAdmin<T = unknown>(id: number) {
  return postJSON<T>(`${API_ENDPOINTS.admin.base}/${id}/deactivate`);
}

export function reactivateAdmin<T = unknown>(id: number) {
  return postJSON<T>(`${API_ENDPOINTS.admin.base}/${id}/reactivate`);
}

export function updateAdminPermissions<T = unknown>(id: number, perms: string[]) {
  return putJSON<T>(`${API_ENDPOINTS.admin.base}/${id}/permissions`, { permissions: perms });
}

/* =========================
 * Settings
 * ========================= */

export function updateSystemSetting<T = unknown>(key: string, value: unknown) {
  return putJSON<T>(`${API_ENDPOINTS.settings.base}/${encodeURIComponent(key)}`, { value });
}

/* =========================
 * Named export for convenience + back-compat bucket
 * ========================= */

export const api = {
  // departments
  getDepartments,
  createDepartment,
  // doctors
  getDoctors,
  deleteDoctor,
  // dashboard & activity
  getRecentActivities,
};

export { API_ENDPOINTS };
