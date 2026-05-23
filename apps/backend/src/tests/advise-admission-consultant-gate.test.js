// Regression test for finding H' D37 (ee096dc7).
//
// `POST /api/v1/appointments/:id/advise-admission` previously allowed
// JUNIOR_DOCTOR to record admission advice independently. Indian
// clinical practice (and the consultant-led admission discipline
// this hospital runs) requires consultant sign-off — a junior may
// flag the case but the admission decision is the consultant's. The
// fix drops JUNIOR_DOCTOR from the role allowlist.
//
// Asserts:
//   * DOCTOR / CONSULTANT / SENIOR_DOCTOR / ADMIN / SUPER_ADMIN can
//     still advise (200, advice timestamp set on the appointment).
//   * JUNIOR_DOCTOR is now blocked with 403 ADVISE_ADMISSION_ROLE_REQUIRED.
//   * NURSE / RECEPTIONIST stay blocked (unchanged behaviour).

import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import { API_KEY, generateTestToken } from './testClient.js';

const STAMP = String(Date.now() % 100000).padStart(5, '0');
const CONSULTANT_UID = 'e1111111-1111-4111-8111-aaaaaaaa9921';
const JUNIOR_DOCTOR_UID = 'e1111111-1111-4111-8111-aaaaaaaa9922';
const NURSE_UID = 'e1111111-1111-4111-8111-aaaaaaaa9923';
const PATIENT_UID = 'e1111111-1111-4111-8111-aaaaaaaa9924';

let consultantId;
let juniorId;
let nurseId;
let patientId;
let appointmentId;

async function ensureUser(uid, role, phone) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
     VALUES ($1::uuid, $2, $3, $4, true, NOW())
     ON CONFLICT (uid) DO UPDATE SET role = EXCLUDED.role, updated_at = NOW()
     RETURNING id`,
    uid, phone, `D37 ${role}`, role,
  );
  return rows[0].id;
}

describe('POST /appointments/:id/advise-admission — drop JUNIOR_DOCTOR from allowlist (H D37)', () => {
  beforeAll(async () => {
    consultantId = await ensureUser(CONSULTANT_UID, 'CONSULTANT', `99500100${STAMP.slice(-2)}`);
    juniorId = await ensureUser(JUNIOR_DOCTOR_UID, 'JUNIOR_DOCTOR', `99500200${STAMP.slice(-2)}`);
    nurseId = await ensureUser(NURSE_UID, 'NURSING_STAFF', `99500300${STAMP.slice(-2)}`);
    patientId = await ensureUser(PATIENT_UID, 'PATIENT', `99500400${STAMP.slice(-2)}`);

    // Dev DB doesn't carry appointments.tenant_id (migration 075).
    // CI does. Probe + branch so the seed works against either shape.
    const colCheck = await prisma.$queryRawUnsafe(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'appointments' AND column_name = 'tenant_id'`,
    );
    const hasTenantCol = colCheck.length > 0;
    const apptRows = hasTenantCol
      ? await prisma.$queryRawUnsafe(
          `INSERT INTO appointments
             (uid, phone, patient_id, doctor_id, appointment_date, appointment_time,
              status, department, tenant_id, updated_at)
           VALUES (gen_random_uuid(), $1, $2::int, $3::int,
                   CURRENT_DATE, '10:00', 'CONFIRMED', 'General Medicine',
                   '00000000-0000-4000-8000-000000000001'::uuid, NOW())
           RETURNING id`,
          `99500400${STAMP.slice(-2)}`, patientId, consultantId,
        )
      : await prisma.$queryRawUnsafe(
          `INSERT INTO appointments
             (uid, phone, patient_id, doctor_id, appointment_date, appointment_time,
              status, department, updated_at)
           VALUES (gen_random_uuid(), $1, $2::int, $3::int,
                   CURRENT_DATE, '10:00', 'CONFIRMED', 'General Medicine',
                   NOW())
           RETURNING id`,
          `99500400${STAMP.slice(-2)}`, patientId, consultantId,
        );
    appointmentId = apptRows[0].id;
  });

  afterAll(async () => {
    if (appointmentId) {
      await prisma.$executeRawUnsafe(`DELETE FROM appointments WHERE id = $1::int`, appointmentId).catch(() => {});
    }
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
      CONSULTANT_UID, JUNIOR_DOCTOR_UID, NURSE_UID, PATIENT_UID,
    ).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  it('JUNIOR_DOCTOR is now blocked (403 ADVISE_ADMISSION_ROLE_REQUIRED)', async () => {
    const token = generateTestToken('JUNIOR_DOCTOR', { uid: JUNIOR_DOCTOR_UID, id: juniorId });
    const res = await request(app)
      .post(`/api/v1/appointments/${appointmentId}/advise-admission`)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${token}`)
      .send({ note: 'Suspect acute appendicitis' });
    expect(res.statusCode).toBe(403);
    expect(res.body?.code === 'ADVISE_ADMISSION_ROLE_REQUIRED'
      || res.body?.details?.code === 'ADVISE_ADMISSION_ROLE_REQUIRED').toBe(true);
    expect(String(res.body?.message || '')).toMatch(/consultant/i);
  });

  it('NURSING_STAFF still blocked', async () => {
    const token = generateTestToken('NURSING_STAFF', { uid: NURSE_UID, id: nurseId });
    const res = await request(app)
      .post(`/api/v1/appointments/${appointmentId}/advise-admission`)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${token}`)
      .send({ note: 'Patient unwell' });
    expect(res.statusCode).toBe(403);
  });

  it('CONSULTANT can still advise (200, advice timestamp set)', async () => {
    const token = generateTestToken('CONSULTANT', { uid: CONSULTANT_UID, id: consultantId });
    const res = await request(app)
      .post(`/api/v1/appointments/${appointmentId}/advise-admission`)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${token}`)
      .send({ note: 'Admit for IV antibiotics' });
    expect(res.statusCode).toBe(200);
    expect(res.body.data.advised_for_admission_at).toBeTruthy();
  });
});
