// src/middleware/preAuthTenantContextMiddleware.js
//
// Seed the tenant context for the PRE-AUTH surface (/api/v1/auth) from the
// request host, so every database statement in the login, registration and
// OTP handlers runs tenant-scoped under RLS enforcement.
//
// Why this exists (measured 2026-09-03 on a 762-tip database):
//   * 167 FORCE-RLS tables carry a RESTRICTIVE explicit-tenant-context policy
//     (migration 758 and the continuity/interop families), users, staff,
//     doctors and user_devices among them. With app.current_tenant_id unset
//     those tables return ZERO rows to an RLS-subject role and reject every
//     INSERT/UPDATE with 42501, even when tenant_id is named in the statement.
//   * Production connects as vhhealth_runtime (NOSUPERUSER, NOBYPASSRLS, not
//     the owner), so it IS RLS-subject. CI and local .env connect as a
//     superuser, which bypasses RLS even under FORCE, so none of this shows up
//     there.
//   * tenantContextMiddleware deliberately leaves req.tenantId null on public
//     routes (W1), so the global tenantRlsMiddleware seeds an EMPTY context
//     here and the prisma proxy scopes nothing. Every pre-auth users read was
//     therefore blind (a returning patient looked new, staff login found
//     nobody) and every pre-auth users write was rejected.
//
// The handlers already resolve the tenant from the request host
// (resolveTenantForRequest, W4 trust-by-topology: client tenant headers are not
// trusted before authentication). This middleware resolves it the same way and
// runs the rest of the chain inside runInTenantContext, exactly as
// tenantRlsMiddleware does post-auth, so the proxy wraps plain prisma calls in
// setTenant. It never writes req.tenantId (W1 semantics unchanged) and is
// inert while AUTH_ENFORCE_TENANT_RLS is off (the proxy only wraps under
// enforcement). SUPER_ADMIN login keeps working under a tenant context because
// the admins tenant_isolation policy admits rows with tenant_id IS NULL.
//
// Two things a tenant context does NOT cover, on purpose: a bare
// prisma.$transaction (its tx client skips the proxy — creation sites use
// setTenantTx explicitly, pinned by preAuthIdentityCreationTenantScope.test.js)
// and an unknown tenant subdomain, which resolveTenantForRequest rejects with
// TENANT_NOT_RESOLVED before any handler runs.
import { runInTenantContext, getCurrentTenantId } from '../lib/tenantContext.js';
import { resolveTenantForRequest } from '../services/tenant/tenantService.js';

export default async function preAuthTenantContextMiddleware(req, _res, next) {
  // Already scoped (a post-auth mount or a test harness seeded it): keep it.
  if (getCurrentTenantId()) return next();
  let tenantId;
  try {
    tenantId = await resolveTenantForRequest(req);
  } catch (err) {
    return next(err);
  }
  return runInTenantContext(tenantId, () => next());
}
