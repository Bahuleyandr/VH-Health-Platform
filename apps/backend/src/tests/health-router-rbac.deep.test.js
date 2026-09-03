// Protected health router RBAC + tenant context (CAN-028/029).
//
// The protected health routes were wrapped with an empty-routeMap wrapAutoRBAC
// (a no-op) and sat before tenant middleware, so ANY authenticated user could
// read/write patient vitals with no tenant scoping. They now enforce the
// healthRecordsRoutes role set + tenant context/RLS.
import { generateTestToken, API_KEY, ensureTestIdentity } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const TENANT_ID = '00000000-0000-4000-8000-000000000001';

function client(role) {
  const t = generateTestToken(role, { uid: 'c0de0289-0001-4c0d-8c0d-c0de02890001', tenant_id: TENANT_ID });
  const h = (r) => r.set('x-api-key', API_KEY).set('Authorization', `Bearer ${t}`);
  return { get: (p) => h(request(app).get(p)), post: (p) => h(request(app).post(p)) };
}

d('Protected health router RBAC (CAN-028/029)', () => {
  // Authentication fails closed when a token's subject has no live identity
  // row, so an invented uid 401s before this suite's authz gate is reached.
  beforeAll(async () => {
    await ensureTestIdentity('c0de0289-0001-4c0d-8c0d-c0de02890001', { tenantId: TENANT_ID });
  });
  afterAll(async () => { await prisma.$disconnect().catch(() => {}); });

  it('a role outside healthRecordsRoutes (GENERAL_STAFF) is denied patient health reads/writes', async () => {
    const C = client('GENERAL_STAFF');
    expect((await C.get('/api/v1/health/patient/123/summary')).statusCode).toBe(403);
    expect((await C.get('/api/v1/health/patient/123/vitals')).statusCode).toBe(403);
    expect((await C.post('/api/v1/health/records').send({ patient_id: 123 })).statusCode).toBe(403);
  });

  it('an allowed role (ADMIN) is not blocked by the router RBAC', async () => {
    const res = await client('ADMIN').get('/api/v1/health/patient/123/summary');
    expect(res.statusCode).not.toBe(403);
    expect(res.statusCode).not.toBe(401);
  });
});
