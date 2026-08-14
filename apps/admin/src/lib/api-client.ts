// src/lib/api-client.ts
//
// SECURITY: Auth tokens are stored ONLY in httpOnly cookies.
// localStorage is used ONLY for caching non-sensitive user profile data.
// All API calls go through /api/proxy which uses the cookie automatically.

import { API_ENDPOINTS } from "./api-config";
import { getJSON, fetchAdminAPI, APIError } from "./api";
import { StoredAdminUserSchema } from "./schemas";
import type { AdminUser } from "./types";

/* =========================
 * Local storage helpers
 * ========================= */

const USER_KEY = "adminUser";
const CACHE_MAX_AGE_MS = 4 * 60 * 60 * 1000; // 4 hours — matches JWT expiry
export const IDLE_SIGN_OUT_WARNING_KEY = "vh:idle-sign-out-warning";

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
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    const result = StoredAdminUserSchema.safeParse(parsed);
    if (!result.success) {
      if (process.env.NODE_ENV === "development") {
        console.warn(
          "[api-client] Stored admin user failed validation:",
          result.error.format(),
        );
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
    try {
      localStorage.removeItem(USER_KEY);
    } catch {
      /* storage may be unavailable */
    }
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
  try {
    localStorage.removeItem(USER_KEY);
  } catch {
    /* storage may be unavailable */
  }
}

function parseAdminUser(candidate: unknown): AdminUser {
  const parsed = StoredAdminUserSchema.safeParse(candidate);
  if (!parsed.success) {
    clearAuthData();
    throw new APIError(
      "Admin profile has an unsupported or invalid role",
      403,
      {
        issues: parsed.error.issues,
      },
    );
  }
  return parsed.data as AdminUser;
}

/** Validate and save an admin user with a cache timestamp. */
function cacheAdminUser(candidate: unknown): AdminUser {
  const admin = parseAdminUser(candidate);
  if (typeof window === "undefined") return admin;
  const cached: CachedUser = { ...admin, _cachedAt: Date.now() };
  try {
    localStorage.setItem(USER_KEY, JSON.stringify(cached));
  } catch {
    /* a valid cookie session must not fail because storage is unavailable */
  }
  return admin;
}

/* =========================
 * Auth flows
 * ========================= */

interface LoginResponse {
  token?: string;
  admin?: AdminUser;
  accessToken?: string;
  staff?: AdminUser;
  message?: string;
  success?: boolean;
  data?: {
    token?: string;
    accessToken?: string;
    admin?: AdminUser;
    staff?: AdminUser;
  };
}

/** Staff login via employee ID + password */
export async function staffLogin(
  employeeId: string,
  password: string,
): Promise<{
  user?: AdminUser;
  success: boolean;
}> {
  const res = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ employeeId, password }),
  });

  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(err.message ?? "Staff login failed");
  }

  // Cookie-only contract: the /api/login route sets the credential as an
  // httpOnly cookie and STRIPS token/accessToken from the body. Success is a
  // 200 + the (non-sensitive) staff profile — never a body token.
  const raw = (await res.json()) as { data?: LoginResponse } & LoginResponse;
  const payload: LoginResponse = raw.data ?? raw;

  const staffCandidate = payload.staff ?? payload.admin;
  const staffUser = staffCandidate ? cacheAdminUser(staffCandidate) : undefined;
  return { user: staffUser, success: true };
}

export type AdminLoginResult =
  | {
      success: true;
      requiresTwoFactor: false;
      requiresMfaSetup: false;
      admin?: AdminUser;
    }
  | {
      success: true;
      requiresTwoFactor: true;
      requiresMfaSetup: false;
      challengeToken: string;
      expiresAt?: string;
      admin?: Partial<AdminUser>;
    }
  | {
      success: true;
      requiresTwoFactor: false;
      requiresMfaSetup: true;
      setupToken: string;
      expiresIn: number;
      admin?: Partial<AdminUser>;
    };

