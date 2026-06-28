// Admin dashboard stats/activity services tenant scope (CAN-015, remainder).
//
// The admin dashboard handlers (routes/admin/dashboardController.js) delegate to
// routes/admin/services/statsService.js (getUserStats/…/getQuickStats) and
// activityService.js (getRecentActivity). Those services ran ~25 COUNT/SUM/SELECT
// aggregates over users, doctors, departments, appointments, medical_records,
// sos_alerts, staff, staff_attendance, staff_performance_reviews, leave_applications
// and pharmacy_orders with NO tenant filter, so an admin's "hospital totals"
// blended in other tenants' rows. The caller's tenant is now threaded into every
// service signature and every aggregate ANDs tenant_id (defense-in-depth alongside
// RLS). RLS is OFF in the test env, so this differential test proves the explicit
// predicate: users seeded in tenant B do not change a tenant-A dashboard total,
// nor surface in a tenant-A admin's recent-activity feed.
//
// Also covers the getStaffStats pending-reviews fix: the count queried a
// non-existent table (`performance_reviews WHERE status = 'pending'`). The real
// table is `staff_performance_reviews`, which has no `status` column — a pending
// review is one with review_date IS NULL (per staffAdminDashboardController) — so
// the tableExists gate always failed and pending_reviews silently always read 0.
// It now counts staff_performance_reviews rows with review_date IS NULL,
// tenant-scoped.
import { generateTestToken, API_KEY } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const TENANT_A = '00000000-0000-4000-8000-000000000001';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const MARKER = 'CAN015SVC';
// review_period is a free-text VARCHAR(50) on staff_performance_reviews — use it
// as a delete marker so the seed cleans up without touching real review rows.
const REVIEW_MARKER = 'CAN015SVC-REVIEW';

function admin(tenantId) {
  const t = generateTestToken('ADMIN', { uid: 'c0de0015-50d0-4000-8000-00000000d015', tenant_id: tenantId });
  return { get: (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${t}`) };
}

async function clean() {
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE name = $1`, MARKER).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM staff_performance_reviews WHERE review_period = $1`, REVIEW_MARKER).catch(() => {});
}

async function seedUser(tenantId, phone) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, registered_at, updated_at)
     VALUES (gen_random_uuid(), $1::uuid, $2, $3, 'PATIENT', true, NOW(), NOW())
     RETURNING (uid)::text AS uid`, tenantId, phone, MARKER);
  return rows[0]?.uid;
}

// A pending review = review_date IS NULL. staff_id is nullable (FK to users.id),
// so leave it NULL to avoid seeding a staff row.
async function seedPendingReview(tenantId) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO staff_performance_reviews (tenant_id, review_period, review_date, created_at)
     VALUES ($1::uuid, $2, NULL, NOW())`, tenantId, REVIEW_MARKER);
}

const totalUsers = (body) => Number(body.data?.overview?.totalUsers ?? 0);
const pendingReviews = (body) => Number(body.data?.pending_reviews ?? 0);

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

  it('counts a pending staff performance review (review_date IS NULL)', async () => {
    const before = pendingReviews((await admin(TENANT_A).get('/api/v1/admin/stats/staff')).body);
    await seedPendingReview(TENANT_A);
    const res = await admin(TENANT_A).get('/api/v1/admin/stats/staff');
    expect(res.statusCode).toBe(200);
    // Was always 0 — getStaffStats queried a non-existent `performance_reviews`.
    expect(pendingReviews(res.body)).toBe(before + 1);
  });

  it('a pending review seeded in tenant B does not change tenant A pending_reviews', async () => {
    const before = pendingReviews((await admin(TENANT_A).get('/api/v1/admin/stats/staff')).body);
    await seedPendingReview(TENANT_B);
    const after = pendingReviews((await admin(TENANT_A).get('/api/v1/admin/stats/staff')).body);
    expect(after).toBe(before); // tenant-B review must not leak into tenant A's count
  });
});
