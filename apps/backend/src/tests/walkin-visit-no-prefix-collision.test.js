// Regression test for finding
// 2026-05-15-dynamic-acute-abdomen-receptionist-6e92df1b
//
// `appointments.visit_no` is globally UNIQUE (idx_appointments_visit_no_unique)
// and is composed as `${deptPrefix(department)}-YYYYMMDD-${padded_token}`.
// Multiple raw department strings can map to the same prefix — e.g. NULL,
// 'General Medicine', 'Medicine', 'OPD' all → 'OPD'. The token counter
// used to scope by raw `department` text equality, so each department
// bucket restarted at 1 — and the second department's first INSERT
// collided with an existing row's visit_no, surfacing as a generic 500
// WALK_IN_FAILED.
//
// This test:
//   1. Seeds an appointment for today with department=NULL and visit_no
//      OPD-<today>-001.
//   2. POSTs a walk-in registration with department='General Medicine'
//      (different raw text, same prefix 'OPD').
//   3. Asserts the new walk-in's visit_no is OPD-<today>-002, NOT
//      OPD-<today>-001 (which would have collided).

import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import { API_KEY, generateTestToken } from './testClient.js';

const SEED_PATIENT_UID = 'a5555555-5555-4555-8555-55555555fb01';
const STAFF_UID = 'a5555555-5555-4555-8555-55555555fb02';
const RUN_SUFFIX = String(Date.now() % 100000).padStart(5, '0');
const SEED_PHONE = `99996${RUN_SUFFIX}`;
const NEW_WALKIN_PHONE = `99997${RUN_SUFFIX}`;
const PHONE_FORMS = [SEED_PHONE, `+91${SEED_PHONE}`, NEW_WALKIN_PHONE, `+91${NEW_WALKIN_PHONE}`];

function todayYYYYMMDD() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

async function cleanupFixtures() {
  const userRows = await prisma
    .$queryRawUnsafe(
      `SELECT id FROM users
       WHERE uid IN ($1::uuid, $2::uuid)
          OR phone = ANY($3::text[])`,
      SEED_PATIENT_UID,
      STAFF_UID,
      PHONE_FORMS,
    )
    .catch(() => []);
  const userIds = userRows.map((r) => r.id);
  if (userIds.length > 0) {
    await prisma
      .$executeRawUnsafe(
        'DELETE FROM appointments WHERE patient_id = ANY($1::int[]) OR created_by IN (SELECT uid FROM users WHERE id = ANY($1::int[]))',
        userIds,
      )
      .catch(() => {});
    await prisma
      .$executeRawUnsafe('DELETE FROM users WHERE id = ANY($1::int[])', userIds)
      .catch(() => {});
  }
}

describe('walk-in visit_no prefix collision regression', () => {
  let seedPatientId;
  let staffId;

  beforeAll(async () => {
    await cleanupFixtures();
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES
         ($1::uuid, $3, 'Visit No Seed Patient', 'PATIENT', true, NOW()),
         ($2::uuid, '9999660002', 'Visit No Test Staff', 'GENERAL_STAFF', true, NOW())
       RETURNING id, uid::text AS uid`,
      SEED_PATIENT_UID,
      STAFF_UID,
      SEED_PHONE,
    );
    seedPatientId = rows.find((r) => r.uid === SEED_PATIENT_UID).id;
    staffId = rows.find((r) => r.uid === STAFF_UID).id;

    // Seed a confirmed walk-in for today with department=NULL → visit_no
    // resolves to OPD-<today>-001 (the fallback prefix). The new walk-in
    // below uses department='General Medicine' which ALSO maps to OPD.
    // Without the fix, both buckets reset at token 1 and collide on
    // visit_no UNIQUE; with the fix, the second walk-in gets token 2.
    const seedVisitNo = `OPD-${todayYYYYMMDD()}-001`;
    await prisma.$executeRawUnsafe(
      `INSERT INTO appointments
         (patient_id, appointment_date, appointment_time, phone, reason,
          status, confirmed_at, token_number, visit_no, department,
          created_by, updated_at)
       VALUES
         ($1, NOW(), 'Walk-in', $2, 'Seed', 'CONFIRMED', NOW(),
          '1', $3, NULL, $4::uuid, NOW())`,
      seedPatientId,
      SEED_PHONE,
      seedVisitNo,
      STAFF_UID,
    );
  });

  afterAll(async () => {
    await cleanupFixtures();
    await prisma.$disconnect().catch(() => {});
  });

  it("assigns token=2 (not token=1) when another prefix-equivalent department already used token=1 today", async () => {
    const token = generateTestToken('GENERAL_STAFF', { uid: STAFF_UID, id: staffId });

    const res = await request(app)
      .post('/api/v1/appointments/walk-in')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${token}`)
      .send({
        patient_name: 'General Medicine Patient',
        patient_phone: NEW_WALKIN_PHONE,
        patient_gender: 'M',
        department: 'General Medicine',
        reason: 'Acute abdominal pain',
        visit_type: 'NEW',
      });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.token_number).toBe('2');
    expect(res.body.data.visit_no).toBe(`OPD-${todayYYYYMMDD()}-002`);
    expect(res.body.data.department).toBe('General Medicine');
  });
});