export async function adminLogin(
  username: string,
  password: string,
): Promise<AdminLoginResult> {
  // Route through /api/login proxy (server-side) which:
  // 1. Adds the x-api-key from process.env.API_KEY
  // 2. Sets the auth_token as an httpOnly cookie
  // This avoids exposing the API key on the client side.
  const response = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });

  const loginResult = (await response.json()) as LoginResponse;

  if (!response.ok) {
    throw new Error(loginResult?.message ?? "Login failed");
  }

  const payload = (loginResult?.data ?? loginResult) as Record<string, unknown>;

  // 2FA challenge — caller must complete via verifyAdminMfa()
  if (
    payload?.requiresTwoFactor &&
    typeof payload?.challengeToken === "string"
  ) {
    return {
      success: true,
      requiresTwoFactor: true,
      requiresMfaSetup: false,
      challengeToken: payload.challengeToken as string,
      expiresAt: payload.expiresAt as string | undefined,
      admin: payload.admin as Partial<AdminUser> | undefined,
    };
  }

  // First-time MFA setup required — caller must complete enrollment via
  // adminMfaSetupEnroll() + adminMfaSetupConfirm() before accessing the dashboard.
  if (payload?.requiresMfaSetup && typeof payload?.setupToken === "string") {
    return {
      success: true,
      requiresTwoFactor: false,
      requiresMfaSetup: true,
      setupToken: payload.setupToken as string,
      expiresIn:
        typeof payload.expiresIn === "number" ? payload.expiresIn : 600,
      admin: payload.admin as Partial<AdminUser> | undefined,
    };
  }

  // Cookie-only contract: /api/login sets the httpOnly auth_token cookie and
  // strips the token from the body. A 200 here IS success — gate on the
  // (non-sensitive) admin profile, never on a body token.
  const admin = payload?.admin ? cacheAdminUser(payload.admin) : undefined;

  return {
    success: true,
    requiresTwoFactor: false,
    requiresMfaSetup: false,
    admin,
  };
}

/**
 * First leg of first-time MFA enrollment. Returns the QR data URL, otpauth
 * URL, encryptedSecret, and plaintext backup codes — caller must store the
 * backup codes and echo the encryptedSecret back to [adminMfaSetupConfirm].
 */
export async function adminMfaSetupEnroll(params: {
  setupToken: string;
}): Promise<{
  qrCodeDataUrl: string;
  otpauthUrl: string;
  backupCodes: string[];
  encryptedSecret: string;
}> {
  const response = await fetch("/api/login/mfa/setup-enroll", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ setupToken: params.setupToken }),
  });
  const json = await response.json();
  if (!response.ok) {
    throw new Error(json?.message ?? "Failed to start MFA setup");
  }
  const payload = json?.data ?? json;
  const { qrCodeDataUrl, otpauthUrl, backupCodes, encryptedSecret } =
    payload ?? {};
  if (!qrCodeDataUrl || !encryptedSecret || !Array.isArray(backupCodes)) {
    throw new Error("Incomplete MFA setup response");
  }
  return { qrCodeDataUrl, otpauthUrl, backupCodes, encryptedSecret };
}

/**
 * Second leg of first-time MFA enrollment. On success the httpOnly auth
 * cookie is set by the /api/login/mfa/setup-confirm route and the caller is
 * authenticated like a normal admin session.
 */
