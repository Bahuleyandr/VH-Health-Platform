// Typed read path for per-tenant configuration stored in `tenants.settings`
// (jsonb). Reuses the 60s in-memory tenant cache in tenantService — callers do
// NOT hit the DB on every read. All accessors are defensive: a missing tenant,
// null settings, or a DB error yields the empty default, never a throw, so a
// per-tenant override is always a pure enhancement over the hardcoded baseline.
//
// `tenants.settings` shape (every key optional):
//   {
//     rateLimits?: { <profile>: { windowMs?: number, max?: number } },
//     branding?:   { name?, logoUrl?, primaryColor?, supportEmail? },
//     cache?:      { enabledRoutes?: string[] },
//   }
import { getTenantById } from './tenantService.js';

export async function getTenantSettings(tenantId) {
  if (!tenantId) return {};
  const tenant = await getTenantById(tenantId).catch(() => null);
  const settings = tenant?.settings;
  return settings && typeof settings === 'object' ? settings : {};
}

export async function getRateLimitOverride(tenantId, profile) {
  const settings = await getTenantSettings(tenantId);
  const override = settings.rateLimits?.[profile];
  return override && typeof override === 'object' ? override : null;
}

export async function getBranding(tenantId) {
  const settings = await getTenantSettings(tenantId);
  return settings.branding && typeof settings.branding === 'object' ? settings.branding : {};
}
