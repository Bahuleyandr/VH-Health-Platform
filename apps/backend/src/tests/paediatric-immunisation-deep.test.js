import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import { API_KEY, generateTestToken } from './testClient.js';

const PATIENT_UID = 'd4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d401';
const NURSE_UID = 'd4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d402';

function twoYearOldDob() {
  return new Date(Date.now() - 760 * 86400000).toISOString().slice(0, 10);
}

function nurseClient(id = 1) {
  const token = generateTestToken('NURSING_STAFF', { uid: NURSE_UID, id });
  return {
    get: (path) => request(app)
      .get(path)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${token}`),
  };
}

describe('Paediatric immunisation schedule reads', () => {
  let patientId;
  let nurseId;
  let nurse;

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM patient_immunisations WHERE patient_uid=$1::uuid`,
      PATIENT_UID,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`,
      PATIENT_UID, NURSE_UID,
    ).catch(() => {});

    const patient = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, birthday, gender, is_active, updated_at)
       VALUES ($1::uuid, '9000094401', 'Paeds Immunisation Child', 'PATIENT', $2::date, 'Male', true, NOW())
       RETURNING id`,
      PATIENT_UID, twoYearOldDob(),
    );
    patientId = patient[0].id;

    const nurseRow = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9000094402', 'Paeds Immunisation Nurse', 'NURSING_STAFF', true, NOW())
       RETURNING id`,
      NURSE_UID,
    );
    nurseId = nurseRow[0].id;
    nurse = nurseClient(nurseId);
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM patient_immunisations WHERE patient_uid=$1::uuid`,
      PATIENT_UID,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE id IN ($1, $2)`,
      patientId, nurseId,
    ).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  it('lazily seeds a DOB-based schedule instead of returning an empty patient list', async () => {
    const catalogue = await nurse.get('/api/v1/paediatric/immunisations/catalogue');
    expect(catalogue.statusCode).toBe(200);
    expect(catalogue.body.data.length).toBeGreaterThan(0);

    const list = await nurse.get(`/api/v1/paediatric/immunisations/patient/${PATIENT_UID}`);
    expect(list.statusCode).toBe(200);
    expect(list.body.data.length).toBeGreaterThan(0);
    expect(list.body.data.every((row) => row.patient_uid === PATIENT_UID)).toBe(true);
    expect(list.body.data.some((row) => ['due', 'overdue', 'scheduled'].includes(row.display_status))).toBe(true);

    const dbCount = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count FROM patient_immunisations WHERE patient_uid=$1::uuid`,
      PATIENT_UID,
    );
    expect(Number(dbCount[0].count)).toBe(list.body.data.length);
  });

  it('returns due/overdue rows after lazy seeding', async () => {
    const due = await nurse.get(`/api/v1/paediatric/immunisations/patient/${PATIENT_UID}/due`);
    expect(due.statusCode).toBe(200);
    expect(due.body.data.length).toBeGreaterThan(0);
    expect(due.body.data.every((row) => row.status === 'scheduled')).toBe(true);
  });
});
