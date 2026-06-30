// Admin audit-log feed tenant scope (CAN-042).
//
// getAuditLogs (and the unified feed / summary / per-user history) queried
// audit_log with no tenant filter, so an admin saw every tenant's request audit
// trail. The list now always ANDs al.tenant_id, and the unified feed projects
// the real al.tenant_id (was NULL, which bypassed the tenant filter). RLS is OFF
// in the test env, so this explicit predicate is what scopes the feed.
import { generateTestToken, API_KEY } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const TENANT_A = '00000000-0000-4000-8000-000000000001';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const MARKER = 'CAN042_MARKER';

function admin(tenantId) {
  const t = generateTestToken('ADMIN', { uid: 'c0de0042-00d0-4000-8000-00000000d001', tenant_id: tenantId });
  return { get: (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${t}`) };
}

async function clean() {
  await prisma.$executeRawUnsafe(`DELETE FROM audit_log WHERE action = $1`, MARKER).catch(() => {});
}

async function seedAudit(tenantId, userName) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO audit_log (action, path, user_name, success, created_at, tenant_id)
     VALUES ($1, '/CAN042', $2, true, NOW(), $3::uuid)`, MARKER, userName, tenantId);
}

d('Admin audit-log tenant scope (CAN-042)', () => {
  beforeAll(async () => {
    await clean();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, 'can042-tenant-b', 'CAN-042 Tenant B') ON CONFLICT (id) DO NOTHING`,
      TENANT_B);
    await seedAudit(TENANT_A, 'AUDIT_TENANT_A');
    await seedAudit(TENANT_B, 'AUDIT_TENANT_B');
  }, 30000);
  afterAll(async () => { await clean(); await prisma.$disconnect().catch(() => {}); }, 30000);

  it('a tenant-A admin audit feed excludes tenant-B rows', async () => {
    const res = await admin(TENANT_A).get(`/api/v1/admin/audit/logs?search=${MARKER}&limit=50`);
    expect(res.statusCode).toBe(200);
    const names = (res.body.data?.logs || []).map((l) => l.user_name);
    expect(names).toContain('AUDIT_TENANT_A');
    expect(names).not.toContain('AUDIT_TENANT_B');
    expect(res.body.data?.total).toBe(1); // count query is tenant-scoped too
  });
});
