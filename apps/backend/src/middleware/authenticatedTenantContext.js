// src/middleware/authenticatedTenantContext.js
//
// CAN-004: a few routers are mounted BEFORE the app-level tenant middleware
// chain (tenantContextMiddleware → tenantRlsMiddleware) because they must be
// reachable with just an API key + their own auth gate (infrastructure RBAC,
// diagnostics). Those routers therefore ran their queries with NO tenant
// context: req.tenantId was unset and the RLS AsyncLocalStorage was never
// seeded, so reads/exports could span tenants once multi-tenant is live.
//
// This composes the same two middlewares, but ONLY once the request is
// authenticated (req.user populated by the router's own gate). Unauthenticated
// public routes (no req.user) pass straight through unchanged. A SUPER_ADMIN can
// still take an audited cross-tenant view via the x-tenant-id override that
// tenantContextMiddleware implements (it is resolved into a tenant-scoped
// context, not an RLS bypass).

import tenantContextMiddleware from './tenantContextMiddleware.js';
import tenantRlsMiddleware from './tenantRlsMiddleware.js';

export default function authenticatedTenantContext(req, res, next) {
  // No authenticated subject → nothing to scope to. Public/pre-auth routes
  // keep their existing behaviour (any tenant-scoped access downstream is still
  // gated by resolveTenantOrThrow / RLS).
  if (!req.user) return next();
  return tenantContextMiddleware(req, res, (err) => {
    if (err) return next(err);
    // Seeds the AsyncLocalStorage so the prisma auto-wrapper applies setTenant()
    // to this request's queries (when AUTH_ENFORCE_TENANT_RLS=true).
    return tenantRlsMiddleware(req, res, next);
  });
}