export async function adminMfaSetupConfirm(params: {
  setupToken: string;
  code: string;
  encryptedSecret: string;
  backupCodes: string[];
}): Promise<{ admin?: AdminUser; success: true }> {
  const response = await fetch("/api/login/mfa/setup-confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const json = (await response.json()) as LoginResponse;
  if (!response.ok) {
    throw new Error(json?.message ?? "Failed to complete MFA setup");
  }
  // Cookie-only: setup-confirm sets the httpOnly cookie and strips the body
  // token. Success = 200 + the admin profile.
  const payload = (json?.data ?? json) as Record<string, unknown>;
  const admin = payload?.admin ? cacheAdminUser(payload.admin) : undefined;
  return { success: true, admin };
}

/**
 * Completes the admin 2FA flow using the challenge token from [adminLogin].
 * On success the httpOnly auth cookie is set by the /api/login/mfa route.
 */
export async function verifyAdminMfa(params: {
  challengeToken: string;
  code: string;
  useBackupCode?: boolean;
}): Promise<{ admin?: AdminUser; success: true }> {
  const response = await fetch("/api/login/mfa", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });

  const json = (await response.json()) as LoginResponse;
  if (!response.ok) {
    throw new Error(json?.message ?? "MFA verification failed");
  }

  // Cookie-only: the /api/login/mfa route sets the httpOnly cookie and strips
  // the body token. Success = 200 + the admin profile.
  const payload = (json?.data ?? json) as Record<string, unknown>;
  const admin = payload?.admin ? cacheAdminUser(payload.admin) : undefined;
  return { success: true, admin };
}

export async function getAdminProfile(): Promise<AdminUser> {
  // Backend response shape (post `requestJSON` single-level unwrap):
  //   { admin: { uid, role, permissions, ... } }
  // adminLogin returns the admin flat (it destructures before returning), but
  // this endpoint returns the wrapper as-is. Unwrap here so the cache and
  // every downstream consumer (AuthContext.user, usePermissions) sees a flat
  // AdminUser with a top-level `role`.
  const data = await getJSON<{ admin?: AdminUser } | AdminUser>(
    API_ENDPOINTS.auth.admin.profile,
    undefined,
    true,
    false,
  );
  const candidate: unknown =
    data && typeof data === "object" && "admin" in data && data.admin
      ? data.admin
      : data;
  return cacheAdminUser(candidate);
}

/**
 * Result of a logout attempt. Local state (profile cache + httpOnly cookie)
 * is ALWAYS cleared, but the backend revocation call can genuinely fail —
 * e.g. a 500 when the durable revocation store is down — in which case the
 * server-side session token may still be alive. Callers must surface that
 * honestly instead of telling the admin they are fully signed out.
 */
export interface AdminLogoutResult {
  /** True when the backend acknowledged the server-side sign-out (2xx). */
  serverSignOutOk: boolean;
  /** Human-readable failure detail when serverSignOutOk is false. */
  serverSignOutError?: string;
}

function createLogoutIdempotencyKey(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `admin-logout:${globalThis.crypto.randomUUID()}`;
  }
  return `admin-logout:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

export async function adminLogout(): Promise<AdminLogoutResult> {
  let serverSignOutOk = true;
  let serverSignOutError: string | undefined;
  try {
    await fetchAdminAPI(API_ENDPOINTS.auth.admin.logout, {
      method: "POST",
      headers: { "Idempotency-Key": createLogoutIdempotencyKey() },
    });
  } catch (err) {
    // Do NOT swallow this into an unconditional "signed out" — the backend
    // fails logout closed when its durable revocation store is unavailable,
    // meaning the server-side session may still be usable. We still clear
    // local state below (this browser forgets the session either way), but
    // the caller must tell the admin the server-side sign-out failed.
    serverSignOutOk = false;
    serverSignOutError = err instanceof Error ? err.message : String(err);
    console.warn(
      "Backend logout failed — server-side session may still be active:",
      err,
    );
  } finally {
    // Clear httpOnly cookie via logout route
    await fetch("/api/logout", { method: "POST" }).catch(() => {});
    clearAuthData();
  }
  return { serverSignOutOk, serverSignOutError };
}

/**
 * Rotate the httpOnly auth_token cookie via the server-side /api/refresh route.
 * The browser never sees the token — it only observes the cookie being swapped.
 * Throws on failure; caller is responsible for redirecting to /login.
 */
export async function refreshToken(): Promise<void> {
  const res = await fetch("/api/refresh", {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) {
    clearAuthData();
    throw new Error("Refresh failed");
  }
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
