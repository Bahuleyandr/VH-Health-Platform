// src/lib/tenantContext.js
//
// AsyncLocalStorage-backed tenant context for the Phase-2 RLS rollout
// (docs/GAP_ANALYSIS_TENANT_RLS.md).
//
// Express middleware seeds the context once per request from req.tenantId.
// Downstream code (services, controllers, scheduled jobs) reads
// `getCurrentTenantId()` without needing the tenantId threaded through
// every function signature.
//
// The prisma wrapper at src/lib/prisma.js consults this store to decide
// whether to auto-wrap a query in setTenant(tenantId, ...). When the
// store is empty (cron jobs without explicit context, tests, bootstrap)
// the wrapper passes through unchanged — preserving every legacy call
// path's behaviour.
//
// To explicitly run code under a specific tenant (e.g. per-tenant cron
// loops), use `runInTenantContext(tenantId, fn)`. To bypass tenant
// scoping (cross-tenant admin reads, analytics, scheduled aggregators)
// use `runWithSuperAdmin(fn)`.

import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

/**
 * Run a callback with a tenant context active. Code inside `fn` (and any
 * async work it spawns) sees the tenantId via getCurrentTenantId().
 *
 * @param {string|null} tenantId UUID. May be null when superAdmin=true.
 * @param {() => Promise<T>|T} fn
 * @param {Object} [options]
 * @param {boolean} [options.superAdmin=false] cross-tenant bypass
 * @param {boolean} [options.inSetTenant=false] internal marker used by
 *   prisma.setTenant to break the auto-wrap recursion (the wrapper at
 *   prisma.js:maybeRunUnderTenant skips re-wrapping when this is true).
 * @returns {Promise<T>|T}
 */
export function runInTenantContext(tenantId, fn, { superAdmin = false, inSetTenant = false } = {}) {
  return storage.run({ tenantId: tenantId || null, superAdmin, inSetTenant }, fn);
}

/** Convenience wrapper for runInTenantContext(null, fn, { superAdmin: true }). */
export function runWithSuperAdmin(fn) {
  return storage.run({ tenantId: null, superAdmin: true }, fn);
}

/**
 * Return the current request's tenantId, or null when no context is set
 * (legacy / cron / bootstrap paths).
 */
export function getCurrentTenantId() {
  return storage.getStore()?.tenantId ?? null;
}

/**
 * Return true when the active context is a SUPER_ADMIN bypass. The prisma
 * wrapper uses this to call setTenant(null, fn, { superAdmin: true })
 * instead of setTenant(tenantId, fn).
 */
export function isSuperAdminContext() {
  return Boolean(storage.getStore()?.superAdmin);
}

/**
 * Return the full active context, or null. Internal helper for the prisma
 * wrapper — exported for tests.
 */
export function getCurrentTenantContext() {
  return storage.getStore() ?? null;
}

export const __testing__ = { storage };
