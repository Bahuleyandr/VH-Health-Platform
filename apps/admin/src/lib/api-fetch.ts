// src/lib/api-fetch.ts
import { API_BASE_URL } from "./api-config";

export type ApiRequestInit = RequestInit & {
  /** If provided, adds `Authorization: Bearer <token>` */
  token?: string;
  /** Treat `endpoint` as absolute URL even if it doesn't look like one */
  absolute?: boolean;
};

// API key is injected server-side in the /api/proxy route via process.env.API_KEY.
// Client-side code must NOT use NEXT_PUBLIC_API_KEY (would inline the key in the browser bundle).

function isAbsoluteUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function toAbsoluteUrl(endpoint: string, absolute?: boolean): string {
  if (absolute || isAbsoluteUrl(endpoint)) return endpoint;
  const base = API_BASE_URL.replace(/\/+$/, "");
  const path = endpoint.replace(/^\/+/, "");
  return `${base}/${path}`;
}

/**
 * Merge arbitrary HeadersInit values into a real Headers instance.
 * No `any` casts; supports Headers, array tuples, or plain objects.
 */
function mergeHeaders(...parts: HeadersInit[]): Headers {
  const out = new Headers();

  for (const part of parts) {
    if (!part) continue;

    if (part instanceof Headers) {
      part.forEach((value, key) => out.set(key, value));
      continue;
    }

    if (Array.isArray(part)) {
      // Array<[string, string]>
      for (const [key, value] of part) {
        out.set(key, value);
      }
      continue;
    }

    // Plain object
    const entries = Object.entries(part as Record<string, string>);
    for (const [key, value] of entries) {
      if (typeof value !== "undefined") out.set(key, String(value));
    }
  }

  return out;
}

/**
 * Core fetch used by the app. Adds Origin/x-api-key/Authorization automatically.
 */
export async function apiFetch(
  endpoint: string,
  init: ApiRequestInit = {},
): Promise<Response> {
  const { token, absolute, headers, ...rest } = init;

  // Build absolute URL
  const url = toAbsoluteUrl(endpoint, absolute);

  // Compose headers without `any`
  const composed = mergeHeaders(headers ?? {});

  // Add Origin (best-effort: only in browser)
  if (typeof window !== "undefined" && !composed.has("Origin")) {
    composed.set("Origin", window.location.origin);
  }

  // NOTE: x-api-key is NOT set here. All API calls go through /api/proxy which
  // injects the key server-side. Setting it client-side would expose it in the bundle.

  // Add Authorization if token provided and not already present
  if (token && !composed.has("Authorization")) {
    composed.set("Authorization", `Bearer ${token}`);
  }

  // Default Accept header for JSON APIs (don’t clobber if caller set one)
  if (!composed.has("Accept")) {
    composed.set("Accept", "application/json");
  }

  return fetch(url, {
    ...rest,
    headers: composed,
  });
}

/** Convenience GET that still returns the raw Response (callers decide how to parse) */
export function apiGet(
  endpoint: string,
  token?: string,
  init?: RequestInit,
): Promise<Response> {
  return apiFetch(endpoint, { ...(init ?? {}), method: "GET", token });
}
