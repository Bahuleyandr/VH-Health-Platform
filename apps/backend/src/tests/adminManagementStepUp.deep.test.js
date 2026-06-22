// WS-D / audit 2026-06-22 H1 — the SUPER_ADMIN 2FA step-up gate must protect the
// admin-identity-mutation endpoints under /api/v1/auth/admin/*, not just the
// /admin, /system, /logs dashboard mounts. rbacMiddleware grants SUPER_ADMIN an
// unconditional role bypass, so without requireSuperAdminStepUp a SUPER_ADMIN
// whose session was never 2FA-stepped-up could create/deactivate admins.

import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import { API_KEY, generateTestToken } from './testClient.js';

const DB = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB ? describe : describe.skip;

const SUPER_UID = '00000000-0000-4000-8000-00000000d5a1';

function superClient(overrides) {
  const token = generateTestToken('SUPER_ADMIN', { uid: SUPER_UID, ...overrides });
  return request(app)
    .post('/api/v1/auth/admin/create-admin')
    .set('x-api-key', API_KEY)
    .set('Authorization', `Bearer ${token}`);
}

d('SUPER_ADMIN step-up on admin management (audit H1)', () => {
  afterAll(async () => {
    await prisma.$disconnect().catch(() => {});
  });

  it('403s a SUPER_ADMIN whose session is NOT 2FA-stepped-up (mfa!==true)', async () => {
    const res = await superClient({ mfa: false }).send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SUPER_ADMIN_MFA_REQUIRED');
  });

  it('403s when the mfa claim is absent entirely', async () => {
    const res = await superClient({}).send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SUPER_ADMIN_MFA_REQUIRED');
  });

  it('lets a 2FA-stepped-up SUPER_ADMIN past the gate (no step-up 403)', async () => {
    // With mfa:true the request clears the step-up gate and proceeds to the
    // request-body validators (an empty body then fails validation) — the point
    // is that it is NOT rejected with the step-up code.
    const res = await superClient({ mfa: true }).send({});
    expect(res.body.code).not.toBe('SUPER_ADMIN_MFA_REQUIRED');
    expect(res.status).not.toBe(403);
  });
});
