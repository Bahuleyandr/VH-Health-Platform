// src/middleware/tenantRlsMiddleware.js
//
// Phase-2 RLS activation: wrap the downstream request chain in an
// AsyncLocalStorage tenant context. The prisma wrapper at src/lib/prisma.js
// reads that context to auto-apply setTenant() to every raw-SQL call when
// AUTH_ENFORCE_TENANT_RLS=true. With the flag off, the context is still
// seeded — it just isn't acted on, so legacy behaviour is unchanged.
//
// Mounts AFTER tenantContextMiddleware (which sets req.tenantId).
//
// SUPER_ADMIN with the `x-tenant-id` header gets a bypass context
// (cross-tenant operator debug). All other requests scope to
// req.tenantId. If req.tenantId is unset (cron, health probes, public
// endpoints), we run the chain in the empty context — the prisma
// auto-wrapper short-circuits and passes through.
//
// Scheduled jobs (cron) and bootstrap code don't pass through Express
// middleware — they explicitly wrap their work in runInTenantContext()
// or runWithSuperAdmin() from src/lib/tenantContext.js.

import { runInTenantContext } from '../lib/tenantContext.js';

function isSuperAdminHeaderBypass(req) {
  if (String(req.user?.role || '').toUpperCase() !== 'SUPER_ADMIN') return false;
  return Boolean(req.get('x-tenant-id'));
}

export default function tenantRlsMiddleware(req, _res, next) {
  const tenantId = req.tenantId || null;
  const superAdmin = isSuperAdminHeaderBypass(req);
  // Run the rest of the middleware chain inside the tenant context.
  // Express's next() is synchronous — but AsyncLocalStorage propagates
  // through the resulting async work because the storage.run callback's
  // synchronous part still establishes the context for any promises
  // that subsequent middleware schedules.
  runInTenantContext(tenantId, () => next(), { superAdmin });
}
