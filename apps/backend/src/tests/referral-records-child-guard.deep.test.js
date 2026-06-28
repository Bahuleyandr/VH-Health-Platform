// Child-route patient guards for referrals + records (CAN-020, CAN-039).
//
// The /referrals and /records parent mounts apply patientAccessGuard before the
// child :uid is bound, so it can't see it. The guards now sit on the child
// routes. Governed: shadow by default, real 403 under enforce.
import { generateTestToken, API_KEY } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const PATIENT = 'c0de2039-0000-4000-8000-0000000007a1';

function doctor() {
  const t = generateTestToken('DOCTOR', { uid: 'c0de2039-00d0-4000-8000-00000000d001', tenant_id: TENANT_ID });
  return { get: (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${t}`) };
}

async function clean() {
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, PATIENT).catch(() => {});
}

d('Referral + records child-route guards (CAN-020, CAN-039)', () => {
  let prevMode;
  beforeAll(async () => {
    prevMode = process.env.CARE_TEAM_ENFORCEMENT_MODE;
    await clean();
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid,$2::uuid,'+919002039701','Ref Patient','PATIENT',true,NOW())`, PATIENT, TENANT_ID);
  }, 30000);
  afterAll(async () => {
    if (prevMode === undefined) delete process.env.CARE_TEAM_ENFORCEMENT_MODE;
    else process.env.CARE_TEAM_ENFORCEMENT_MODE = prevMode;
    await clean(); await prisma.$disconnect().catch(() => {});
  }, 30000);

  it('CAN-020 ENFORCE: unrelated clinician cannot list a patient\'s referrals', async () => {
    process.env.CARE_TEAM_ENFORCEMENT_MODE = 'enforce';
    expect((await doctor().get(`/api/v1/referrals/patient/${PATIENT}`)).statusCode).toBe(403);
  });

  it('CAN-020 SHADOW: same referral read not blocked by the guard', async () => {
    delete process.env.CARE_TEAM_ENFORCEMENT_MODE;
    expect((await doctor().get(`/api/v1/referrals/patient/${PATIENT}`)).statusCode).not.toBe(403);
  });

  it('CAN-039 ENFORCE: unrelated clinician cannot read records by uid', async () => {
    process.env.CARE_TEAM_ENFORCEMENT_MODE = 'enforce';
    expect((await doctor().get(`/api/v1/records/uid/${PATIENT}`)).statusCode).toBe(403);
  });
});
