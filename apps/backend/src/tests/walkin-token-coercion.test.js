// Regression test for finding
// 2026-05-09-dynamic-acute-abdomen-receptionist-walkin-token-type-coercion-crash
//
// `appointments.token_number` is varchar(20) and may carry composite tokens
// like 'EMER-001' alongside plain numeric tokens. The walk-in token counter
// query previously ran `COALESCE(MAX(token_number), 0) + 1` — Postgres
// raised "COALESCE types text and integer cannot be matched" so EVERY
// walk-in registration 500'd. The fix in commit e041bd42 added
// `NULLIF(token_number,'')::int` plus a `~ '^[0-9]+$'` row filter so
// non-numeric tokens are skipped before the cast. This test seeds a non-
// numeric token in the same (date, department) bucket and asserts the
// walk-in registration succeeds and assigns the next *numeric* slot.

import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import { API_KEY, generateTestToken } from './testClient.js';

const SEED_PATIENT_UID = 'a5555555-5555-4555-8555-55555555fc01';
const STAFF_UID = 'a5555555-5555-4555-8555-55555555fc02';
const TEST_DEPARTMENT = `WalkInTest-${Date.now() % 100000}`;
const SEED_PHONE = `99994${Date.now() % 100000}`.slice(0, 10);
const NEW_WALKIN_PHONE = `99995${Date.now() % 100000}`.slice(0, 10);

async function cleanupFixtures() {
  const userRows = await prisma
    .$queryRawUnsafe(
      `SELECT id FROM users
       WHERE uid IN ($1::uuid, $2::uuid)
          OR phone = $3
          OR phone = $4`,
      SEED_PATIENT_UID,
      STAFF_UID,
      SEED_PHONE,
      NEW_WALKIN_PHONE
    )
    .catch(() => []);
  const userIds = userRows.map(r => r.id);
  if (userIds.length > 0) {
    await prisma
      .$executeRawUnsafe(
        `DELETE FROM appointment_status_history
         WHERE appointment_id IN (
           SELECT id FROM appointments WHERE patient_id = ANY($1::int[])
         )`,
        userIds
      )
      .catch(() => {});
    await prisma
      .$executeRawUnsafe(
        `DELETE FROM appointments WHERE patient_id = ANY($1::int[])`,
        userIds
      )
      .catch(() => {});
  }
  await prisma
    .$executeRawUnsafe(
      `DELETE FROM users
       WHERE uid IN ($1::uuid, $2::uuid)
          OR phone = $3
          OR phone = $4`,
      SEED_PATIENT_UID,
      STAFF_UID,
      SEED_PHONE,
      NEW_WALKIN_PHONE
    )
    .catch(() => {});
}

describe('POST /appointments/walk-in — token counter type coercion', () => {
  let seedPatientId;
  let staffId;

  beforeAll(async () => {
    await cleanupFixtures();
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES
         ($1::uuid, $3, 'Walk-in Seed Patient', 'PATIENT', true, NOW()),
         ($2::uuid, '9999440002', 'Walk-in Test Staff', 'GENERAL_STAFF', true, NOW())
       RETURNING id, uid::text AS uid`,
      SEED_PATIENT_UID,
      STAFF_UID,
      SEED_PHONE
    );
    seedPatientId = rows.find(r => r.uid === SEED_PATIENT_UID).id;
    staffId = rows.find(r => r.uid === STAFF_UID).id;

    // Seed a confirmed appointment for today, same department, with a
    // non-numeric token. Pre-fix this row alone made MAX(token_number)
    // crash with the COALESCE type mismatch.
    await prisma.$executeRawUnsafe(
      `INSERT INTO appointments
         (patient_id, appointment_date, appointment_time, phone, reason,
          status, confirmed_at, token_number, department, created_by, updated_at)
       VALUES
         ($1, NOW(), 'Walk-in', $2, 'Seed', 'CONFIRMED', NOW(), 'EMER-001', $3, $4::uuid, NOW())`,
      seedPatientId,
      SEED_PHONE,
      TEST_DEPARTMENT,
      STAFF_UID
    );
  });

  afterAll(async () => {
    await cleanupFixtures();
    await prisma.$disconnect().catch(() => {});
  });

  it('returns 200 with token_number=1 even when a non-numeric token sits in the same (date, department) bucket', async () => {
    const token = generateTestToken('GENERAL_STAFF', { uid: STAFF_UID, id: staffId });

    const res = await request(app)
      .post('/api/v1/appointments/walk-in')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${token}`)
      .send({
        patient_name: 'Priya Iyer',
        patient_phone: NEW_WALKIN_PHONE,
        patient_gender: 'F',
        department: TEST_DEPARTMENT,
        reason: 'Acute abdominal pain',
        visit_type: 'NEW'
      });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.token_number).toBe('1');
    expect(res.body.data.department).toBe(TEST_DEPARTMENT);
  });
});
