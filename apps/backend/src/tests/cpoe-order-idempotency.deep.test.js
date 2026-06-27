// CPOE order-create idempotency contract (Epic #9 slice 2 — offline drug chart).
//
// POST /emr/orders is flipped to requireIdempotencyKey({ required: true }) so the
// offline queue's redrain of a lost-2xx can never create a SECOND clinical order.
// Proven over the real HTTP middleware chain (DOCTOR + deviceType:'desktop' token
// passes rejectMobileClinicalWrite and may write medication orders):
//   1. No Idempotency-Key            -> 400 (required:true gate fires pre-handler).
//   2. Same key + same body, twice   -> the 2nd is a cached REPLAY: identical 201
//                                       and EXACTLY ONE clinical_orders row.
import { generateTestToken } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const API_KEY = process.env.API_KEY || 'test-api-key';
const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT_ID = '00000000-0000-4000-8000-000000000001'; // platform default tenant
const PATIENT_UID = 'c0de0002-0001-4c0d-8c0d-c0de00020001';
const DOCTOR_UID = 'c0de0002-0002-4c0d-8c0d-c0de00020002';

function doctor() {
  const t = generateTestToken('DOCTOR', { uid: DOCTOR_UID, id: 880771, deviceType: 'desktop', tenant_id: TENANT_ID });
  const h = (r) => r.set('x-api-key', API_KEY).set('Authorization', `Bearer ${t}`);
  return { post: (p) => h(request(app).post(p)) };
}
const D = doctor();

const ORDER_BODY = {
  patient_uid: PATIENT_UID,
  order_type: 'medication',
  priority: 'routine',
  details: { medication_name: 'Paracetamol', dose: '500mg', route: 'oral', frequency: 'BD' },
};

async function orderCount() {
  const rows = await prisma.$queryRawUnsafe(
    'SELECT COUNT(*)::int AS n FROM clinical_orders WHERE patient_uid = $1::uuid', PATIENT_UID);
  return Number(rows[0]?.n ?? 0);
}

async function clean() {
  for (const sql of [
    `DELETE FROM medication_safety_reviews WHERE patient_uid = $1::uuid`,
    `DELETE FROM clinical_timeline_events WHERE patient_uid = $1::uuid AND source_table = 'clinical_orders'`,
    `DELETE FROM clinical_audit_events WHERE patient_uid = $1::uuid AND resource_table = 'clinical_orders'`,
    `DELETE FROM clinical_orders WHERE patient_uid = $1::uuid`,
    `DELETE FROM admissions WHERE patient_uid = $1::uuid`,
  ]) await prisma.$executeRawUnsafe(sql, PATIENT_UID).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`, PATIENT_UID, DOCTOR_UID).catch(() => {});
}

d('CPOE order-create idempotency (POST /emr/orders required:true)', () => {
  beforeAll(async () => {
    await clean();
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at) VALUES
        ($1::uuid,'9320000021','CPOE Idem Patient','PATIENT',true,$3::uuid,NOW()),
        ($2::uuid,'9320000022','CPOE Idem Doctor','DOCTOR',true,$3::uuid,NOW())`,
      PATIENT_UID, DOCTOR_UID, TENANT_ID);
    // guardClinicalOrderWrite needs a doctor↔patient relationship; an active
    // admission with this doctor as attending satisfies findAdmissionRelationship.
    await prisma.$executeRawUnsafe(
      `INSERT INTO admissions (patient_uid, tenant_id, admitting_doctor, attending_doctor, status, admitted_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $3::uuid, 'ADMITTED', NOW(), NOW())`,
      PATIENT_UID, TENANT_ID, DOCTOR_UID);
  }, 60000);
  afterAll(async () => { await clean(); await prisma.$disconnect().catch(() => {}); }, 60000);
  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM clinical_orders WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
  });

  it('rejects a clinical order with NO Idempotency-Key (required:true)', async () => {
    const res = await D.post('/api/v1/emr/orders').send(ORDER_BODY);
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/idempotency-key/i);
    expect(await orderCount()).toBe(0);
  });

  it('replays the same key+body: one order row, identical order id', async () => {
    // Run-unique key: idempotency_keys rows persist for 24h, so a FIXED key would
    // make a re-run replay a cached response pointing at a since-deleted order.
    const key = `cpoe-idem-${Date.now()}`;
    const first = await D.post('/api/v1/emr/orders').set('Idempotency-Key', key).send(ORDER_BODY);
    expect(first.statusCode).toBe(201);
    const firstOrderId = first.body?.data?.order?.id ?? first.body?.data?.id;
    expect(firstOrderId).toBeDefined();

    const second = await D.post('/api/v1/emr/orders').set('Idempotency-Key', key).send(ORDER_BODY);
    expect(second.statusCode).toBe(201);
    const secondOrderId = second.body?.data?.order?.id ?? second.body?.data?.id;

    expect(String(secondOrderId)).toBe(String(firstOrderId));
    expect(await orderCount()).toBe(1);
  });
});
