// Self-service profile authz (CAN-001 role minting + CAN-002 cross-profile overwrite).
//
// POST /api/v1/users/profile is reachable by PATIENT. Two confirmed bugs are
// fixed here and locked in by this suite:
//   CAN-001: the create path must NEVER honour a body `role` for self-service —
//            a PATIENT registering with role:'ADMIN' must land as PATIENT.
//   CAN-002: a self-service caller must not be able to overwrite ANOTHER user's
//            profile by passing that user's phone in the body.
// A privileged (ADMIN) actor retains the ability to set role / target a phone.
//
// Note: the app normalises phones to +91XXXXXXXXXX (utils/phoneUtils), so we
// SEND bare 10-digit numbers (as a real client does) but SEED/QUERY the DB in
// the normalised form.
import { generateTestToken, API_KEY, ensureTestIdentity } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT_ID = '00000000-0000-4000-8000-000000000001'; // platform default tenant
const N = (p) => `+91${p}`; // DB-stored normalised form

const A_UID = 'c0de0101-0001-4c0d-8c0d-c0de01010001';
const SELF_REGISTER_UID = 'c0de0101-000a-4c0d-8c0d-c0de0101000a';
const A_PHONE = '9310000101';
const B_UID = 'c0de0101-0002-4c0d-8c0d-c0de01010002';
const B_PHONE = '9310000102';
const NEW_PHONE = '9310000103'; // no pre-existing row — used for the create test
const ADMIN_UID = 'c0de0101-0009-4c0d-8c0d-c0de01010009';
const ADMIN_TARGET_PHONE = '9310000104';

function client(role, overrides) {
  const t = generateTestToken(role, { tenant_id: TENANT_ID, ...overrides });
  const h = (r) => r.set('x-api-key', API_KEY).set('Authorization', `Bearer ${t}`);
  return { post: (p) => h(request(app).post(p)) };
}

async function roleOf(phone) {
  const rows = await prisma.$queryRawUnsafe(
    'SELECT role FROM users WHERE phone = $1 LIMIT 1', N(phone));
  return rows[0]?.role ?? null;
}
async function nameOf(uid) {
  const rows = await prisma.$queryRawUnsafe(
    'SELECT name FROM users WHERE uid = $1::uuid LIMIT 1', uid);
  return rows[0]?.name ?? null;
}

async function clean() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE phone IN ($1,$2,$3,$4)`,
    N(A_PHONE), N(B_PHONE), N(NEW_PHONE), N(ADMIN_TARGET_PHONE)).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid,$2::uuid,$3::uuid)`,
    A_UID, B_UID, ADMIN_UID).catch(() => {});
}

d('Self-service profile authz (CAN-001, CAN-002)', () => {
  beforeAll(async () => {
    await clean();
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at) VALUES
        ($1::uuid,$2,'Patient A','PATIENT',true,$5::uuid,NOW()),
        ($3::uuid,$4,'Patient B','PATIENT',true,$5::uuid,NOW())`,
      A_UID, N(A_PHONE), B_UID, N(B_PHONE), TENANT_ID);
  }, 60000);

  // Seeded AFTER the block above, because clean() deletes ADMIN_UID and would
  // otherwise undo this. Authentication now fails closed on a subject with no
  // live identity row, so both callers below have to exist.
  //
  // The self-registration caller is given NEW_PHONE deliberately: a
  // self-service profile write resolves the target by the CALLER's identity
  // rather than the body phone (that is the CAN-002 protection), so with a live
  // caller the write lands on NEW_PHONE exactly as the original create path did
  // and `roleOf(NEW_PHONE)` still proves the role-escalation refusal.
  beforeAll(async () => {
    await ensureTestIdentity(SELF_REGISTER_UID, { role: 'PATIENT', phone: N(NEW_PHONE), tenantId: TENANT_ID });
    await ensureTestIdentity(ADMIN_UID, { role: 'ADMIN', tenantId: TENANT_ID });
  }, 60000);
  afterAll(async () => { await clean(); await prisma.$disconnect().catch(() => {}); }, 60000);

  it('CAN-001: PATIENT self-registration with role=ADMIN lands as PATIENT', async () => {
    const C = client('PATIENT', { uid: SELF_REGISTER_UID, phone: NEW_PHONE });
    const res = await C.post('/api/v1/users/profile')
      .send({ phone: NEW_PHONE, name: 'New Patient', role: 'ADMIN' });
    expect(res.statusCode).toBeLessThan(300);
    expect(await roleOf(NEW_PHONE)).toBe('PATIENT');
  });

  it('CAN-001: PATIENT updating own profile with role=ADMIN stays PATIENT', async () => {
    const C = client('PATIENT', { uid: A_UID, phone: A_PHONE });
    const res = await C.post('/api/v1/users/profile')
      .send({ phone: A_PHONE, name: 'Patient A v2', role: 'ADMIN' });
    expect(res.statusCode).toBeLessThan(300);
    expect(await roleOf(A_PHONE)).toBe('PATIENT');
    expect(await nameOf(A_UID)).toBe('Patient A v2'); // own update still works
  });

  it('CAN-002: PATIENT cannot overwrite another patient by body phone', async () => {
    const C = client('PATIENT', { uid: A_UID, phone: A_PHONE });
    const res = await C.post('/api/v1/users/profile')
      .send({ phone: B_PHONE, name: 'HACKED', blood_group: 'AB-' });
    expect(res.statusCode).toBe(403);
    expect(await nameOf(B_UID)).toBe('Patient B'); // victim unchanged
  });

  it('privileged ADMIN may still create a user with an explicit role', async () => {
    const C = client('ADMIN', { uid: ADMIN_UID, phone: '9310000100' });
    const res = await C.post('/api/v1/users/profile')
      .send({ phone: ADMIN_TARGET_PHONE, name: 'Admin Made Doctor', role: 'DOCTOR' });
    expect(res.statusCode).toBeLessThan(300);
    expect(await roleOf(ADMIN_TARGET_PHONE)).toBe('DOCTOR');
  });
});
