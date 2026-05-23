// Regression test for finding cluster H' D65 (55a91186 + 6e610cd1).
//
// Phone-booked follow-up appointments confirmed via
// `POST /api/v1/appointments/:id/confirm` got a `token_number` but
// NO `visit_no`. The reception counter search-by-visit_no surface
// (used for receiving the patient at the door) found nothing, so
// the patient had to be re-registered as a fresh walk-in even
// though they had a real CONFIRMED appointment. Plus the token
// counter was global-per-day (cross-department), so concurrent
// confirmations across departments could collide on the visit_no
// UNIQUE constraint.
//
// Fix:
//   * Confirm now computes + persists a deterministic visit_no using
//     the same composeVisitNo helper the walk-in path uses
//     (department prefix + YYYYMMDD + 3-digit token).
//   * Token counter is scoped to the dept-prefix slice of visit_no
//     so cross-department same-day confirmations don't collide.
//   * Re-confirming a row that already has a visit_no preserves the
//     existing one (idempotent on retry).
//
// Asserts:
//   * A confirm assigns visit_no matching the deptPrefix+YYYYMMDD format.
//   * Two confirms across departments on the same day land on
//     distinct visit_no values (no collision).
//   * Re-confirming a row that already has a visit_no leaves it
//     unchanged.

import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import { API_KEY, generateTestToken } from './testClient.js';

const STAMP = String(Date.now() % 100000).padStart(5, '0');
const STAFF_UID = 'e8888888-8888-4888-8888-aaaaaaaa6501';
const PATIENT_UID = 'e8888888-8888-4888-8888-aaaaaaaa6502';
const DOCTOR_UID = 'e8888888-8888-4888-8888-aaaaaaaa6503';

let staffId;
let patientId;
let doctorId;
let staffToken;
const createdApptIds = [];

async function ensureUser(uid, role, phone, name) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
     VALUES ($1::uuid, $2, $3, $4, true, NOW())
     ON CONFLICT (uid) DO UPDATE SET updated_at = NOW()
     RETURNING id`,
    uid, phone, name, role,
  );
  return rows[0].id;
}

async function seedAppointment({ department }) {
  // Dev DB may not carry appointments.tenant_id (migration 075). Probe.
  const colCheck = await prisma.$queryRawUnsafe(
    `SELECT 1 FROM information_schema.columns
      WHERE table_name = 'appointments' AND column_name = 'tenant_id'`,
  );
  const rows = colCheck.length > 0
    ? await prisma.$queryRawUnsafe(
        `INSERT INTO appointments
           (uid, phone, patient_id, doctor_id, appointment_date,
            appointment_time, status, department, tenant_id, updated_at)
         VALUES (gen_random_uuid(), $1, $2::int, $3::int,
                 CURRENT_DATE + INTERVAL '1 day', '11:00', 'PENDING', $4,
                 '00000000-0000-4000-8000-000000000001'::uuid, NOW())
         RETURNING id`,
        '9700655001', patientId, doctorId, department,
      )
    : await prisma.$queryRawUnsafe(
        `INSERT INTO appointments
           (uid, phone, patient_id, doctor_id, appointment_date,
            appointment_time, status, department, updated_at)
         VALUES (gen_random_uuid(), $1, $2::int, $3::int,
                 CURRENT_DATE + INTERVAL '1 day', '11:00', 'PENDING', $4,
                 NOW())
         RETURNING id`,
        '9700655001', patientId, doctorId, department,
      );
  createdApptIds.push(rows[0].id);
  return rows[0].id;
}

describe('POST /appointments/:id/confirm — visit_no assignment (H D65)', () => {
  beforeAll(async () => {
    staffId = await ensureUser(STAFF_UID, 'RECEPTIONIST', `97006550${STAMP.slice(-2)}`, 'D65 Reception');
    patientId = await ensureUser(PATIENT_UID, 'PATIENT', `97006551${STAMP.slice(-2)}`, 'D65 Patient');
    doctorId = await ensureUser(DOCTOR_UID, 'DOCTOR', `97006552${STAMP.slice(-2)}`, 'D65 Doctor');
    staffToken = generateTestToken('RECEPTIONIST', { uid: STAFF_UID, id: staffId });
  });

  afterAll(async () => {
    for (const id of createdApptIds) {
      await prisma.$executeRawUnsafe(`DELETE FROM appointment_status_history WHERE appointment_id = $1::int`, id).catch(() => {});
      await prisma.$executeRawUnsafe(`DELETE FROM appointments WHERE id = $1::int`, id).catch(() => {});
    }
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid)`,
      STAFF_UID, PATIENT_UID, DOCTOR_UID,
    ).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  it('assigns a visit_no on confirm', async () => {
    const apptId = await seedAppointment({ department: 'General Medicine' });
    const res = await request(app)
      .post(`/api/v1/appointments/${apptId}/confirm`)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({});
    expect(res.statusCode).toBe(200);
    expect(res.body.data.visit_no).toMatch(/^[A-Z]{2,5}-\d{8}-\d{3}$/);
  });

  it('cross-department same-day confirms produce distinct visit_no (no UNIQUE collision)', async () => {
    const apptA = await seedAppointment({ department: 'Cardiology' });
    const apptB = await seedAppointment({ department: 'Dermatology' });

    const resA = await request(app)
      .post(`/api/v1/appointments/${apptA}/confirm`)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({});
    const resB = await request(app)
      .post(`/api/v1/appointments/${apptB}/confirm`)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({});

    expect(resA.statusCode).toBe(200);
    expect(resB.statusCode).toBe(200);
    expect(resA.body.data.visit_no).not.toBe(resB.body.data.visit_no);
    // Different department prefixes → no collision possible.
    const prefixA = resA.body.data.visit_no.split('-')[0];
    const prefixB = resB.body.data.visit_no.split('-')[0];
    expect(prefixA).not.toBe(prefixB);
  });

  it('re-confirm preserves an existing visit_no (idempotent on retry)', async () => {
    const apptId = await seedAppointment({ department: 'Paediatrics' });
    const first = await request(app)
      .post(`/api/v1/appointments/${apptId}/confirm`)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({});
    expect(first.statusCode).toBe(200);
    const firstVisit = first.body.data.visit_no;
    expect(firstVisit).toBeTruthy();

    const second = await request(app)
      .post(`/api/v1/appointments/${apptId}/confirm`)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({});
    expect(second.statusCode).toBe(200);
    expect(second.body.data.visit_no).toBe(firstVisit);
  });
});
