// Regression coverage for doctor chart reads used by swarm journeys.
// The chart should tolerate patients that have no encounter/admission row yet.

import { API_KEY, generateTestToken } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const PATIENT_UID = 'a6666666-6666-4666-8666-666666666a01';
const DOCTOR_UID = 'a6666666-6666-4666-8666-666666666a02';
const PATIENT_PHONE = '9000060001';
const ORDER_NUMBER = 'TEST-CHART-ORDER-0001';

function doctorAs(uid = DOCTOR_UID) {
  const token = generateTestToken('DOCTOR', { uid, id: 990601 });
  return {
    get: (path) => request(app)
      .get(path)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${token}`),
  };
}

describe('EMR chart read endpoints', () => {
  const doctor = doctorAs();

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_orders WHERE patient_uid = $1::uuid`, PATIENT_UID);
    await prisma.$executeRawUnsafe(`DELETE FROM clinical_notes WHERE patient_uid = $1::uuid`, PATIENT_UID);
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`, PATIENT_UID, DOCTOR_UID);

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
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`, PATIENT_UID, DOCTOR_UID).catch(() => {});
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
});
