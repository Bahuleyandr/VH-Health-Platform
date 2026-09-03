// W5 S1 — GET /api/v1/admin/tenant-context returns the caller's OWN tenant
// identity + branding (from tenants.settings.branding), self-scoped to the
// token's tenant_id. A regular ADMIN of tenant A can only ever see tenant A
// (the endpoint takes no tenant param; req.tenantId comes from the token).
import request from 'supertest';
import app from '../app.js';
import { ensureTestIdentity } from './testClient.js';
import prisma from '../lib/prisma.js';
import { generateToken } from '../utils/jwtUtils.js';

const API_KEY = process.env.API_KEY || 'test-api-key';
const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT_A = 'a5a5a5a5-c5c5-4a5a-8a5a-a5a5c5c5aa01';
const TENANT_B = 'b5b5b5b5-c5c5-4b5b-8b5b-b5b5c5c5bb02';
const SFX = String(Date.now() % 100000).padStart(5, '0');

const adminTokenA = () => generateToken({ uid: 'a5a5a5a5-0000-4a5a-8a5a-a5a5a5a5aa01', role: 'ADMIN', tenant_id: TENANT_A, type: 'admin' });
const adminTokenB = () => generateToken({ uid: 'b5b5b5b5-0000-4b5b-8b5b-b5b5b5b5bb02', role: 'ADMIN', tenant_id: TENANT_B, type: 'admin' });

async function seedTenant(id, slug, name, settingsJson) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO tenants (id, slug, name, region, compliance_profile, status, settings, created_at, updated_at)
     VALUES ($1::uuid,$2,$3,'IN','DPDP','active',$4::jsonb,NOW(),NOW())
     ON CONFLICT (id) DO UPDATE SET settings = EXCLUDED.settings, name = EXCLUDED.name`,
    id, slug, name, settingsJson,
  );
  // Admin surface is entitlement-gated barrel-wide (once-over 2026-08-23):
  // give every test tenant a package, mirroring production provisioning.
  await prisma.$executeRawUnsafe(
    `INSERT INTO tenant_entitlements (tenant_id, package_key, status, starts_at, source)
     SELECT id, 'enterprise', 'active', NOW(), 'test_seed' FROM tenants
     ON CONFLICT (tenant_id, package_key) DO NOTHING`,
  );
}

d('W5 S1 — GET /admin/tenant-context', () => {
  // Authentication fails closed when a token's subject has no live identity
  // row, so these subjects must exist before any request or the suite 401s
  // before reaching the behaviour it asserts.
  beforeAll(async () => {
    for (const uid of [
      'a5a5a5a5-0000-4a5a-8a5a-a5a5a5a5aa01',
      'b5b5b5b5-0000-4b5b-8b5b-b5b5b5b5bb02',
    ]) {
      await ensureTestIdentity(uid);
    }
  });
  beforeAll(async () => {
    await seedTenant(TENANT_A, `w5-a-${SFX}`, 'W5 Hospital A',
      JSON.stringify({ branding: { name: 'Brand A', primaryColor: '#aa0011', logoUrl: 'https://a.example/logo.png' } }));
    await seedTenant(TENANT_B, `w5-b-${SFX}`, 'W5 Hospital B',
      JSON.stringify({})); // no branding key → default shape
  }, 30000);

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM tenants WHERE id IN ($1::uuid,$2::uuid)`, TENANT_A, TENANT_B).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  }, 30000);

  it('returns the caller tenant identity + branding for tenant A', async () => {
    const res = await request(app)
      .get('/api/v1/admin/tenant-context')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${adminTokenA()}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id: TENANT_A,
      slug: `w5-a-${SFX}`,
      name: 'W5 Hospital A',
      region: 'IN',
      branding: { name: 'Brand A', primaryColor: '#AA0011', logoUrl: 'https://a.example/logo.png' },
    });
    expect(res.body.data.branding.mobile).toEqual({
      identityMode: 'stamped_build',
      tokenColorSource: 'VH_TENANT_PRIMARY',
    });
  });

  it('is self-scoped — a tenant-B admin gets tenant B, never tenant A', async () => {
    const res = await request(app)
      .get('/api/v1/admin/tenant-context')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${adminTokenB()}`);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(TENANT_B);
    expect(res.body.data.name).toBe('W5 Hospital B');
  });

  it('defaults branding to displayName=name when settings.branding is absent', async () => {
    const res = await request(app)
      .get('/api/v1/admin/tenant-context')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${adminTokenB()}`);
    expect(res.status).toBe(200);
    // No branding key seeded for B → endpoint fills a safe default name.
    expect(res.body.data.branding).toBeDefined();
    expect(res.body.data.branding.name).toBe('W5 Hospital B');
    expect(res.body.data.branding.logoUrl).toBeNull();
    expect(res.body.data.branding.fallbacks).toMatchObject({
      name: true,
      logo: true,
      supportEmail: true,
    });
  });

  it('401s without a token', async () => {
    const res = await request(app)
      .get('/api/v1/admin/tenant-context')
      .set('x-api-key', API_KEY);
    expect(res.status).toBe(401);
  });
});
