// W4 C4: a token minted for tenant X must not be used on tenant Y's subdomain.
// tenantContextMiddleware cross-checks the Host-derived tenant against the bearer's
// resolved tenant and rejects a mismatch (SUPER_ADMIN / override exempt; bare host skip).
import prisma from '../lib/prisma.js';
import tenantContextMiddleware from '../middleware/tenantContextMiddleware.js';

const TENANT_A = 'a4a4a4a4-c4c4-4a4a-8a4a-a4a4c4c4a401';
const TENANT_B = 'b4b4b4b4-c4c4-4b4b-8b4b-b4b4c4c4b402';
const SFX = String(Date.now() % 100000);
const SLUG_A = `w4c4-a-${SFX}`;
const SLUG_B = `w4c4-b-${SFX}`;

// Run the middleware; resolve with { errCode, tenantId } (errCode = the AppError
// code passed to next(), or null when next() was called cleanly).
function run(req) {
  return new Promise((resolve) => {
    req.get = req.get || ((h) => req.headers?.[String(h).toLowerCase()]);
    req.id = 'test-req';
    req.ip = '127.0.0.1';
    tenantContextMiddleware(req, {}, (err) => {
      resolve({ errCode: err ? (err.code || err.message) : null, tenantId: req.tenantId });
    });
  });
}

describe('W4 C4 — Host↔token cross-check', () => {
  beforeAll(async () => {
    for (const [id, slug] of [[TENANT_A, SLUG_A], [TENANT_B, SLUG_B]]) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO tenants (id, slug, name, region, compliance_profile, status, settings, created_at, updated_at)
         VALUES ($1::uuid,$2,$3,'IN','DPDP','active','{}'::jsonb,NOW(),NOW()) ON CONFLICT (id) DO NOTHING`,
        id, slug, `W4 C4 ${slug}`,
      );
    }
  }, 30000);

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM tenants WHERE id IN ($1::uuid,$2::uuid)`, TENANT_A, TENANT_B).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  }, 30000);

  it('tenant-A token on tenant-B subdomain → 403 TENANT_HOST_TOKEN_MISMATCH', async () => {
    const r = await run({ user: { uid: 'u1', tenant_id: TENANT_A, role: 'PATIENT' }, hostname: `${SLUG_B}-api.localhost`, headers: {} });
    expect(r.errCode).toBe('TENANT_HOST_TOKEN_MISMATCH');
  });

  it('tenant-A token on tenant-A subdomain → allowed', async () => {
    const r = await run({ user: { uid: 'u1', tenant_id: TENANT_A, role: 'PATIENT' }, hostname: `${SLUG_A}-api.localhost`, headers: {} });
    expect(r.errCode).toBeNull();
    expect(r.tenantId).toBe(TENANT_A);
  });

  it('tenant-A token on the bare host → allowed (no cross-check)', async () => {
    const r = await run({ user: { uid: 'u1', tenant_id: TENANT_A, role: 'PATIENT' }, hostname: 'localhost', headers: {} });
    expect(r.errCode).toBeNull();
    expect(r.tenantId).toBe(TENANT_A);
  });

  it('SUPER_ADMIN on another tenant subdomain → exempt (allowed)', async () => {
    const r = await run({ user: { uid: 'sa', tenant_id: TENANT_A, role: 'ADMIN', rawRole: 'SUPER_ADMIN' }, hostname: `${SLUG_B}-api.localhost`, headers: {} });
    expect(r.errCode).toBeNull();
  });
});
