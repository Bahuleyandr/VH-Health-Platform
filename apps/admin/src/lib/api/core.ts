// src/lib/api/core.ts
// Core request helpers, error class, and shared utilities

import { toast } from "react-hot-toast";

import { API_ENDPOINTS } from "../api-config";
import { apiFetch } from "../api-fetch";
import { navigateToLogin } from "../browserNavigation";

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
  requestId?: string;
  code?: string;
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

/** Normalize legacy frontend endpoints to the backend's current routes. */
function normalizeAdminEndpoint(endpoint: string): string {
  const [rawPath, rawQuery = ""] = endpoint.split("?", 2);
  const path = rawPath.startsWith("/api/v1")
    ? rawPath.slice(7) || "/"
    : rawPath;
  const query = rawQuery ? `?${rawQuery}` : "";

  // /admin/users/*, /admin/doctors/*, /admin/departments/* rewrites:
  // - Exact match (list): /admin/doctors -> /doctors
  // - With sub-path (/admin/doctors/:id/...): keep as /admin/doctors/:id/... -> /api/v1/admin/doctors/:id/...
  if (path === "/admin/users" || path.startsWith("/admin/users?"))
    return `/users${query}`;
  if (path === "/admin/doctors" || path.startsWith("/admin/doctors?"))
    return `/doctors${query}`;
  if (path === "/admin/departments" || path.startsWith("/admin/departments?"))
    return `/departments${query}`;
  // Sub-paths like /admin/doctors/:id/profile pass through as /admin/doctors/:id/profile -> /api/v1/admin/doctors/:id/profile
  if (path === "/feedback")
    return `/feedback/recent${query || "?page=1&limit=100"}`;
  if (path === "/feedback/stats") return `/feedback/dashboard${query}`;
  if (path === "/notifications")
    return `/notifications/admin/manage${query || "?page=1&limit=50"}`;
  if (path === "/notifications/stats")
    return `/notifications/admin/overview${query}`;
  if (path === "/admin/appointments" || path === "/appointments") {
    return `/appointments/list${query}`;
  }

  return `${path}${query}`;
}

function toApiV1Endpoint(endpoint: string): string {
  const normalizedEndpoint = normalizeAdminEndpoint(endpoint);
  return normalizedEndpoint.startsWith("/api/v1")
    ? normalizedEndpoint
    : `/api/v1${normalizedEndpoint}`;
}

/* =========================
 * 401 auto-refresh (single-flight)
 * =========================
 * Concurrent 401s share one refresh call. On success the original request is
 * retried once. On failure the user is sent to /login. The refresh endpoint
 * itself skips this path to avoid recursion.
 */
let refreshInFlight: Promise<void> | null = null;

function isRefreshEndpoint(endpoint: string): boolean {
  return endpoint.includes("/auth/refresh-token");
}

function triggerSessionExpired(): void {
  if (!isBrowser()) return;
  try {
    localStorage.removeItem("adminUser");
  } catch {
    /* best-effort */
  }
  toast.error("Session expired. Please log in again.");
  navigateToLogin("/login?reason=session_expired");
}

/**
 * Rotate the httpOnly auth_token cookie via the server-side /api/refresh route.
 * Throws on failure — caller handles the redirect.
 * (Inlined here to avoid a circular import with lib/api-client.ts.)
 */
