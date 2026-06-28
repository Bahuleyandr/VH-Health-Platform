// Infrastructure RBAC routes tenant context (CAN-004).
//
// The infrastructure router (/api/v1/rbac/*) mounts BEFORE the app-level tenant
// middleware, so its user/analytics/audit/export reads previously ran with no
// tenant context — req.tenantId unset, RLS AsyncLocalStorage unseeded — and
// could span tenants once multi-tenant is live. authenticatedTenantContext now
// resolves the tenant + seeds RLS for an authenticated request and skips public
// ones. The infra HTTP routes are production-JWT-gated, so this exercises the
// middleware directly (the level at which the fix lives).
import authenticatedTenantContext from '../middleware/authenticatedTenantContext.js';
import { getCurrentTenantId } from '../lib/tenantContext.js';
import prisma from '../lib/prisma.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const TENANT_ID = '00000000-0000-4000-8000-000000000001';

function run(req) {
  return new Promise((resolve) => {
    let seenTenant = 'unset';
    authenticatedTenantContext(req, { get: () => undefined }, () => {
      seenTenant = getCurrentTenantId();
      resolve(seenTenant);
    });
  });
}

d('Infrastructure RBAC tenant context (CAN-004)', () => {
  afterAll(async () => { await prisma.$disconnect().catch(() => {}); });

  it('resolves the tenant + seeds RLS for an authenticated admin request', async () => {
    const req = {
      user: { uid: 'c0de0004-00d0-4000-8000-00000000d001', role: 'ADMIN', tenant_id: TENANT_ID },
      get: () => undefined,
    };
    const seenTenant = await run(req);
    // req.tenantId resolved AND the query context is scoped to that tenant.
    expect(req.tenantId).toBe(TENANT_ID);
    expect(seenTenant).toBe(TENANT_ID);
  });

  it('passes an unauthenticated request through with no tenant context', async () => {
    const req = { get: () => undefined };
    const seenTenant = await run(req);
    expect(req.tenantId).toBeUndefined();
    expect(seenTenant).toBeNull(); // no AsyncLocalStorage tenant seeded
  });
});
