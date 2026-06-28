// Salary-revision list tenant scope (CAN-016).
//
// getRevisions enumerated salary_revisions with no tenant filter, so an HR/admin
// saw every tenant's pay-revision history. The list now ANDs sr.tenant_id (and
// runPayroll's staff enumeration + the annual-review query are likewise scoped).
// RLS is OFF in the test env, so this explicit predicate is what scopes the list:
// a tenant-A admin must not see a tenant-B revision.
import { generateTestToken, API_KEY } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const TENANT_A = '00000000-0000-4000-8000-000000000001';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const STAFF_A = 'c0de0016-00a0-4000-8000-0000000000a1';
const STAFF_B = 'c0de0016-00b0-4000-8000-0000000000b1';

function admin(tenantId) {
  const t = generateTestToken('ADMIN', { uid: 'c0de0016-00d0-4000-8000-00000000d001', tenant_id: tenantId });
  return { get: (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${t}`) };
}

async function clean() {
  await prisma.$executeRawUnsafe(`DELETE FROM salary_revisions WHERE staff_uid IN ($1::uuid,$2::uuid)`, STAFF_A, STAFF_B).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid IN ($1::uuid,$2::uuid)`, STAFF_A, STAFF_B).catch(() => {});
}

async function seedRevision(staffUid, tenantId, num, phone) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, updated_at)
     VALUES ($1::uuid,$2::uuid,$3,'Salary Staff','NURSING_STAFF',true,NOW())`, staffUid, tenantId, phone);
  await prisma.$executeRawUnsafe(
    `INSERT INTO salary_revisions (revision_number, revision_type, effective_from, reason, staff_uid, status, tenant_id, created_at)
     VALUES ($1, 'increment', CURRENT_DATE, 'CAN-016 test', $2::uuid, 'proposed', $3::uuid, NOW())`,
    num, staffUid, tenantId);
}

d('Salary-revision list tenant scope (CAN-016)', () => {
  beforeAll(async () => {
    await clean();
    await seedRevision(STAFF_A, TENANT_A, 'REV-CAN016-A', '+919000016701');
    await seedRevision(STAFF_B, TENANT_B, 'REV-CAN016-B', '+919000016702');
  }, 30000);
  afterAll(async () => { await clean(); await prisma.$disconnect().catch(() => {}); }, 30000);

  it('a tenant-A admin revision list excludes tenant-B revisions', async () => {
    const res = await admin(TENANT_A).get('/api/v1/staff/admin/payroll/revisions?limit=200');
    expect(res.statusCode).toBe(200);
    const staffUids = (res.body.data || []).map((r) => String(r.staff_uid));
    expect(staffUids).toContain(STAFF_A);
    expect(staffUids).not.toContain(STAFF_B);
  });
});
