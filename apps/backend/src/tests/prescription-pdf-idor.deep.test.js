// Prescription PDF + by-appointment IDOR regression (#4).
//
// downloadPrescriptionPDF (GET /prescriptions/pdf/:id) and
// getPrescriptionByAppointment (GET /prescriptions/appointment/:appointmentId)
// returned a signed PDF URL / prescription by BARE id with NO ownership check,
// while the parent RBAC admits the PATIENT role — so a patient could enumerate
// the SERIAL id and fetch ANY other patient's prescription. These prove a
// PATIENT only reaches their OWN script (404 for another patient's) while staff
// reach any.
//
// Needs the test Postgres (DATABASE_URL / TEST_DATABASE_URL, default
// 127.0.0.1:55432 db vhhealth_test). Self-skips when unconfigured.

import { generateTestToken } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const API_KEY = process.env.API_KEY || 'test-api-key';
const TENANT = '00000000-0000-4000-8000-000000000001';

const OWNER_UID = 'f4400000-0000-4000-8000-0000000004a1';
const OWNER_PHONE = '+919000040001';
const ATTACKER_UID = 'f4400000-0000-4000-8000-0000000004b2';
const ATTACKER_PHONE = '+919000040002';
const DOCTOR_UID = 'f4400000-0000-4000-8000-0000000004d3';
const DOCTOR_PHONE = '+919000040003';

function client(role, uid, intId) {
  const token = generateTestToken(role, { uid, id: intId });
  return {
    get: (p) =>
      request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}

async function seedUser(uid, phone, role, name) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
     VALUES ($1::uuid, $2, $3, $4, true, NOW()) RETURNING id`,
    uid, phone, name, role,
  );
  return rows[0].id;
}

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM e_prescriptions WHERE patient_uid IN ($1::uuid, $2::uuid)`,
    OWNER_UID, ATTACKER_UID,
  );
  await prisma.$executeRawUnsafe(`DELETE FROM appointments WHERE phone IN ($1, $2)`, OWNER_PHONE, ATTACKER_PHONE);
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid)`,
    OWNER_UID, ATTACKER_UID, DOCTOR_UID,
  );
}

d('Prescription PDF / by-appointment IDOR (#4)', () => {
  let ownerId; let attackerId; let doctorId; let rxId; let apptId;

  beforeAll(async () => {
    await cleanup();
    ownerId = await seedUser(OWNER_UID, OWNER_PHONE, 'PATIENT', 'Rx Owner');
    attackerId = await seedUser(ATTACKER_UID, ATTACKER_PHONE, 'PATIENT', 'Rx Attacker');
    doctorId = await seedUser(DOCTOR_UID, DOCTOR_PHONE, 'DOCTOR', 'Dr Rx');

    const appt = await prisma.$queryRawUnsafe(
      `INSERT INTO appointments
         (uid, phone, patient_id, doctor_id, appointment_date, appointment_time,
          status, department, tenant_id, updated_at)
       VALUES (gen_random_uuid(), $1, $2::int, $3::int, CURRENT_DATE, '10:00',
               'CONFIRMED', 'General Medicine', $4::uuid, NOW())
       RETURNING id`,
      OWNER_PHONE, ownerId, doctorId, TENANT,
    );
    apptId = appt[0].id;

    const rx = await prisma.$queryRawUnsafe(
      `INSERT INTO e_prescriptions
         (patient_id, patient_uid, doctor_id, doctor_uid, appointment_id,
          medications, diagnosis, status, created_by, pdf_key)
       VALUES ($1::int, $2::uuid, $3::int, $4::uuid, $5::int,
               $6::jsonb, 'Test dx', 'active', $3::int, 'rx/owner-test.pdf')
       RETURNING id`,
      ownerId, OWNER_UID, doctorId, DOCTOR_UID, apptId, '[{"name":"TestMed"}]',
    );
    rxId = rx[0].id;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  test('PATIENT cannot download ANOTHER patient PDF → 404', async () => {
    const res = await client('PATIENT', ATTACKER_UID, attackerId).get(`/api/v1/prescriptions/pdf/${rxId}`);
    expect(res.statusCode).toBe(404);
  });

  test('PATIENT CAN download their OWN PDF → 200', async () => {
    const res = await client('PATIENT', OWNER_UID, ownerId).get(`/api/v1/prescriptions/pdf/${rxId}`);
    expect(res.statusCode).toBe(200);
    expect(res.body?.data?.url).toBeTruthy();
  });

  test('DOCTOR (staff) CAN download any PDF → 200', async () => {
    const res = await client('DOCTOR', DOCTOR_UID, doctorId).get(`/api/v1/prescriptions/pdf/${rxId}`);
    expect(res.statusCode).toBe(200);
  });

  // The /appointment/:id route is staff-only by RBAC (PATIENT is not in
  // ePrescriptionAppointmentRoutes), so it is NOT a patient-IDOR surface — a
  // patient is blocked with 403 before the handler. The ownership guard added
  // to that handler is belt-and-suspenders if PATIENT is ever admitted to the
  // route. The PDF route above is the real patient-reachable IDOR.
  test('by-appointment route is staff-only — PATIENT → 403', async () => {
    const res = await client('PATIENT', OWNER_UID, ownerId).get(`/api/v1/prescriptions/appointment/${apptId}`);
    expect(res.statusCode).toBe(403);
  });

  test('DOCTOR can read prescription by appointment → 200', async () => {
    const res = await client('DOCTOR', DOCTOR_UID, doctorId).get(`/api/v1/prescriptions/appointment/${apptId}`);
    expect(res.statusCode).toBe(200);
  });
});
