// Doctor admin router RBAC (CAN-003).
//
// /api/v1/doctors is mounted publicCache-only (no requireRole) and the doctor
// index wrapped adminDoctorRoutes with an empty routeMap (a no-op). So admin
// doctor-management was reachable by any authenticated user. The /admin
// sub-mount now requires ADMIN.
import { generateTestToken, API_KEY, ensureTestIdentity } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const TENANT_ID = '00000000-0000-4000-8000-000000000001';

function client(role) {
  const t = generateTestToken(role, { uid: 'c0de0106-0001-4c0d-8c0d-c0de01060001', tenant_id: TENANT_ID });
  const h = (r) => r.set('x-api-key', API_KEY).set('Authorization', `Bearer ${t}`);
  return { get: (p) => h(request(app).get(p)), post: (p) => h(request(app).post(p)) };
}

d('Doctor admin router RBAC (CAN-003)', () => {
  // Authentication fails closed when a token's subject has no live identity
  // row, so an invented uid 401s before this suite's authz gate is reached.
  beforeAll(async () => {
    await ensureTestIdentity('c0de0106-0001-4c0d-8c0d-c0de01060001', { tenantId: TENANT_ID });
  });
  afterAll(async () => { await prisma.$disconnect().catch(() => {}); });

  it.each(['PATIENT', 'GENERAL_STAFF', 'DOCTOR'])('%s is denied admin doctor management', async (role) => {
    const C = client(role);
    expect((await C.get('/api/v1/doctors/admin/overview')).statusCode).toBe(403);
    expect((await C.post('/api/v1/doctors/admin/create').send({ name: 'X' })).statusCode).toBe(403);
  });

  it('ADMIN is not blocked by the role gate on admin doctor routes', async () => {
    const res = await client('ADMIN').get('/api/v1/doctors/admin/overview');
    expect(res.statusCode).not.toBe(403);
    expect(res.statusCode).not.toBe(401);
  });
});
