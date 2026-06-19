// WS7 (W3): per-tenant cron fan-out helper.
//
// Proves runForEachTenant discovers active tenants (+ the default floor), runs the
// job once per tenant INSIDE that tenant's context (so the prisma proxy can
// auto-scope at the enforcement cutover), and fault-isolates one tenant's failure
// from the rest.
import prisma from '../lib/prisma.js';
import { runForEachTenant } from '../utils/tenantFanout.js';
import { getCurrentTenantId } from '../lib/tenantContext.js';

const TENANT_A = 'a7a7a7a7-a7a7-4a7a-8a7a-a7a7a7a7a701';
const TENANT_B = 'b7b7b7b7-b7b7-4b7b-8b7b-b7b7b7b7b702';
const DEFAULT = '00000000-0000-4000-8000-000000000001';

describe('W3 WS7 — cron fan-out', () => {
  beforeAll(async () => {
    const sfx = String(Date.now() % 100000);
    for (const [id, slug] of [[TENANT_A, 'w3-ws7-a'], [TENANT_B, 'w3-ws7-b']]) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO tenants (id, slug, name, region, compliance_profile, status, settings, created_at, updated_at)
         VALUES ($1::uuid,$2,$3,'IN','DPDP','active','{}'::jsonb,NOW(),NOW()) ON CONFLICT (id) DO NOTHING`,
        id, `${slug}-${sfx}`, slug,
      );
    }
  }, 30000);

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM tenants WHERE id IN ($1::uuid,$2::uuid)`, TENANT_A, TENANT_B).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  }, 30000);

  it('runs the job once per active tenant, each inside its tenant context', async () => {
    const seen = [];
    const res = await runForEachTenant('test-job', (tid) => {
      seen.push({ tid, ctx: getCurrentTenantId() });
    });
    // Each run sees its own tenant as the ambient context (runInTenantContext).
    expect(seen.every((s) => s.ctx === s.tid)).toBe(true);
    const tids = seen.map((s) => s.tid);
    expect(tids).toContain(DEFAULT); // default-tenant floor always included
    expect(tids).toContain(TENANT_A);
    expect(tids).toContain(TENANT_B);
    expect(res.tenantsRun).toBe(tids.length);
    expect(res.errors).toBe(0);
  });

  it("isolates one tenant's failure from the others", async () => {
    let ranForB = false;
    const res = await runForEachTenant('test-fail', (tid) => {
      if (tid === TENANT_A) throw new Error('boom for A');
      if (tid === TENANT_B) ranForB = true;
    });
    expect(res.errors).toBeGreaterThanOrEqual(1); // A threw
    expect(ranForB).toBe(true); // B still ran despite A's failure
    expect(res.tenantsRun).toBeGreaterThanOrEqual(2); // default + B
  });
});
