// src/tests/specialty-department-gate.deep.test.js
//
// End-to-end pins for the specialty department gate against the real app and
// the seeded CI database: a General Medicine doctor exercising the oncology
// surface, an Oncology doctor exercising their own, and the CMO bypass —
// in the default report mode (nothing blocked) and in enforce mode.

import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import { generateToken } from '../utils/jwtUtils.js';

const API_KEY = process.env.API_KEY || 'test-api-key';

const get = (path, token) => request(app)
  .get(path)
  .set('x-api-key', API_KEY)
  .set('x-forwarded-proto', 'https')
  .set('Authorization', `Bearer ${token}`);

const doctorTokenFor = (userId) => generateToken({
  uid: `cdcdcdcd-0000-4000-8000-${String(userId).padStart(12, '0')}`,
  id: userId,
  role: 'DOCTOR',
});

async function doctorUserIdInDepartment(departmentName) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT d.user_id
       FROM doctors d
       JOIN departments dep ON dep.id = d.department_id
      WHERE dep.name = $1
        AND d.user_id IS NOT NULL
      LIMIT 1`,
    departmentName,
  );
  return rows[0]?.user_id ?? null;
}

const PROBE = '/api/v1/oncology/protocols';
const savedMode = process.env.SPECIALTY_DEPARTMENT_GATE_MODE;

afterAll(() => {
  if (savedMode === undefined) delete process.env.SPECIALTY_DEPARTMENT_GATE_MODE;
  else process.env.SPECIALTY_DEPARTMENT_GATE_MODE = savedMode;
});

describe('specialty department gate (oncology probe)', () => {
  let gmDoctorId;
  let oncoDoctorId;

  beforeAll(async () => {
    gmDoctorId = await doctorUserIdInDepartment('General Medicine');
    oncoDoctorId = await doctorUserIdInDepartment('Oncology');
  });

  it('seed sanity: both probe doctors exist', () => {
    expect(gmDoctorId).not.toBeNull();
    expect(oncoDoctorId).not.toBeNull();
  });

  it('report mode (the default): a non-oncology doctor is NOT blocked', async () => {
    process.env.SPECIALTY_DEPARTMENT_GATE_MODE = 'report';
    const res = await get(PROBE, doctorTokenFor(gmDoctorId));
    expect(res.status).not.toBe(403);
  });

  it('enforce mode: a General Medicine doctor is denied with the structured code', async () => {
    process.env.SPECIALTY_DEPARTMENT_GATE_MODE = 'enforce';
    const res = await get(PROBE, doctorTokenFor(gmDoctorId));
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toContain('SPECIALTY_DEPARTMENT_REQUIRED');
  });

  it('enforce mode: an Oncology doctor passes', async () => {
    process.env.SPECIALTY_DEPARTMENT_GATE_MODE = 'enforce';
    const res = await get(PROBE, doctorTokenFor(oncoDoctorId));
    expect(res.status).not.toBe(403);
  });

  it('enforce mode: the CMO bypasses (leadership supervision)', async () => {
    process.env.SPECIALTY_DEPARTMENT_GATE_MODE = 'enforce';
    const cmoToken = generateToken({
      uid: 'cdcdcdcd-0000-4000-8000-000000009999',
      id: 9999,
      role: 'CMO',
    });
    const res = await get(PROBE, cmoToken);
    expect(res.status).not.toBe(403);
  });

  it('off mode is inert for everyone', async () => {
    process.env.SPECIALTY_DEPARTMENT_GATE_MODE = 'off';
    const res = await get(PROBE, doctorTokenFor(gmDoctorId));
    expect(res.status).not.toBe(403);
  });
});
