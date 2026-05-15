// Regression test for finding
// 2026-05-08-walk-in-opd-pharmacy-prescription-phone-filter-leaks-all-patients
//
// GET /api/v1/prescriptions/all?phone=X must restrict the response to the
// matching patient. Before commit 75e9d40d the controller dropped the phone
// param on the floor and returned every prescription in the database (PHI
// leak). This test guards against the regression by inserting two patients,
// one prescription each, and asserting the filter actually narrows.

import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import { API_KEY, generateTestToken } from './testClient.js';

const PATIENT_A_UID = 'a5555555-5555-4555-8555-55555555fa01';
const PATIENT_B_UID = 'a5555555-5555-4555-8555-55555555fa02';
const DOCTOR_UID = 'a5555555-5555-4555-8555-55555555fa03';
const STAFF_UID = 'a5555555-5555-4555-8555-55555555fa04';

const PATIENT_A_PHONE = '9999110001';
const PATIENT_B_PHONE = '9999110002';

async function cleanupFixtures() {
  const rows = await prisma
    .$queryRawUnsafe(
      `SELECT id FROM users
       WHERE uid IN ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
      PATIENT_A_UID,
      PATIENT_B_UID,
      DOCTOR_UID,
      STAFF_UID
    )
    .catch(() => []);
  const ids = rows.map(r => r.id);
  if (ids.length > 0) {
    await prisma
      .$executeRawUnsafe(
        `DELETE FROM e_prescriptions WHERE patient_id = ANY($1::int[]) OR doctor_id = ANY($1::int[])`,
        ids
      )
      .catch(() => {});
  }
  await prisma
    .$executeRawUnsafe(
      `DELETE FROM users
       WHERE uid IN ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
      PATIENT_A_UID,
      PATIENT_B_UID,
      DOCTOR_UID,
      STAFF_UID
    )
    .catch(() => {});
}

describe('GET /prescriptions/all — phone filter regression', () => {
  let patientAId;
  let patientBId;
  let doctorId;
  let staffId;

  beforeAll(async () => {
    await cleanupFixtures();
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES
         ($1::uuid, $5, 'Phone Filter Patient A', 'PATIENT', true, NOW()),
         ($2::uuid, $6, 'Phone Filter Patient B', 'PATIENT', true, NOW()),
         ($3::uuid, '9999110003', 'Phone Filter Doctor', 'DOCTOR', true, NOW()),
         ($4::uuid, '9999110004', 'Phone Filter Nurse', 'NURSING_STAFF', true, NOW())
       RETURNING id, uid::text AS uid`,
      PATIENT_A_UID,
      PATIENT_B_UID,
      DOCTOR_UID,
      STAFF_UID,
      PATIENT_A_PHONE,
      PATIENT_B_PHONE
    );
    patientAId = rows.find(r => r.uid === PATIENT_A_UID).id;
    patientBId = rows.find(r => r.uid === PATIENT_B_UID).id;
    doctorId = rows.find(r => r.uid === DOCTOR_UID).id;
    staffId = rows.find(r => r.uid === STAFF_UID).id;

    await prisma.$executeRawUnsafe(
      `INSERT INTO e_prescriptions
         (patient_id, doctor_id, medications, status, created_by)
       VALUES
         ($1, $3, $4::jsonb, 'active', $5),
         ($2, $3, $4::jsonb, 'active', $5)`,
      patientAId,
      patientBId,
      doctorId,
      JSON.stringify([{ name: 'Paracetamol', dosage: '500mg' }]),
      staffId
    );
  });

  afterAll(async () => {
    await cleanupFixtures();
    await prisma.$disconnect().catch(() => {});
  });

  it('returns only the matching patient when ?phone=<patientA> is supplied', async () => {
    const token = generateTestToken('PHARMACY_STAFF', {
      uid: STAFF_UID,
      id: staffId,
      phone: '9999110004'
    });

    const res = await request(app)
      .get(`/api/v1/prescriptions/all?phone=${PATIENT_A_PHONE}`)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${token}`);

    expect(res.statusCode).toBe(200);
    const patientIds = res.body.data.map(rx => rx.patient_id);
    expect(patientIds).toContain(patientAId);
    expect(patientIds).not.toContain(patientBId);
  });

  it('returns nothing when ?phone matches no patient', async () => {
    const token = generateTestToken('PHARMACY_STAFF', {
      uid: STAFF_UID,
      id: staffId,
      phone: '9999110004'
    });

    const res = await request(app)
      .get('/api/v1/prescriptions/all?phone=0000000000')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${token}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  // Regression coverage for finding
  // 2026-05-15-pediatric-opd-pharmacy-34cc16a5
  //
  // Pre-fix, ?prescription_number, ?patient_id, and ?visit_no were
  // silently ignored — the response leaked unrelated patients' Rx rows.
  // For pharmacy counter dispense-against-the-paper-Rx flows this is a
  // wrong-patient-dispensing risk.
  it('returns only the matching prescription when ?prescription_number is supplied', async () => {
    const token = generateTestToken('PHARMACY_STAFF', {
      uid: STAFF_UID,
      id: staffId,
      phone: '9999110004'
    });

    // Find one of the seeded Rx numbers (generated server-side as RX-...).
    const seededRows = await prisma.$queryRawUnsafe(
      `SELECT prescription_number, patient_id
         FROM e_prescriptions
        WHERE patient_id = $1::int
        ORDER BY id DESC LIMIT 1`,
      patientAId,
    );
    const rxNumber = seededRows[0].prescription_number;

    const res = await request(app)
      .get(`/api/v1/prescriptions/all?prescription_number=${encodeURIComponent(rxNumber)}`)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${token}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].prescription_number).toBe(rxNumber);
    expect(res.body.data[0].patient_id).toBe(patientAId);
  });

  it('returns only the matching patient when ?patient_id is supplied', async () => {
    const token = generateTestToken('PHARMACY_STAFF', {
      uid: STAFF_UID,
      id: staffId,
      phone: '9999110004'
    });

    const res = await request(app)
      .get(`/api/v1/prescriptions/all?patient_id=${patientBId}`)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${token}`);

    expect(res.statusCode).toBe(200);
    const patientIds = res.body.data.map(rx => rx.patient_id);
    expect(patientIds).toContain(patientBId);
    expect(patientIds).not.toContain(patientAId);
  });

  it('returns nothing for an unknown prescription_number', async () => {
    const token = generateTestToken('PHARMACY_STAFF', {
      uid: STAFF_UID,
      id: staffId,
      phone: '9999110004'
    });

    const res = await request(app)
      .get('/api/v1/prescriptions/all?prescription_number=RX-does-not-exist-zzzzz')
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${token}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});
