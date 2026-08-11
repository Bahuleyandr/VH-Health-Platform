// Specialty-module care-team guards (CAN-046/047/048/049/050/051).
//
// Oncology uses child-level patient/resource guards; the sibling specialty
// modules use parent guards. All are shadow by default (non-breaking) and
// return a real 403 once the tenant/env flips to 'enforce'. This proves the
// oncology wiring: an unrelated clinician is denied under enforce and passes
// under shadow.
import { generateTestToken, API_KEY } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const PATIENT = 'c0de0246-0000-4000-8000-0000000007a1';
// A body-patient route protected by the oncology child-level guard.
const PATH = '/api/v1/oncology/protocols/00000000-0000-4000-8000-0000000000ff/plans';

function doctor() {
  const t = generateTestToken('DOCTOR', { uid: 'c0de0246-00d0-4000-8000-00000000d001', tenant_id: TENANT_ID });
  return { post: (p) => request(app).post(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${t}`) };
}

async function clean() {
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, PATIENT).catch(() => {});
}

d('Specialty-module care-team guard (CAN-046…051)', () => {
  let prevMode;
  beforeAll(async () => {
    prevMode = process.env.CARE_TEAM_ENFORCEMENT_MODE;
    await clean();
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid,$2::uuid,'+919000246701','Onco Patient','PATIENT',true,NOW())`, PATIENT, TENANT_ID);
  }, 30000);
  afterAll(async () => {
    if (prevMode === undefined) delete process.env.CARE_TEAM_ENFORCEMENT_MODE;
    else process.env.CARE_TEAM_ENFORCEMENT_MODE = prevMode;
    await clean(); await prisma.$disconnect().catch(() => {});
  }, 30000);

  it('ENFORCE: an unrelated clinician is denied (403)', async () => {
    process.env.CARE_TEAM_ENFORCEMENT_MODE = 'enforce';
    const res = await doctor().post(PATH).send({ patient_uid: PATIENT });
    expect(res.statusCode).toBe(403);
  });

  it('SHADOW (default): the same request is not blocked by the guard', async () => {
    delete process.env.CARE_TEAM_ENFORCEMENT_MODE;
    const res = await doctor().post(PATH).send({ patient_uid: PATIENT });
    expect(res.statusCode).not.toBe(403);
  });
});