async function doRefresh(): Promise<void> {
  const res = await fetch("/api/refresh", {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) throw new Error("Refresh failed");
}

async function sharedRefresh(): Promise<void> {
  if (!refreshInFlight) {
    refreshInFlight = doRefresh().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

/* =========================
 * Core JSON fetch (via apiFetch)
 * ========================= */

interface InternalOptions extends RequestInit {
  useAuth?: boolean;
  /** Internal — prevents infinite 401 loops on retried requests. */
  _retried?: boolean;
  /** Internal — keeps the backend envelope for callers that need request IDs. */
  _preserveEnvelope?: boolean;
  /** Internal — preserves the legacy helper's endpoint-aware fallback message. */
  _fallbackErrorMessage?: string;
  /** Internal — session probes can fail without navigating the current page. */
  _redirectOnUnauthorized?: boolean;
}

const AUTOMATICALLY_REPLAYABLE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function canReplayAfterRefresh(method: string, headers?: HeadersInit): boolean {
  if (AUTOMATICALLY_REPLAYABLE_METHODS.has(method)) return true;
  return new Headers(headers).has("Idempotency-Key");
}

async function requestJSON<T = unknown>(
  endpoint: string,
  options: InternalOptions = {},
): Promise<T> {
  const {
    useAuth = true,
    _retried = false,
    _preserveEnvelope = false,
    _fallbackErrorMessage,
    _redirectOnUnauthorized = true,
    headers,
    ...rest
  } = options;
  const apiEndpoint = toApiV1Endpoint(endpoint);
  const method = (rest.method ?? "GET").toUpperCase();

  // Auth is carried via the httpOnly auth_token cookie handled server-side by
  // /api/proxy. No client-side token injection.
  const res = await apiFetch(apiEndpoint, {
    ...rest,
    headers: headers as HeadersInit | undefined,
  });

  const contentType = res.headers.get("content-type") ?? "";
  const isJson = contentType.includes("application/json");

  let payload: APIResponse<T> | unknown = null;
  try {
    payload = isJson
      ? ((await res.json()) as APIResponse<T>)
      : ((await res.text()) as unknown);
  } catch {
    // Keep transport/status context even when an upstream returned malformed
    // JSON. The legacy fetchAdminAPI contract relies on an APIError here.
  }

  if (!res.ok) {
    if (res.status === 401) {
      // Don't try to refresh while refreshing — and don't retry forever.
      if (!useAuth || _retried || isRefreshEndpoint(endpoint)) {
        if (_redirectOnUnauthorized) triggerSessionExpired();
        throw new APIError("Unauthorized", 401, payload);
      }
      try {
        await sharedRefresh();
      } catch {
        if (_redirectOnUnauthorized) triggerSessionExpired();
        throw new APIError("Unauthorized", 401, payload);
      }
      if (!canReplayAfterRefresh(method, headers)) {
        throw new APIError(
          `${method} request was not replayed after session renewal because it has no Idempotency-Key. The operation may be ambiguous; review its result before retrying.`,
          401,
          payload,
        );
      }
      // Refresh succeeded — replay the original request exactly once.
      return requestJSON<T>(endpoint, { ...options, _retried: true });
    }
    if (res.status === 403) {
      if (isBrowser())
        toast.error("You do not have permission to perform this action.");
      throw new APIError("Forbidden", 403, payload);
    }
    const message =
      isJson && typeof (payload as APIResponse | null)?.message === "string"
        ? ((payload as APIResponse).message as string)
        : isJson &&
            typeof (payload as { error?: unknown } | null)?.error === "string"
          ? (payload as { error: string }).error
          : _fallbackErrorMessage
            ? `HTTP ${res.status} ${_fallbackErrorMessage}`
            : `API Error: ${res.status}`;
    throw new APIError(message, res.status, payload);
  }

  if (isJson) {
    const body = payload as APIResponse<T>;
    if (_preserveEnvelope) return body as T;
    return (
      "data" in body && body.data !== undefined ? body.data : (body as unknown)
    ) as T;
  }
  return payload as T;
}

/* =========================
 * Thin helpers
 * ========================= */

// Serialize a request body for the JSON helpers. Accepts a raw object
// (canonical) OR a string that the caller already JSON-stringified.
// Without the string passthrough, pre-serialized bodies get wrapped in
// outer quotes and the backend rejects them as malformed JSON — a
// latent bug across ~30 call sites that survived because they hit
// rarely-used mutation paths.
function serializeJsonBody(body: unknown): string | undefined {
  if (body === undefined || body === null) return undefined;
  return typeof body === "string" ? body : JSON.stringify(body);
}

export function getJSON<T = unknown>(
  endpoint: string,
  params?: QueryParams,
  useAuth = true,
  redirectOnUnauthorized = true,
) {
  const qs = params ? buildQueryString(params) : "";
  return requestJSON<T>(`${endpoint}${qs}`, {
    method: "GET",
    useAuth,
    _redirectOnUnauthorized: redirectOnUnauthorized,
  });
}

export function getJSONEnvelope<T = unknown>(
  endpoint: string,
  params?: QueryParams,
  useAuth = true,
): Promise<APIResponse<T>> {
  const qs = params ? buildQueryString(params) : "";
  return requestJSON<APIResponse<T>>(`${endpoint}${qs}`, {
    method: "GET",
    useAuth,
    _preserveEnvelope: true,
  });
}

/**
 * `headers` exists so callers can attach an `Idempotency-Key`. Routes mounted
 * with `requireIdempotencyKey({ required: true })` hard-400 without it, and the
 * 401→refresh replay above only re-sends an unsafe method when the header is
 * present. Mint the key with `lib/idempotencyKey` — a fresh random value per
 * click defeats the point. `Content-Type` is set last so it cannot be
 * accidentally overridden by a caller.
 */
export function postJSON<T = unknown>(
  endpoint: string,
  body?: unknown,
  useAuth = true,
  headers?: HeadersInit,
) {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("Content-Type", "application/json");
  return requestJSON<T>(endpoint, {
    method: "POST",
    body: serializeJsonBody(body),
    headers: requestHeaders,
    useAuth,
  });
}

export function postJSONEnvelope<T = unknown>(
  endpoint: string,
  body?: unknown,
  useAuth = true,
  headers?: HeadersInit,
): Promise<APIResponse<T>> {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("Content-Type", "application/json");
  return requestJSON<APIResponse<T>>(endpoint, {
    method: "POST",
    body: serializeJsonBody(body),
    headers: requestHeaders,
    useAuth,
    _preserveEnvelope: true,
  });
}

/** See `postJSON` for why `headers` exists. */
export function putJSON<T = unknown>(
  endpoint: string,
  body?: unknown,
  useAuth = true,
  headers?: HeadersInit,
) {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("Content-Type", "application/json");
  return requestJSON<T>(endpoint, {
    method: "PUT",
    body: serializeJsonBody(body),
    headers: requestHeaders,
    useAuth,
  });
}

export function deleteJSON<T = unknown>(endpoint: string, useAuth = true) {
  return requestJSON<T>(endpoint, { method: "DELETE", useAuth });
}

/** Back-compat helper used widely across pages */
export async function fetchAdminAPI<T = unknown>(
  endpoint: string,
  init?: {
    method?: string;
    body?: unknown;
    token?: string;
    headers?: HeadersInit;
  },
): Promise<T> {
  const { method = "GET", body, headers } = init ?? {};
  const prefixedEndpoint = toApiV1Endpoint(endpoint);
  // Note: `token` arg is legacy — client-side requests are authenticated via
  // the httpOnly auth_token cookie handled by /api/proxy. Passing a token here
  // is a no-op for security, kept only for API-shape compatibility.
  const serializedBody = serializeJsonBody(body);
  const requestHeaders = new Headers(headers);
  if (serializedBody !== undefined) {
    requestHeaders.set("Content-Type", "application/json");
  }
  return requestJSON<T>(prefixedEndpoint, {
    method,
    headers:
      Array.from(requestHeaders.keys()).length > 0 ? requestHeaders : undefined,
    body: serializedBody,
    _fallbackErrorMessage: `calling ${method} ${endpoint}`,
  });
}

export { API_ENDPOINTS };
