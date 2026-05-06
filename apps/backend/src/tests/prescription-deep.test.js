import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';
import { API_KEY, generateTestToken } from './testClient.js';
import { validatePrescriptionSafety } from '../utils/clinical/prescriptionSafetyCheck.js';

const PATIENT_UID = 'a5555555-5555-4555-8555-555555555a01';
const DOCTOR_UID = 'a5555555-5555-4555-8555-555555555a02';
const STAFF_UID = 'a5555555-5555-4555-8555-555555555a03';

function staffAs(id) {
  const token = generateTestToken('NURSING_STAFF', {
    uid: STAFF_UID,
    id,
    phone: '9000050003'
  });
  return {
    post: path =>
      request(app).post(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`)
  };
}

async function cleanupFixtures(patientId, doctorId) {
  const existingUsers = await prisma
    .$queryRawUnsafe(
      `SELECT id, uid::text AS uid
     FROM users
     WHERE uid IN ($1::uuid, $2::uuid, $3::uuid)`,
      PATIENT_UID,
      DOCTOR_UID,
      STAFF_UID
    )
    .catch(() => []);
  const resolvedPatientId = patientId || existingUsers.find(row => row.uid === PATIENT_UID)?.id;
  const resolvedDoctorId = doctorId || existingUsers.find(row => row.uid === DOCTOR_UID)?.id;

  if (resolvedPatientId || resolvedDoctorId) {
    await prisma
      .$executeRawUnsafe(
        `DELETE FROM prescription_safety_overrides
       WHERE patient_id = $1 OR doctor_id = $2`,
        resolvedPatientId || -1,
        resolvedDoctorId || -1
      )
      .catch(() => {});
    await prisma
      .$executeRawUnsafe(
        `DELETE FROM e_prescriptions
       WHERE patient_id = $1 OR doctor_id = $2`,
        resolvedPatientId || -1,
        resolvedDoctorId || -1
      )
      .catch(() => {});
  }
  await prisma
    .$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid)`,
      PATIENT_UID,
      DOCTOR_UID,
      STAFF_UID
    )
    .catch(() => {});
}

describe('E-prescriptions — deep integration', () => {
  let patientId;
  let doctorId;
  let staffId;

  beforeAll(async () => {
    await cleanupFixtures();
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES
         ($1::uuid, '9000050001', 'Prescription Test Patient', 'PATIENT', true, NOW()),
         ($2::uuid, '9000050002', 'Prescription Test Doctor', 'DOCTOR', true, NOW()),
         ($3::uuid, '9000050003', 'Prescription Test Nurse', 'NURSING_STAFF', true, NOW())
       RETURNING id, uid`,
      PATIENT_UID,
      DOCTOR_UID,
      STAFF_UID
    );
    patientId = rows.find(row => row.uid === PATIENT_UID).id;
    doctorId = rows.find(row => row.uid === DOCTOR_UID).id;
    staffId = rows.find(row => row.uid === STAFF_UID).id;
  });

  afterAll(async () => {
    await cleanupFixtures(patientId, doctorId);
    await prisma.$disconnect().catch(() => {});
  });

  it('checks duplicate active medicines from the current jsonb prescription schema', async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO e_prescriptions (patient_id, doctor_id, medications, follow_up_date, status, created_by)
       VALUES ($1, $2, $3::jsonb, CURRENT_DATE + INTERVAL '7 days', 'active', $4)`,
      patientId,
      doctorId,
      JSON.stringify([{ name: 'Paracetamol', dosage: '650mg' }]),
      staffId
    );

    const safety = await validatePrescriptionSafety(patientId, [
      { name: 'Paracetamol', dosage: '650mg' }
    ]);

    expect(safety.safe).toBe(true);
    expect(safety.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'DUPLICATE_MEDICATION',
          medication: 'Paracetamol'
        })
      ])
    );
  });

  it('creates a structured prescription with medications and vitals stored as jsonb', async () => {
    const res = await staffAs(staffId)
      .post('/api/v1/prescriptions/create')
      .send({
        patient_id: patientId,
        doctor_id: doctorId,
        diagnosis: 'Seasonal allergy',
        clinical_notes: 'No respiratory distress.',
        medications: [
          {
            name: 'Cetirizine',
            dosage: '10mg',
            frequency: 'OD',
            duration: '5 days',
            route: 'Oral',
            instructions: 'After food',
            qty: 5
          }
        ],
        vitals: { pulse: 72, spo2: 99 },
        follow_up_date: '2026-05-13',
        follow_up_notes: 'Review if symptoms persist.'
      });

    expect(res.statusCode).toBe(200);
    expect(res.body.data.patient_id).toBe(patientId);
    expect(res.body.data.doctor_id).toBe(doctorId);
    expect(res.body.data.medications[0].name).toBe('Cetirizine');

    const stored = await prisma.$queryRawUnsafe(
      `SELECT jsonb_typeof(medications) AS medications_type,
              jsonb_typeof(vitals) AS vitals_type,
              medications->0->>'name' AS medication_name,
              vitals->>'pulse' AS pulse
       FROM e_prescriptions
       WHERE id = $1`,
      res.body.data.id
    );

    expect(stored[0]).toMatchObject({
      medications_type: 'array',
      vitals_type: 'object',
      medication_name: 'Cetirizine',
      pulse: '72'
    });
  });
});
