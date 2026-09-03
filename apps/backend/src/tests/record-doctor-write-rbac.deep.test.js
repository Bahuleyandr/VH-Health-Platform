// Record write routes (doctorRoutes: POST /create, PUT /:id) were mounted via an
// inert no-op wrapAutoRBAC(doctorRoutes,'doctorRoutes') and gated only by the
// broad RECORD_ROUTE_ROLES parent. PUT /:id updates a record BY ID (no patient
// context), so the parent patientAccessGuard passes it through — a non-doctor
// record role could update/tamper any medical record by id. rbacConfig intends
// doctorRoutes:[DOCTOR,ADMIN]; the create/update routes are now gated to that.
// (Reads stay at parent breadth; staff createPrescription/PUT have no active
// non-doctor callers, so this does not break a clinical documentation flow.)
import { generateTestToken, API_KEY, ensureTestIdentity } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const TENANT = '00000000-0000-4000-8000-000000000001';

function client(role) {
  const t = generateTestToken(role, { uid: 'c0de0b07-00d0-4000-8000-00000000d001', id: 4242, tenant_id: TENANT });
  return {
    put: (p, body) => request(app).put(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${t}`).send(body || {}),
  };
}

d('Record write RBAC (doctor create/update)', () => {
  // Authentication fails closed when a token's subject has no live identity
  // row, so an invented uid 401s before this suite's authz gate is reached.
  beforeAll(async () => {
    await ensureTestIdentity('c0de0b07-00d0-4000-8000-00000000d001', { tenantId: TENANT });
  });
  afterAll(async () => { await prisma.$disconnect().catch(() => {}); });

  // PUT /:id has no patient context (record id), so the parent PHI guard passes
  // it through — the route's own requireRole is the sole gate. This is the clean
  // RED→GREEN for the cross-patient record-tamper integrity gap.
  it('a non-doctor record role (NURSING_STAFF) cannot update a record by id (403)', async () => {
    const res = await client('NURSING_STAFF').put('/api/v1/records/999999', { title: 'tampered', description: 'x' });
    expect(res.statusCode).toBe(403);
  });

  it('a DOCTOR is not blocked by the role gate on update (not 403)', async () => {
    const res = await client('DOCTOR').put('/api/v1/records/999999', { title: 'ok', description: 'x' });
    expect(res.statusCode).not.toBe(403);
  });

  it('an ADMIN is not blocked by the role gate on update (not 403)', async () => {
    const res = await client('ADMIN').put('/api/v1/records/999999', { title: 'ok', description: 'x' });
    expect(res.statusCode).not.toBe(403);
  });
});
