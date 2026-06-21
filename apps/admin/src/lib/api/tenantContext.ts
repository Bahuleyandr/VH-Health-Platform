// W5 S2 — the caller's own tenant identity + branding, for rendering the admin
// portal chrome. Backed by GET /api/v1/admin/tenant-context (W5 S1), self-scoped
// to the bearer's tenant by the backend.
import { getJSON } from './core';

export interface TenantBranding {
  name: string | null;
  logoUrl: string | null;
  primaryColor: string | null;
  supportEmail: string | null;
}

export interface TenantContext {
  id: string;
  slug: string | null;
  name: string;
  region: string;
  branding: TenantBranding;
}

export async function getTenantContext() {
  // requestJSON unwraps the { success, message, data } envelope → TenantContext.
  return getJSON<TenantContext>('/admin/tenant-context');
}
