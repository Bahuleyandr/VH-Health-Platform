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
  '/pharmacy',
  '/pharmacy-orders',
  '/health',
  '/health-check',
  '/auth',
  '/sos',
  '/devices',
  '/feedback',
  '/analytics',
  '/rbac',
  '/logs',
  '/admin',  // Add admin root
  '/staff',  // Add staff root
  '/settings',
  '/system',
  '/consultations',
  '/health-records',
  '/categories',
  '/verify',
  '/debug',
];

/** Admin and staff paths that sometimes arrive without /api/v1 */
const ADMINISH: readonly string[] = [
  '/admin/',
  '/admin/stats/',
  '/admin/attendance/',
  '/admin/sos/',
  '/admin/uploads/',
  '/admin/health/',
  '/admin/alerts/',
  '/admin/activity/',
  '/admin/reports/',
  '/admin/dashboard',
  '/admin/users/',
  '/admin/appointments/',
  '/admin/departments/',
  '/admin/doctors/',
  '/admin/notifications/',
  '/admin/records/',
  '/admin/investigations/',
  '/admin/pharmacy/',
  '/admin/analytics/',
  '/staff/',
  '/staff/admin/',
  '/staff/attendance/',
  '/staff/hr/',
  '/staff/medical/',
  '/appointments/admin/',
  '/notifications/admin/',
  '/investigations/admin/',
  '/pharmacy/admin/',
  '/records/admin/',
  '/rbac/admin/',
];

function getApiBaseForParsing(): string {
  if (typeof window !== 'undefined' && API_BASE_URL.startsWith('/')) {
    return `${window.location.origin}${API_BASE_URL}`;
  }
  return API_BASE_URL;
}

function needsApiV1Prefix(p: string): boolean {
  // Already has /api/v1/
  if (p.startsWith('/api/v1/')) return false;
  
  // Check if it's an admin/staff path
  if (ADMINISH.some((a) => p.startsWith(a))) return true;
  
  // Check if it matches a top-level root
  if (TOP_LEVEL_ROOTS.some((root) => 
    p === root || 
    p.startsWith(root + '/') || 
    p.startsWith(root + '?')
  )) {
    return true;
  }
  
  // Special cases for paths without leading slash (shouldn't happen but defensive)
  const withSlash = '/' + p;
  if (TOP_LEVEL_ROOTS.some((root) => 
    withSlash === root || 
    withSlash.startsWith(root + '/') || 
    withSlash.startsWith(root + '?')
  )) {
    return true;
  }
  
  return false;
}

function isAbsoluteUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

function isRequest(input: RequestInfo | URL): input is Request {
  return typeof Request !== 'undefined' && input instanceof Request;
}

/**
 * Install the fetch guard.
 *
 * Auth is carried via the httpOnly auth_token cookie handled server-side by
 * /api/proxy — no client-side token injection.
 */
export function installApiFetchGuard() {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  // Dev helpers — only attach to window in development so an XSS in production
  // cannot access a ready-made authenticated-fetch primitive (ADM-1).
  if (process.env.NODE_ENV === 'development') {
    window.__fetchGuardInstalled = true;
    window.__fetchGuardApiBase = API_BASE_URL;
    window.__testFetchGuard = (path: string) => fetch(path, { method: 'GET' });
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

      const apiBaseForParsing = getApiBaseForParsing();

      // Skip non-API requests (e.g., external URLs, assets)
      if (isAbsoluteUrl(raw) && !raw.startsWith(apiBaseForParsing)) {
        // Not our API, pass through unchanged
        return originalFetch(input, init);
      }

      // If absolute and points to our API host, strip host to work with path
      if (isAbsoluteUrl(raw) && raw.startsWith(apiBaseForParsing)) {
        raw = raw.slice(apiBaseForParsing.length) || '/';
      }

      const isRelativeOrSameHost = !isAbsoluteUrl(raw) || raw.startsWith('/');
      let path = isRelativeOrSameHost ? raw : '';

      // Skip processing for non-API paths (e.g., Next.js internals, static assets)
      if (path && !path.startsWith('/api/') && !needsApiV1Prefix(path)) {
        // Check if it's a static asset or Next.js internal
        if (path.startsWith('/_next/') || 
            path.startsWith('/static/') || 
            path.match(/\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot)$/)) {
          return originalFetch(input, init);
        }
      }

      // Add /api/v1 if clearly an API call that's missing it
      if (path && needsApiV1Prefix(path)) {
        path = '/api/v1' + path;
      }

      const targetIsApi = path.startsWith('/api/v1/');
      const finalUrl: RequestInfo | URL = targetIsApi ? `${API_BASE_URL}${path}` : input;

      let finalInit = init;

      if (targetIsApi) {
        // Auth is carried via the httpOnly auth_token cookie; the proxy
        // injects Authorization + x-api-key server-side. No client injection.
        const defaults = new Headers(getHeaders());
        const merged = new Headers(init?.headers ?? undefined);

        // Add default headers if not present
        const defaultApiKey = defaults.get('x-api-key');
        if (defaultApiKey && !merged.has('x-api-key')) {
          merged.set('x-api-key', defaultApiKey);
        }

        // Content-Type only for JSON string bodies (avoid FormData)
        const body = init?.body;
        const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
        const isBlob = typeof Blob !== 'undefined' && body instanceof Blob;
        const isArrayBuffer = body instanceof ArrayBuffer;
        const isURLSearchParams = typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams;
        
        if (body && !isForm && !isBlob && !isArrayBuffer && !isURLSearchParams && 
            typeof body === 'string' && !merged.has('content-type')) {
          merged.set('content-type', 'application/json');
        }

        // Add Accept header if not present
        if (!merged.has('accept')) {
          merged.set('accept', 'application/json');
        }

        // Never send Origin manually (browser handles this)
        merged.delete('origin');

        finalInit = { ...init, headers: merged };

        if (process.env.NODE_ENV === 'development') {
          console.debug('[fetch-guard] API request', {
            input: typeof input === 'string' ? input : input instanceof URL ? input.href : 'Request',
            path,
            finalUrl: typeof finalUrl === 'string' ? finalUrl : 'URL',
          });
        }
      } else if (process.env.NODE_ENV === 'development' && path) {
        console.debug('[fetch-guard] Passthrough', { input: raw });
      }

      return originalFetch(finalUrl, finalInit);
    } catch (error) {
      console.error('[fetch-guard] Error processing request:', error);
      return originalFetch(input, init);
    }
  };
}
