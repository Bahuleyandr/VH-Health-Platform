// src/lib/install-api-fetch-guard.ts
'use client';

import { API_BASE_URL, getHeaders } from '@/lib/api-config';

let installed = false;

export function installApiFetchGuard(getToken: () => string | undefined) {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  const originalFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      // Normalize input → string URL
      let url =
        typeof input === 'string'
          ? input
          : input instanceof URL
          ? input.toString()
          : (input as Request).url;

      const isAbsolute = /^https?:\/\//i.test(url);

      // If caller passed absolute URL to OUR API, trim host so we can normalize path
      if (isAbsolute && url.startsWith(API_BASE_URL)) {
        url = url.slice(API_BASE_URL.length) || '/';
      }

      // Identify “admin-ish” paths that sometimes miss the /api/v1 prefix
      const isAdminish =
        url.startsWith('/admin/') ||
        url.startsWith('/staff/') ||
        url.startsWith('/appointments/admin/') ||
        url.startsWith('/notifications/admin/') ||
        url.startsWith('/investigations/admin/') ||
        url.startsWith('/pharmacy/admin/');

      // Add /api/v1 only for admin-ish paths lacking it
      if (isAdminish && !url.startsWith('/api/v1/')) {
        url = '/api/v1' + url;
      }

      // We should route to the backend API only if the path is now /api/v1/...
      const targetIsApi = url.startsWith('/api/v1/');

      // Decide final URL:
      // - For API calls with a relative path → prefix with API_BASE_URL
      // - Otherwise, leave the original input untouched
      const finalUrl = targetIsApi
        ? `${API_BASE_URL}${url}`
        : // Not an API path → use original input verbatim (keeps internal fetches, _next assets, 3rd-party, etc.)
          input;

      // Only inject headers for API calls
      let finalInit = init;
      if (targetIsApi) {
        const token = getToken();
        const defaults = getHeaders(token);

        // Start from caller headers (if any)
        const callerHeaders =
          (init?.headers as Record<string, string> | undefined) ?? {};
        const merged = new Headers(callerHeaders as HeadersInit);

        // Add missing auth headers
        if (!merged.has('x-api-key') && defaults['x-api-key']) {
          merged.set('x-api-key', String(defaults['x-api-key']));
        }
        if (token && !merged.has('authorization')) {
          merged.set('authorization', `Bearer ${token}`);
        }

        // Set Content-Type only when body is clearly JSON-like
        const body = init?.body;
        const isFormData =
          typeof FormData !== 'undefined' && body instanceof FormData;
        const isJsonString = typeof body === 'string';
        if (body && !isFormData && isJsonString && !merged.has('content-type')) {
          merged.set('content-type', 'application/json');
        }

        // Never set Origin manually (browser handles it)
        merged.delete('Origin');

        finalInit = { ...init, headers: merged };
      }

      // Debug to verify rewriting in DevTools
      if (targetIsApi) {
        // eslint-disable-next-line no-console
        console.debug('[fetch-guard]', { in: input, out: finalUrl });
      }

      return originalFetch(finalUrl as RequestInfo, finalInit);
    } catch {
      // If anything goes wrong, fall back to the original fetch untouched
      return originalFetch(input, init);
    }
  };
}
