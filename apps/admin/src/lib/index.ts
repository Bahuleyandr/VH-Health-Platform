// src/lib/index.ts
// Barrel re-exports so new pages can `import { X } from "@/lib"` without
// figuring out which file houses which symbol.

// Data-fetching helpers (api/core.ts via api/index.ts)
export { fetchAdminAPI, getJSON, postJSON, putJSON, deleteJSON, APIError } from './api';

// Auth lifecycle (api-client.ts)
export {
  staffLogin,
  adminLogin,
  adminLogout,
  getAdminProfile,
  isAuthenticated,
  getAdminUser,
  clearAuthData,
  refreshToken,
  authenticatedFetch,
} from './api-client';

// Configuration & endpoints (api-config.ts)
export { API_BASE_URL, API_ENDPOINTS, WS_BASE_URL, buildUrl, getHeaders } from './api-config';

// Low-level fetch (api-fetch.ts) — rarely needed directly
export { apiFetch, apiGet } from './api-fetch';
export type { ApiRequestInit } from './api-fetch';
