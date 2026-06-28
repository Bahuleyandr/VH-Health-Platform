// Admin dashboard stats/activity services tenant scope (CAN-015, remainder).
//
// The admin dashboard handlers (routes/admin/dashboardController.js) delegate to
// routes/admin/services/statsService.js (getUserStats/…/getQuickStats) and
// activityService.js (getRecentActivity). Those services ran ~25 COUNT/SUM/SELECT
// aggregates over users, doctors, departments, appointments, medical_records,
// sos_alerts, staff, staff_attendance, performance_reviews, leave_applications
// and pharmacy_orders with NO tenant filter, so an admin's "hospital totals"
// blended in other tenants' rows. The caller's tenant is now threaded into every
// service signature and every aggregate ANDs tenant_id (defense-in-depth alongside
// RLS). RLS is OFF in the test env, so this differential test proves the explicit
// predicate: users seeded in tenant B do not change a tenant-A dashboard total,
// nor surface in a tenant-A admin's recent-activity feed.
import { generateTestToken, API_KEY } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const TENANT_A = '00000000-0000-4000-8000-000000000001';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const MARKER = 'CAN015SVC';

function admin(tenantId) {
  const t = generateTestToken('ADMIN', { uid: 'c0de0015-50d0-4000-8000-00000000d015', tenant_id: tenantId });
  return { get: (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${t}`) };
}

async function clean() {
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE name = $1`, MARKER).catch(() => {});
}

async function seedUser(tenantId, phone) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, registered_at, updated_at)
     VALUES (gen_random_uuid(), $1::uuid, $2, $3, 'PATIENT', true, NOW(), NOW())
     RETURNING (uid)::text AS uid`, tenantId, phone, MARKER);
  return rows[0]?.uid;
}

const totalUsers = (body) => Number(body.data?.overview?.totalUsers ?? 0);

d('Admin dashboard stats/activity tenant scope (CAN-015)', () => {
  beforeAll(async () => { await clean(); }, 30000);
  afterAll(async () => { await clean(); await prisma.$disconnect().catch(() => {}); }, 30000);

  it('users seeded in tenant B do not change a tenant-A dashboard total', async () => {
    const before = totalUsers((await admin(TENANT_A).get('/api/v1/admin/dashboard')).body);
    await seedUser(TENANT_B, '+919000150701');
    await seedUser(TENANT_B, '+919000150702');
    await seedUser(TENANT_B, '+919000150703');
    const after = totalUsers((await admin(TENANT_A).get('/api/v1/admin/dashboard')).body);
    expect(after).toBe(before); // tenant-B users must not leak into tenant A's totals
  });

  it('a tenant-B admin dashboard counts its own seeded users', async () => {
    const res = await admin(TENANT_B).get('/api/v1/admin/dashboard');
    expect(res.statusCode).toBe(200);
    expect(totalUsers(res.body)).toBeGreaterThanOrEqual(3);
  });

  it('tenant-B user registrations do not surface in a tenant-A recent-activity feed', async () => {
    const leakedUid = await seedUser(TENANT_B, '+919000150704');
    const res = await admin(TENANT_A).get('/api/v1/admin/activity/recent?limit=100');
    expect(res.statusCode).toBe(200);
    const activityUserIds = (res.body.data || []).map((a) => String(a.user_id));
    expect(activityUserIds).not.toContain(String(leakedUid)); // tenant-B activity must not leak into tenant A's feed
  });
});
