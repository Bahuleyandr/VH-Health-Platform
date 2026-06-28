// SUPER_ADMIN step-up on the clinical-AI + tenant control plane (CAN-043).
//
// requireRole grants SUPER_ADMIN an un-scoped bypass; the control-plane mounts
// now also require an MFA step-up (req.user.mfa), matching /admin, /system,
// /logs. A SUPER_ADMIN token without mfa must be blocked.
import { generateTestToken, API_KEY } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const TENANT_ID = '00000000-0000-4000-8000-000000000001';

function su(mfa) {
  const t = generateTestToken('SUPER_ADMIN', { uid: 'c0de0143-0001-4c0d-8c0d-c0de01430001', tenant_id: TENANT_ID, mfa });
  return { get: (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${t}`) };
}

d('Control-plane SUPER_ADMIN step-up (CAN-043)', () => {
  afterAll(async () => { await prisma.$disconnect().catch(() => {}); });

  it('SUPER_ADMIN WITHOUT mfa is blocked from the tenant control plane', async () => {
    expect((await su(false).get('/api/v1/admin/tenants')).statusCode).toBe(403);
  });

  it('SUPER_ADMIN WITHOUT mfa is blocked from the clinical-AI control plane', async () => {
    expect((await su(false).get('/api/v1/clinical-ai/control/governance/status')).statusCode).toBe(403);
  });

  it('SUPER_ADMIN WITH mfa passes the step-up gate on the tenant control plane', async () => {
    const res = await su(true).get('/api/v1/admin/tenants');
    expect(res.statusCode).not.toBe(403);
    expect(res.statusCode).not.toBe(401);
  });
});
