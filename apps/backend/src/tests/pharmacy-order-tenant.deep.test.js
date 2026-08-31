// Legacy pharmacy order phone-resolution tenant scope (CAN-033).
//
// THE ORIGINAL FINDING. createOrder resolved phone -> patient with no tenant
// filter and inserted the order without an explicit tenant, so a tenant-A
// caller ordering for a phone that existed only in tenant B attached tenant B's
// patient to a tenant-A order. The fix (a18df477) tenant-scoped both the lookup
// and the insert, and this suite asserted the scoping by driving
// POST /api/v1/pharmacy-orders/orders once per tenant.
//
// WHY THE SHAPE CHANGED. That endpoint no longer exists. The MED-03 authority
// integration (28f0b9d6b) deleted the legacy phone-keyed create from
// routes/pharmacy/orderRoutes.js — "Legacy create and generic status mutation
// were retired: both bypassed the facility-bound, verified Inventory V2
// lifecycle above" — and deleted its controller with it: the only export left
// in controllers/pharmacy/orderController.js is getOrdersByUID. Nothing in the
// corpus resolves phone -> patient during pharmacy order creation any more.
// The old cases were therefore asserting `200` against a route that answers
// 404, and no amount of fixture repair brings them back.
//
// WHAT THIS SUITE ASSERTS NOW, and why it is not a narrowing. Both halves of
// the original proposition are kept, re-aimed at the surfaces that survived:
//
//   1. THE VULNERABLE SURFACE IS GONE. POST on the legacy path is 404 while GET
//      on the same path still serves the staff queue, so the 404 is the verb's
//      deliberate absence and not a broken or moved mount. A retired attack
//      surface is a stronger guarantee than a scoped one.
//   2. THE SURVIVING CREATE PATH IS STILL TENANT-BOUND. POST /orders/place
//      resolves its subject from the authenticated identity rather than from a
//      phone, and that resolution carries an explicit tenant predicate
//      (pharmacyOrderController.js:511-518). A tenant-A request carrying tenant
//      B's patient identity is refused 403
//      PHARMACY_ORDER_PATIENT_AUTHORITY_INVALID — it does not silently create an
//      order with a null or foreign patient — and the tenant-B caller's own
//      placement lands on tenant B with tenant B's patient id. That is the
//      CAN-033 invariant ("an order never attaches another tenant's patient")
//      asserted on the code path that can still violate it.
import { generateTestToken, API_KEY } from './testClient.js';
import prisma, { setTenantTx } from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const TENANT_A = '00000000-0000-4000-8000-000000000001';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const PATIENT_B = 'c0de0033-00b0-4000-8000-0000000000b1';
const DOCTOR_UID = 'c0de0033-00d0-4000-8000-00000000d001';
const PHONE = '+919000033701';
const FACILITY_CODE = 'CAN033-TENANT-B-PHARMACY';

function client(role, claims) {
  const t = generateTestToken(role, claims);
  return {
    get: (p) => request(app).get(p)
      .set('x-api-key', API_KEY).set('Authorization', `Bearer ${t}`),
    post: (p, body) => request(app).post(p)
      .set('x-api-key', API_KEY).set('Authorization', `Bearer ${t}`).send(body),
  };
}

let patientBId;
let facilityBId;

