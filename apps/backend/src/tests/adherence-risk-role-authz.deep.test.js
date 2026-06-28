// Adherence-risk clinical-role boundary (CAN-052).
//
// /api/v1/gamification/adherence-risk/:patientId returns clinician-facing risk
// scoring + escalation. The gamification mount is patient-facing, so a clinical
// role gate must keep non-clinical callers (incl. patients) out.
import { generateTestToken, API_KEY } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const TENANT_ID = '00000000-0000-4000-8000-000000000001';

function client(role) {
  const t = generateTestToken(role, { uid: 'c0de0152-0001-4c0d-8c0d-c0de01520001', tenant_id: TENANT_ID });
  return { get: (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${t}`) };
}

d('Adherence-risk clinical-role boundary (CAN-052)', () => {
  afterAll(async () => { await prisma.$disconnect().catch(() => {}); });

  it.each(['PATIENT', 'GENERAL_STAFF'])('%s is denied the adherence-risk endpoint', async (role) => {
    const res = await client(role).get('/api/v1/gamification/adherence-risk/12345');
    expect(res.statusCode).toBe(403);
  });
});
