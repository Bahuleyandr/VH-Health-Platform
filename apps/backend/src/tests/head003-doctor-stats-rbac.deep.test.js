// HEAD-003: the doctor stats endpoint (GET /api/v1/doctors/stats/:id) exposes
// workload / patient-volume / revenue aggregates. It was reachable by ANY
// authenticated user — the /doctors mount is publicCache-only, the wrapAutoRBAC
// on the stats router is a no-op (empty routeMap), and the controller only
// restricts a DOCTOR to their own id. The mount is now role-gated to
// admin/clinical leadership + doctors (doctor-self-only still enforced).
import { generateTestToken, API_KEY, ensureTestIdentity } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const TENANT = '00000000-0000-4000-8000-000000000001';

function client(role, extra = {}) {
  const t = generateTestToken(role, { uid: 'c0de0d03-00d0-4000-8000-00000000d001', tenant_id: TENANT, ...extra });
  return { get: (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${t}`) };
}

d('HEAD-003 doctor stats RBAC', () => {
  // Authentication fails closed when a token's subject has no live identity
  // row, so an invented uid 401s before this suite's authz gate is reached.
  beforeAll(async () => {
    await ensureTestIdentity('c0de0d03-00d0-4000-8000-00000000d001', { tenantId: TENANT });
  });
  afterAll(async () => { await prisma.$disconnect().catch(() => {}); });

  it('a PATIENT cannot read doctor stats (403)', async () => {
    const res = await client('PATIENT').get('/api/v1/doctors/stats/1');
    expect(res.statusCode).toBe(403);
  });

  it('a GENERAL_STAFF cannot read doctor stats (403)', async () => {
    const res = await client('GENERAL_STAFF').get('/api/v1/doctors/stats/1');
    expect(res.statusCode).toBe(403);
  });

  it('an ADMIN may read doctor stats (not 403)', async () => {
    const res = await client('ADMIN').get('/api/v1/doctors/stats/1');
    expect(res.statusCode).not.toBe(403);
  });

  it('a DOCTOR may read their own stats but not another doctor\'s', async () => {
    const own = await client('DOCTOR', { id: 7 }).get('/api/v1/doctors/stats/7');
    expect(own.statusCode).not.toBe(403);
    const other = await client('DOCTOR', { id: 7 }).get('/api/v1/doctors/stats/8');
    expect(other.statusCode).toBe(403);
  });
});
