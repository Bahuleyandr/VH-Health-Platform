// Legacy lookup OR-predicate bug (CAN-056).
//
// LookupService.lookupUser OR-ed the non-admin `role != 'ADMIN'` guard into the
// same list as the search criteria, so a NON-MATCHING lookup returned the whole
// non-admin roster. Fix: criteria are OR-ed; the role guard is AND-ed on top.
import { generateTestToken, API_KEY } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const N = (p) => `+91${p}`;
const U1 = 'c0de0103-0001-4c0d-8c0d-c0de01030001';
const P1 = '9310000301';
const U2 = 'c0de0103-0002-4c0d-8c0d-c0de01030002';
const P2 = '9310000302';
const NONEXISTENT = '9399999999';

function staff(role = 'GENERAL_STAFF') {
  const t = generateTestToken(role, { uid: 'c0de0103-00aa-4c0d-8c0d-c0de010300aa', tenant_id: TENANT_ID });
  return { get: (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${t}`) };
}

async function clean() {
  await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid IN ($1::uuid,$2::uuid)`, U1, U2).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM audit_logs WHERE action = 'user-lookup'`).catch(() => {});
}

d('Legacy lookup OR-predicate (CAN-056)', () => {
  beforeAll(async () => {
    await clean();
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at) VALUES
        ($1::uuid,$2,'Lookup One','PATIENT',true,$5::uuid,NOW()),
        ($3::uuid,$4,'Lookup Two','PATIENT',true,$5::uuid,NOW())`,
      U1, N(P1), U2, N(P2), TENANT_ID);
  }, 60000);
  afterAll(async () => { await clean(); await prisma.$disconnect().catch(() => {}); }, 60000);

  it('a nonexistent-phone lookup returns ZERO users (no roster leak)', async () => {
    const res = await staff().get(`/api/v1/users/lookup/advanced?phone=${NONEXISTENT}`);
    expect(res.statusCode).toBeLessThan(300);
    expect(res.body?.data?.totalFound ?? res.body?.data?.users?.length).toBe(0);
  });

  it('an exact-phone lookup still finds the one matching user', async () => {
    const res = await staff().get(`/api/v1/users/lookup/advanced?phone=${P1}`);
    expect(res.statusCode).toBeLessThan(300);
    const users = res.body?.data?.users ?? [];
    expect(users.length).toBe(1);
    expect(users[0].uid).toBe(U1);
  });

  it('GET /users/lookup (root) resolves — not shadowed by /users/:identifier', async () => {
    // Regression: userRoutes' GET /:identifier used to be registered before
    // the /lookup mount, so "lookup" was captured as an identifier and the
    // root lookup endpoint 500'd on the uuid cast. It must behave exactly
    // like /lookup/advanced.
    const res = await staff().get(`/api/v1/users/lookup?phone=${P1}`);
    expect(res.statusCode).toBe(200);
    const users = res.body?.data?.users ?? [];
    expect(users.length).toBe(1);
    expect(users[0].uid).toBe(U1);
  });

  it('GET /users/lookup (root) returns zero users for a nonexistent phone', async () => {
    const res = await staff().get(`/api/v1/users/lookup?phone=${NONEXISTENT}`);
    expect(res.statusCode).toBe(200);
    expect(res.body?.data?.totalFound ?? res.body?.data?.users?.length).toBe(0);
  });
});
