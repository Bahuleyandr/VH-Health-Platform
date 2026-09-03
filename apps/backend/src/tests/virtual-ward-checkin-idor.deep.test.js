// Virtual-ward check-in staff IDOR regression (#7).
//
// submitCheckIn locked PATIENT callers to themselves but applied NO check to
// STAFF callers — any in-scope staff role could submit a fabricated check-in
// for an ARBITRARY enrolled patient (triggering or noise-suppressing clinical
// escalations). These prove a non-care-manager staff member is blocked, while
// the assigned care manager, an admin, and the patient themselves are allowed.
//
// Needs the test Postgres (DATABASE_URL / TEST_DATABASE_URL, default
// 127.0.0.1:55432 db vhhealth_test). Self-skips when unconfigured.

import { generateTestToken, ensureTestIdentity } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const API_KEY = process.env.API_KEY || 'test-api-key';
const TENANT = '00000000-0000-4000-8000-000000000001';
const CHECK_IN = '/api/v1/patient/virtual-ward/check-in';

const PATIENT_UID = 'f7700000-0000-4000-8000-0000000007a1';
const PATIENT_PHONE = '+919000070701';
const CARE_MANAGER_UID = 'f7700000-0000-4000-8000-0000000007b2';
const CARE_MANAGER_PHONE = '+919000070702';
const OTHER_STAFF_UID = 'f7700000-0000-4000-8000-0000000007c3';
// Oversight actor, used inline below and never inserted by this suite.
const OVERSIGHT_UID = 'f7700000-0000-4000-8000-0000000007d4';
const OTHER_STAFF_PHONE = '+919000070703';

function client(role, uid, intId) {
  const token = generateTestToken(role, { uid, id: intId });
  return {
    post: (p, body) =>
      request(app).post(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`).send(body),
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
  await prisma.$executeRawUnsafe(`DELETE FROM virtual_ward_check_ins WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM virtual_ward_escalations WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM virtual_ward_enrollments WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid)`,
    PATIENT_UID, CARE_MANAGER_UID, OTHER_STAFF_UID,
  );
}

d('Virtual-ward check-in staff IDOR (#7)', () => {
  let patientId; let careManagerId; let otherStaffId;

  beforeAll(async () => {
    await cleanup();
    patientId = await seedUser(PATIENT_UID, PATIENT_PHONE, 'PATIENT', 'VW Patient');
    careManagerId = await seedUser(CARE_MANAGER_UID, CARE_MANAGER_PHONE, 'DOCTOR', 'VW Care Mgr');
    otherStaffId = await seedUser(OTHER_STAFF_UID, OTHER_STAFF_PHONE, 'DOCTOR', 'VW Other');
    await prisma.$queryRawUnsafe(
      `INSERT INTO virtual_ward_enrollments
         (tenant_id, patient_uid, care_manager_uid, pathway, start_date,
          expected_check_in_cadence_hours, metadata, status, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'generic_post_discharge', CURRENT_DATE,
               24, '{}'::jsonb, 'active', NOW(), NOW())`,
      TENANT, PATIENT_UID, CARE_MANAGER_UID,
    );
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  test('non-care-manager staff CANNOT submit a check-in for the patient → 403', async () => {
    const res = await client('DOCTOR', OTHER_STAFF_UID, otherStaffId).post(CHECK_IN, { patient_uid: PATIENT_UID });
    expect(res.statusCode).toBe(403);
  });

  test('the assigned care manager CAN submit → 201', async () => {
    const res = await client('DOCTOR', CARE_MANAGER_UID, careManagerId).post(CHECK_IN, { patient_uid: PATIENT_UID });
    expect(res.statusCode).toBe(201);
  });

  test('the patient CAN submit for themselves → 201', async () => {
    const res = await client('PATIENT', PATIENT_UID, patientId).post(CHECK_IN, { patient_uid: PATIENT_UID });
    expect(res.statusCode).toBe(201);
  });

  beforeAll(async () => {

    await ensureTestIdentity(OVERSIGHT_UID, { role: 'SUPER_ADMIN' });

  });


  test('SUPER_ADMIN (oversight) CAN submit → 201', async () => {
    const res = await client('SUPER_ADMIN', OVERSIGHT_UID, 999).post(CHECK_IN, { patient_uid: PATIENT_UID });
    expect(res.statusCode).toBe(201);
  });
});
