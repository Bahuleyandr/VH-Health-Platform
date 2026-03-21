// src/lib/api-client.ts
import { API_ENDPOINTS } from "./api-config";
import {
  getJSON,
  postJSON,
  loginAdmin as apiLoginAdmin,
  APIError,
} from "./api";
<<<<<<< HEAD
=======
import { API_ENDPOINTS } from "./api-config";
import { StoredAdminUserSchema } from "./schemas";
>>>>>>> 7ca9048 (Comprehensive code review fixes: security, consistency, UX, and a11y)
import type { AdminUser } from "./types";

/* =========================
 * Local storage helpers
 * ========================= */

const TOKEN_KEY = "adminToken";
const USER_KEY = "adminUser";

export function getAuthToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function getAdminUser(): AdminUser | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    // Validate structure to guard against corrupted localStorage data
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

export function isAuthenticated(): boolean {
  return !!getAuthToken();
}

export function clearAuthData() {
  if (typeof window === "undefined") return;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

/* =========================
 * Auth flows
 * ========================= */

interface LoginResponse {
  token: string;
  admin?: AdminUser;
}

export async function adminLogin(
  username: string,
  password: string,
): Promise<{
  token: string;
  admin?: AdminUser;
  success: boolean;
}> {
  // Uses api.ts -> apiFetch under the hood (no token yet)
  const result = await apiLoginAdmin(username, password);

  // Expected backend envelope: { data: { token, admin }, ... }
  // Our api.ts unwraps .data for success responses, so result is { token, admin } here.
  const loginResult = result as LoginResponse;
  const { token, admin } = loginResult;

  if (!token) {
    throw new Error("No token received from server");
  }

  // Persist for subsequent authed calls (apiFetch reads from localStorage via our wrappers)
  if (typeof window !== "undefined") {
    localStorage.setItem(TOKEN_KEY, token);
    if (admin) localStorage.setItem(USER_KEY, JSON.stringify(admin));
  }

  return { token, admin, success: true };
}

export async function getAdminProfile(): Promise<AdminUser> {
  const data = await getJSON<AdminUser>(API_ENDPOINTS.auth.admin.profile);
  // Optionally refresh the cached copy
  if (typeof window !== "undefined" && data) {
    localStorage.setItem(USER_KEY, JSON.stringify(data));
  }
  return data;
}

export async function adminLogout(): Promise<void> {
  try {
    await postJSON(API_ENDPOINTS.auth.admin.logout);
  } catch (err) {
    // Non-fatal: we'll still clear local state

    console.warn("Logout API error:", err);
  } finally {
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
  if (typeof window !== "undefined") {
    localStorage.setItem(TOKEN_KEY, data.token);
  }
  return data.token;
}

/* =========================
 * Generic authed fetcher (legacy)
 * Prefer using getJSON/postJSON in new code
 * ========================= */

export async function authenticatedFetch(
  endpoint: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = getAuthToken();
  if (!token) throw new Error("Not authenticated");

  try {
    const { apiFetch } = await import("./api-fetch");
    return apiFetch(endpoint, {
      ...init,
      headers: init.headers as HeadersInit | undefined,
      token,
    });
  } catch (err) {
    if (err instanceof APIError && (err.status === 401 || err.status === 403)) {
      clearAuthData();
      if (typeof window !== "undefined") window.location.href = "/login";
    }
    throw err;
  }
}
