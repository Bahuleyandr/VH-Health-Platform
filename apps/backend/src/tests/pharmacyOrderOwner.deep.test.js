// Deep test for Sol Ultra audit #13: a PATIENT could POST
// /prescriptions/:id/order-pharmacy for ANY prescription id — the handler
// loaded the prescription and proceeded without checking that the caller owns
// it — so a patient could create a pharmacy order against another patient's
// prescription (and read its medication PHI back through catalog resolution).
//
// The fix reuses the controller's existing callerMayAccessPrescription helper
// (staff read-roles pass; a PATIENT must match the prescription's patient_id)
// and returns 404 for a foreign prescription (no existence oracle).
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';
import { API_KEY, generateTestToken } from './testClient.js';

const OWNER_UID = 'a6666666-6666-4666-8666-666666666601';
const DOCTOR_UID = 'a6666666-6666-4666-8666-666666666602';
const FOREIGN_UID = 'a6666666-6666-4666-8666-666666666699';

let ownerId;
let doctorId;
let rxId;

function patientClient(uid, id) {
  const token = generateTestToken('PATIENT', { uid, id });
  return {
    post: (path) => request(app).post(path)
      .set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}

async function insertUser(uid, role, phone) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
     VALUES ($1::uuid, $2, $3, $4, true, NOW()) RETURNING id`,
    uid, phone, `${role} owner-test`, role,
  );
  return rows[0].id;
}

beforeAll(async () => {
  await prisma.$executeRawUnsafe(
    `DELETE FROM e_prescriptions WHERE patient_id IN (SELECT id FROM users WHERE uid IN ($1::uuid,$2::uuid,$3::uuid))`,
    OWNER_UID, DOCTOR_UID, FOREIGN_UID).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid,$2::uuid,$3::uuid)`,
    OWNER_UID, DOCTOR_UID, FOREIGN_UID).catch(() => {});

  ownerId = await insertUser(OWNER_UID, 'PATIENT', '9000066601');
  doctorId = await insertUser(DOCTOR_UID, 'DOCTOR', '9000066602');
  const rx = await prisma.$queryRawUnsafe(
    `INSERT INTO e_prescriptions (patient_id, doctor_id, medications, status, created_by)
     VALUES ($1, $2, $3::jsonb, 'active', $4) RETURNING id`,
    ownerId, doctorId,
    JSON.stringify([{ name: 'Paracetamol', dosage: '500mg', frequency: 'BD', duration: '3 days', route: 'Oral' }]),
    doctorId);
  rxId = rx[0].id;
});

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DELETE FROM e_prescriptions WHERE id = $1`, rxId).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid,$2::uuid,$3::uuid)`,
    OWNER_UID, DOCTOR_UID, FOREIGN_UID).catch(() => {});
});

describe('pharmacy order ownership (Sol Ultra #13)', () => {
  it('a non-owner PATIENT cannot order-pharmacy from another patient\'s prescription (404)', async () => {
    // A PATIENT token whose id is NOT the prescription's patient_id.
    const foreign = patientClient(FOREIGN_UID, ownerId + 7777777);
    const res = await foreign.post(`/api/v1/prescriptions/${rxId}/order-pharmacy`)
      .send({ delivery_type: 'counter' });
    expect(res.statusCode).toBe(404);
  });

  it('the owning PATIENT is not blocked at the ownership check', async () => {
    const owner = patientClient(OWNER_UID, ownerId);
    const res = await owner.post(`/api/v1/prescriptions/${rxId}/order-pharmacy`)
      .send({ delivery_type: 'counter' });
    // Ownership passes; the request proceeds (may fail later on catalog/stock,
    // but must NOT be the ownership 404).
    expect(res.statusCode).not.toBe(404);
  });
});
