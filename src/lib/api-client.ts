// src/lib/api-client.ts
//
// SECURITY: Auth tokens are stored ONLY in httpOnly cookies.
// localStorage is used ONLY for caching non-sensitive user profile data.
// All API calls go through /api/proxy which uses the cookie automatically.

import { API_BASE_URL, API_ENDPOINTS } from "./api-config";
import {
  getJSON,
  postJSON,
  loginAdmin as apiLoginAdmin,
  APIError,
} from "./api";
import { StoredAdminUserSchema } from "./schemas";
import type { AdminUser } from "./types";

/* =========================
 * Local storage helpers
 * ========================= */

const USER_KEY = "adminUser";

/**
 * Check if user is authenticated by checking for cached user data.
 * The actual auth check happens server-side via the httpOnly cookie.
 */
export function getAdminUser(): AdminUser | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = StoredAdminUserSchema.safeParse(parsed);
    if (!result.success) {
      if (process.env.NODE_ENV === "development") {
        console.warn("[api-client] Stored admin user failed validation:", result.error.format());
      }
      localStorage.removeItem(USER_KEY);
      return null;
    }
    return result.data as AdminUser;
  } catch {
    return null;
  }
}

/**
 * Check if user appears to be authenticated based on cached profile.
 * Real auth is enforced server-side via the httpOnly cookie.
 */
export function isAuthenticated(): boolean {
  return getAdminUser() !== null;
}

export function clearAuthData() {
  if (typeof window === "undefined") return;
  localStorage.removeItem(USER_KEY);
}

/* =========================
 * Auth flows
 * ========================= */

interface LoginResponse {
  token: string;
  admin?: AdminUser;
  accessToken?: string;
  staff?: AdminUser;
}

/** Staff login via employee ID + password */
export async function staffLogin(
  employeeId: string,
  password: string,
): Promise<{
  token: string;
  user?: AdminUser;
  success: boolean;
}> {
  const res = await fetch(`${API_BASE_URL}${API_ENDPOINTS.auth.staff.login}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ employeeId, password }),
  });

  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(err.message ?? "Staff login failed");
  }

  const raw = (await res.json()) as { data?: LoginResponse } & LoginResponse;
  const payload: LoginResponse = raw.data ?? raw;
  const token = payload.accessToken ?? payload.token;

  if (!token) throw new Error("No token received from server");

  const staffUser = payload.staff ?? (payload.admin as AdminUser | undefined);

  // Set httpOnly cookie via our login API route
  await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });

  // Cache user profile (non-sensitive) for UI
  if (typeof window !== "undefined" && staffUser) {
    localStorage.setItem(USER_KEY, JSON.stringify(staffUser));
  }

  return { token, user: staffUser, success: true };
}

export async function adminLogin(
  username: string,
  password: string,
): Promise<{
  token: string;
  admin?: AdminUser;
  success: boolean;
}> {
  const result = await apiLoginAdmin(username, password);
  const loginResult = result as LoginResponse;
  const { token, admin } = loginResult;

  if (!token) {
    throw new Error("No token received from server");
  }

  // Set httpOnly cookie via our login API route
  await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });

  // Cache user profile (non-sensitive) for UI
  if (typeof window !== "undefined" && admin) {
    localStorage.setItem(USER_KEY, JSON.stringify(admin));
  }

  return { token, admin, success: true };
}

export async function getAdminProfile(): Promise<AdminUser> {
  const data = await getJSON<AdminUser>(API_ENDPOINTS.auth.admin.profile);
  if (typeof window !== "undefined" && data) {
    localStorage.setItem(USER_KEY, JSON.stringify(data));
  }
  return data;
}

export async function adminLogout(): Promise<void> {
  try {
    await postJSON(API_ENDPOINTS.auth.admin.logout);
  } catch (err) {
    console.warn("Logout API error:", err);
  } finally {
    // Clear httpOnly cookie via logout route
    await fetch("/api/logout", { method: "POST" }).catch(() => {});
    clearAuthData();
  }
}

export async function refreshToken(): Promise<string> {
  const data = await postJSON<{ token: string }>(
    API_ENDPOINTS.auth.refreshToken,
  );
  if (!data?.token) {
    clearAuthData();
    throw new Error("No token in refresh response");
  }
  // Update httpOnly cookie with new token
  await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: data.token }),
  });
  return data.token;
}

/* =========================
 * Generic authed fetcher (legacy)
 * ========================= */

export async function authenticatedFetch(
  endpoint: string,
  init: RequestInit = {},
): Promise<Response> {
  try {
    const { apiFetch } = await import("./api-fetch");
    return apiFetch(endpoint, {
      ...init,
      headers: init.headers as HeadersInit | undefined,
    });
  } catch (err) {
    if (err instanceof APIError && (err.status === 401 || err.status === 403)) {
      clearAuthData();
      if (typeof window !== "undefined") window.location.href = "/login";
    }
    throw err;
  }
}
