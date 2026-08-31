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
const ENCOUNTER_ID = 'c0de0002-0003-4c0d-8c0d-c0de00020003';
const CATALOG_NAME = 'CPOE Idem Paracetamol 500';
let catalogId;
let orderSetId;
let wardId;

function doctor() {
  const t = generateTestToken('DOCTOR', { uid: DOCTOR_UID, id: 880771, deviceType: 'desktop', tenant_id: TENANT_ID });
  const h = (r) => r.set('x-api-key', API_KEY).set('Authorization', `Bearer ${t}`);
  return { post: (p) => h(request(app).post(p)) };
}
const D = doctor();

const orderBody = () => ({
  patient_uid: PATIENT_UID,
  order_type: 'medication',
  encounter_id: ENCOUNTER_ID,
  priority: 'routine',
  details: {
    medication_name: CATALOG_NAME,
    catalog_id: catalogId,
    quantity_requested: 10,
    unit: 'tablet',
    dose: '500mg',
    route: 'oral',
    frequency: 'BD',
  },
});

async function orderCount() {
  const rows = await prisma.$queryRawUnsafe(
    'SELECT COUNT(*)::int AS n FROM clinical_orders WHERE patient_uid = $1::uuid', PATIENT_UID);
  return Number(rows[0]?.n ?? 0);
}

async function cleanOrderArtifacts() {
  await prisma
    .$executeRawUnsafe(
      `DELETE FROM tasks WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid`,
      TENANT_ID,
      PATIENT_UID
    )
    .catch(() => {});
  await prisma
    .$executeRawUnsafe(
      `DELETE FROM workflow_sla_instances
      WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid`,
      TENANT_ID,
      PATIENT_UID
    )
    .catch(() => {});
  for (const table of [
    'ward_indent_events',
    'ward_indent_inventory_allocations',
    'ward_indent_items'
  ]) {
    await prisma
      .$executeRawUnsafe(
        `DELETE FROM ${table}
        WHERE tenant_id = $1::uuid
          AND ward_indent_id IN (
            SELECT id FROM ward_indents
             WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid
          )`,
        TENANT_ID,
        PATIENT_UID
      )
      .catch(() => {});
  }
  await prisma
    .$executeRawUnsafe(
      `DELETE FROM ward_indents
      WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid`,
      TENANT_ID,
      PATIENT_UID
    )
    .catch(() => {});
  for (const table of [
    'medication_safety_reviews',
    'clinical_timeline_events',
    'clinical_audit_events',
    'clinical_orders'
  ]) {
    await prisma
      .$executeRawUnsafe(`DELETE FROM ${table} WHERE patient_uid = $1::uuid`, PATIENT_UID)
      .catch(() => {});
  }
  await prisma
    .$executeRawUnsafe(`DELETE FROM idempotency_keys WHERE user_uid = $1::uuid`, DOCTOR_UID)
    .catch(() => {});
}

