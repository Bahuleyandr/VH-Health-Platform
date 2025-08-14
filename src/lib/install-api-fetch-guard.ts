// src/lib/install-api-fetch-guard.ts
'use client';

import { API_BASE_URL, getHeaders } from '@/lib/api-config';

let installed = false;

/** Roots that should live under /api/v1/<root> */
const TOP_LEVEL_ROOTS = [
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
const ADMINISH = [
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

/** normalize historical/legacy paths to the backend's current routes (and queries) */
function applyAliasesWithQuery(path: string): string {
  // Support both raw and /api/v1-prefixed inputs
  const hasApiPrefix = path.startsWith('/api/v1/');
  const inner = hasApiPrefix ? path.slice('/api/v1'.length) : path; // keep leading '/'

  const u = new URL(inner, API_BASE_URL);
  const { pathname } = u;

  // ---- USERS ----
  // Keep /admin/users under the admin namespace
  if (pathname.startsWith('/admin/users')) {
    u.pathname = '/admin/users';
    withDefaults(u, { page: '1', limit: '20' });
    return u.pathname + u.search;
  }

  // Non-admin users list can pass through (still add defaults)
  if (pathname === '/users' || pathname.startsWith('/users?')) {
    withDefaults(u, { page: '1', limit: '20' });
    return u.pathname + u.search;
  }

  // ---- DOCTORS ----
  if (pathname === '/doctors') {
    withDefaults(u, { page: '1', limit: '20' });
    return (hasApiPrefix ? '/api/v1' : '') + u.pathname + u.search;
  }

  // ---- APPOINTMENTS ----
  if (pathname.startsWith('/appointments/manage')) {
    u.pathname = '/appointments'; // canonical
    withDefaults(u, { page: '1', limit: '20' });
    return (hasApiPrefix ? '/api/v1' : '') + u.pathname + u.search;
  }
  if (pathname === '/appointments') {
    withDefaults(u, { page: '1', limit: '20' });
    return (hasApiPrefix ? '/api/v1' : '') + u.pathname + u.search;
  }

  // ---- PHARMACY ----
  if (pathname.startsWith('/pharmacy/orders')) {
    u.pathname = '/pharmacy-orders';
    withDefaults(u, { page: '1', limit: '10' });
    return (hasApiPrefix ? '/api/v1' : '') + u.pathname + u.search;
  }

  if (pathname.startsWith('/pharmacy/analytics') || pathname.startsWith('/analytics/revenue')) {
    u.pathname = '/admin/stats/quick';
    return (hasApiPrefix ? '/api/v1' : '') + u.pathname + u.search;
  }

  // ---- NOTIFICATIONS (root list doesn't exist) ----
  if (pathname === '/notifications') {
    u.pathname = '/notifications/stats/summary';
    return (hasApiPrefix ? '/api/v1' : '') + u.pathname + u.search;
  }

  // ---- LOGS (frontend placeholders) ----
  if (pathname.startsWith('/logs/audit')) {
    u.pathname = '/rbac/admin/audit-log';
    withDefaults(u, { page: '1', limit: '20' });
    return (hasApiPrefix ? '/api/v1' : '') + u.pathname + u.search;
  }
  if (pathname.startsWith('/logs/system')) {
    const page = Number(u.searchParams.get('page') || '1');
    const limit = Number(u.searchParams.get('limit') || '20');
    const offset = Math.max(0, (page - 1) * limit);
    u.pathname = '/admin/activity/recent';
    u.searchParams.set('limit', String(limit));
    u.searchParams.set('offset', String(offset));
    u.searchParams.delete('page');
    return (hasApiPrefix ? '/api/v1' : '') + u.pathname + u.search;
  }

  // ---- SYSTEM SETTINGS ----
  if (pathname.startsWith('/system/settings')) {
    u.pathname = '/system/status';
    return (hasApiPrefix ? '/api/v1' : '') + u.pathname + u.search;
  }

  // ---- AUTH ADMIN MANAGEMENT (placeholder) ----
  if (pathname.startsWith('/auth/adminManagement')) {
    u.pathname = '/rbac/rbacRoutes';
    return (hasApiPrefix ? '/api/v1' : '') + u.pathname + u.search;
  }

  return path; // unchanged
}

function needsApiV1Prefix(p: string): boolean {
  if (p.startsWith('/api/v1/')) return false;
  if (ADMINISH.some((a) => p.startsWith(a))) return true;
  if (TOP_LEVEL_ROOTS.some((root) => p === root || p.startsWith(root + '/') || p.startsWith(root + '?'))) {
    return true;
  }
  return false;
}

export function installApiFetchGuard(getToken: () => string | undefined) {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  // dev signal + helpers
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  w.__fetchGuardInstalled = true;
  w.__fetchGuardApiBase = API_BASE_URL;
  w.__testFetchGuard = (path: string) => fetch(path, { method: 'GET' });
  console.info('[fetch-guard] installed', { API_BASE_URL });

  const originalFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      // Normalize URL to string
      let raw =
        typeof input === 'string'
          ? input
          : input instanceof URL
          ? input.toString()
          : (input as Request).url;

      const isAbsolute = /^https?:\/\//i.test(raw);

      // If absolute and points to our API host, drop host to work on path
      if (isAbsolute && raw.startsWith(API_BASE_URL)) {
        raw = raw.slice(API_BASE_URL.length) || '/';
      }

      const isSameHostOrRelative = !isAbsolute || raw.startsWith('/');
      let path = isSameHostOrRelative ? raw : '';

      // Apply aliases and fill defaults (works whether or not /api/v1 is already present)
      if (path) path = applyAliasesWithQuery(path);

      // Add /api/v1 prefix where it's clearly an API call that's missing it
      if (path && needsApiV1Prefix(path)) path = '/api/v1' + path;

      const targetIsApi = path.startsWith('/api/v1/');
      const finalUrl = targetIsApi ? `${API_BASE_URL}${path}` : input;

      let finalInit = init;
      if (targetIsApi) {
        const token = getToken();

        // Convert defaults to a real Headers so we can safely read values
        const defaults = new Headers(getHeaders(token));

        // Start from caller headers (if any) and merge
        const merged = new Headers((init?.headers as HeadersInit | undefined) ?? {});

        const defaultApiKey = defaults.get('x-api-key');
        if (defaultApiKey && !merged.has('x-api-key')) {
          merged.set('x-api-key', defaultApiKey);
        }
        if (token && !merged.has('authorization')) {
          merged.set('authorization', `Bearer ${token}`);
        }

        // Only set JSON content-type when body is a string (not FormData)
        const body = init?.body;
        const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
        if (body && !isForm && typeof body === 'string' && !merged.has('content-type')) {
          merged.set('content-type', 'application/json');
        }

        // Never set or keep Origin manually
        merged.delete('origin');

        finalInit = { ...init, headers: merged };

        // Single visible log for API rewrites
        // eslint-disable-next-line no-console
        if (process.env.NODE_ENV === 'development') {
          console.info('[fetch-guard]', { in: input, out: finalUrl });
        }
      }

      return originalFetch(finalUrl as RequestInfo, finalInit);
    } catch {
      return originalFetch(input, init);
    }
  };
}