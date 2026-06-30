// Legacy pharmacy order phone-resolution tenant scope (CAN-033).
//
// createOrder resolved phone→patient with no tenant filter and inserted the
// order without an explicit tenant, so an order could resolve/attach a patient
// in another tenant. The lookup + insert are now tenant scoped. RLS is OFF in
// the test env, so this explicit predicate is what scopes: a tenant-A caller
// ordering for a phone that exists only in tenant B resolves no patient
// (patient_id null), while a tenant-B caller resolves it.
import { generateTestToken, API_KEY } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const TENANT_A = '00000000-0000-4000-8000-000000000001';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const PATIENT_B = 'c0de0033-00b0-4000-8000-0000000000b1';
const DOCTOR_UID = 'c0de0033-00d0-4000-8000-00000000d001';
const PHONE = '+919000033701';

function doctor(tenantId) {
  const t = generateTestToken('DOCTOR', { uid: DOCTOR_UID, tenant_id: tenantId });
  return {
    post: (p, body) => request(app).post(p)
      .set('x-api-key', API_KEY).set('Authorization', `Bearer ${t}`).send(body),
  };
}

let patientBId;

async function clean() {
  await prisma.$executeRawUnsafe(`DELETE FROM pharmacy_orders WHERE phone = $1`, PHONE).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid IN ($1::uuid,$2::uuid)`, PATIENT_B, DOCTOR_UID).catch(() => {});
}

d('Pharmacy order phone-resolution tenant scope (CAN-033)', () => {
  beforeAll(async () => {
    await clean();
    // The non-default tenant B exists on a data-rich dev DB but not on a fresh
    // CI DB; create it idempotently so the users insert below FKs cleanly.
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, 'can033-tenant-b', 'CAN-033 Tenant B') ON CONFLICT (id) DO NOTHING`,
      TENANT_B);
    // prescribed_by FKs to users(uid); seed the ordering clinician so the insert
    // is referentially valid.
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid,$2::uuid,'+919000033700','Pharmacy Doctor','DOCTOR',true,NOW())`,
      DOCTOR_UID, TENANT_A);
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid,$2::uuid,$3,'Pharmacy Tenant Patient','PATIENT',true,NOW())
       RETURNING id`, PATIENT_B, TENANT_B, PHONE);
    patientBId = Number(rows[0].id);
  }, 30000);
  afterAll(async () => { await clean(); await prisma.$disconnect().catch(() => {}); }, 30000);

  it('a tenant-A order does not resolve a tenant-B patient by phone (patient_id null)', async () => {
    const res = await doctor(TENANT_A).post('/api/v1/pharmacy-orders/orders',
      { phone: PHONE, order_note: 'CAN-033 cross-tenant probe' });
    expect(res.statusCode).toBe(200);
    expect(res.body.data?.patient_id ?? null).toBeNull();
  });

  it('a tenant-B order resolves its own patient by phone', async () => {
    const res = await doctor(TENANT_B).post('/api/v1/pharmacy-orders/orders',
      { phone: PHONE, order_note: 'CAN-033 same-tenant order' });
    expect(res.statusCode).toBe(200);
    expect(Number(res.body.data?.patient_id)).toBe(patientBId);
  });
});
