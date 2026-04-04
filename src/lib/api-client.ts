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
const CACHE_MAX_AGE_MS = 4 * 60 * 60 * 1000; // 4 hours — matches JWT expiry

interface CachedUser extends AdminUser {
  _cachedAt?: number;
}

/**
 * Check if user is authenticated by checking for cached user data.
 * The actual auth check happens server-side via the httpOnly cookie.
 * Rejects cached data older than CACHE_MAX_AGE_MS to prevent stale state.
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

    // Check cache staleness
    const cached = result.data as unknown as CachedUser;
    if (cached._cachedAt) {
      const age = Date.now() - cached._cachedAt;
      if (age > CACHE_MAX_AGE_MS) {
        localStorage.removeItem(USER_KEY);
        return null;
      }
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

/** Save admin user with cache timestamp */
function cacheAdminUser(admin: AdminUser) {
  if (typeof window === "undefined") return;
  const cached: CachedUser = { ...admin, _cachedAt: Date.now() };
  localStorage.setItem(USER_KEY, JSON.stringify(cached));
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

  // Cache user profile (non-sensitive) with timestamp for UI
  if (staffUser) cacheAdminUser(staffUser);

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
  // Route through /api/login proxy (server-side) which:
  // 1. Adds the x-api-key from process.env.API_KEY
  // 2. Sets the auth_token as an httpOnly cookie
  // This avoids exposing the API key on the client side.
  const response = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });

  const loginResult = await response.json() as LoginResponse;

  if (!response.ok) {
    throw new Error(loginResult?.message ?? "Login failed");
  }

  const { token, admin } = loginResult?.data ?? loginResult;

  if (!token) {
    throw new Error("No token received from server");
  }

  // Cache user profile (non-sensitive) with timestamp for UI
  if (admin) cacheAdminUser(admin);

  return { token, admin, success: true };
}

export async function getAdminProfile(): Promise<AdminUser> {
  const data = await getJSON<AdminUser>(API_ENDPOINTS.auth.admin.profile);
  if (data) cacheAdminUser(data);
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
