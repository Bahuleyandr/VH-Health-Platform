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

// The gate resolves departments from the caller's REAL doctors/users rows, so
// the probe doctors have to exist. The committed seed carries one department
// (Dentistry, unlinked) and a single unassigned doctor, so this suite seeds its
// own two probes. Without them both lookups returned null, the token uid
// degraded to '...00000000null', and every request died at 22P02 — which the
// old `not.toBe(403)` cases silently accepted as a pass.
//
// That is why the admit cases below now pin 200 rather than "not 403": the
// gate calling next() has to be observable as the protocol list actually
// coming back. "Anything but 403" is satisfied by the 500 that a broken
// fixture produces, which is precisely how this suite hid its own breakage.
const TENANT = '00000000-0000-4000-8000-000000000001';

const PROBES = [
  {
    department: 'General Medicine',
    code: 'SPEC_GATE_GENMED',
    uid: 'cdcdcdcd-0000-4000-8000-0000000f0001',
    phone: '9100000731',
    name: 'Dr Specialty Gate GenMed',
  },
  {
    department: 'Oncology',
    code: 'SPEC_GATE_ONCO',
    uid: 'cdcdcdcd-0000-4000-8000-0000000f0002',
    phone: '9100000732',
    name: 'Dr Specialty Gate Onco',
  },
];

// Departments we had to create ourselves, so cleanup puts the shared database
// back exactly as it was found.
const createdDepartmentIds = [];

async function seedDepartment(name, code) {
  const existing = await prisma.$queryRawUnsafe(
    'SELECT id FROM departments WHERE tenant_id = $1::uuid AND name = $2',
    TENANT,
    name,
  );
  if (existing[0]) return existing[0].id;

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO departments (tenant_id, name, code, description, is_active, updated_at)
     VALUES ($1::uuid, $2, $3, 'Specialty department gate probe', true, NOW())
     RETURNING id`,
    TENANT,
    name,
    code,
  );
  createdDepartmentIds.push(rows[0].id);
  return rows[0].id;
}

async function seedProbeDoctor({ department, code, uid, phone, name }) {
  const departmentId = await seedDepartment(department, code);
  const users = await prisma.$queryRawUnsafe(
    `INSERT INTO users (tenant_id, uid, phone, name, role, is_active, updated_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, 'DOCTOR', true, NOW())
     RETURNING id`,
    TENANT,
    uid,
    phone,
    name,
  );
  // Both department signals the gate reads are stamped: the normalized
  // department_id link and the free-text column. They agree here, which is the
  // configuration the enforce rollout targets.
  await prisma.$queryRawUnsafe(
    `INSERT INTO doctors
       (tenant_id, user_id, name, department, department_id, specialty,
        is_active, is_available, updated_at)
     VALUES ($1::uuid, $2::int, $3, $4, $5::int, $4, true, true, NOW())`,
    TENANT,
    users[0].id,
    name,
    department,
    departmentId,
  );
}

async function cleanupProbes() {
  const uids = PROBES.map((probe) => probe.uid);
  await prisma.$queryRawUnsafe(
    `DELETE FROM doctors
      WHERE user_id IN (SELECT id FROM users WHERE tenant_id = $1::uuid AND uid = ANY($2::uuid[]))`,
    TENANT,
    uids,
  );
  await prisma.$queryRawUnsafe(
    'DELETE FROM users WHERE tenant_id = $1::uuid AND uid = ANY($2::uuid[])',
    TENANT,
    uids,
  );
  if (createdDepartmentIds.length > 0) {
    await prisma.$queryRawUnsafe(
      'DELETE FROM departments WHERE tenant_id = $1::uuid AND id = ANY($2::int[])',
      TENANT,
      createdDepartmentIds,
    );
    createdDepartmentIds.length = 0;
  }
}

const doctorTokenFor = (doctor) => generateToken({
  uid: doctor.uid,
  id: doctor.id,
  role: 'DOCTOR',
});

// Resolve the probe through the same doctors -> departments join the gate
// itself walks, and require the users row too: a doctor row whose user_id
// dangles could never carry a usable token.
async function doctorInDepartment(departmentName) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT d.user_id, u.uid
       FROM doctors d
       JOIN departments dep ON dep.id = d.department_id
       JOIN users u ON u.id = d.user_id
      WHERE dep.name = $1
        AND d.user_id IS NOT NULL
      LIMIT 1`,
    departmentName,
  );
  return rows[0] ? { id: rows[0].user_id, uid: rows[0].uid } : null;
}

const PROBE = '/api/v1/oncology/protocols';
const savedMode = process.env.SPECIALTY_DEPARTMENT_GATE_MODE;

afterAll(() => {
  if (savedMode === undefined) delete process.env.SPECIALTY_DEPARTMENT_GATE_MODE;
  else process.env.SPECIALTY_DEPARTMENT_GATE_MODE = savedMode;
});

describe('specialty department gate (oncology probe)', () => {
  let gmDoctor;
  let oncoDoctor;

  beforeAll(async () => {
    // Sweeping a shared database can outrun jest's default 5s budget, so this
    // hook carries its own.
    await cleanupProbes();
    for (const probe of PROBES) await seedProbeDoctor(probe);
    gmDoctor = await doctorInDepartment('General Medicine');
    oncoDoctor = await doctorInDepartment('Oncology');
  }, 120_000);

  afterAll(async () => {
    await cleanupProbes();
  }, 120_000);

  it('seed sanity: both probe doctors exist', () => {
    expect(gmDoctor).not.toBeNull();
    expect(oncoDoctor).not.toBeNull();
  });

  it('report mode (the default): a non-oncology doctor is NOT blocked', async () => {
    process.env.SPECIALTY_DEPARTMENT_GATE_MODE = 'report';
    const res = await get(PROBE, doctorTokenFor(gmDoctor));
    expect(res.status).toBe(200);
  });

  it('enforce mode: a General Medicine doctor is denied with the structured code', async () => {
    process.env.SPECIALTY_DEPARTMENT_GATE_MODE = 'enforce';
    const res = await get(PROBE, doctorTokenFor(gmDoctor));
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toContain('SPECIALTY_DEPARTMENT_REQUIRED');
  });

  it('enforce mode: an Oncology doctor passes', async () => {
    process.env.SPECIALTY_DEPARTMENT_GATE_MODE = 'enforce';
    const res = await get(PROBE, doctorTokenFor(oncoDoctor));
    expect(res.status).toBe(200);
  });

  it('enforce mode: the CMO bypasses (leadership supervision)', async () => {
    process.env.SPECIALTY_DEPARTMENT_GATE_MODE = 'enforce';
    const cmoToken = generateToken({
      uid: 'cdcdcdcd-0000-4000-8000-000000009999',
      id: 9999,
      role: 'CMO',
    });
    const res = await get(PROBE, cmoToken);
    expect(res.status).toBe(200);
  });

  it('off mode is inert for everyone', async () => {
    process.env.SPECIALTY_DEPARTMENT_GATE_MODE = 'off';
    const res = await get(PROBE, doctorTokenFor(gmDoctor));
    expect(res.status).toBe(200);
  });
});
