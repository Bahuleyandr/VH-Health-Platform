// Roadmap B4 — PACS foundations deep round-trip.
//
// Seeds a radiology order, exercises: config endpoint, MWL feed (order
// appears until linked), study linking (validates UID, idempotency-guard,
// timeline event with viewer URL), and the patient studies list.

import prisma from '../lib/prisma.js';
import { authClient } from './testClient.js';
import { DEFAULT_TENANT_ID } from '../services/tenant/tenantService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const PHONE = `+9199912${String(Date.now() % 10000).padStart(4, '0')}`;
const STUDY_UID = `1.2.826.0.1.3680043.8.498.${Date.now()}`;
const DOCTOR_UID = 'b4b4b4b4-b4b4-4b4b-8b4b-b4b4b4b4b401';
let patientUid;
let doctorId;
let doctor;
let orderId;

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_timeline_events
      WHERE source_table = 'radiology_orders'
        AND source_id IN (
          SELECT id::text FROM radiology_orders WHERE clinical_indication LIKE 'B4TEST%'
        )`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM admissions WHERE patient_uid IN (SELECT uid FROM users WHERE name LIKE 'B4TEST%')`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM radiology_orders WHERE clinical_indication LIKE 'B4TEST%'`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, DOCTOR_UID).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE name LIKE 'B4TEST%'`).catch(() => {});
}

d('PACS foundations — deep round-trip (roadmap B4)', () => {
  beforeAll(async () => {
    await cleanup();
    const doc = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'B4TEST Doctor', 'DOCTOR', true, $3::uuid, NOW())
       ON CONFLICT (uid) DO UPDATE
         SET phone = EXCLUDED.phone,
             name = EXCLUDED.name,
             role = EXCLUDED.role,
             is_active = EXCLUDED.is_active,
             tenant_id = EXCLUDED.tenant_id,
             updated_at = NOW()
       RETURNING id, uid`,
      DOCTOR_UID,
      `+9199913${String(Date.now() % 10000).padStart(4, '0')}`,
      DEFAULT_TENANT_ID,
    );
    doctorId = Number(doc[0].id);
    doctor = authClient('DOCTOR', { uid: DOCTOR_UID, id: doctorId, phone: '9991300001' });

    const p = await prisma.$queryRawUnsafe(
      `INSERT INTO users (phone, name, role, is_active, birthday, gender, tenant_id, updated_at)
       VALUES ($1, 'B4TEST Patient', 'PATIENT', true, '1975-07-07', 'female', $2::uuid, NOW()) RETURNING uid`,
      PHONE,
      DEFAULT_TENANT_ID,
    );
    patientUid = p[0].uid;

    const order = await prisma.$queryRawUnsafe(
      `INSERT INTO radiology_orders
         (tenant_id, patient_uid, modality, body_part, clinical_indication, priority, status, ordered_by)
       VALUES ($1::uuid, $2::uuid, 'CT', 'Chest', 'B4TEST cough 3 weeks, r/o mass', 'urgent', 'ordered', $3::uuid)
       RETURNING id`,
      DEFAULT_TENANT_ID, patientUid, DOCTOR_UID,
    );
    orderId = Number(order[0].id);

    await prisma.$executeRawUnsafe(
      `INSERT INTO admissions
         (tenant_id, patient_uid, status, admitting_doctor, attending_doctor,
          admitted_at, ward, bed_number, created_by, created_at, updated_at)
       VALUES
         ($1::uuid, $2::uuid, 'admitted', $3::uuid, $3::uuid,
          NOW(), 'B4TEST Ward', 'B4P-01', $3::uuid, NOW(), NOW())`,
      DEFAULT_TENANT_ID,
      patientUid,
      DOCTOR_UID,
    );
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  test('config endpoint reports the (possibly disabled) PACS wiring', async () => {
    const res = await doctor.get('/api/v1/pacs/config');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('enabled');
    expect(res.body.data).toHaveProperty('viewer_url');
    expect(res.body.data.aet).toBeTruthy();
  });

  test('modality worklist carries the un-acquired order in MWL shape', async () => {
    const res = await doctor.get('/api/v1/pacs/worklist').query({ modality: 'ct' });
    expect(res.status).toBe(200);
    const item = res.body.data.items.find((i) => i.order_id === orderId);
    expect(item).toBeDefined();
    expect(item.accession_number).toBe(`RAD-${orderId}`);
    expect(item.modality).toBe('CT');
    expect(item.patient.sex).toBe('F');
    expect(item.patient.birth_date).toBe('19750707');
    expect(item.scheduled_date).toMatch(/^\d{8}$/);
  });

  test('study linking validates the UID and lands a timeline event with the image link', async () => {
    const bad = await doctor
      .post(`/api/v1/pacs/orders/${orderId}/link-study`)
      .send({ study_instance_uid: 'not-a-uid' });
    expect(bad.status).toBe(400);

    const res = await doctor
      .post(`/api/v1/pacs/orders/${orderId}/link-study`)
      .send({ study_instance_uid: STUDY_UID });
    expect(res.status).toBe(201);
    expect(res.body.data.order.pacs_study_instance_uid).toBe(STUDY_UID);

    const relink = await doctor
      .post(`/api/v1/pacs/orders/${orderId}/link-study`)
      .send({ study_instance_uid: `${STUDY_UID}.99` });
    expect(relink.status).toBe(409);

    const timeline = await prisma.$queryRawUnsafe(
      `SELECT event_type, payload FROM clinical_timeline_events
        WHERE source_table = 'radiology_orders' AND source_id = $1
          AND event_type = 'imaging.study_linked'`,
      String(orderId),
    );
    expect(timeline.length).toBeGreaterThanOrEqual(1);
    expect(timeline[0].payload.study_instance_uid).toBe(STUDY_UID);
    expect(timeline[0].payload).toHaveProperty('viewer_url');
  });

  test('linked order leaves the worklist and appears in the patient studies list', async () => {
    const worklist = await doctor.get('/api/v1/pacs/worklist').query({ modality: 'CT' });
    expect(worklist.body.data.items.some((i) => i.order_id === orderId)).toBe(false);

    const studies = await authClient('NURSING_STAFF').get(`/api/v1/pacs/studies/patient/${patientUid}`);
    expect(studies.status).toBe(200);
    const study = studies.body.data.studies.find((s) => s.id === orderId);
    expect(study).toBeDefined();
    expect(study.pacs_study_instance_uid).toBe(STUDY_UID);
    expect(study.accession_number).toBe(`RAD-${orderId}`);
  });

  test('patient role blocked at mount', async () => {
    const res = await authClient('PATIENT').get('/api/v1/pacs/config');
    expect(res.status).toBe(403);
  });
});