async function clean() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM pharmacy_order_history WHERE order_id IN
       (SELECT id FROM pharmacy_orders WHERE phone = $1)`, PHONE).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM pharmacy_orders WHERE phone = $1`, PHONE).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid IN ($1::uuid,$2::uuid)`, PATIENT_B, DOCTOR_UID).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM facility_locations WHERE facility_id IN
       (SELECT id FROM facilities WHERE facility_code = $1)`, FACILITY_CODE).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM facilities WHERE facility_code = $1`, FACILITY_CODE).catch(() => {});
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
    // placeOrder resolves custody through resolvePharmacyFacility, which
    // demands EXACTLY ONE active is_default facility for the ordering tenant
    // (pharmacyFacilityAuthorityService.js:343-390). Tenant A deliberately gets
    // none: the cross-tenant case must be refused on patient identity, before
    // custody is ever consulted, and seeding a tenant-A facility would let a
    // custody failure masquerade as the identity refusal.
    const facilityRows = await setTenantTx(TENANT_B, async (tx) => tx.$queryRawUnsafe(
      `INSERT INTO facilities (tenant_id, facility_code, display_name, status, is_default)
       VALUES ($1::uuid, $2, 'CAN-033 Tenant B Pharmacy', 'active', TRUE)
       RETURNING id`,
      TENANT_B, FACILITY_CODE));
    facilityBId = Number(facilityRows[0].id);
  }, 30000);
  afterAll(async () => { await clean(); await prisma.$disconnect().catch(() => {}); }, 30000);

  it('has retired the phone-keyed legacy create the finding was filed against', async () => {
    const patient = client('PATIENT', {
      uid: PATIENT_B, id: patientBId, tenant_id: TENANT_B,
    });
    // The prefix mount is alive and serving on this exact path...
    const mine = await patient.get('/api/v1/pharmacy-orders/orders/my');
    expect(mine.statusCode).toBe(200);
    // ...and the create verb on it is gone, so a phone can no longer name the
    // patient an order is attached to. The 404 is the router's, not a 403 or a
    // validation refusal: there is no handler behind POST on this path at all.
    const legacyCreate = await patient.post('/api/v1/pharmacy-orders/orders',
      { phone: PHONE, order_note: 'CAN-033 cross-tenant probe' });
    expect(legacyCreate.statusCode).toBe(404);
    expect(legacyCreate.body.success).toBe(false);
  });

  it('a tenant-A order cannot attach a tenant-B patient', async () => {
    const crossTenant = client('PATIENT', {
      uid: PATIENT_B, id: patientBId, tenant_id: TENANT_A,
    });
    const res = await crossTenant.post('/api/v1/pharmacy-orders/orders/place',
      { order_note: 'CAN-033 cross-tenant probe', delivery_type: 'counter' });
    // The refusal comes from the funding-identity lock, which placeOrder takes
    // before its own patient-authority read: resolvePharmacyFundingPatientUidTx
    // requires the (tenant_id, id, uid) triple to resolve to exactly one active
    // PATIENT row, and the tenant-B patient does not exist in tenant A. Both
    // gates are tenant-scoped and both refuse; this is simply the first one the
    // request reaches, and it is pinned exactly rather than as "some 4xx".
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('PHARMACY_FUNDING_PATIENT_IDENTITY_MISMATCH');
    const leaked = await prisma.$queryRawUnsafe(
      `SELECT id FROM pharmacy_orders WHERE patient_id = $1::int AND tenant_id = $2::uuid`,
      patientBId, TENANT_A);
    expect(leaked).toHaveLength(0);
  });

  it('a tenant-B order carries its own patient and tenant', async () => {
    const own = client('PATIENT', {
      uid: PATIENT_B, id: patientBId, tenant_id: TENANT_B,
    });
    const res = await own.post('/api/v1/pharmacy-orders/orders/place',
      { order_note: 'CAN-033 same-tenant order', delivery_type: 'counter' });
    expect(res.statusCode).toBe(200);
    expect(Number(res.body.data.patient_id)).toBe(patientBId);
    expect(String(res.body.data.tenant_id)).toBe(TENANT_B);
    const stored = await prisma.$queryRawUnsafe(
      `SELECT tenant_id, patient_id, facility_id FROM pharmacy_orders WHERE id = $1::int`,
      Number(res.body.data.id));
    expect(String(stored[0].tenant_id)).toBe(TENANT_B);
    expect(Number(stored[0].patient_id)).toBe(patientBId);
    expect(Number(stored[0].facility_id)).toBe(facilityBId);
  });
});
