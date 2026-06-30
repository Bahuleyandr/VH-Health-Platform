// Admin voucher redemption tenant scope (CAN-012).
//
// POST /admin/gamification/vouchers/:code/redeem looked the voucher up by code
// alone, so an admin could redeem a voucher issued in another tenant. The lookup
// now ANDs hmc.tenant_id. RLS is OFF in the test env, so this explicit predicate
// is what scopes it: a tenant-A admin gets 404 for a tenant-B voucher, while a
// tenant-B admin redeems it.
import { generateTestToken, API_KEY } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const TENANT_A = '00000000-0000-4000-8000-000000000001';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const HOLDER = 'c0de0012-00b0-4000-8000-0000000000b1';
const CODE = 'CAN012VOUCHER';
const MILESTONE_NAME = 'CAN012_MILESTONE';

function admin(tenantId) {
  const t = generateTestToken('ADMIN', { uid: 'c0de0012-00d0-4000-8000-00000000d001', tenant_id: tenantId });
  return { post: (p) => request(app).post(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${t}`).send({}) };
}

let milestoneId;

async function clean() {
  await prisma.$executeRawUnsafe(`DELETE FROM health_milestone_claims WHERE voucher_code = $1`, CODE).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM health_milestones WHERE name = $1`, MILESTONE_NAME).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, HOLDER).catch(() => {});
}

d('Admin voucher redeem tenant scope (CAN-012)', () => {
  beforeAll(async () => {
    await clean();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, 'can012-tenant-b', 'CAN-012 Tenant B') ON CONFLICT (id) DO NOTHING`,
      TENANT_B);
    const ms = await prisma.$queryRawUnsafe(
      `INSERT INTO health_milestones (name, points_required, reward_type, reward_value, reward_description)
       VALUES ($1, 100, 'voucher', 0, 'CAN-012 test reward') RETURNING id`, MILESTONE_NAME);
    milestoneId = Number(ms[0].id);
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid,$2::uuid,'+919000012701','Voucher Holder','PATIENT',true,NOW())`, HOLDER, TENANT_B);
    await prisma.$executeRawUnsafe(
      `INSERT INTO health_milestone_claims (user_uid, milestone_id, voucher_code, is_redeemed, expires_at, tenant_id)
       VALUES ($1::uuid, $2::int, $3, false, NOW() + INTERVAL '30 days', $4::uuid)`,
      HOLDER, milestoneId, CODE, TENANT_B);
  }, 30000);
  afterAll(async () => { await clean(); await prisma.$disconnect().catch(() => {}); }, 30000);

  it('a tenant-A admin cannot redeem a tenant-B voucher (404)', async () => {
    const res = await admin(TENANT_A).post(`/api/v1/admin/gamification/vouchers/${CODE}/redeem`);
    expect(res.statusCode).toBe(404);
  });

  it('a tenant-B admin redeems its own voucher', async () => {
    const res = await admin(TENANT_B).post(`/api/v1/admin/gamification/vouchers/${CODE}/redeem`);
    expect(res.statusCode).toBe(200);
    expect(res.body.data?.voucher?.is_redeemed).toBe(true);
  });
});
