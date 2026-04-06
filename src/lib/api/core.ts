// src/lib/api/core.ts
// Core request helpers, error class, and shared utilities

import { toast } from "react-hot-toast";
import { API_ENDPOINTS } from "../api-config";
import { apiFetch } from "../api-fetch";

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

/** Normalize legacy frontend endpoints to the backend's current routes. */
function normalizeAdminEndpoint(endpoint: string): string {
  const [rawPath, rawQuery = ""] = endpoint.split("?", 2);
  const path = rawPath.startsWith("/api/v1") ? rawPath.slice(7) || "/" : rawPath;
  const query = rawQuery ? `?${rawQuery}` : "";

  // /admin/users/*, /admin/doctors/*, /admin/departments/* rewrites:
  // - Exact match (list): /admin/doctors → /doctors
  // - With sub-path (/admin/doctors/:id/...): keep as /admin/doctors/:id/... → /api/v1/admin/doctors/:id/...
  if (path === "/admin/users" || path.startsWith("/admin/users?")) return `/users${query}`;
  if (path === "/admin/doctors" || path.startsWith("/admin/doctors?")) return `/doctors${query}`;
  if (path === "/admin/departments" || path.startsWith("/admin/departments?")) return `/departments${query}`;
  // Sub-paths like /admin/doctors/:id/profile pass through as /admin/doctors/:id/profile → /api/v1/admin/doctors/:id/profile
  if (path === "/feedback") return `/feedback/recent${query || "?page=1&limit=100"}`;
  if (path === "/feedback/stats") return `/feedback/dashboard${query}`;
  if (path === "/notifications") return `/notifications/admin/manage${query || "?page=1&limit=50"}`;
  if (path === "/notifications/stats") return `/notifications/admin/overview${query}`;
  if (path === "/admin/appointments" || path === "/appointments") {
    return `/appointments/list${query}`;
  }

  return `${path}${query}`;
}

/** Back-compat helper used widely across pages */
export async function fetchAdminAPI<T = unknown>(
  endpoint: string,
  init?: { method?: string; body?: unknown; token?: string },
): Promise<T> {
  const { method = "GET", body, token } = init ?? {};
  const normalizedEndpoint = normalizeAdminEndpoint(endpoint);
  // Ensure /api/v1 prefix — callers pass short paths like "/admin/stats/quick"
  const prefixedEndpoint = normalizedEndpoint.startsWith("/api/v1")
    ? normalizedEndpoint
    : `/api/v1${normalizedEndpoint}`;
  const res = await apiFetch(prefixedEndpoint, {
    method,
    token: token ?? getToken(),
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const body = await safeReadJson(res);
    const msg =
      (body as { message?: string })?.message ||
      (body as { error?: string })?.error ||
      `HTTP ${res.status} calling ${method} ${endpoint}`;
    throw new APIError(msg, res.status, body);
  }
  const payload = (await res.json()) as APIResponse<T> | T;
  if (
    payload &&
    typeof payload === 'object' &&
    'data' in (payload as APIResponse<T>) &&
    (payload as APIResponse<T>).data !== undefined
  ) {
    return (payload as APIResponse<T>).data as T;
  }
  return payload as T;
}

async function safeReadJson(res: Response) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export { API_ENDPOINTS };
