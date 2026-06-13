// Roadmap B1 — BCMA closed loop deep round-trip.
//
// Covers the pharmacist clinical-verification gate (verify → preparing,
// blockers → override-with-reason, rejected orders frozen), med-pack
// barcode + label, the scan-first MAR policy (bare administer 409s,
// override audited), pack-barcode drug-right matching, and wristband
// printing.

import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import { authClient, API_KEY, generateTestToken } from './testClient.js';
import { __resetDrugKbCache } from '../services/clinical/drugKnowledgeBaseService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const PHONE = `+9199907${String(Date.now() % 10000).padStart(5, '0')}`;
const NURSE_UID = 'b1b1b1b1-1111-4111-8111-b1b1b1b1fd01';
// MAR routes sit behind the patient-access guard: the acting staff member
// must exist in users and hold a care relationship (admission context).
const nurseClient = () => {
  const token = generateTestToken('NURSING_STAFF', { uid: NURSE_UID });
  return {
    get: (path) => request(app).get(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    post: (path) => request(app).post(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
};

let patientId;
let patientUid;
let cleanOrderId; // order with benign items
let riskyOrderId; // order whose items trip a KB contraindication
let maId; // scheduled MAR row for scan-policy tests

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM medication_administrations WHERE medication_name LIKE 'B1TEST%'`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM medication_safety_reviews WHERE patient_uid IN (SELECT uid FROM users WHERE name = 'B1TEST Patient')`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM pharmacy_order_history WHERE order_id IN (SELECT id FROM pharmacy_orders WHERE patient_name = 'B1TEST Patient')`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM pharmacy_orders WHERE patient_name = 'B1TEST Patient'`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM admissions WHERE ward = 'B1TEST Ward'`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM patient_access_audit_log WHERE patient_uid IN (SELECT uid FROM users WHERE name LIKE 'B1TEST%')`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE name LIKE 'B1TEST%'`).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, NURSE_UID).catch(() => {});
}

d('BCMA closed loop — deep round-trip (roadmap B1)', () => {
  beforeAll(async () => {
    await cleanup();
    __resetDrugKbCache();

    const p = await prisma.$queryRawUnsafe(
      `INSERT INTO users (phone, name, role, is_active, birthday, gender, updated_at)
       VALUES ($1, 'B1TEST Patient', 'PATIENT', true, '1985-05-05', 'male', NOW()) RETURNING id, uid`,
      PHONE,
    );
    patientId = Number(p[0].id);
    patientUid = p[0].uid;

    const clean = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_orders (patient_id, patient_name, phone, order_note, status, delivery_type, items_list, total_amount, updated_at)
       VALUES ($1, 'B1TEST Patient', $2, 'B1TEST order', 'CONFIRMED', 'counter',
               '[{"name":"B1TEST Paracetamol 500mg","dose":"500mg","frequency":"TDS","qty":10,"price":2}]'::jsonb, 20, NOW())
       RETURNING id`,
      patientId, PHONE,
    );
    cleanOrderId = Number(clean[0].id);

    const risky = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_orders (patient_id, patient_name, phone, order_note, status, delivery_type, items_list, total_amount, updated_at)
       VALUES ($1, 'B1TEST Patient', $2, 'B1TEST order', 'CONFIRMED', 'counter',
               '[{"name":"Tab Sildenafil 50mg","dose":"50mg","frequency":"OD","qty":4,"price":50},
                 {"name":"Sorbitrate (isosorbide) 10mg","dose":"10mg","frequency":"BD","qty":10,"price":5}]'::jsonb, 250, NOW())
       RETURNING id`,
      patientId, PHONE,
    );
    riskyOrderId = Number(risky[0].id);

    // Acting nurse must exist in users for the access-decision layer.
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2, 'B1TEST Nurse', 'NURSING_STAFF', true, NOW())
       ON CONFLICT (uid) DO NOTHING`,
      NURSE_UID, `+9199908${String(Date.now() % 10000).padStart(5, '0')}`,
    );

    // Active admission — gives the MAR access guard an admission-context
    // care relationship for this patient (BCMA is an inpatient loop).
    await prisma.$executeRawUnsafe(
      `INSERT INTO admissions (patient_uid, allergies, status, admitted_at, ward, bed_number, created_by, created_at, updated_at)
       VALUES ($1::uuid, '{}', 'admitted', NOW(), 'B1TEST Ward', 'B1T-01', $2::uuid, NOW(), NOW())`,
      patientUid, NURSE_UID,
    );

    const ma = await prisma.$queryRawUnsafe(
      `INSERT INTO medication_administrations (patient_uid, medication_name, dose, route, scheduled_time, status)
       VALUES ($1::uuid, 'B1TEST Paracetamol 500mg', '500mg', 'oral', NOW(), 'scheduled')
       RETURNING id`,
      patientUid,
    );
    maId = Number(ma[0].id);
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  test('PREPARING is blocked until pharmacist verification clears', async () => {
    const res = await authClient('PHARMACY_STAFF').post(`/api/v1/pharmacy/orders/${cleanOrderId}/preparing`);
    expect(res.status).toBe(409);
  });

  test('counter dispense is blocked until verification clears', async () => {
    const res = await authClient('PHARMACY_STAFF')
      .post(`/api/v1/pharmacy/orders/${cleanOrderId}/dispense-counter`)
      .send({ payment_mode: 'cash', amount_collected: 20 });
    expect(res.status).toBe(409);
  });

  test('clean order verifies; preparing then proceeds; safety event lands on the timeline', async () => {
    const verify = await authClient('PHARMACY_STAFF')
      .post(`/api/v1/pharmacy/orders/${cleanOrderId}/verify`)
      .send({ decision: 'verified', notes: 'B1TEST reviewed against allergies/KB' });
    expect(verify.status).toBe(200);
    expect(verify.body.data.order.clinical_verification_status).toBe('verified');
    expect(verify.body.data.safety.blockers).toHaveLength(0);

    const timeline = await prisma.$queryRawUnsafe(
      `SELECT event_type FROM clinical_timeline_events
        WHERE source_table = 'pharmacy_orders' AND source_id = $1
          AND event_type = 'pharmacy.order_clinically_verified'`,
      String(cleanOrderId),
    );
    expect(timeline.length).toBeGreaterThanOrEqual(1);

    const preparing = await authClient('PHARMACY_STAFF').post(`/api/v1/pharmacy/orders/${cleanOrderId}/preparing`);
    expect(preparing.status).toBe(200);
  });

  test('risky order: verify refused with blockers; override requires a reason and records reviews', async () => {
    const verify = await authClient('PHARMACY_STAFF')
      .post(`/api/v1/pharmacy/orders/${riskyOrderId}/verify`)
      .send({ decision: 'verified' });
    expect(verify.status).toBe(409);
    expect(verify.body.details.blockers.length).toBeGreaterThanOrEqual(1);

    const badOverride = await authClient('PHARMACY_STAFF')
      .post(`/api/v1/pharmacy/orders/${riskyOrderId}/verify`)
      .send({ decision: 'override', override_reason: 'short' });
    expect(badOverride.status).toBe(400);

    const override = await authClient('PHARMACY_STAFF')
      .post(`/api/v1/pharmacy/orders/${riskyOrderId}/verify`)
      .send({
        decision: 'override',
        override_reason: 'B1TEST cardiologist confirmed nitrate stopped 48h ago',
      });
    expect(override.status).toBe(200);
    expect(override.body.data.order.clinical_verification_status).toBe('override');

    const reviews = await prisma.$queryRawUnsafe(
      `SELECT review_type, status, override_reason FROM medication_safety_reviews
        WHERE patient_uid = $1::uuid AND override_reason LIKE 'B1TEST%'`,
      patientUid,
    );
    expect(reviews.length).toBeGreaterThanOrEqual(1);
    expect(reviews.some((r) => r.status === 'overridden')).toBe(true);
  });

  test('pack label issues a stable VHMP barcode after verification', async () => {
    const label = await authClient('PHARMACY_STAFF').get(`/api/v1/pharmacy/orders/${cleanOrderId}/pack-label`);
    expect(label.status).toBe(200);
    expect(label.body.data.pack_barcode).toMatch(/^VHMP-\d+-[0-9A-F]{8}$/);
    expect(label.body.data.items[0].name).toContain('B1TEST Paracetamol');

    const again = await authClient('PHARMACY_STAFF').get(`/api/v1/pharmacy/orders/${cleanOrderId}/pack-label`);
    expect(again.body.data.pack_barcode).toBe(label.body.data.pack_barcode);
  });

  test('MAR: bare administer 409s under scan-first policy; override is persisted + audited', async () => {
    const bare = await nurseClient().post(`/api/v1/clinical/mar/${maId}/administer`).send({});
    expect(bare.status).toBe(409);

    const withReason = await nurseClient()
      .post(`/api/v1/clinical/mar/${maId}/administer`)
      .send({ override_reason: 'B1TEST scanner battery dead, identity verified verbally' });
    expect(withReason.status).toBe(200);
    expect(withReason.body.data.override_reason).toMatch(/scanner battery dead/);
  });

  test('B4.2: administer-with-scan 409s on a mismatched patient scan, 200s with an override', async () => {
    // Fresh scheduled row for this patient.
    const ma3 = await prisma.$queryRawUnsafe(
      `INSERT INTO medication_administrations (patient_uid, medication_name, dose, route, scheduled_time, status)
       VALUES ($1::uuid, 'B1TEST Paracetamol 500mg', '500mg', 'oral', NOW(), 'scheduled')
       RETURNING id`,
      patientUid,
    );
    const scanMaId = Number(ma3[0].id);

    // Mismatched wristband UID (NURSE_UID is a real user but not this MA's
    // patient) with no override → server-side two-scan gate rejects with 409.
    const mismatch = await nurseClient()
      .post(`/api/v1/clinical/mar/${scanMaId}/administer-with-scan`)
      .send({
        scanned_patient_uid: NURSE_UID,
        scanned_barcode: 'B1TEST Paracetamol 500mg',
      });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.code).toBe('MAR_TWO_SCAN_REQUIRED');

    // Same mismatch WITH a documented override (>=5 chars) → administered.
    const overridden = await nurseClient()
      .post(`/api/v1/clinical/mar/${scanMaId}/administer-with-scan`)
      .send({
        scanned_patient_uid: NURSE_UID,
        scanned_barcode: 'B1TEST Paracetamol 500mg',
        override_reason: 'B1TEST wristband unreadable; identity confirmed verbally + ID band',
      });
    expect(overridden.status).toBe(200);
    expect(overridden.body.data.status).toBe('administered');
    expect(overridden.body.data.override_reason).toMatch(/wristband unreadable/);
  });

  test('5-rights drug-right passes via med-pack barcode for the right patient', async () => {
    // Fresh scheduled row + the pack barcode of the verified order.
    const ma2 = await prisma.$queryRawUnsafe(
      `INSERT INTO medication_administrations (patient_uid, medication_name, dose, route, scheduled_time, status)
       VALUES ($1::uuid, 'B1TEST Paracetamol 500mg', '500mg', 'oral', NOW(), 'scheduled')
       RETURNING id`,
      patientUid,
    );
    const labelRes = await authClient('PHARMACY_STAFF').get(`/api/v1/pharmacy/orders/${cleanOrderId}/pack-label`);
    const packBarcode = labelRes.body.data.pack_barcode;

    const verify = await nurseClient()
      .post('/api/v1/clinical/mar/verify')
      .send({
        ma_id: Number(ma2[0].id),
        scanned_patient_uid: patientUid,
        scanned_barcode: packBarcode,
      });
    expect(verify.status).toBe(200);
    expect(verify.body.data.rights.drug).toBe(true);
    expect(verify.body.data.rights.patient).toBe(true);
    expect(verify.body.data.context.drugMatchMode).toBe('pack_barcode');
  });

  test('wristband JSON + printable HTML with Code 39 of the patient UID', async () => {
    const json = await nurseClient().get(`/api/v1/bcma/wristband/${patientUid}`);
    expect(json.status).toBe(200);
    expect(json.body.data.barcode_payload).toBe(patientUid);
    expect(json.body.data.barcode_symbology).toBe('code39');
    expect(json.body.data.patient.name).toBe('B1TEST Patient');

    const html = await nurseClient()
      .get(`/api/v1/bcma/wristband/${patientUid}?format=html`);
    expect(html.status).toBe(200);
    expect(html.headers['content-type']).toMatch(/text\/html/);
    expect(html.text).toContain('<svg');
    expect(html.text).toContain(patientUid.toUpperCase());
  });

  test('rejected orders cannot progress', async () => {
    const blocked = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_orders (patient_id, patient_name, phone, order_note, status, delivery_type, items_list, total_amount, updated_at)
       VALUES ($1, 'B1TEST Patient', $2, 'B1TEST order', 'CONFIRMED', 'counter',
               '[{"name":"B1TEST Cetirizine 10mg","dose":"10mg","qty":5,"price":1}]'::jsonb, 5, NOW())
       RETURNING id`,
      patientId, PHONE,
    );
    const rejectId = Number(blocked[0].id);
    const reject = await authClient('PHARMACY_STAFF')
      .post(`/api/v1/pharmacy/orders/${rejectId}/verify`)
      .send({ decision: 'rejected', notes: 'B1TEST illegible strength — back to prescriber' });
    expect(reject.status).toBe(200);

    const preparing = await authClient('PHARMACY_STAFF').post(`/api/v1/pharmacy/orders/${rejectId}/preparing`);
    expect(preparing.status).toBe(409);
  });
});
