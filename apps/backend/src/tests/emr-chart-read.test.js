// Regression coverage for doctor chart reads used by swarm journeys.
// The chart should tolerate patients that have no encounter/admission row yet.

import { API_KEY, generateTestToken } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const PATIENT_UID = 'a6666666-6666-4666-8666-666666666a01';
const DOCTOR_UID = 'a6666666-6666-4666-8666-666666666a02';
const RECEPTIONIST_UID = 'a6666666-6666-4666-8666-666666666a03';
const PATIENT_PHONE = '9000060001';
const ORDER_NUMBER = 'TEST-CHART-ORDER-0001';
const TENANT_ID = '00000000-0000-4000-8000-000000000001';

function doctorAs(uid = DOCTOR_UID) {
  const token = generateTestToken('DOCTOR', { uid, id: 990601 });
  return {
    get: (path) => request(app)
      .get(path)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${token}`),
  };
}

function receptionistAs(uid = RECEPTIONIST_UID) {
  const token = generateTestToken('RECEPTIONIST', { uid, id: 990602 });
  return {
    get: (path) => request(app)
      .get(path)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${token}`),
  };
}

async function clearCareTeam() {
  await prisma.$executeRawUnsafe(`DELETE FROM care_team_members WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM care_teams WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
}

describe('EMR chart read endpoints', () => {
  const doctor = doctorAs();
  const receptionist = receptionistAs();

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_orders WHERE patient_uid = $1::uuid`, PATIENT_UID);
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_notes WHERE patient_uid = $1::uuid`, PATIENT_UID);
    await clearCareTeam();
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid)`,
      PATIENT_UID,
      DOCTOR_UID,
      RECEPTIONIST_UID,
    );

    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, status, updated_at)
       VALUES ($1::uuid, $2, 'Chart Read Test Patient', 'PATIENT', true, 'active', NOW())`,
      PATIENT_UID,
      PATIENT_PHONE);

    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, status, updated_at)
       VALUES ($1::uuid, '9000060002', 'Chart Read Test Doctor', 'DOCTOR', true, 'active', NOW())`,
      DOCTOR_UID);

    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, status, updated_at)
       VALUES ($1::uuid, '9000060003', 'Chart Read Receptionist', 'RECEPTIONIST', true, 'active', NOW())`,
      RECEPTIONIST_UID);

    const careTeam = await prisma.$queryRawUnsafe(
      `INSERT INTO care_teams
         (tenant_id, patient_uid, team_kind, display_name, status, created_by, updated_at)
       VALUES ($1::uuid, $2::uuid, 'op', 'Chart read front-office team', 'active', $3::uuid, NOW())
       RETURNING id`,
      TENANT_ID,
      PATIENT_UID,
      RECEPTIONIST_UID,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO care_team_members
         (tenant_id, care_team_id, patient_uid, staff_uid, staff_role, member_name,
          relationship_kind, break_glass_allowed, created_by, updated_at)
       VALUES ($1::uuid, $2::int, $3::uuid, $4::uuid, 'RECEPTIONIST', 'Chart Read Receptionist',
               'care_coordinator', false, $4::uuid, NOW())`,
      TENANT_ID,
      careTeam[0].id,
      PATIENT_UID,
      RECEPTIONIST_UID,
    );

    await prisma.$executeRawUnsafe(
      `INSERT INTO clinical_orders
         (order_number, patient_uid, order_type, priority, details, status, ordered_by, notes, updated_at)
       VALUES
         ($1, $2::uuid, 'medication', 'routine', $3::jsonb, 'ordered', $4::uuid, 'chart read order', NOW())`,
      ORDER_NUMBER,
      PATIENT_UID,
      JSON.stringify({ medication: 'Test Paracetamol' }),
      DOCTOR_UID);

    await prisma.$executeRawUnsafe(
      `INSERT INTO clinical_notes
         (patient_uid, author_uid, author_role, note_type, title, content, is_signed, updated_at)
       VALUES
         ($1::uuid, $2::uuid, 'DOCTOR', 'progress', 'Chart read progress note', $3::jsonb, true, NOW())`,
      PATIENT_UID,
      DOCTOR_UID,
      JSON.stringify({ subjective: 'Improving', assessment: 'Stable' }));
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_orders WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_notes WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await clearCareTeam();
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid)`,
      PATIENT_UID,
      DOCTOR_UID,
      RECEPTIONIST_UID,
    ).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  it('returns patient clinical orders without a 500', async () => {
    const res = await doctor.get(`/api/v1/emr/orders/patient/${PATIENT_UID}?limit=20`);

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({
      order_number: ORDER_NUMBER,
      patient_uid: PATIENT_UID,
      order_type: 'medication',
    });
  });

  it('returns patient clinical notes without a 500', async () => {
    const res = await doctor.get(`/api/v1/emr/notes/patient/${PATIENT_UID}?limit=5`);

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({
      patient_uid: PATIENT_UID,
      note_type: 'progress',
    });
  });

  it('lets reception open the patient timeline without unlocking EMR notes', async () => {
    const timeline = await receptionist.get(`/api/v1/emr/timeline/${PATIENT_UID}`);

    expect(timeline.statusCode).toBe(200);
    expect(Array.isArray(timeline.body.data)).toBe(true);

    const notes = await receptionist.get(`/api/v1/emr/notes/patient/${PATIENT_UID}?limit=5`);

    expect(notes.statusCode).toBe(403);
  });
});
