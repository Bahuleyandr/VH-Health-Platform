// Investigation list patient-scope requirement (CAN-031).
//
// GET /investigations/list returned every patient's investigations + results
// for a broad clinical role when no patient filter was supplied. Non-privileged
// callers must now scope by patient (or their own doctor filter); ops/records/
// leadership roles may still run the unscoped worklist.
import { generateTestToken, API_KEY } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const SOME_PATIENT = 'c0de0031-0000-4000-8000-0000000007a1';

function client(role) {
  const t = generateTestToken(role, { uid: 'c0de0031-00d0-4000-8000-00000000d001', tenant_id: TENANT_ID });
  return { get: (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${t}`) };
}

d('Investigation list patient-scope (CAN-031)', () => {
  afterAll(async () => { await prisma.$disconnect().catch(() => {}); });

  it('DOCTOR list with no patient filter is denied', async () => {
    const res = await client('DOCTOR').get('/api/v1/investigations/list');
    expect(res.statusCode).toBe(403);
    expect(JSON.stringify(res.body)).toMatch(/patient_id or patient_uid filter is required/i);
  });

  it('DOCTOR list scoped by patient_uid is allowed', async () => {
    const res = await client('DOCTOR').get(`/api/v1/investigations/list?patient_uid=${SOME_PATIENT}`);
    expect(res.statusCode).not.toBe(403);
  });

  it('ADMIN may run the unscoped worklist', async () => {
    const res = await client('ADMIN').get('/api/v1/investigations/list');
    expect(res.statusCode).not.toBe(403);
  });
});
