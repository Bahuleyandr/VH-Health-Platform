// Analytics dashboard tenant scope (CAN-015).
//
// The analytics dashboard/trends/usage/etc. aggregates queried users,
// appointments, health_records, investigations, pharmacy_orders, feedback,
// sos_alerts with no tenant filter, so an admin's "hospital totals" blended in
// other tenants' rows. Every aggregate now ANDs tenant_id. RLS is OFF in the
// test env, so this differential test proves the predicate on the user count:
// users seeded in tenant B do not change a tenant-A dashboard total.
import { generateTestToken, API_KEY } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const TENANT_A = '00000000-0000-4000-8000-000000000001';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const MARKER = 'CAN015';

function admin(tenantId) {
  const t = generateTestToken('ADMIN', { uid: 'c0de0015-00d0-4000-8000-00000000d001', tenant_id: tenantId });
  return { get: (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${t}`) };
}

async function clean() {
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE name = $1`, MARKER).catch(() => {});
}

async function seedUser(tenantId, phone) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, registered_at, updated_at)
     VALUES (gen_random_uuid(), $1::uuid, $2, $3, 'PATIENT', true, NOW(), NOW())`, tenantId, phone, MARKER);
}

const totalUsers = (body) => Number(body.data?.userAnalytics?.total_users ?? 0);

d('Analytics dashboard tenant scope (CAN-015)', () => {
  beforeAll(async () => {
    await clean();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, 'can015-analytics-tenant-b', 'CAN-015 Analytics Tenant B') ON CONFLICT (id) DO NOTHING`,
      TENANT_B);
  }, 30000);
  afterAll(async () => { await clean(); await prisma.$disconnect().catch(() => {}); }, 30000);

  it('users seeded in tenant B do not change a tenant-A dashboard total', async () => {
    const before = totalUsers((await admin(TENANT_A).get('/api/v1/admin/analytics/dashboard')).body);
    await seedUser(TENANT_B, '+919000015701');
    await seedUser(TENANT_B, '+919000015702');
    await seedUser(TENANT_B, '+919000015703');
    const after = totalUsers((await admin(TENANT_A).get('/api/v1/admin/analytics/dashboard')).body);
    expect(after).toBe(before); // tenant-B users must not leak into tenant A's totals
  });

  it('a tenant-B admin dashboard counts its own seeded users', async () => {
    const res = await admin(TENANT_B).get('/api/v1/admin/analytics/dashboard');
    expect(res.statusCode).toBe(200);
    expect(totalUsers(res.body)).toBeGreaterThanOrEqual(3);
  });
});
