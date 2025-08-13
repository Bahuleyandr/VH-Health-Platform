// src/lib/install-api-fetch-guard.ts
'use client';

import { API_BASE_URL, getHeaders } from '@/lib/api-config';

let installed = false;

/** roots that should live under /api/v1/<root> */
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

/** normalize some historical/legacy paths to the backend’s current routes */
function applyAliases(p: string): string {
  if (p.startsWith('/pharmacy/orders')) {
    return p.replace(/^\/pharmacy\/orders/, '/pharmacy-orders');
  }
  if (p.startsWith('/pharmacy/analytics')) {
    return p.replace(/^\/pharmacy\/analytics/, '/analytics/revenue');
  }
  // Example: uncomment if needed
  // if (p.startsWith('/appointments/manage')) return p.replace('/appointments/manage', '/appointments');
  return p;
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

      if (path) path = applyAliases(path);
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

        // Debug so you can see rewrites
        // eslint-disable-next-line no-console
        console.debug('[fetch-guard]', { in: input, out: finalUrl });
      }

      return originalFetch(finalUrl as RequestInfo, finalInit);
    } catch {
      return originalFetch(input, init);
    }
  };
}
