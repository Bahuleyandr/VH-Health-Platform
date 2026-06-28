// Pre-JWT internal docs/stats exposure (CAN-044).
//
// /api/v1/internal is mounted with validateApiKey only. /docs and /stats must
// require a verified ADMIN JWT; /health stays API-key-only.
import { generateTestToken, API_KEY } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const TENANT_ID = '00000000-0000-4000-8000-000000000001';

const withKey = (r) => r.set('x-api-key', API_KEY);
const withAuth = (r, role) => withKey(r).set('Authorization',
  `Bearer ${generateTestToken(role, { uid: 'c0de0108-0001-4c0d-8c0d-c0de01080001', tenant_id: TENANT_ID })}`);

d('Internal docs/stats exposure (CAN-044)', () => {
  afterAll(async () => { await prisma.$disconnect().catch(() => {}); });

  it('API-key only (no JWT) cannot read /docs or /stats', async () => {
    expect((await withKey(request(app).get('/api/v1/internal/docs'))).statusCode).toBe(401);
    expect((await withKey(request(app).get('/api/v1/internal/stats'))).statusCode).toBe(401);
  });

  it('a non-admin JWT cannot read /docs or /stats', async () => {
    expect((await withAuth(request(app).get('/api/v1/internal/docs'), 'PATIENT')).statusCode).toBe(403);
    expect((await withAuth(request(app).get('/api/v1/internal/stats'), 'DOCTOR')).statusCode).toBe(403);
  });

  it('ADMIN can read /docs', async () => {
    const res = await withAuth(request(app).get('/api/v1/internal/docs'), 'ADMIN');
    expect(res.statusCode).toBe(200);
  });

  it('/health stays reachable with API key only', async () => {
    const res = await withKey(request(app).get('/api/v1/internal/health'));
    expect(res.statusCode).toBe(200);
  });
});