async function clean() {
  await cleanOrderArtifacts();
  for (const sql of [
    `DELETE FROM medication_safety_reviews WHERE patient_uid = $1::uuid`,
    `DELETE FROM clinical_timeline_events WHERE patient_uid = $1::uuid AND source_table = 'clinical_orders'`,
    `DELETE FROM clinical_audit_events WHERE patient_uid = $1::uuid AND resource_table = 'clinical_orders'`,
    `DELETE FROM clinical_orders WHERE patient_uid = $1::uuid`,
    `DELETE FROM admissions WHERE patient_uid = $1::uuid`
  ])
    await prisma.$executeRawUnsafe(sql, PATIENT_UID).catch(() => {});
  await prisma
    .$executeRawUnsafe(`DELETE FROM idempotency_keys WHERE user_uid = $1::uuid`, DOCTOR_UID)
    .catch(() => {});
  await prisma
    .$executeRawUnsafe(
      `DELETE FROM pharmacy_catalog WHERE tenant_id = $1::uuid AND name = $2`,
      TENANT_ID,
      CATALOG_NAME
    )
    .catch(() => {});
  await prisma
    .$executeRawUnsafe(
      `DELETE FROM clinical_order_set_items
      WHERE tenant_id = $1::uuid
        AND order_set_id IN (
          SELECT id FROM clinical_order_sets
           WHERE tenant_id = $1::uuid AND family_key = 'CPOE-IDEMPOTENCY-ATOMIC'
        )`,
      TENANT_ID
    )
    .catch(() => {});
  await prisma
    .$executeRawUnsafe(
      `DELETE FROM clinical_order_sets
      WHERE tenant_id = $1::uuid AND family_key = 'CPOE-IDEMPOTENCY-ATOMIC'`,
      TENANT_ID
    )
    .catch(() => {});
  await prisma
    .$executeRawUnsafe(
      `DELETE FROM beds WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid`,
      TENANT_ID,
      PATIENT_UID
    )
    .catch(() => {});
  await prisma
    .$executeRawUnsafe(
      `DELETE FROM wards WHERE tenant_id = $1::uuid AND name = 'CPOE Idempotency Ward'`,
      TENANT_ID
    )
    .catch(() => {});
  await prisma
    .$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`,
      PATIENT_UID,
      DOCTOR_UID
    )
    .catch(() => {});
}

d('CPOE order-create idempotency (POST /emr/orders required:true)', () => {
  beforeAll(async () => {
    await clean();
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at) VALUES
        ($1::uuid,'9320000021','CPOE Idem Patient','PATIENT',true,$3::uuid,NOW()),
        ($2::uuid,'9320000022','CPOE Idem Doctor','DOCTOR',true,$3::uuid,NOW())`,
      PATIENT_UID,
      DOCTOR_UID,
      TENANT_ID
    );
    wardId = Number(
      (
        await prisma.$queryRawUnsafe(
          `INSERT INTO wards (tenant_id, name, total_beds, created_at, updated_at)
       VALUES ($1::uuid, 'CPOE Idempotency Ward', 1, NOW(), NOW())
       RETURNING id`,
          TENANT_ID
        )
      )[0].id
    );
    const bedId = Number(
      (
        await prisma.$queryRawUnsafe(
          `INSERT INTO beds
         (tenant_id, ward_id, ward_name, bed_number, status, patient_uid,
          created_at, updated_at)
       VALUES ($1::uuid, $2::int, 'CPOE Idempotency Ward', 'CPOE-IDEM-1',
               'occupied', $3::uuid, NOW(), NOW())
       RETURNING id`,
          TENANT_ID,
          wardId,
          PATIENT_UID
        )
      )[0].id
    );
    // guardClinicalOrderWrite needs a doctor↔patient relationship; an active
    // admission with this doctor as attending satisfies findAdmissionRelationship.
    await prisma.$executeRawUnsafe(
      `INSERT INTO admissions
         (patient_uid, tenant_id, encounter_id, admitting_doctor, attending_doctor,
          bed_id, bed_number, ward, status, admitted_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $4::uuid,
               $5::int, 'CPOE-IDEM-1', 'CPOE Idempotency Ward',
               'ADMITTED', NOW(), NOW())`,
      PATIENT_UID,
      TENANT_ID,
      ENCOUNTER_ID,
      DOCTOR_UID,
      bedId
    );
    const composition = await prisma.$queryRawUnsafe(
      `INSERT INTO drug_compositions
         (composition_key, display_label, active_ingredients, source)
       VALUES ('cpoe_idem_paracetamol', 'Paracetamol', ARRAY['paracetamol']::text[], 'curated')
       ON CONFLICT (composition_key) DO UPDATE SET display_label = EXCLUDED.display_label
       RETURNING id`,
    );
    const catalog = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_catalog
         (tenant_id, name, generic_name, is_active, composition_id,
          composition_confidence, composition_source, strength, strength_key,
          strength_components, form, form_key, route, release_key, updated_at)
       VALUES ($1::uuid, $2, 'paracetamol', TRUE, $3::int,
               'high', 'curated', '500mg', '500mg', $4::jsonb,
               'tablet', 'tablet', 'oral', 'ir', NOW())
       RETURNING id`,
      TENANT_ID,
      CATALOG_NAME,
      Number(composition[0].id),
      JSON.stringify([{ ingredient: 'paracetamol', value: 500, unit: 'mg' }]),
    );
    catalogId = Number(catalog[0].id);
    const set = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_order_sets
         (tenant_id, code, family_key, version, status, active, title, specialty,
          condition_codes, description, created_by, source)
       VALUES ($1::uuid, 'CPOE-IDEMPOTENCY-ATOMIC-V1', 'CPOE-IDEMPOTENCY-ATOMIC',
               1, 'approved', TRUE, 'Atomic receipt fixture', 'General Medicine',
               ARRAY[]::text[], 'Atomic apply-set receipt fixture', $2::uuid, 'authored')
       RETURNING id`,
      TENANT_ID,
      DOCTOR_UID
    );
    orderSetId = Number(set[0].id);
    await prisma.$executeRawUnsafe(
      `INSERT INTO clinical_order_set_items
         (tenant_id, order_set_id, display_order, kind, payload, default_selected)
       VALUES
         ($1::uuid, $2::int, 1, 'lab', $3::jsonb, TRUE),
         ($1::uuid, $2::int, 2, 'nursing', $4::jsonb, TRUE)`,
      TENANT_ID,
      orderSetId,
      JSON.stringify({ test_name: 'Atomic receipt CBC', priority: 'routine' }),
      JSON.stringify({ description: 'Atomic receipt observations', frequency: 'Q4H' })
    );
  }, 60000);
  afterAll(async () => {
    await clean();
    await prisma.$disconnect().catch(() => {});
  }, 60000);
  beforeEach(cleanOrderArtifacts);

  it('rejects a clinical order with NO Idempotency-Key (required:true)', async () => {
    const res = await D.post('/api/v1/emr/orders').send(orderBody());
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/idempotency-key/i);
    expect(await orderCount()).toBe(0);
  });

  it('replays the same key+body: one order row, identical order id', async () => {
    // Run-unique key: idempotency_keys rows persist for 24h, so a FIXED key would
    // make a re-run replay a cached response pointing at a since-deleted order.
    const key = `cpoe-idem-${Date.now()}`;
    const body = orderBody();
    const first = await D.post('/api/v1/emr/orders').set('Idempotency-Key', key).send(body);
    expect(first.statusCode).toBe(201);
    const firstOrderId = first.body?.data?.order?.id ?? first.body?.data?.id;
    expect(firstOrderId).toBeDefined();

    const receipt = await prisma.$queryRawUnsafe(
      `SELECT status, response_status, response_body
         FROM idempotency_keys
        WHERE tenant_id = $1::uuid
          AND user_uid = $2::uuid
          AND request_key = $3`,
      TENANT_ID,
      DOCTOR_UID,
      key,
    );
    expect(receipt[0]).toMatchObject({ status: 'complete', response_status: 201 });
    expect(receipt[0].response_body?.data?.order?.id).toBe(firstOrderId);

    const second = await D.post('/api/v1/emr/orders').set('Idempotency-Key', key).send(body);
    expect(second.statusCode).toBe(201);
    const secondOrderId = second.body?.data?.order?.id ?? second.body?.data?.id;

    expect(String(secondOrderId)).toBe(String(firstOrderId));
    expect(await orderCount()).toBe(1);
  });

  it('applies an order set atomically and replays the persisted HTTP receipt', async () => {
    const key = `cpoe-apply-set-idem-${Date.now()}`;
    const body = {
      patient_uid: PATIENT_UID,
      encounter_id: ENCOUNTER_ID,
      order_set_id: orderSetId
    };
    const first = await D.post('/api/v1/emr/orders/apply-set')
      .set('Idempotency-Key', key)
      .send(body);
    expect(first.statusCode).toBe(201);
    expect(first.body).toMatchObject({
      success: true,
      message: 'Order set applied',
      data: [
        { order: { order_type: 'investigation' }, cds_warnings: expect.any(Array) },
        { order: { order_type: 'nursing' }, cds_warnings: expect.any(Array) }
      ]
    });

    const receipt = await prisma.$queryRawUnsafe(
      `SELECT status, response_status, response_body
         FROM idempotency_keys
        WHERE tenant_id = $1::uuid
          AND user_uid = $2::uuid
          AND request_key = $3`,
      TENANT_ID,
      DOCTOR_UID,
      key
    );
    expect(receipt).toHaveLength(1);
    expect(receipt[0]).toMatchObject({ status: 'complete', response_status: 201 });
    expect(receipt[0].response_body).toEqual(first.body);

    const replay = await D.post('/api/v1/emr/orders/apply-set')
      .set('Idempotency-Key', key)
      .send(body);
    expect(replay.statusCode).toBe(201);
    expect(replay.body).toEqual(first.body);
    expect(await orderCount()).toBe(2);
  });
});
