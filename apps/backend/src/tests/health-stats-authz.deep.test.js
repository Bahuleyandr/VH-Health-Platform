// Health stats overview role boundary (CAN-053).
//
// GET /api/v1/health/stats/overview returns platform-wide health_records
// aggregates; it must be restricted to admin/clinical-leadership analytics roles
// (was reachable by PATIENT + broad health roles).
import { generateTestToken, API_KEY } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const TENANT_ID = '00000000-0000-4000-8000-000000000001';

function client(role) {
  const t = generateTestToken(role, { uid: 'c0de0053-0001-4c0d-8c0d-c0de00530001', tenant_id: TENANT_ID });
  return { get: (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${t}`) };
}

d('Health stats overview role boundary (CAN-053)', () => {
  afterAll(async () => { await prisma.$disconnect().catch(() => {}); });

  it.each(['PATIENT', 'NURSING_STAFF'])('%s is denied the global health stats overview', async (role) => {
    expect((await client(role).get('/api/v1/health/stats/overview')).statusCode).toBe(403);
  });

  it('ADMIN is not blocked by the role gate', async () => {
    const res = await client('ADMIN').get('/api/v1/health/stats/overview');
    expect(res.statusCode).not.toBe(403);
    expect(res.statusCode).not.toBe(401);
  });
});
