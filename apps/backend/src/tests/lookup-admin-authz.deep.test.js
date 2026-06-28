// Legacy lookup admin verbs (CAN-057).
//
// /users/lookup/{stats,activity} and POST /users/lookup/bulk-search expose
// hospital-wide user analytics / bulk lists. They sit behind the broad lookup
// RBAC mount; an inner ADMIN guard must keep operational roles out.
import { generateTestToken, API_KEY } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const TENANT_ID = '00000000-0000-4000-8000-000000000001';

function client(role) {
  const t = generateTestToken(role, { uid: 'c0de0104-0001-4c0d-8c0d-c0de01040001', tenant_id: TENANT_ID });
  const h = (r) => r.set('x-api-key', API_KEY).set('Authorization', `Bearer ${t}`);
  return { get: (p) => h(request(app).get(p)), post: (p) => h(request(app).post(p)) };
}

d('Legacy lookup admin verbs (CAN-057)', () => {
  afterAll(async () => { await prisma.$disconnect().catch(() => {}); });

  it('GENERAL_STAFF is denied lookup stats / activity / bulk-search', async () => {
    const C = client('GENERAL_STAFF');
    expect((await C.get('/api/v1/users/lookup/stats')).statusCode).toBe(403);
    expect((await C.get('/api/v1/users/lookup/activity')).statusCode).toBe(403);
    expect((await C.post('/api/v1/users/lookup/bulk-search').send({ criteria: { name: 'x' } })).statusCode).toBe(403);
  });

  it('ADMIN is not blocked by the role gate on lookup stats', async () => {
    const res = await client('ADMIN').get('/api/v1/users/lookup/stats');
    expect(res.statusCode).not.toBe(403);
    expect(res.statusCode).not.toBe(401);
  });
});
