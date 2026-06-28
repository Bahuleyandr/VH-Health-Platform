// Staff messaging patient-relationship guard (CAN-013 read, CAN-014 send).
//
// Patient-linked staff discussions are PHI. With a patient_uid present, the
// reader/sender must have a care relationship. Governed: shadow by default,
// real 403 under enforce.
import { generateTestToken, API_KEY } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const PATIENT = 'c0de1314-0000-4000-8000-0000000007a1';
const RECIPIENT = 'c0de1314-0000-4000-8000-00000000d002';

function staff() {
  const t = generateTestToken('GENERAL_STAFF', { uid: 'c0de1314-00d0-4000-8000-00000000d001', tenant_id: TENANT_ID });
  const h = (r) => r.set('x-api-key', API_KEY).set('Authorization', `Bearer ${t}`);
  return { get: (p) => h(request(app).get(p)), post: (p) => h(request(app).post(p)) };
}

async function clean() {
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, PATIENT).catch(() => {});
}

d('Staff messaging patient guard (CAN-013, CAN-014)', () => {
  let prevMode;
  beforeAll(async () => {
    prevMode = process.env.CARE_TEAM_ENFORCEMENT_MODE;
    await clean();
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid,$2::uuid,'+919001314701','Msg Patient','PATIENT',true,NOW())`, PATIENT, TENANT_ID);
  }, 30000);
  afterAll(async () => {
    if (prevMode === undefined) delete process.env.CARE_TEAM_ENFORCEMENT_MODE;
    else process.env.CARE_TEAM_ENFORCEMENT_MODE = prevMode;
    await clean(); await prisma.$disconnect().catch(() => {});
  }, 30000);

  it('CAN-013 ENFORCE: unrelated staff cannot read a patient discussion', async () => {
    process.env.CARE_TEAM_ENFORCEMENT_MODE = 'enforce';
    expect((await staff().get(`/api/v1/messaging/patient/${PATIENT}`)).statusCode).toBe(403);
  });

  it('CAN-013 SHADOW: same read not blocked by the guard', async () => {
    delete process.env.CARE_TEAM_ENFORCEMENT_MODE;
    expect((await staff().get(`/api/v1/messaging/patient/${PATIENT}`)).statusCode).not.toBe(403);
  });

  it('CAN-014 ENFORCE: unrelated staff cannot send a patient-context message', async () => {
    process.env.CARE_TEAM_ENFORCEMENT_MODE = 'enforce';
    const res = await staff().post('/api/v1/messaging/send')
      .send({ recipient_uid: RECIPIENT, body: 'hello', patient_uid: PATIENT });
    expect(res.statusCode).toBe(403);
  });
});
