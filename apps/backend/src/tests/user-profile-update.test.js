// Regression test for finding
// 2026-05-08-walk-in-opd-receptionist-blood-group-silently-dropped
//
// PUT /api/v1/users/:uid must persist the clinical PHI fields
// (blood_group, emergency_contact, allergies, medical_history) AND surface
// them on the response so callers can verify the write succeeded. Before
// 79596add the SET clause silently dropped these fields and returned HTTP
// 200; the RETURNING gap then meant callers had no way to detect the loss.

import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import { API_KEY, generateTestToken } from './testClient.js';

const PATIENT_UID = 'a5555555-5555-4555-8555-55555555fb01';
const ADMIN_UID = 'a5555555-5555-4555-8555-55555555fb02';

async function cleanupFixtures() {
  await prisma
    .$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`,
      PATIENT_UID,
      ADMIN_UID
    )
    .catch(() => {});
}

describe('PUT /users/:uid — clinical PHI fields persist + return', () => {
  let patientId;

  beforeAll(async () => {
    await cleanupFixtures();
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES
         ($1::uuid, '9999330001', 'Profile Update Patient', 'PATIENT', true, NOW()),
         ($2::uuid, '9999330002', 'Profile Update Admin',   'ADMIN',   true, NOW())
       RETURNING id, uid::text AS uid`,
      PATIENT_UID,
      ADMIN_UID
    );
    patientId = rows.find(r => r.uid === PATIENT_UID).id;
  });

  afterAll(async () => {
    await cleanupFixtures();
    await prisma.$disconnect().catch(() => {});
  });

  it('persists blood_group, emergency_contact, allergies and surfaces them in the response', async () => {
    const token = generateTestToken('ADMIN', { uid: ADMIN_UID });

    const res = await request(app)
      .put(`/api/v1/users/${PATIENT_UID}`)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Ramesh Kumar',
        gender: 'MALE',
        birthday: '1988-04-15',
        address: '23 Nehru Street, Chennai',
        blood_group: 'O+',
        allergies: 'Penicillin, peanuts',
        emergency_contact: JSON.stringify({ name: 'Sita Kumar', phone: '+919900112233', relationship: 'spouse' })
      });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.user).toMatchObject({
      uid: PATIENT_UID,
      name: 'Ramesh Kumar',
      blood_group: 'O+',
      allergies: 'Penicillin, peanuts'
    });
    expect(res.body.data.user.emergency_contact).toMatchObject({
      name: 'Sita Kumar',
      phone: '+919900112233',
      relationship: 'spouse'
    });

    const stored = await prisma.$queryRawUnsafe(
      `SELECT blood_group, allergies, emergency_contact, name, gender
       FROM users WHERE id = $1`,
      patientId
    );
    expect(stored[0].blood_group).toBe('O+');
    expect(stored[0].allergies).toBe('Penicillin, peanuts');
    expect(stored[0].emergency_contact).toMatchObject({
      name: 'Sita Kumar',
      phone: '+919900112233',
      relationship: 'spouse'
    });
    expect(stored[0].name).toBe('Ramesh Kumar');
    expect(stored[0].gender).toBe('MALE');
  });
});
