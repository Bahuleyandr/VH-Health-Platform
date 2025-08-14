// src/lib/install-api-fetch-guard.ts
'use client';

import { API_BASE_URL, getHeaders } from '@/lib/api-config';

let installed = false;

/** Extend Window shape (dev helpers) */
declare global {
  interface Window {
    __fetchGuardInstalled?: boolean;
    __fetchGuardApiBase?: string;
    __testFetchGuard?: (path: string) => Promise<Response>;
  }
}

/** Roots that should live under /api/v1/<root> */
const TOP_LEVEL_ROOTS: readonly string[] = [
  '/users',
  '/doctors',
  '/departments',
  '/appointments',
  '/notifications',
  '/records',
  '/investigations',
  '/pharmacy-orders',
  '/health',
  '/auth',
  '/sos',
  '/devices',
  '/feedback',
  '/analytics',
  '/rbac',
  '/logs',
];

/** legacy/admin-ish paths that sometimes arrive without /api/v1 */
const ADMINISH: readonly string[] = [
  '/admin/',
  '/staff/',
  '/appointments/admin/',
  '/notifications/admin/',
  '/investigations/admin/',
  '/pharmacy/admin/',
];

function withDefaults(u: URL, defaults: Record<string, string>) {
  for (const [k, v] of Object.entries(defaults)) {
    if (!u.searchParams.has(k)) u.searchParams.set(k, v);
  }
}

/** normalize historical/legacy paths to the backend’s current routes (and queries) */
function applyAliasesWithQuery(path: string): string {
  const u = new URL(path, API_BASE_URL);
  const { pathname } = u;

  // ---- USERS ----
  if (pathname.startsWith('/admin/users') || pathname === '/users') {
    u.pathname = '/users';
    withDefaults(u, { page: '1', limit: '20' });
    return u.pathname + u.search;
  }

  // ---- DOCTORS ----
  if (pathname === '/doctors') {
    withDefaults(u, { page: '1', limit: '20' });
    return u.pathname + u.search;
  }

  // ---- APPOINTMENTS ----
  if (pathname.startsWith('/appointments/manage') || pathname === '/appointments') {
    u.pathname = '/appointments/list';
    withDefaults(u, { page: '1', limit: '20' });
    return u.pathname + u.search;
  }

  // ---- PHARMACY ----
  if (pathname.startsWith('/pharmacy/orders')) {
    u.pathname = '/pharmacy-orders';
    withDefaults(u, { page: '1', limit: '10' });
    return u.pathname + u.search;
  }
  if (pathname.startsWith('/pharmacy/analytics')) {
    u.pathname = '/admin/stats/quick';
    return u.pathname + u.search;
  }

  // ---- ANALYTICS (legacy) ----
  if (pathname.startsWith('/analytics/revenue')) {
    u.pathname = '/admin/stats/quick';
    return u.pathname + u.search;
  }

  // ---- NOTIFICATIONS (root list doesn’t exist) ----
  if (pathname === '/notifications') {
    u.pathname = '/notifications/stats/summary';
    return u.pathname + u.search;
  }

  // ---- LOGS (frontend placeholders) ----
  if (pathname.startsWith('/logs/audit')) {
    u.pathname = '/rbac/admin/audit-log';
    withDefaults(u, { page: '1', limit: '20' });
    return u.pathname + u.search;
  }
  if (pathname.startsWith('/logs/system')) {
    const page = Number(u.searchParams.get('page') || '1');
    const limit = Number(u.searchParams.get('limit') || '20');
    const offset = Math.max(0, (page - 1) * limit);
    u.pathname = '/admin/activity/recent';
    u.searchParams.set('limit', String(limit));
    u.searchParams.set('offset', String(offset));
    u.searchParams.delete('page');
    return u.pathname + u.search;
  }

  // ---- SYSTEM SETTINGS (no direct endpoint) ----
  if (pathname.startsWith('/system/settings')) {
    u.pathname = '/system/status';
    return u.pathname + u.search;
  }

  // ---- AUTH ADMIN MANAGEMENT (placeholder) ----
  if (pathname.startsWith('/auth/adminManagement')) {
    u.pathname = '/rbac/rbacRoutes';
    return u.pathname + u.search;
  }

  return path;
}

function needsApiV1Prefix(p: string): boolean {
  if (p.startsWith('/api/v1/')) return false;
  if (ADMINISH.some((a) => p.startsWith(a))) return true;
  if (TOP_LEVEL_ROOTS.some((root) => p === root || p.startsWith(root + '/') || p.startsWith(root + '?'))) {
    return true;
  }
  return false;
}

function isAbsoluteUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

function isRequest(input: RequestInfo | URL): input is Request {
  // In browsers Request is defined; guard for SSR safety
  return typeof Request !== 'undefined' && input instanceof Request;
}

export function installApiFetchGuard(getToken: () => string | undefined) {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  // Dev helpers
  window.__fetchGuardInstalled = true;
  window.__fetchGuardApiBase = API_BASE_URL;
  window.__testFetchGuard = (path: string) => fetch(path, { method: 'GET' });

  if (process.env.NODE_ENV === 'development') {
    // eslint-disable-next-line no-console
    console.info('[fetch-guard] installed', { API_BASE_URL });
  }

  const originalFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      // Normalize input -> raw string
      let raw: string;
      if (typeof input === 'string') raw = input;
      else if (input instanceof URL) raw = input.toString();
      else if (isRequest(input)) raw = input.url;
      else raw = String(input as unknown as string);

      // If absolute and points to our API host, strip host to work with path
      if (isAbsoluteUrl(raw) && raw.startsWith(API_BASE_URL)) {
        raw = raw.slice(API_BASE_URL.length) || '/';
      }

      const isRelativeOrSameHost = !isAbsoluteUrl(raw) || raw.startsWith('/');
      let path = isRelativeOrSameHost ? raw : '';

      // Apply aliases/defaults
      if (path) path = applyAliasesWithQuery(path);

      // Add /api/v1 if clearly an API call that’s missing it
      if (path && needsApiV1Prefix(path)) path = '/api/v1' + path;

      const targetIsApi = path.startsWith('/api/v1/');
      const finalUrl: string | RequestInfo = targetIsApi ? `${API_BASE_URL}${path}` : input;

      let finalInit = init;

      if (targetIsApi) {
        const token = getToken();

        // Defaults & merge
        const defaults = new Headers(getHeaders(token));
        const merged = new Headers(init?.headers ?? undefined);

        const defaultApiKey = defaults.get('x-api-key');
        if (defaultApiKey && !merged.has('x-api-key')) {
          merged.set('x-api-key', defaultApiKey);
        }
        if (token && !merged.has('authorization')) {
          merged.set('authorization', `Bearer ${token}`);
        }

        // Content-Type only for JSON string bodies (avoid FormData)
        const body = init?.body;
        const isForm =
          typeof FormData !== 'undefined' && body instanceof FormData;
        if (body && !isForm && typeof body === 'string' && !merged.has('content-type')) {
          merged.set('content-type', 'application/json');
        }

        // Never send Origin manually
        merged.delete('origin');

        finalInit = { ...init, headers: merged };

        if (process.env.NODE_ENV === 'development') {
          // eslint-disable-next-line no-console
          console.debug('[fetch-guard]', { in: input, out: finalUrl });
        }
      } else if (process.env.NODE_ENV === 'development') {
        // eslint-disable-next-line no-console
        console.debug('[fetch-guard passthrough]', { in: input });
      }

      return originalFetch(finalUrl as RequestInfo, finalInit);
    } catch {
      return originalFetch(input, init);
    }
  };
}
