// SOS responder performance report tenant scope (CAN-006).
//
// getPerformanceReport ran an unscoped aggregate over sos_alerts, so an admin's
// "responder performance" report mixed in responders from other tenants. It now
// filters on sa.tenant_id. RLS is OFF in the test env (AUTH_ENFORCE_TENANT_RLS
// unset), so this explicit predicate is exactly what scopes the report — a
// tenant-A admin must not see a tenant-B responder.
import { generateTestToken, API_KEY, ensureTestIdentity } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const TENANT_A = '00000000-0000-4000-8000-000000000001';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const RESP_A = 'c0de0006-00a0-4000-8000-0000000000a1';
const RESP_B = 'c0de0006-00b0-4000-8000-0000000000b1';

function admin(tenantId) {
  const t = generateTestToken('ADMIN', { uid: 'c0de0006-00d0-4000-8000-00000000d001', tenant_id: tenantId });
  return { get: (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${t}`) };
}

async function clean() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM sos_alerts WHERE responded_by IN ($1::uuid, $2::uuid)`, RESP_A, RESP_B).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`, RESP_A, RESP_B).catch(() => {});
}

async function seedResponder(uid, tenantId, name, phone) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, updated_at)
     VALUES ($1::uuid,$2::uuid,$3,$4,'NURSE',true,NOW())`, uid, tenantId, phone, name);
}

async function seedAlert(tenantId, respUid) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO sos_alerts (phone, responded_by, status, raised_at, responded_at, tenant_id, updated_at)
     VALUES ('+919000006700', $1::uuid, 'RESOLVED', NOW() - INTERVAL '10 minutes', NOW(), $2::uuid, NOW())`,
    respUid, tenantId);
}

d('SOS performance report tenant scope (CAN-006)', () => {
  // Authentication fails closed when a token's subject has no live identity
  // row, so an invented uid 401s before this suite's authz gate is reached.
  beforeAll(async () => {
    await ensureTestIdentity('c0de0006-00d0-4000-8000-00000000d001');
  });
  beforeAll(async () => {
    await clean();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, 'can006-tenant-b', 'CAN-006 Tenant B') ON CONFLICT (id) DO NOTHING`,
      TENANT_B);
    await seedResponder(RESP_A, TENANT_A, 'SOS Responder A', '+919000006701');
    await seedResponder(RESP_B, TENANT_B, 'SOS Responder B', '+919000006702');
    await seedAlert(TENANT_A, RESP_A);
    await seedAlert(TENANT_B, RESP_B);
  }, 30000);
  afterAll(async () => { await clean(); await prisma.$disconnect().catch(() => {}); }, 30000);

  it('a tenant-A admin report excludes a tenant-B responder', async () => {
    const res = await admin(TENANT_A).get('/api/v1/sos/admin/performance-report');
    expect(res.statusCode).toBe(200);
    const names = (res.body.data?.responders || []).map((r) => r.responder_name);
    expect(names).toContain('SOS Responder A');
    expect(names).not.toContain('SOS Responder B');
  });
});
